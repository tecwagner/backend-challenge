import { randomUUID } from 'crypto';
import type { Message } from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { INBOX_REPOSITORY, type InboxRepositoryPort } from '../../application/ports/inbox.repository.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../application/ports/unit-of-work.port.js';
import type { ProcessWagerTransactionCommand } from '../../application/use-cases/process-wager-transaction/process-wager-transaction.dto.js';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction/process-wager-transaction.use-case.js';
import { PayloadHashService } from '../../application/services/payload-hash.service.js';
import { InboxMessage } from '../../domain/outbox/inbox-message.js';
import { SqsClient } from './sqs.client.js';

export interface SqsConsumerOptions {
  queueUrl?: string;
  consumerName?: string;
  maxMessages?: number;
  waitTimeSeconds?: number;
  shutdownTimeoutMs?: number;
}

export const SQS_CONSUMER_OPTIONS = Symbol('SqsConsumerOptions');

/**
 * Consumes wagering transactions from SQS FIFO queue with persistent Inbox
 * deduplication, transactional execution, and graceful shutdown.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8
 */
@Injectable()
export class SqsConsumerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SqsConsumerService.name);

  readonly queueUrl: string;
  readonly consumerName: string;
  readonly maxMessages: number;
  readonly waitTimeSeconds: number;
  readonly shutdownTimeoutMs: number;

  private isRunning = false;
  private isShuttingDown = false;
  private readonly inFlight = new Set<Promise<void>>();
  private loopPromise?: Promise<void> | undefined;

  constructor(
    private readonly sqsClient: SqsClient,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(INBOX_REPOSITORY) private readonly inboxRepository: InboxRepositoryPort,
    private readonly processUseCase: ProcessWagerTransactionUseCase,
    private readonly payloadHashService: PayloadHashService,
    @Optional() @Inject(SQS_CONSUMER_OPTIONS) options?: SqsConsumerOptions,
  ) {
    this.queueUrl =
      options?.queueUrl ??
      process.env['QUEUE_URL'] ??
      'http://localhost:4566/000000000000/wager-transactions.fifo';
    this.consumerName = options?.consumerName ?? 'wagering-processor';
    this.maxMessages = options?.maxMessages ?? 10;
    this.waitTimeSeconds = options?.waitTimeSeconds ?? 20;
    this.shutdownTimeoutMs = options?.shutdownTimeoutMs ?? 30_000;
  }

  async onModuleInit(): Promise<void> {
    const autoStart =
      process.env['SQS_CONSUMER_AUTO_START'] === 'true' ||
      (process.env['NODE_ENV'] !== 'test' && process.env['SQS_CONSUMER_DISABLED'] !== 'true');

    if (autoStart) {
      this.logger.log(`Starting SqsConsumerService for queue: ${this.queueUrl}`);
      this.start().catch((err) => {
        this.logger.error('Failed to start SqsConsumerService loop', err);
      });
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`onApplicationShutdown received signal: ${signal ?? 'none'}`);
    await this.gracefulShutdown(this.shutdownTimeoutMs);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isShuttingDown = false;
    this.loopPromise = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.isShuttingDown = true;
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        // Ignored on stop
      }
    }
  }

  get running(): boolean {
    return this.isRunning;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Main long-polling loop. Runs while `isRunning` is true and shutdown has not begun.
   */
  private async pollLoop(): Promise<void> {
    while (this.isRunning && !this.isShuttingDown) {
      try {
        await this.pollOnce();
      } catch (err) {
        if (!this.isRunning || this.isShuttingDown) break;
        this.logger.error('Error during SQS poll iteration', err);
        // Avoid tight loop on repeated polling errors
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Performs a single poll cycle from the SQS queue and processes messages.
   */
  async pollOnce(): Promise<void> {
    if (!this.isRunning && !this.isShuttingDown) {
      // Allow explicit single poll call even if loop is not running
    } else if (this.isShuttingDown) {
      return;
    }

    const messages = await this.sqsClient.receiveMessages(
      this.queueUrl,
      this.maxMessages,
      this.waitTimeSeconds,
    );

    if (messages.length === 0) {
      return;
    }

    for (const message of messages) {
      if (this.isShuttingDown) {
        break;
      }
      try {
        await this.processSingleMessage(message);
      } catch (err) {
        // Message failed: visibility backoff was applied.
        // We continue to next message in the batch without crashing the consumer.
        this.logger.warn(`Failed to process message ${message.MessageId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Wraps message processing in in-flight tracking for graceful shutdown.
   */
  async processSingleMessage(message: Message): Promise<void> {
    const task = this.executeMessage(message);
    this.inFlight.add(task);
    try {
      await task;
    } finally {
      this.inFlight.delete(task);
    }
  }

  /**
   * Core processing logic:
   * 1. Parse JSON envelope
   * 2. Insert InboxMessage atomically (ON CONFLICT DO NOTHING) inside SQL transaction
   * 3. If duplicate delivery, ack message immediately without re-running effects
   * 4. Execute ProcessWagerTransactionUseCase within the same SQL transaction
   * 5. Ack (deleteMessage) ONLY after successful transaction commit
   * 6. Business rejection (REJECTED): ack without DLQ
   * 7. Transient error: rollback without ack, apply exponential backoff visibility
   */
  private async executeMessage(message: Message): Promise<void> {
    if (!message.ReceiptHandle) {
      this.logger.warn(`Message ${message.MessageId} missing ReceiptHandle. Skipping.`);
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(message.Body ?? '{}');
    } catch (parseErr) {
      this.logger.error(`Malformed JSON in SQS message ${message.MessageId}`, parseErr);
      throw parseErr;
    }

    const data = parsed && typeof parsed === 'object' && 'data' in parsed && parsed.data
      ? parsed.data
      : parsed;

    const inboxMessageId =
      typeof parsed.messageId === 'string' && parsed.messageId.trim().length > 0
        ? parsed.messageId.trim()
        : (message.MessageId ?? randomUUID());

    const correlationId =
      parsed.correlationId ??
      data.correlationId ??
      message.MessageAttributes?.correlationId?.StringValue ??
      message.MessageAttributes?.CorrelationId?.StringValue ??
      randomUUID();

    const idempotencyKey =
      data.idempotencyKey ??
      `${data.providerId}:${data.externalTransactionId}`;

    const command: ProcessWagerTransactionCommand = {
      idempotencyKey,
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: data.money,
      referenceExternalTransactionId: data.referenceExternalTransactionId,
      correlationId,
    };

    const payloadHash = this.payloadHashService.compute(command);
    let shouldAck = false;

    try {
      await this.uow.transactional(async () => {
        // Atomic inbox deduplication (Requirement 9.2, 9.8)
        const inbox = InboxMessage.receive({
          messageId: inboxMessageId,
          consumerName: this.consumerName,
          payloadHash,
        });

        const { isDuplicate } = await this.inboxRepository.insertOrFind(inbox);
        if (isDuplicate) {
          this.logger.warn(`Duplicate SQS message detected via inbox (messageId: ${inboxMessageId}). Acknowledging duplicate.`);
          shouldAck = true;
          return;
        }

        // Execute financial transaction inside this SQL transaction (Requirement 9.1)
        await this.processUseCase.execute(command);

        // Mark inbox message processed inside the same transaction
        inbox.markProcessed(new Date());
        await this.inboxRepository.markProcessed(inbox);

        // Commit will execute upon returning from this callback
        // Both business success and domain rejection (REJECTED) commit and ack (Requirement 9.3, 9.4)
        shouldAck = true;
      });

      // Ack ONLY after successful commit (Requirement 9.3)
      if (shouldAck && message.ReceiptHandle) {
        await this.sqsClient.deleteMessage(this.queueUrl, message.ReceiptHandle);
      }
    } catch (err) {
      // Transaction rolled back. Transient / infrastructure error (Requirement 9.5).
      // Do NOT ack. Apply exponential backoff visibility timeout so SQS re-delivers.
      if (message.ReceiptHandle) {
        try {
          const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
          const backoffSeconds = Math.min(Math.pow(2, Math.max(1, receiveCount)) * 5, 300);
          await this.sqsClient.changeMessageVisibility(
            this.queueUrl,
            message.ReceiptHandle,
            backoffSeconds,
          );
        } catch (visErr) {
          this.logger.warn(`Could not update visibility for message ${message.MessageId}`, visErr);
        }
      }
      throw err;
    }
  }

  /**
   * Graceful shutdown: awaits in-flight message processing up to `timeoutMs` (default 30s).
   * Requirement 9.7
   */
  async gracefulShutdown(timeoutMs: number = 30_000): Promise<void> {
    if (this.isShuttingDown) return;
    this.logger.log('Initiating SQS consumer graceful shutdown...');
    this.isShuttingDown = true;
    this.isRunning = false;

    if (this.inFlight.size === 0) {
      this.logger.log('No in-flight messages. Clean shutdown.');
      return;
    }

    this.logger.log(`Waiting for ${this.inFlight.size} in-flight message(s) to finish (timeout: ${timeoutMs}ms)...`);

    const inFlightPromises = Array.from(this.inFlight);
    const inFlightDone = Promise.allSettled(inFlightPromises);
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, timeoutMs));

    await Promise.race([inFlightDone, timeoutPromise]);

    if (this.inFlight.size > 0) {
      this.logger.warn(`Graceful shutdown timed out after ${timeoutMs}ms. ${this.inFlight.size} message(s) still in-flight.`);
    } else {
      this.logger.log('All in-flight messages completed. SQS consumer shut down cleanly.');
    }
  }
}
