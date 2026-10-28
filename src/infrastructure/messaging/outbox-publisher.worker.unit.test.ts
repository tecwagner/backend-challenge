import { describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'crypto';
import { OutboxMessage } from '../../domain/outbox/outbox-message.js';
import type { OutboxRepositoryPort } from '../../application/ports/outbox.repository.port.js';
import type { UnitOfWorkPort } from '../../application/ports/unit-of-work.port.js';
import type { SqsClient } from './sqs.client.js';
import { OutboxPublisherWorker } from './outbox-publisher.worker.js';

class InMemoryOutboxRepository implements OutboxRepositoryPort {
  messages: OutboxMessage[] = [];
  updateCalls: OutboxMessage[] = [];

  async save(message: OutboxMessage): Promise<void> {
    this.messages.push(message);
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    return this.messages
      .filter((m) => m.isDue(now))
      .slice(0, limit);
  }

  async update(message: OutboxMessage): Promise<void> {
    this.updateCalls.push(message);
    const index = this.messages.findIndex((m) => m.id === message.id);
    if (index >= 0) {
      this.messages[index] = message;
    }
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

function createSampleOutboxMessage(overrides: Partial<Parameters<typeof OutboxMessage.rehydrate>[0]> = {}): OutboxMessage {
  const eventId = overrides.payload && typeof overrides.payload === 'object' && 'eventId' in overrides.payload
    ? (overrides.payload as any).eventId
    : `event-${randomUUID()}`;

  return OutboxMessage.rehydrate({
    id: randomUUID(),
    aggregateId: 'wallet-123',
    eventType: 'WagerTransactionProcessed',
    payload: {
      eventId,
      eventType: 'WagerTransactionProcessed',
      version: 1,
      aggregateId: 'wallet-123',
      correlationId: 'corr-456',
      occurredAt: new Date().toISOString(),
      data: { status: 'PROCESSED' },
    },
    occurredAt: new Date(),
    attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000), // due
    publishedAt: undefined,
    ...overrides,
  });
}

describe('OutboxPublisherWorker', () => {
  const queueUrl = 'http://localhost:4566/000000000000/integration-events.fifo';

  it('Requirement 10.3: claims due messages, publishes to SQS with eventId as MessageDeduplicationId, and sets publishedAt = NOW()', async () => {
    const uow = new TestUnitOfWork();
    const outboxRepo = new InMemoryOutboxRepository();
    const msg = createSampleOutboxMessage();
    await outboxRepo.save(msg);

    let sentQueueUrl: string | undefined;
    let sentBody: string | undefined;
    let sentGroupId: string | undefined;
    let sentDedupId: string | undefined;

    const sqsClient = {
      sendMessage: mock(async (q: string, body: string, groupId?: string, dedupId?: string) => {
        sentQueueUrl = q;
        sentBody = body;
        sentGroupId = groupId;
        sentDedupId = dedupId;
        return 'sqs-msg-id-1';
      }),
    } as unknown as SqsClient;

    const worker = new OutboxPublisherWorker(sqsClient, uow, outboxRepo, {
      queueUrl,
      batchSize: 10,
      maxAttempts: 10,
    });

    const count = await worker.pollOnce();

    expect(count).toBe(1);
    expect(uow.commitCount).toBe(1);
    expect(sentQueueUrl).toBe(queueUrl);
    expect(sentGroupId).toBe('wallet-123');
    expect(sentDedupId).toBe((msg.payload as any).eventId);
    expect(sentBody).toBe(JSON.stringify(msg.payload));

    expect(msg.publishedAt).toBeDefined();
    expect(msg.isPending()).toBe(false);
    expect(outboxRepo.updateCalls).toHaveLength(1);
  });

  it('Requirement 10.7: schedules retry with exponential backoff on publish failure', async () => {
    const uow = new TestUnitOfWork();
    const outboxRepo = new InMemoryOutboxRepository();
    const msg = createSampleOutboxMessage({ attempts: 1 });
    await outboxRepo.save(msg);

    const sqsClient = {
      sendMessage: mock(async () => {
        throw new Error('SQS network timeout');
      }),
    } as unknown as SqsClient;

    const worker = new OutboxPublisherWorker(sqsClient, uow, outboxRepo, {
      queueUrl,
      batchSize: 10,
      maxAttempts: 10,
    });

    const count = await worker.pollOnce();

    expect(count).toBe(1);
    expect(uow.commitCount).toBe(1); // transaction commits the updated attempt count and nextAttemptAt
    expect(msg.publishedAt).toBeUndefined();
    expect(msg.attempts).toBe(2);
    expect(msg.nextAttemptAt).toBeDefined();
    // 2^2 * 1000 = 4000ms in the future
    expect(msg.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 2000);
    expect(outboxRepo.updateCalls).toHaveLength(1);
  });

  it('skips message if attempts already reached maxAttempts (OUTBOX_MAX_ATTEMPTS)', async () => {
    const uow = new TestUnitOfWork();
    const outboxRepo = new InMemoryOutboxRepository();
    const msg = createSampleOutboxMessage({ attempts: 10 });
    await outboxRepo.save(msg);

    let sendCalled = false;
    const sqsClient = {
      sendMessage: mock(async () => {
        sendCalled = true;
        return 'id';
      }),
    } as unknown as SqsClient;

    const worker = new OutboxPublisherWorker(sqsClient, uow, outboxRepo, {
      queueUrl,
      batchSize: 10,
      maxAttempts: 10,
    });

    const count = await worker.pollOnce();

    expect(count).toBe(1);
    expect(sendCalled).toBe(false);
    expect(msg.publishedAt).toBeUndefined();
  });

  it('returns 0 when there are no due outbox messages', async () => {
    const uow = new TestUnitOfWork();
    const outboxRepo = new InMemoryOutboxRepository();

    const sqsClient = {
      sendMessage: mock(async () => 'id'),
    } as unknown as SqsClient;

    const worker = new OutboxPublisherWorker(sqsClient, uow, outboxRepo, {
      queueUrl,
    });

    const count = await worker.pollOnce();
    expect(count).toBe(0);
    expect(sqsClient.sendMessage).not.toHaveBeenCalled();
  });

  it('stops polling cleanly when stop() is invoked', async () => {
    const uow = new TestUnitOfWork();
    const outboxRepo = new InMemoryOutboxRepository();
    const sqsClient = {
      sendMessage: mock(async () => 'id'),
    } as unknown as SqsClient;

    const worker = new OutboxPublisherWorker(sqsClient, uow, outboxRepo, {
      queueUrl,
      pollIntervalMs: 10,
    });

    await worker.start();
    expect(worker.running).toBe(true);

    await worker.stop();
    expect(worker.running).toBe(false);
  });
});
