import { describe, expect, it, mock } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import { Money } from '../../domain/money/money.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../../domain/wager-transaction/failure-codes.js';
import { InboxMessage } from '../../domain/outbox/inbox-message.js';
import type { InboxRepositoryPort } from '../../application/ports/inbox.repository.port.js';
import type { UnitOfWorkPort } from '../../application/ports/unit-of-work.port.js';
import type { ProcessWagerTransactionCommand, ProcessWagerTransactionResult } from '../../application/use-cases/process-wager-transaction/process-wager-transaction.dto.js';
import { PayloadHashService } from '../../application/services/payload-hash.service.js';
import type { SqsClient } from './sqs.client.js';
import { SqsConsumerService } from './sqs-consumer.service.js';

class InMemoryInboxRepository implements InboxRepositoryPort {
  readonly recorded = new Map<string, InboxMessage>();
  readonly markedProcessed = new Set<string>();

  async insertOrFind(message: InboxMessage): Promise<{ message: InboxMessage; isDuplicate: boolean }> {
    const key = `${message.consumerName}:${message.messageId}`;
    if (this.recorded.has(key)) {
      return { message: this.recorded.get(key)!, isDuplicate: true };
    }
    this.recorded.set(key, message);
    return { message, isDuplicate: false };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    this.markedProcessed.add(`${message.consumerName}:${message.messageId}`);
    message.markProcessed(new Date());
  }
}

class TestUnitOfWork implements UnitOfWorkPort {
  commitCount = 0;
  rollbackCount = 0;

  async transactional<T>(work: () => Promise<T>): Promise<T> {
    try {
      const res = await work();
      this.commitCount++;
      return res;
    } catch (err) {
      this.rollbackCount++;
      throw err;
    }
  }
}

describe('SqsConsumerService', () => {
  const queueUrl = 'http://localhost:4566/000000000000/wager-transactions.fifo';
  const payloadHashService = new PayloadHashService();

  function makeValidMessage(overrides: Partial<Message> = {}, dataOverrides: Record<string, any> = {}): Message {
    const body = {
      messageId: 'msg-abc-123',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-1',
        externalTransactionId: 'ext-tx-100',
        idempotencyKey: 'provider-1:ext-tx-100',
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '50.00', currency: 'BRL' },
        ...dataOverrides,
      },
    };

    return {
      MessageId: 'sqs-message-id-1',
      ReceiptHandle: 'receipt-handle-1',
      Body: JSON.stringify(body),
      Attributes: {
        ApproximateReceiveCount: '1',
      },
      ...overrides,
    };
  }

  it('Requirement 9.1 & 9.3: successfully processes message and acks (deleteMessage) after commit', async () => {
    const uow = new TestUnitOfWork();
    const inboxRepo = new InMemoryInboxRepository();

    let executedCommand: ProcessWagerTransactionCommand | undefined;
    const processUseCase = {
      execute: mock(async (cmd: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> => {
        executedCommand = cmd;
        return {
          transactionId: 'tx-1',
          status: WagerTransactionStatus.Processed,
          balance: { amount: '150.00', currency: 'BRL' },
          idempotentReplay: false,
        };
      }),
    } as any;

    let deletedReceiptHandle: string | undefined;
    const sqsClient = {
      receiveMessages: mock(async () => [makeValidMessage()]),
      deleteMessage: mock(async (_q: string, handle: string) => {
        deletedReceiptHandle = handle;
      }),
      changeMessageVisibility: mock(async () => {}),
    } as unknown as SqsClient;

    const consumer = new SqsConsumerService(
      sqsClient,
      uow,
      inboxRepo,
      processUseCase,
      payloadHashService,
      { queueUrl, waitTimeSeconds: 0 },
    );

    await consumer.pollOnce();

    // Verify use case was invoked with mapped data
    expect(executedCommand).toBeDefined();
    expect(executedCommand?.providerId).toBe('provider-1');
    expect(executedCommand?.externalTransactionId).toBe('ext-tx-100');
    expect(executedCommand?.money.amount).toBe('50.00');

    // Verify inbox message was recorded and marked processed
    expect(inboxRepo.recorded.has('wagering-processor:msg-abc-123')).toBe(true);
    expect(inboxRepo.markedProcessed.has('wagering-processor:msg-abc-123')).toBe(true);

    // Verify SQL transaction committed and SQS deleteMessage was called
    expect(uow.commitCount).toBe(1);
    expect(deletedReceiptHandle).toBe('receipt-handle-1');
  });

  it('Requirement 9.2 & 9.8: detects duplicate delivery via inbox and acks without re-running effects', async () => {
    const uow = new TestUnitOfWork();
    const inboxRepo = new InMemoryInboxRepository();

    // Pre-populate inbox with this messageId
    const existing = InboxMessage.receive({
      messageId: 'msg-abc-123',
      consumerName: 'wagering-processor',
      payloadHash: 'hash-pre-existing',
    });
    existing.markProcessed(new Date());
    await inboxRepo.insertOrFind(existing);

    const processUseCase = {
      execute: mock(async () => {
        throw new Error('Should NOT be called for duplicate inbox message!');
      }),
    } as any;

    let deletedReceiptHandle: string | undefined;
    const sqsClient = {
      receiveMessages: mock(async () => [makeValidMessage()]),
      deleteMessage: mock(async (_q: string, handle: string) => {
        deletedReceiptHandle = handle;
      }),
      changeMessageVisibility: mock(async () => {}),
    } as unknown as SqsClient;

    const consumer = new SqsConsumerService(
      sqsClient,
      uow,
      inboxRepo,
      processUseCase,
      payloadHashService,
      { queueUrl, waitTimeSeconds: 0 },
    );

    await consumer.pollOnce();

    expect(processUseCase.execute).not.toHaveBeenCalled();
    expect(deletedReceiptHandle).toBe('receipt-handle-1');
    expect(uow.commitCount).toBe(1);
  });

  it('Requirement 9.4: acks message when transaction is rejected by domain rules (REJECTED) without DLQ routing', async () => {
    const uow = new TestUnitOfWork();
    const inboxRepo = new InMemoryInboxRepository();

    const processUseCase = {
      execute: mock(async (): Promise<ProcessWagerTransactionResult> => {
        // Domain rule rejection: state persisted as REJECTED
        return {
          transactionId: 'tx-rejected-1',
          status: WagerTransactionStatus.Rejected,
          balance: { amount: '10.00', currency: 'BRL' },
          idempotentReplay: false,
          failureCode: FailureCode.BalanceInsufficient,
        };
      }),
    } as any;

    let deletedReceiptHandle: string | undefined;
    const sqsClient = {
      receiveMessages: mock(async () => [makeValidMessage()]),
      deleteMessage: mock(async (_q: string, handle: string) => {
        deletedReceiptHandle = handle;
      }),
      changeMessageVisibility: mock(async () => {}),
    } as unknown as SqsClient;

    const consumer = new SqsConsumerService(
      sqsClient,
      uow,
      inboxRepo,
      processUseCase,
      payloadHashService,
      { queueUrl, waitTimeSeconds: 0 },
    );

    await consumer.pollOnce();

    // Verify commit and ack
    expect(uow.commitCount).toBe(1);
    expect(deletedReceiptHandle).toBe('receipt-handle-1');
  });

  it('Requirement 9.5: does NOT ack on transient error and applies exponential backoff visibility', async () => {
    const uow = new TestUnitOfWork();
    const inboxRepo = new InMemoryInboxRepository();

    const processUseCase = {
      execute: mock(async () => {
        throw new Error('Database connection timeout (transient)');
      }),
    } as any;

    let deletedMessageCalled = false;
    let changedVisibilityTimeout: number | undefined;

    const sqsClient = {
      receiveMessages: mock(async () => [
        makeValidMessage({
          Attributes: { ApproximateReceiveCount: '2' },
        }),
      ]),
      deleteMessage: mock(async () => {
        deletedMessageCalled = true;
      }),
      changeMessageVisibility: mock(async (_q: string, _handle: string, timeout: number) => {
        changedVisibilityTimeout = timeout;
      }),
    } as unknown as SqsClient;

    const consumer = new SqsConsumerService(
      sqsClient,
      uow,
      inboxRepo,
      processUseCase,
      payloadHashService,
      { queueUrl, waitTimeSeconds: 0 },
    );

    await consumer.pollOnce();

    // Verify transaction rolled back
    expect(uow.rollbackCount).toBe(1);
    // Did NOT ack
    expect(deletedMessageCalled).toBe(false);
    // Changed visibility with backoff (receiveCount = 2 -> 2^2 * 5 = 20s)
    expect(changedVisibilityTimeout).toBe(20);
  });

  it('Requirement 9.7: gracefulShutdown waits for in-flight message before resolving', async () => {
    const uow = new TestUnitOfWork();
    const inboxRepo = new InMemoryInboxRepository();

    let resolveExecution!: () => void;
    const executionPending = new Promise<void>((resolve) => {
      resolveExecution = resolve;
    });

    const processUseCase = {
      execute: mock(async (): Promise<ProcessWagerTransactionResult> => {
        await executionPending;
        return {
          transactionId: 'tx-slow-1',
          status: WagerTransactionStatus.Processed,
          balance: { amount: '100.00', currency: 'BRL' },
          idempotentReplay: false,
        };
      }),
    } as any;

    const sqsClient = {
      receiveMessages: mock(async () => []),
      deleteMessage: mock(async () => {}),
      changeMessageVisibility: mock(async () => {}),
    } as unknown as SqsClient;

    const consumer = new SqsConsumerService(
      sqsClient,
      uow,
      inboxRepo,
      processUseCase,
      payloadHashService,
      { queueUrl, waitTimeSeconds: 0 },
    );

    // Start single message in background
    const msg = makeValidMessage();
    const messageTask = consumer.processSingleMessage(msg);

    expect(consumer.inFlightCount).toBe(1);

    // Initiate graceful shutdown
    let shutdownDone = false;
    const shutdownPromise = consumer.gracefulShutdown(5000).then(() => {
      shutdownDone = true;
    });

    // Should NOT have completed yet while message is in-flight
    await new Promise((r) => setTimeout(r, 20));
    expect(shutdownDone).toBe(false);

    // Release in-flight task
    resolveExecution();
    await messageTask;
    await shutdownPromise;

    expect(shutdownDone).toBe(true);
    expect(consumer.inFlightCount).toBe(0);
  });

  it('handles flat payload structure seamlessly', async () => {
    const uow = new TestUnitOfWork();
    const inboxRepo = new InMemoryInboxRepository();

    let commandPassed: ProcessWagerTransactionCommand | undefined;
    const processUseCase = {
      execute: mock(async (cmd: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> => {
        commandPassed = cmd;
        return {
          transactionId: 'tx-flat',
          status: WagerTransactionStatus.Processed,
          balance: { amount: '200.00', currency: 'USD' },
          idempotentReplay: false,
        };
      }),
    } as any;

    const flatMessage: Message = {
      MessageId: 'sqs-flat-msg-1',
      ReceiptHandle: 'handle-flat',
      Body: JSON.stringify({
        providerId: 'provider-flat',
        externalTransactionId: 'ext-flat-1',
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: 'round-flat',
        gameId: 'game-flat',
        kind: WagerTransactionKind.Win,
        money: { amount: '75.00', currency: 'USD' },
      }),
    };

    let deletedReceiptHandle: string | undefined;
    const sqsClient = {
      receiveMessages: mock(async () => [flatMessage]),
      deleteMessage: mock(async (_q: string, handle: string) => {
        deletedReceiptHandle = handle;
      }),
      changeMessageVisibility: mock(async () => {}),
    } as unknown as SqsClient;

    const consumer = new SqsConsumerService(
      sqsClient,
      uow,
      inboxRepo,
      processUseCase,
      payloadHashService,
      { queueUrl, waitTimeSeconds: 0 },
    );

    await consumer.pollOnce();

    expect(commandPassed).toBeDefined();
    expect(commandPassed?.providerId).toBe('provider-flat');
    expect(commandPassed?.kind).toBe(WagerTransactionKind.Win);
    expect(deletedReceiptHandle).toBe('handle-flat');
  });
});
