import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { OUTBOX_REPOSITORY, type OutboxRepositoryPort } from '../../application/ports/outbox.repository.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../application/ports/unit-of-work.port.js';
import { SqsClient } from './sqs.client.js';

export interface OutboxWorkerOptions {
  queueUrl?: string;
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
}

export const OUTBOX_WORKER_OPTIONS = Symbol('OutboxWorkerOptions');

/**
 * OutboxPublisherWorker continuously polls pending outbox messages using
 * `SELECT FOR UPDATE SKIP LOCKED`, publishes integration events to SQS FIFO,
 * and updates their status atomically with exponential backoff on retry.
 *
 * Requirements: 10.3, 10.4, 10.5, 10.6, 10.7
 */
@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);

  readonly queueUrl: string;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly maxAttempts: number;

  private isRunning = false;
  private isShuttingDown = false;
  private loopPromise?: Promise<void>;
  private currentPollTask?: Promise<number>;

  constructor(
    private readonly sqsClient: SqsClient,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(OUTBOX_REPOSITORY) private readonly outboxRepo: OutboxRepositoryPort,
    @Optional() @Inject(OUTBOX_WORKER_OPTIONS) options?: OutboxWorkerOptions,
  ) {
    this.queueUrl =
      options?.queueUrl ??
      process.env['INTEGRATION_EVENTS_QUEUE_URL'] ??
      process.env['OUTBOX_QUEUE_URL'] ??
      'http://localhost:4566/000000000000/integration-events.fifo';

    this.pollIntervalMs =
      options?.pollIntervalMs ??
      (process.env['OUTBOX_POLL_INTERVAL_MS']
        ? Number(process.env['OUTBOX_POLL_INTERVAL_MS'])
        : 1000);

    this.batchSize = options?.batchSize ?? 10;

    this.maxAttempts =
      options?.maxAttempts ??
      (process.env['OUTBOX_MAX_ATTEMPTS']
        ? Number(process.env['OUTBOX_MAX_ATTEMPTS'])
        : 10);
  }

  async onModuleInit(): Promise<void> {
    const autoStart =
      process.env['OUTBOX_PUBLISHER_AUTO_START'] === 'true' ||
      (process.env['NODE_ENV'] !== 'test' && process.env['OUTBOX_PUBLISHER_DISABLED'] !== 'true');

    if (autoStart) {
      this.logger.log(`Starting OutboxPublisherWorker polling every ${this.pollIntervalMs}ms`);
      this.start().catch((err) => {
        this.logger.error('Failed to start OutboxPublisherWorker loop', err);
      });
    }
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`onApplicationShutdown received signal: ${signal ?? 'none'}`);
    await this.stop();
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
    if (this.currentPollTask) {
      try {
        await this.currentPollTask;
      } catch {
        // Ignored on shutdown
      }
    }
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        // Ignored on shutdown
      }
    }
  }

  get running(): boolean {
    return this.isRunning;
  }

  private async pollLoop(): Promise<void> {
    while (this.isRunning && !this.isShuttingDown) {
      try {
        await this.pollOnce();
      } catch (err) {
        if (!this.isRunning || this.isShuttingDown) break;
        this.logger.error('Error during outbox poll iteration', err);
      }

      if (this.isRunning && !this.isShuttingDown) {
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
  }

  /**
   * Performs a single outbox sweep:
   * 1. Claims due outbox messages via `SELECT FOR UPDATE SKIP LOCKED`
   * 2. Publishes each message to SQS with `eventId` as `MessageDeduplicationId`
   * 3. Upon success: sets `publishedAt = NOW()` in the same SQL transaction
   * 4. Upon failure: calls `scheduleRetry(now)` with exponential backoff and updates attempts
   */
  async pollOnce(): Promise<number> {
    const task = this.executePoll();
    this.currentPollTask = task;
    try {
      return await task;
    } finally {
      this.currentPollTask = undefined;
    }
  }

  private async executePoll(): Promise<number> {
    if (this.isShuttingDown) return 0;

    return await this.uow.transactional(async () => {
      const now = new Date();
      const messages = await this.outboxRepo.claimDue(now, this.batchSize);

      if (messages.length === 0) {
        return 0;
      }

      for (const message of messages) {
        if (this.isShuttingDown) break;

        if (message.attempts >= this.maxAttempts) {
          this.logger.error(
            `OutboxMessage ${message.id} reached max attempts (${this.maxAttempts}). Skipping.`,
          );
          continue;
        }

        const attemptTime = new Date();
        try {
          const payloadObj = message.payload as Record<string, unknown>;
          const eventId =
            payloadObj && typeof payloadObj === 'object' && 'eventId' in payloadObj
              ? String(payloadObj['eventId'])
              : message.id;

          const messageGroupId = message.aggregateId || 'default-aggregate';
          const messageDeduplicationId = eventId;
          const body =
            typeof message.payload === 'string'
              ? message.payload
              : JSON.stringify(message.payload);

          // Publish to SQS FIFO queue
          await this.sqsClient.sendMessage(
            this.queueUrl,
            body,
            messageGroupId,
            messageDeduplicationId,
          );

          // Mark published in the same transaction (Requirement 10.3)
          message.markPublished(attemptTime);
          await this.outboxRepo.update(message);
        } catch (err) {
          // Exponential backoff and persistence for retry (Requirement 10.7)
          this.logger.warn(
            `Failed to publish OutboxMessage ${message.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          message.scheduleRetry(attemptTime);
          await this.outboxRepo.update(message);

          if (message.attempts >= this.maxAttempts) {
            this.logger.error(
              `OutboxMessage ${message.id} exceeded max attempts (${this.maxAttempts}) and will not be retried automatically.`,
            );
          }
        }
      }

      return messages.length;
    });
  }
}
