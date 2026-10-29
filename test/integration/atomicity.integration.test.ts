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
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../../src/domain/wager-transaction/failure-codes.js';
import { InboxMessage } from '../../src/domain/outbox/inbox-message.js';
import { SqsClient } from '../../src/infrastructure/messaging/sqs.client.js';
import { OutboxPublisherWorker } from '../../src/infrastructure/messaging/outbox-publisher.worker.js';

describe('Integration Tests: Atomicity (Wallet / Ledger / Inbox / Outbox) & Worker Crash Recovery', () => {
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

  function createTransactionalStack(em: EntityManager) {
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

    return { uow, wallets, wagerTx, ledger, outbox, inbox, payloadHash, processUseCase };
  }

  // ===========================================================================
  // 1. Commit Atômico (Requirement 10.1, 15.2)
  // ===========================================================================
  it('Requirement 10.1: persiste Wallet + Ledger + WagerTransaction + Inbox + Outbox na MESMA transação SQL', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Cria carteira inicial com 1000.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 1000.00, 1)`,
      [walletId, playerId],
    );

    const em = context.orm.em.fork({ useContext: true });
    const stack = createTransactionalStack(em);

    const messageId = `msg-atomicity-${randomUUID()}`;
    const consumerName = 'wagering-processor';
    const externalTransactionId = `ext-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;

    const command = {
      idempotencyKey,
      providerId: 'prov-1',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-atomicity-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Bet,
      money: { amount: '250.00', currency: 'BRL' },
      correlationId: `corr-${randomUUID()}`,
    };

    const payloadHash = stack.payloadHash.compute(command);

    // Executa tudo dentro de UoW.transactional
    await stack.uow.transactional(async () => {
      const inbox = InboxMessage.receive({ messageId, consumerName, payloadHash });
      const { isDuplicate } = await stack.inbox.insertOrFind(inbox);
      expect(isDuplicate).toBe(false);

      const result = await stack.processUseCase.execute(command);
      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance).toEqual({ amount: '750.00', currency: 'BRL' });

      inbox.markProcessed(new Date());
      await stack.inbox.markProcessed(inbox);
    });

    // -------------------------------------------------------------------------
    // Verificação de atomicidade em todas as tabelas após COMMIT
    // -------------------------------------------------------------------------

    // 1. Wallets: saldo atualizado de 1000.00 -> 750.00 e versão incrementada para 2
    const walletRows = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows.length).toBe(1);
    expect(walletRows[0]?.balance_amount).toBe('750.00');
    expect(walletRows[0]?.version).toBe(2);

    // 2. Wager Transactions: 1 registro PROCESSED
    const txRows = await conn.execute<Array<{ status: string; money_amount: string; kind: string }>>(
      `SELECT status, money_amount, kind FROM wager_transactions WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
    expect(txRows.length).toBe(1);
    expect(txRows[0]?.status).toBe('PROCESSED');
    expect(txRows[0]?.kind).toBe('BET');
    expect(txRows[0]?.money_amount).toBe('250.00');

    // 3. Wallet Ledger Entries: 1 registro DEBIT com auditoria de saldo antes/depois
    const ledgerRows = await conn.execute<
      Array<{ direction: string; money_amount: string; balance_before: string; balance_after: string }>
    >(
      `SELECT direction, money_amount, balance_before, balance_after FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0]?.direction).toBe('DEBIT');
    expect(ledgerRows[0]?.money_amount).toBe('250.00');
    expect(ledgerRows[0]?.balance_before).toBe('1000.00');
    expect(ledgerRows[0]?.balance_after).toBe('750.00');

    // 4. Inbox Messages: 1 registro com processed_at preenchido
    const inboxRows = await conn.execute<Array<{ processed_at: Date | null }>>(
      `SELECT processed_at FROM inbox_messages WHERE message_id = ? AND consumer_name = ?`,
      [messageId, consumerName],
    );
    expect(inboxRows.length).toBe(1);
    expect(inboxRows[0]?.processed_at).not.toBeNull();

    // 5. Outbox Messages: 2 eventos gerados (WalletBalanceChanged, WagerTransactionProcessed)
    const outboxRows = await conn.execute<Array<{ event_type: string; published_at: Date | null }>>(
      `SELECT event_type, published_at FROM outbox_messages WHERE aggregate_id = ? ORDER BY event_type ASC`,
      [walletId],
    );
    expect(outboxRows.length).toBe(2);
    expect(outboxRows.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(outboxRows[0]?.published_at).toBeNull();
    expect(outboxRows[1]?.published_at).toBeNull();
  });

  // ===========================================================================
  // 2. Rollback Atômico (Requirement 10.1, 15.2)
  // ===========================================================================
  it('Requirement 10.1: falha na transação reverte TODOS os registros (Wallet, Ledger, Tx, Inbox, Outbox)', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial: 500.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 500.00, 1)`,
      [walletId, playerId],
    );

    const em = context.orm.em.fork({ useContext: true });
    const stack = createTransactionalStack(em);

    const messageId = `msg-rollback-${randomUUID()}`;
    const consumerName = 'wagering-processor';
    const externalTransactionId = `ext-rollback-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;

    const command = {
      idempotencyKey,
      providerId: 'prov-1',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-fail-1',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Bet,
      money: { amount: '100.00', currency: 'BRL' },
      correlationId: `corr-${randomUUID()}`,
    };

    const payloadHash = stack.payloadHash.compute(command);

    // Executa e força erro antes do commit
    let caughtError: any;
    try {
      await stack.uow.transactional(async () => {
        const inbox = InboxMessage.receive({ messageId, consumerName, payloadHash });
        await stack.inbox.insertOrFind(inbox);

        await stack.processUseCase.execute(command);

        inbox.markProcessed(new Date());
        await stack.inbox.markProcessed(inbox);

        // Simula falha catastrófica antes do commit (ex: crash ou exceção de negócio)
        throw new Error('SIMULATED_UNHANDLED_EXCEPTION_BEFORE_COMMIT');
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError.message).toBe('SIMULATED_UNHANDLED_EXCEPTION_BEFORE_COMMIT');

    // -------------------------------------------------------------------------
    // Verificação de Rollback Completo no Banco
    // -------------------------------------------------------------------------

    // 1. Wallets: saldo e versão permanecem estritamente intactos
    const walletRows = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows[0]?.balance_amount).toBe('500.00');
    expect(walletRows[0]?.version).toBe(1);

    // 2. Wager Transactions: nenhum registro inserido
    const txRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wager_transactions WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
    expect(txRows.length).toBe(0);

    // 3. Wallet Ledger Entries: nenhuma entrada inserida
    const ledgerRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows.length).toBe(0);

    // 4. Inbox Messages: nenhuma mensagem persistida
    const inboxRows = await conn.execute<Array<{ message_id: string }>>(
      `SELECT message_id FROM inbox_messages WHERE message_id = ?`,
      [messageId],
    );
    expect(inboxRows.length).toBe(0);

    // 5. Outbox Messages: nenhum evento enfileirado
    const outboxRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM outbox_messages WHERE aggregate_id = ?`,
      [walletId],
    );
    expect(outboxRows.length).toBe(0);
  });

  // ===========================================================================
  // 3. Simulação de Crash do Processo & Recuperação pelo Outbox Worker (Requirement 10.4)
  // ===========================================================================
  it('Requirement 10.4: simula encerramento do processo após commit SQL e garante que nova instância do Outbox Worker recupera e publica para o SQS', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 800.00, 1)`,
      [walletId, playerId],
    );

    // Etapa 1: Instância original processa transação e commita SQL
    const emOriginal = context.orm.em.fork({ useContext: true });
    const stackOriginal = createTransactionalStack(emOriginal);

    const externalTransactionId = `ext-crash-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;

    await stackOriginal.uow.transactional(async () => {
      await stackOriginal.processUseCase.execute({
        idempotencyKey,
        providerId: 'prov-1',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-crash-1',
        gameId: 'fortune-tiger',
        kind: WagerTransactionKind.Win,
        money: { amount: '200.00', currency: 'BRL' },
        correlationId: `corr-crash-${randomUUID()}`,
      });
    });

    // Simula encerramento imediato do processo original (process.exit / crash)
    // Nenhuma mensagem foi publicada ainda; elas estão no banco com published_at = NULL
    const pendingOutboxRows = await conn.execute<Array<{ id: string; published_at: Date | null }>>(
      `SELECT id, published_at FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NULL`,
      [walletId],
    );
    expect(pendingOutboxRows.length).toBe(2);

    // Etapa 2: Nova instância do worker entra em ação (novo processo independente)
    const emNewInstance = context.orm.em.fork({ useContext: true });
    const newWorker = new OutboxPublisherWorker(
      sqsClientWrapper,
      new UnitOfWorkAdapter(emNewInstance),
      new OutboxRepository(emNewInstance),
      {
        queueUrl: context.integrationEventsQueueUrl,
        pollIntervalMs: 50,
        batchSize: 10,
        maxAttempts: 5,
      },
    );

    // Executa a varredura do novo worker
    const publishedCount = await newWorker.pollOnce();
    expect(publishedCount).toBe(2);

    // Etapa 3: Verifica que no banco todas as mensagens foram marcadas como publicadas
    const updatedOutboxRows = await conn.execute<Array<{ id: string; published_at: Date | null }>>(
      `SELECT id, published_at FROM outbox_messages WHERE aggregate_id = ?`,
      [walletId],
    );
    expect(updatedOutboxRows.length).toBe(2);
    expect(updatedOutboxRows[0]?.published_at).not.toBeNull();
    expect(updatedOutboxRows[1]?.published_at).not.toBeNull();

    // Etapa 4: Verifica que as mensagens chegaram com sucesso na fila SQS FIFO do LocalStack
    const sqsMessages = await sqsClientWrapper.receiveMessages(
      context.integrationEventsQueueUrl,
      10,
      5,
    );
    expect(sqsMessages.length).toBe(2);

    const receivedEventTypes = sqsMessages.map((m) => {
      const parsed = JSON.parse(m.Body ?? '{}');
      return parsed.eventType;
    });

    expect(receivedEventTypes).toContain('WalletBalanceChanged');
    expect(receivedEventTypes).toContain('WagerTransactionProcessed');

    // Limpa a fila após verificação
    for (const msg of sqsMessages) {
      if (msg.ReceiptHandle) {
        await sqsClientWrapper.deleteMessage(context.integrationEventsQueueUrl, msg.ReceiptHandle);
      }
    }
  });

  // ===========================================================================
  // 4. Rejeição Negocial Atômica com Outbox (Requirement 10.1, 10.2)
  // ===========================================================================
  it('Requirement 10.1 & 10.2: transação rejeitada por saldo insuficiente persiste REJECTED + Outbox WagerTransactionRejected atomicamente', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo: 100.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 100.00, 1)`,
      [walletId, playerId],
    );

    const em = context.orm.em.fork({ useContext: true });
    const stack = createTransactionalStack(em);

    const externalTransactionId = `ext-insufficient-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;

    // Aposta de 500.00 BRL (maior que o saldo de 100.00)
    await stack.uow.transactional(async () => {
      const result = await stack.processUseCase.execute({
        idempotencyKey,
        providerId: 'prov-1',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-rej-1',
        gameId: 'fortune-tiger',
        kind: WagerTransactionKind.Bet,
        money: { amount: '500.00', currency: 'BRL' },
        correlationId: `corr-rej-${randomUUID()}`,
      });

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.BalanceInsufficient);
      expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    });

    // 1. Wallets: saldo não foi alterado
    const walletRows = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows[0]?.balance_amount).toBe('100.00');

    // 2. Wager Transactions: registrada como REJECTED
    const txRows = await conn.execute<Array<{ status: string; failure_code: string }>>(
      `SELECT status, failure_code FROM wager_transactions WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
    expect(txRows.length).toBe(1);
    expect(txRows[0]?.status).toBe('REJECTED');
    expect(txRows[0]?.failure_code).toBe(FailureCode.BalanceInsufficient);

    // 3. Wallet Ledger: zero lançamentos criados
    const ledgerRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows.length).toBe(0);

    // 4. Outbox: exatamente 1 evento WagerTransactionRejected
    const outboxRows = await conn.execute<Array<{ event_type: string }>>(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = ?`,
      [walletId],
    );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0]?.event_type).toBe('WagerTransactionRejected');
  });
});
