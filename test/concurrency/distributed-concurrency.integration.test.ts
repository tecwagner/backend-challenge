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
import { WalletRepository } from '../../src/infrastructure/persistence/repositories/wallet.repository.js';
import { WagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/wager-transaction.repository.js';
import { LedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { OutboxRepository } from '../../src/infrastructure/persistence/repositories/outbox.repository.js';
import { InboxRepository } from '../../src/infrastructure/persistence/repositories/inbox.repository.js';
import { PayloadHashService } from '../../src/application/services/payload-hash.service.js';
import { IdempotencyService } from '../../src/application/services/idempotency.service.js';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction/process-wager-transaction.use-case.js';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/reprocess-pending-references/reprocess-pending-references.use-case.js';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../../src/domain/wager-transaction/failure-codes.js';
import { SqsClient } from '../../src/infrastructure/messaging/sqs.client.js';
import { SqsConsumerService } from '../../src/infrastructure/messaging/sqs-consumer.service.js';
import { OutboxPublisherWorker } from '../../src/infrastructure/messaging/outbox-publisher.worker.js';
import { Decimal } from 'decimal.js';

describe('Concurrency Tests: Distributed Instances, Crashes & Asynchronous Ordering (Requirements 7.4, 8.1, 8.2, 9.3, 9.8, 10.3, 15.3, 15.4)', () => {
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

  function createApplicationInstance(em: EntityManager = context.orm.em.fork({ useContext: true })) {
    const uow = new UnitOfWorkAdapter(em);
    const wallets = new WalletRepository(em);
    const wagerTx = new WagerTransactionRepository(em);
    const ledger = new LedgerRepository(em);
    const outbox = new OutboxRepository(em);
    const inbox = new InboxRepository(em);
    const payloadHash = new PayloadHashService();
    const idempotency = new IdempotencyService();

    const processUseCase = new ProcessWagerTransactionUseCase(
      uow,
      wallets,
      wagerTx,
      ledger,
      outbox,
      payloadHash,
      idempotency,
    );

    const reprocessPendingUseCase = new ReprocessPendingReferencesUseCase(
      uow,
      wallets,
      wagerTx,
      ledger,
      outbox,
    );

    const consumer = new SqsConsumerService(
      sqsClientWrapper,
      uow,
      inbox,
      processUseCase,
      payloadHash,
      {
        queueUrl: context.queueUrl,
        consumerName: 'wagering-processor',
        maxMessages: 10,
        waitTimeSeconds: 1,
      },
    );

    const outboxWorker = new OutboxPublisherWorker(
      sqsClientWrapper,
      uow,
      outbox,
      {
        queueUrl: context.integrationEventsQueueUrl,
        pollIntervalMs: 50,
        batchSize: 10,
        maxAttempts: 5,
      },
    );

    return {
      em,
      uow,
      wallets,
      wagerTx,
      ledger,
      outbox,
      inbox,
      payloadHash,
      idempotency,
      processUseCase,
      reprocessPendingUseCase,
      consumer,
      outboxWorker,
    };
  }

  // ===========================================================================
  // 18.5: ≥ 3 instâncias da aplicação simultâneas disputando a mesma wallet
  // ===========================================================================
  it('Requirement 7.4 & 15.4: 3 instâncias concorrentes enviam lote de 15 apostas de 20 BRL para carteira de 200 BRL (10 aceitas, 5 rejeitadas)', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial de 200.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 200.00, 1)`,
      [walletId, playerId],
    );

    // 3 instâncias independentes da aplicação
    const instanceA = createApplicationInstance();
    const instanceB = createApplicationInstance();
    const instanceC = createApplicationInstance();
    const instances = [instanceA, instanceB, instanceC];

    const totalRequests = 15;
    const betAmount = '20.00';

    // 15 apostas com IDs externos distintos distribuídas entre as 3 instâncias em paralelo
    const promises = Array.from({ length: totalRequests }, (_, idx) => {
      const app = instances[idx % instances.length]!;
      const extId = `ext-multi-inst-${idx}-${randomUUID()}`;
      return app.processUseCase.execute({
        idempotencyKey: `prov-1:${extId}`,
        providerId: 'prov-1',
        externalTransactionId: extId,
        playerId,
        walletId,
        roundId: `round-multi-inst-${idx}`,
        gameId: 'fortune-tiger',
        kind: WagerTransactionKind.Bet,
        money: { amount: betAmount, currency: 'BRL' },
        correlationId: `corr-multi-inst-${idx}`,
      });
    });

    const results = await Promise.all(promises);

    const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
    const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected);

    // Com saldo 200.00 e apostas de 20.00, exatamente 10 devem ser processadas e 5 rejeitadas
    expect(processed.length).toBe(10);
    expect(rejected.length).toBe(5);

    for (const rej of rejected) {
      expect(rej.failureCode).toBe(FailureCode.BalanceInsufficient);
      expect(rej.balance.amount).toBe('0.00');
    }

    // Verificação do saldo final e da versão da carteira no PostgreSQL
    const walletRows = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows[0]?.balance_amount).toBe('0.00');
    expect(walletRows[0]?.version).toBe(11); // version inicial 1 + 10 débitos

    // Verificação do ledger: exatamente 10 lançamentos de débito
    const ledgerRows = await conn.execute<Array<{ direction: string; money_amount: string }>>(
      `SELECT direction, money_amount FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows.length).toBe(10);

    // Invariante de Ledger (Requirement 15.4):
    // 200.00 inicial - (10 * 20.00) = 0.00
    let balanceReconstructed = new Decimal('200.00');
    for (const entry of ledgerRows) {
      balanceReconstructed = balanceReconstructed.minus(entry.money_amount);
    }
    expect(balanceReconstructed.toFixed(2)).toBe('0.00');
    expect(balanceReconstructed.toFixed(2)).toBe(walletRows[0]!.balance_amount);
  });

  // ===========================================================================
  // 18.6: Consumer morto após commit e antes do ack SQS
  // ===========================================================================
  it('Requirement 9.3 & 9.8: simula falha do consumer após COMMIT antes do deleteMessage; re-entrega é detectada no inbox com zero efeito financeiro', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial: 500.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 500.00, 1)`,
      [walletId, playerId],
    );

    const messageId = `msg-crash-ack-${randomUUID()}`;
    const externalTransactionId = `ext-crash-ack-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;

    const payload = {
      messageId,
      correlationId: `corr-crash-ack`,
      data: {
        idempotencyKey,
        providerId: 'prov-1',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-crash-ack-1',
        gameId: 'sweet-bonanza',
        kind: WagerTransactionKind.Bet,
        money: { amount: '100.00', currency: 'BRL' },
      },
    };

    // 1. Envia mensagem para o SQS
    await sqsClientWrapper.sendMessage(
      context.queueUrl,
      JSON.stringify(payload),
      {
        messageGroupId: walletId,
        messageDeduplicationId: `dedup-crash-ack-${randomUUID()}`,
      },
    );

    // 2. Instância 1 consome, comita no banco, mas "morre" no momento do ack
    const failingSqsClient = new Proxy(sqsClientWrapper, {
      get(target, prop, receiver) {
        if (prop === 'deleteMessage') {
          return async () => {
            throw new Error('CRASH_SIMULATION_BEFORE_SQS_DELETE_MESSAGE');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const em1 = context.orm.em.fork({ useContext: true });
    const app1 = createApplicationInstance(em1);
    const consumer1 = new SqsConsumerService(
      failingSqsClient,
      app1.uow,
      app1.inbox,
      app1.processUseCase,
      app1.payloadHash,
      {
        queueUrl: context.queueUrl,
        consumerName: 'wagering-processor',
        maxMessages: 1,
        waitTimeSeconds: 1,
      },
    );

    // O pollOnce processará a transação, comitará SQL e falhará apenas no deleteMessage
    await consumer1.pollOnce();

    // Verificação após o crash: a transação foi comitada no banco
    const walletRows1 = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows1[0]?.balance_amount).toBe('400.00');
    expect(walletRows1[0]?.version).toBe(2);

    // 3. A mensagem continua na fila (ou é reenviada). Uma nova instância saudável consome a mensagem re-entregue
    const app2 = createApplicationInstance();
    await app2.consumer.pollOnce();

    // 4. Verificações de ZERO EFEITO FINANCEIRO DUPLICADO:
    const walletRows2 = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows2[0]?.balance_amount).toBe('400.00');
    expect(walletRows2[0]?.version).toBe(2);

    const ledgerRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows.length).toBe(1);

    // Fila SQS agora está limpa (a duplicata foi deletada pela 2ª instância)
    const remainingSqs = await sqsClientWrapper.receiveMessages(context.queueUrl, 1, 1, 0);
    expect(remainingSqs.length).toBe(0);
  });

  // ===========================================================================
  // 18.7: Dois publishers concorrentes sobre a mesma outbox
  // ===========================================================================
  it('Requirement 10.3 & 15.3: dois Outbox Workers concorrentes drenam 20 mensagens com SKIP LOCKED sem publicar duplicatas permanentes', async () => {
    const conn = context.orm.em.getConnection();
    const totalOutboxMessages = 20;
    const eventIds: string[] = [];

    for (let i = 0; i < totalOutboxMessages; i++) {
      const outboxId = randomUUID();
      const eventId = `evt-stream-${i}-${randomUUID()}`;
      eventIds.push(eventId);
      const walletId = randomUUID();

      const payload = {
        eventId,
        eventType: 'WalletBalanceChanged',
        aggregateId: walletId,
        version: 1,
        occurredAt: new Date().toISOString(),
        data: { walletId, amount: '10.00' },
      };

      await conn.execute(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
         VALUES (?, ?, 'WalletBalanceChanged', ?::jsonb, NOW(), 0, NOW(), NULL)`,
        [outboxId, walletId, JSON.stringify(payload)],
      );
    }

    const app1 = createApplicationInstance();
    const app2 = createApplicationInstance();

    // Executa varreduras simultâneas até que todas as mensagens sejam processadas
    let remainingPending = totalOutboxMessages;
    while (remainingPending > 0) {
      await Promise.all([
        app1.outboxWorker.pollOnce(),
        app2.outboxWorker.pollOnce(),
      ]);

      const countRows = await conn.execute<Array<{ count: string | number }>>(
        `SELECT COUNT(*) as count FROM outbox_messages WHERE published_at IS NULL`,
      );
      remainingPending = Number(countRows[0]?.count ?? 0);
    }

    // Todas foram marcadas como publicadas no banco
    const pendingRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM outbox_messages WHERE published_at IS NULL`,
    );
    expect(pendingRows.length).toBe(0);

    // No SQS: exatamente 20 mensagens recebidas
    const receivedMessages: string[] = [];
    while (receivedMessages.length < totalOutboxMessages) {
      const batch = await sqsClientWrapper.receiveMessages(
        context.integrationEventsQueueUrl,
        10,
        2,
      );
      if (batch.length === 0) break;
      for (const msg of batch) {
        const parsed = JSON.parse(msg.Body ?? '{}');
        receivedMessages.push(parsed.eventId);
        if (msg.ReceiptHandle) {
          await sqsClientWrapper.deleteMessage(context.integrationEventsQueueUrl, msg.ReceiptHandle);
        }
      }
    }

    expect(receivedMessages.length).toBe(totalOutboxMessages);
    expect(new Set(receivedMessages).size).toBe(totalOutboxMessages);
  });

  // ===========================================================================
  // 18.8: REFUND entregue antes da BET de referência (Assincronismo e Reprocessamento)
  // ===========================================================================
  it('Requirement 8.1, 8.2 & 15.3: REFUND entregue antes da BET vira PENDING_REFERENCE e transiciona para PROCESSED com crédito único após reprocessamento', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial: 500.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 500.00, 1)`,
      [walletId, playerId],
    );

    const app = createApplicationInstance();

    const originalBetExtId = `bet-ref-orig-${randomUUID()}`;
    const refundExtId = `refund-early-${randomUUID()}`;

    // 1. REFUND chega PRIMEIRO (antes da BET)
    const refundResult = await app.processUseCase.execute({
      idempotencyKey: `prov-1:${refundExtId}`,
      providerId: 'prov-1',
      externalTransactionId: refundExtId,
      playerId,
      walletId,
      roundId: 'round-ref-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: originalBetExtId,
      money: { amount: '100.00', currency: 'BRL' },
      correlationId: `corr-refund-1`,
    });

    // O REFUND é aceito mas fica PENDING_REFERENCE, saldo NÃO é alterado
    expect(refundResult.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refundResult.balance.amount).toBe('500.00');

    const walletAfterEarlyRefund = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletAfterEarlyRefund[0]?.balance_amount).toBe('500.00');
    expect(walletAfterEarlyRefund[0]?.version).toBe(1);

    // Nenhum ledger entry foi gerado para o REFUND ainda
    const ledgerAfterEarlyRefund = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerAfterEarlyRefund.length).toBe(0);

    // 2. A BET original chega depois e é processada
    const betResult = await app.processUseCase.execute({
      idempotencyKey: `prov-1:${originalBetExtId}`,
      providerId: 'prov-1',
      externalTransactionId: originalBetExtId,
      playerId,
      walletId,
      roundId: 'round-ref-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Bet,
      money: { amount: '100.00', currency: 'BRL' },
      correlationId: `corr-bet-orig`,
    });

    expect(betResult.status).toBe(WagerTransactionStatus.Processed);
    expect(betResult.balance.amount).toBe('400.00');

    // 3. Executa o reprocessamento de referências pendentes
    const reprocessResult = await app.reprocessPendingUseCase.execute();
    expect(reprocessResult.processed).toBe(1);
    expect(reprocessResult.rejected).toBe(0);

    // 4. Verificação final: o REFUND transicionou para PROCESSED
    const refundTxRows = await conn.execute<Array<{ status: string }>>(
      `SELECT status FROM wager_transactions WHERE external_transaction_id = ?`,
      [refundExtId],
    );
    expect(refundTxRows[0]?.status).toBe(WagerTransactionStatus.Processed);

    // Saldo restaurado para 500.00 (500 - 100 BET + 100 REFUND = 500)
    const finalWallet = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(finalWallet[0]?.balance_amount).toBe('500.00');
    expect(finalWallet[0]?.version).toBe(3); // 1 inicial + 1 BET + 1 REFUND

    // Verificação do ledger: exatamente 2 lançamentos (1 DEBIT de 100, 1 CREDIT de 100)
    const finalLedger = await conn.execute<Array<{ direction: string; money_amount: string }>>(
      `SELECT direction, money_amount FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY created_at ASC, id ASC`,
      [walletId],
    );
    expect(finalLedger.length).toBe(2);
    expect(finalLedger[0]?.direction).toBe('DEBIT');
    expect(finalLedger[0]?.money_amount).toBe('100.00');
    expect(finalLedger[1]?.direction).toBe('CREDIT');
    expect(finalLedger[1]?.money_amount).toBe('100.00');

    // Invariante de Ledger (Requirement 15.4):
    // 500 inicial - 100 BET + 100 REFUND = 500 final
    let runningBalance = new Decimal('500.00');
    for (const entry of finalLedger) {
      if (entry.direction === 'DEBIT') {
        runningBalance = runningBalance.minus(entry.money_amount);
      } else {
        runningBalance = runningBalance.plus(entry.money_amount);
      }
    }
    expect(runningBalance.toFixed(2)).toBe('500.00');
    expect(runningBalance.toFixed(2)).toBe(finalWallet[0]!.balance_amount);
  });
});
