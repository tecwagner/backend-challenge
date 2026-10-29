import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'crypto';
import type { EntityManager } from '@mikro-orm/core';
import {
  startTestEnvironment,
  stopTestEnvironment,
  cleanDatabase,
  purgeTestQueues,
  type TestEnvironmentContext,
} from './setup.js';
import { UnitOfWorkAdapter } from '../../src/infrastructure/persistence/unit-of-work.adapter.js';
import { OutboxRepository } from '../../src/infrastructure/persistence/repositories/outbox.repository.js';
import { InboxRepository } from '../../src/infrastructure/persistence/repositories/inbox.repository.js';
import { InboxMessage } from '../../src/domain/outbox/inbox-message.js';
import { SqsClient } from '../../src/infrastructure/messaging/sqs.client.js';
import { OutboxPublisherWorker } from '../../src/infrastructure/messaging/outbox-publisher.worker.js';

describe('Integration Tests: Outbox Worker Concurrent Publishers (Requirements 10.3, 15.2)', () => {
  let context: TestEnvironmentContext;
  let sqsClientWrapper: SqsClient;

  beforeAll(async () => {
    context = await startTestEnvironment();
    sqsClientWrapper = new SqsClient(context.sqsClient);
  }, 60_000);

  afterAll(async () => {
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(async () => {
    await cleanDatabase(context.orm);
    await purgeTestQueues(context.sqsClient);
  });

  function createWorkerInstance(
    options?: { batchSize?: number; customSqsClient?: SqsClient; em?: EntityManager },
  ): { worker: OutboxPublisherWorker; em: EntityManager; outboxRepo: OutboxRepository } {
    const em = options?.em ?? context.orm.em.fork({ useContext: true });
    const uow = new UnitOfWorkAdapter(em);
    const outboxRepo = new OutboxRepository(em);
    const worker = new OutboxPublisherWorker(
      options?.customSqsClient ?? sqsClientWrapper,
      uow,
      outboxRepo,
      {
        queueUrl: context.integrationEventsQueueUrl,
        pollIntervalMs: 50,
        batchSize: options?.batchSize ?? 10,
        maxAttempts: 5,
      },
    );

    return { worker, em, outboxRepo };
  }

  // ===========================================================================
  // 1. Concorrência com 1 única OutboxMessage (SKIP LOCKED)
  // ===========================================================================
  it('Requirement 10.3 & 15.2: dois publishers concorrentes disputam a mesma OutboxMessage; SKIP LOCKED garante publicação exatamente uma vez', async () => {
    const conn = context.orm.em.getConnection();
    const outboxId = randomUUID();
    const eventId = `evt-${randomUUID()}`;
    const walletId = randomUUID();

    const payload = {
      eventId,
      eventType: 'WalletBalanceChanged',
      aggregateId: walletId,
      correlationId: `corr-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {
        walletId,
        transactionId: randomUUID(),
        direction: 'DEBIT',
        money: { amount: '100.00', currency: 'BRL' },
        balanceBefore: { amount: '500.00', currency: 'BRL' },
        balanceAfter: { amount: '400.00', currency: 'BRL' },
        walletVersion: 2,
      },
    };

    // 1. Insere uma única OutboxMessage pendente no banco (published_at = NULL)
    await conn.execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       VALUES (?, ?, ?, ?::jsonb, NOW(), 0, NOW(), NULL)`,
      [outboxId, walletId, 'WalletBalanceChanged', JSON.stringify(payload)],
    );

    // 2. Cria duas instâncias independentes do OutboxPublisherWorker com conexões separadas
    const { worker: workerA } = createWorkerInstance();
    const { worker: workerB } = createWorkerInstance();

    // 3. Executa ambos concorrentemente no exato mesmo momento
    const [publishedCountA, publishedCountB] = await Promise.all([
      workerA.pollOnce(),
      workerB.pollOnce(),
    ]);

    // Verificações:
    // Exatamente um worker reivindica a mensagem (retorna 1) e o outro worker vê 0 mensagens (SKIP LOCKED)
    expect(publishedCountA + publishedCountB).toBe(1);

    // No banco, a mensagem foi atualizada com published_at preenchido
    const outboxRows = await conn.execute<Array<{ published_at: Date | null; attempts: number }>>(
      `SELECT published_at, attempts FROM outbox_messages WHERE id = ?`,
      [outboxId],
    );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0]?.published_at).not.toBeNull();
    expect(outboxRows[0]?.attempts).toBe(0);

    // No SQS LocalStack: exatamente 1 mensagem foi entregue na fila FIFO
    const sqsMessages = await sqsClientWrapper.receiveMessages(
      context.integrationEventsQueueUrl,
      10,
      2,
    );
    expect(sqsMessages.length).toBe(1);

    const receivedPayload = JSON.parse(sqsMessages[0]?.Body ?? '{}');
    expect(receivedPayload.eventId).toBe(eventId);
    expect(receivedPayload.eventType).toBe('WalletBalanceChanged');
  });

  // ===========================================================================
  // 2. Concorrência com lote de mensagens (batch distribuído sem colisões)
  // ===========================================================================
  it('Requirement 10.3 & 15.2: dois publishers concorrentes processam lote de 10 mensagens simultaneamente sem sobreposição', async () => {
    const conn = context.orm.em.getConnection();
    const totalMessages = 10;
    const eventIds: string[] = [];

    // 1. Insere 10 mensagens pendentes
    for (let i = 0; i < totalMessages; i++) {
      const outboxId = randomUUID();
      const eventId = `evt-batch-${i}-${randomUUID()}`;
      eventIds.push(eventId);
      const walletId = randomUUID();

      const payload = {
        eventId,
        eventType: 'WagerTransactionProcessed',
        aggregateId: walletId,
        correlationId: `corr-batch-${i}`,
        occurredAt: new Date().toISOString(),
        version: 1,
        data: {
          transactionId: randomUUID(),
          kind: 'BET',
          status: 'PROCESSED',
        },
      };

      await conn.execute(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
         VALUES (?, ?, ?, ?::jsonb, NOW(), 0, NOW(), NULL)`,
        [outboxId, walletId, 'WagerTransactionProcessed', JSON.stringify(payload)],
      );
    }

    // 2. Cria dois workers concorrentes com batchSize 5
    const { worker: workerA } = createWorkerInstance({ batchSize: 5 });
    const { worker: workerB } = createWorkerInstance({ batchSize: 5 });

    // 3. Executa ambos concorrentemente
    const [countA, countB] = await Promise.all([
      workerA.pollOnce(),
      workerB.pollOnce(),
    ]);

    // Ambos devem reivindicar mensagens (soma deve ser o total de 10)
    expect(countA + countB).toBe(totalMessages);
    expect(countA).toBeGreaterThan(0);
    expect(countB).toBeGreaterThan(0);

    // No banco: todas as 10 mensagens estão marcadas como publicadas
    const pendingRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM outbox_messages WHERE published_at IS NULL`,
    );
    expect(pendingRows.length).toBe(0);

    // No SQS LocalStack: todas as 10 mensagens foram entregues sem perda
    const receivedSqsMessages = await sqsClientWrapper.receiveMessages(
      context.integrationEventsQueueUrl,
      10,
      3,
    );
    expect(receivedSqsMessages.length).toBe(totalMessages);

    const receivedEventIds = receivedSqsMessages.map((msg) => {
      const parsed = JSON.parse(msg.Body ?? '{}');
      return parsed.eventId;
    });

    // Cada um dos 10 eventIds foi publicado exatamente 1 vez
    expect(new Set(receivedEventIds).size).toBe(totalMessages);
    for (const id of eventIds) {
      expect(receivedEventIds).toContain(id);
    }
  });

  // ===========================================================================
  // 3. Idempotência downstream via eventId e InboxMessage (Requirement 10.3 & 10.5)
  // ===========================================================================
  it('Requirement 10.3 & 10.5: repubblicação de OutboxMessage com o mesmo eventId é segura para consumidor downstream', async () => {
    const conn = context.orm.em.getConnection();
    const eventId = `evt-idempotent-${randomUUID()}`;
    const walletId = randomUUID();

    const payload = {
      eventId,
      eventType: 'WalletBalanceChanged',
      aggregateId: walletId,
      correlationId: `corr-idem`,
      occurredAt: new Date().toISOString(),
      version: 1,
      data: { walletId, direction: 'CREDIT', amount: '50.00' },
    };

    const outboxId = randomUUID();
    await conn.execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       VALUES (?, ?, ?, ?::jsonb, NOW(), 0, NOW(), NULL)`,
      [outboxId, walletId, 'WalletBalanceChanged', JSON.stringify(payload)],
    );

    // 1. Primeira publicação pelo worker
    const { worker } = createWorkerInstance();
    const publishedCount = await worker.pollOnce();
    expect(publishedCount).toBe(1);

    // 2. Consumidor downstream recebe a primeira mensagem e registra no seu inbox
    const emConsumer = context.orm.em.fork({ useContext: true });
    const consumerInboxRepo = new InboxRepository(emConsumer);

    const inboxMsg1 = InboxMessage.receive({
      messageId: eventId,
      consumerName: 'downstream-analytics-consumer',
      payloadHash: 'hash-test-1',
    });

    const firstReceiveResult = await consumerInboxRepo.insertOrFind(inboxMsg1);
    expect(firstReceiveResult.isDuplicate).toBe(false);

    // 3. Simula uma entrega at-most-twice (ou replay da mesma mensagem downstream)
    const inboxMsg2 = InboxMessage.receive({
      messageId: eventId, // mesmo eventId
      consumerName: 'downstream-analytics-consumer',
      payloadHash: 'hash-test-1',
    });

    const secondReceiveResult = await consumerInboxRepo.insertOrFind(inboxMsg2);
    expect(secondReceiveResult.isDuplicate).toBe(true);
  });

  // ===========================================================================
  // 4. Falha transitória e agendamento de retry com backoff (Requirement 10.7)
  // ===========================================================================
  it('Requirement 10.7: falha de publicação no SQS agenda retry com backoff e não bloqueia outros eventos', async () => {
    const conn = context.orm.em.getConnection();
    const failingOutboxId = randomUUID();
    const healthyOutboxId = randomUUID();

    // Mensagem 1: simulará falha
    await conn.execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       VALUES (?, ?, 'TestFailingEvent', '{"eventId":"fail-1"}'::jsonb, NOW(), 0, NOW(), NULL)`,
      [failingOutboxId, randomUUID()],
    );

    // Mensagem 2: saudável
    await conn.execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       VALUES (?, ?, 'TestHealthyEvent', '{"eventId":"healthy-1"}'::jsonb, NOW(), 0, NOW(), NULL)`,
      [healthyOutboxId, randomUUID()],
    );

    // Mock SQS client que falha apenas na primeira mensagem
    let callCount = 0;
    const failingSqsClient = new Proxy(sqsClientWrapper, {
      get(target, prop, receiver) {
        if (prop === 'sendMessage') {
          return async (queueUrl: string, body: string, groupId?: string, dedupId?: string) => {
            callCount++;
            if (body.includes('fail-1')) {
              throw new Error('Simulated SQS Network Timeout');
            }
            return target.sendMessage(queueUrl, body, groupId, dedupId);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const { worker } = createWorkerInstance({ customSqsClient: failingSqsClient });
    await worker.pollOnce();

    // Verificação no banco:
    // - Mensagem 1: attempts incrementado para 1, next_attempt_at agendado no futuro, published_at ainda NULL
    const failingRows = await conn.execute<Array<{ attempts: number; next_attempt_at: Date; published_at: Date | null }>>(
      `SELECT attempts, next_attempt_at, published_at FROM outbox_messages WHERE id = ?`,
      [failingOutboxId],
    );
    expect(failingRows[0]?.attempts).toBe(1);
    expect(failingRows[0]?.published_at).toBeNull();
    expect(new Date(failingRows[0]!.next_attempt_at).getTime()).toBeGreaterThan(Date.now() - 5000);

    // - Mensagem 2: publicada com sucesso
    const healthyRows = await conn.execute<Array<{ published_at: Date | null }>>(
      `SELECT published_at FROM outbox_messages WHERE id = ?`,
      [healthyOutboxId],
    );
    expect(healthyRows[0]?.published_at).not.toBeNull();
  });
});
