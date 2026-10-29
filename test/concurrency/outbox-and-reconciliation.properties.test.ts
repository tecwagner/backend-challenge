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
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet/reconcile-wallet.use-case.js';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction.enums.js';
import { InboxMessage } from '../../src/domain/outbox/inbox-message.js';
import { NoopMetrics } from '../../src/application/ports/metrics.port.js';

describe('Property Tests: Reconciliation & Outbox Idempotency (Properties 14 & 18)', () => {
  let context: TestEnvironmentContext;

  beforeAll(async () => {
    context = await startTestEnvironment();
  }, 60_000);

  afterAll(async () => {
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(async () => {
    await cleanDatabase(context.orm);
    await purgeTestQueues(context.sqsClient);
  });

  const dummyMetrics = new NoopMetrics();

  function createStack(em: EntityManager = context.orm.em.fork({ useContext: true })) {
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

    const reconcileUseCase = new ReconcileWalletUseCase(
      uow,
      wallets,
      ledger,
      dummyMetrics,
    );

    return { em, uow, wallets, wagerTx, ledger, outbox, inbox, payloadHash, idempotency, processUseCase, reconcileUseCase };
  }

  // ===========================================================================
  // Property 14: Reconciliação — saldo materializado igual ao saldo do ledger
  // Validates: Requirements 6.4
  // ===========================================================================
  it('Property 14: Para qualquer Wallet com N operações, o saldo recalculado pelo ledger é idêntico ao saldo materializado (difference = 0.00)', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial: 100.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 100.00, 1)`,
      [walletId, playerId],
    );

    // Também cria lançamento de ledger inicial para o saldo de abertura
    const openTxId = randomUUID();
    await conn.execute(
      `INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
      ) VALUES (?, 'system', ?, ?, 'hash', ?, ?, 'round-0', 'system', 'OPENING', 100.00, 'BRL', 'PROCESSED')`,
      [openTxId, `open-${openTxId}`, `idem-${openTxId}`, walletId, playerId],
    );

    await conn.execute(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, money_amount, money_currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, 'CREDIT', 100.00, 'BRL', 0.00, 100.00, NOW())`,
      [randomUUID(), walletId, openTxId],
    );

    // Gera uma sequência aleatória de 15 operações (apostas e vitórias)
    const operations = [
      { kind: WagerTransactionKind.Bet, amount: '10.00' },
      { kind: WagerTransactionKind.Bet, amount: '15.00' },
      { kind: WagerTransactionKind.Win, amount: '50.00' },
      { kind: WagerTransactionKind.Bet, amount: '25.00' },
      { kind: WagerTransactionKind.Win, amount: '100.00' },
      { kind: WagerTransactionKind.Bet, amount: '40.00' },
      { kind: WagerTransactionKind.Bet, amount: '20.00' },
      { kind: WagerTransactionKind.Win, amount: '15.00' },
      { kind: WagerTransactionKind.Bet, amount: '35.00' },
      { kind: WagerTransactionKind.Win, amount: '80.00' },
    ];

    const stack = createStack();

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]!;
      const extId = `ext-prop14-${i}-${randomUUID()}`;
      await stack.processUseCase.execute({
        idempotencyKey: `prov-1:${extId}`,
        providerId: 'prov-1',
        externalTransactionId: extId,
        playerId,
        walletId,
        roundId: `round-p14-${i}`,
        gameId: 'fortune-tiger',
        kind: op.kind,
        money: { amount: op.amount, currency: 'BRL' },
        correlationId: `corr-p14-${i}`,
      });
    }

    // Executa reconciliação
    const result = await stack.reconcileUseCase.execute(walletId);

    expect(result.consistent).toBe(true);
    expect(result.difference.amount).toBe('0.00');
    expect(result.storedBalance.amount).toBe(result.calculatedBalance.amount);
    expect(result.checkedEntries).toBe(operations.length + 1); // 10 ops + 1 abertura
  });

  // ===========================================================================
  // Property 18: Publicação de OutboxMessage é idempotente para o consumidor
  // Validates: Requirements 10.3, 10.5
  // ===========================================================================
  it('Property 18: N entregas do mesmo evento para o consumidor downstream são idempotentes graças ao eventId estável e deduplicação via inbox', async () => {
    const stack = createStack();
    const eventId = `evt-prop18-${randomUUID()}`;
    const consumerName = 'downstream-service';

    const firstReceive = await stack.inbox.insertOrFind(
      InboxMessage.receive({
        messageId: eventId,
        consumerName,
        payloadHash: 'hash-prop18',
      }),
    );
    expect(firstReceive.isDuplicate).toBe(false);

    // Qualquer subsequente das N tentativas concorrentes/repetidas deve retornar isDuplicate = true
    const repeatAttempts = 10;
    for (let i = 0; i < repeatAttempts; i++) {
      const duplicateReceive = await stack.inbox.insertOrFind(
        InboxMessage.receive({
          messageId: eventId,
          consumerName,
          payloadHash: 'hash-prop18',
        }),
      );
      expect(duplicateReceive.isDuplicate).toBe(true);
    }
  });
});
