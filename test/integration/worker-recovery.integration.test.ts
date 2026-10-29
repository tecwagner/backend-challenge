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
import { SqsClient } from '../../src/infrastructure/messaging/sqs.client.js';
import { OutboxPublisherWorker } from '../../src/infrastructure/messaging/outbox-publisher.worker.js';

describe('Integration Tests: Worker Recovery After Restart (Requirements 10.4, 15.2)', () => {
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

  function createWorker(em: EntityManager = context.orm.em.fork({ useContext: true }), batchSize = 10) {
    const uow = new UnitOfWorkAdapter(em);
    const outboxRepo = new OutboxRepository(em);
    const worker = new OutboxPublisherWorker(
      sqsClientWrapper,
      uow,
      outboxRepo,
      {
        queueUrl: context.integrationEventsQueueUrl,
        pollIntervalMs: 50,
        batchSize,
        maxAttempts: 5,
      },
    );
    return { worker, em, outboxRepo };
  }

  // ===========================================================================
  // 1. Mensagem pendente inserida diretamente no banco recuperada após reinício
  // ===========================================================================
  it('Requirement 10.4: insere OutboxMessage pendente diretamente no banco e verifica publicação após reinicialização do worker', async () => {
    const conn = context.orm.em.getConnection();
    const outboxId = randomUUID();
    const eventId = `evt-recovery-${randomUUID()}`;
    const walletId = randomUUID();

    const payload = {
      eventId,
      eventType: 'WalletBalanceChanged',
      aggregateId: walletId,
      correlationId: `corr-recov-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {
        walletId,
        transactionId: randomUUID(),
        direction: 'CREDIT',
        money: { amount: '250.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '250.00', currency: 'BRL' },
        walletVersion: 1,
      },
    };

    // 1. Simula estado pós-crash ou downtime: insere evento pendente diretamente no banco (published_at = NULL)
    await conn.execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       VALUES (?, ?, 'WalletBalanceChanged', ?::jsonb, NOW(), 0, NOW(), NULL)`,
      [outboxId, walletId, JSON.stringify(payload)],
    );

    // Confirma que está pendente no banco
    const preRows = await conn.execute<Array<{ published_at: Date | null }>>(
      `SELECT published_at FROM outbox_messages WHERE id = ?`,
      [outboxId],
    );
    expect(preRows[0]?.published_at).toBeNull();

    // 2. O worker inicializa (simulando boot após reboot do container/processo)
    const { worker } = createWorker();
    const publishedCount = await worker.pollOnce();
    expect(publishedCount).toBe(1);

    // 3. Verifica que a mensagem foi marcada como publicada no banco de dados
    const postRows = await conn.execute<Array<{ published_at: Date | null }>>(
      `SELECT published_at FROM outbox_messages WHERE id = ?`,
      [outboxId],
    );
    expect(postRows[0]?.published_at).not.toBeNull();

    // 4. Verifica que a mensagem chegou intacta na fila SQS FIFO real (LocalStack)
    const sqsMessages = await sqsClientWrapper.receiveMessages(
      context.integrationEventsQueueUrl,
      10,
      2,
    );
    expect(sqsMessages.length).toBe(1);

    const receivedEvent = JSON.parse(sqsMessages[0]?.Body ?? '{}');
    expect(receivedEvent.eventId).toBe(eventId);
    expect(receivedEvent.eventType).toBe('WalletBalanceChanged');
    expect(receivedEvent.data.money.amount).toBe('250.00');
  });

  // ===========================================================================
  // 2. Lote de mensagens acumuladas durante downtime é completamente drenado
  // ===========================================================================
  it('Requirement 10.4: drena múltiplas mensagens acumuladas no banco durante período de inatividade do worker', async () => {
    const conn = context.orm.em.getConnection();
    const totalDowntimeMessages = 5;
    const eventIds: string[] = [];

    for (let i = 0; i < totalDowntimeMessages; i++) {
      const outboxId = randomUUID();
      const eventId = `evt-downtime-${i}-${randomUUID()}`;
      eventIds.push(eventId);
      const walletId = randomUUID();

      const payload = {
        eventId,
        eventType: 'WagerTransactionProcessed',
        aggregateId: walletId,
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
         VALUES (?, ?, 'WagerTransactionProcessed', ?::jsonb, NOW(), 0, NOW(), NULL)`,
        [outboxId, walletId, JSON.stringify(payload)],
      );
    }

    // Worker sobe e executa varredura
    const { worker } = createWorker(undefined, 10);
    const count = await worker.pollOnce();
    expect(count).toBe(totalDowntimeMessages);

    // Nenhuma mensagem pendente resta no banco
    const pendingRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM outbox_messages WHERE published_at IS NULL`,
    );
    expect(pendingRows.length).toBe(0);

    // Todas as mensagens foram entregues no SQS
    const sqsMessages = await sqsClientWrapper.receiveMessages(
      context.integrationEventsQueueUrl,
      10,
      2,
    );
    expect(sqsMessages.length).toBe(totalDowntimeMessages);
  });

  // ===========================================================================
  // 3. Mensagens com retry agendado prontas são recuperadas após reboot
  // ===========================================================================
  it('Requirement 10.4 & 10.7: mensagens que falharam anteriormente e atingiram next_attempt_at são publicadas após reinício', async () => {
    const conn = context.orm.em.getConnection();
    const outboxId = randomUUID();
    const eventId = `evt-retry-recovery-${randomUUID()}`;
    const walletId = randomUUID();

    const payload = {
      eventId,
      eventType: 'WagerTransactionRejected',
      aggregateId: walletId,
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {
        transactionId: randomUUID(),
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
      },
    };

    // Mensagem que tentou 1x no passado, teve next_attempt_at agendado para 10 segundos atrás (já vencido)
    await conn.execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       VALUES (?, ?, 'WagerTransactionRejected', ?::jsonb, NOW() - INTERVAL '1 minute', 1, NOW() - INTERVAL '10 seconds', NULL)`,
      [outboxId, walletId, JSON.stringify(payload)],
    );

    const { worker } = createWorker();
    const publishedCount = await worker.pollOnce();
    expect(publishedCount).toBe(1);

    const outboxRows = await conn.execute<Array<{ published_at: Date | null }>>(
      `SELECT published_at FROM outbox_messages WHERE id = ?`,
      [outboxId],
    );
    expect(outboxRows[0]?.published_at).not.toBeNull();
  });
});
