import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'crypto';
import type { EntityManager } from '@mikro-orm/core';
import {
  startTestEnvironment,
  stopTestEnvironment,
  cleanDatabase,
  type TestEnvironmentContext,
} from './setup.js';
import { UnitOfWorkAdapter } from '../../src/infrastructure/persistence/unit-of-work.adapter.js';
import { WalletRepository } from '../../src/infrastructure/persistence/repositories/wallet.repository.js';
import { WagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/wager-transaction.repository.js';
import { LedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { OutboxRepository } from '../../src/infrastructure/persistence/repositories/outbox.repository.js';
import { PayloadHashService } from '../../src/application/services/payload-hash.service.js';
import { IdempotencyService } from '../../src/application/services/idempotency.service.js';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction/process-wager-transaction.use-case.js';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../../src/domain/wager-transaction/failure-codes.js';
import { Decimal } from 'decimal.js';

describe('Concurrency Tests: Real Parallelism with PostgreSQL (Requirements 7.3, 7.4, 7.5, 15.3, 15.4)', () => {
  let context: TestEnvironmentContext;

  beforeAll(async () => {
    context = await startTestEnvironment();
  }, 60_000);

  afterAll(async () => {
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(async () => {
    await cleanDatabase(context.orm);
  });

  function createUseCase(em: EntityManager = context.orm.em.fork({ useContext: true })) {
    const uow = new UnitOfWorkAdapter(em);
    const wallets = new WalletRepository(em);
    const wagerTx = new WagerTransactionRepository(em);
    const ledger = new LedgerRepository(em);
    const outbox = new OutboxRepository(em);
    const payloadHash = new PayloadHashService();
    const idempotency = new IdempotencyService();

    return new ProcessWagerTransactionUseCase(
      uow,
      wallets,
      wagerTx,
      ledger,
      outbox,
      payloadHash,
      idempotency,
    );
  }

  // ===========================================================================
  // 18.2: 50 envios paralelos da mesma aposta resultam em 1 débito
  // ===========================================================================
  it('Requirement 7.3 & 15.4: 50 envios paralelos da MESMA aposta resultam em exatamente 1 débito e 49 replays idempotentes', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial: 1000.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 1000.00, 1)`,
      [walletId, playerId],
    );

    const externalTransactionId = `ext-conc-50-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;

    const command = {
      idempotencyKey,
      providerId: 'prov-1',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-conc-50',
      gameId: 'fortune-tiger',
      kind: WagerTransactionKind.Bet,
      money: { amount: '100.00', currency: 'BRL' },
      correlationId: `corr-50-${randomUUID()}`,
    };

    // Dispara 50 execuções concorrentes com conexões/EntityManagers independentes
    const concurrentCount = 50;
    const promises = Array.from({ length: concurrentCount }, () => {
      const useCase = createUseCase();
      return useCase.execute(command);
    });

    const results = await Promise.all(promises);

    // 1. Todas as 50 chamadas devem ter sido respondidas com sucesso
    expect(results.length).toBe(concurrentCount);
    for (const res of results) {
      expect(res.status).toBe(WagerTransactionStatus.Processed);
      expect(res.balance).toEqual({ amount: '900.00', currency: 'BRL' });
    }

    // 2. Exatamente 1 deve ser a execução original e 49 devem ser idempotentReplay
    const originalExecutions = results.filter((r) => !r.idempotentReplay);
    const replayExecutions = results.filter((r) => r.idempotentReplay);

    expect(originalExecutions.length).toBe(1);
    expect(replayExecutions.length).toBe(concurrentCount - 1);

    // 3. Verificação no banco de dados PostgreSQL
    const walletRows = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows[0]?.balance_amount).toBe('900.00');
    expect(walletRows[0]?.version).toBe(2);

    // Exatamente 1 transação registrada
    const txRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wager_transactions WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
    expect(txRows.length).toBe(1);

    // Exatamente 1 lançamento no ledger
    const ledgerRows = await conn.execute<Array<{ direction: string; money_amount: string }>>(
      `SELECT direction, money_amount FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0]?.direction).toBe('DEBIT');
    expect(ledgerRows[0]?.money_amount).toBe('100.00');

    // 4. Invariante de Ledger (Requirement 15.4):
    // Saldo inicial (1000.00) - Débito (100.00) = Saldo materializado (900.00)
    let reconstructedBalance = new Decimal('1000.00');
    for (const entry of ledgerRows) {
      if (entry.direction === 'DEBIT') {
        reconstructedBalance = reconstructedBalance.minus(entry.money_amount);
      } else {
        reconstructedBalance = reconstructedBalance.plus(entry.money_amount);
      }
    }
    expect(reconstructedBalance.toFixed(2)).toBe(walletRows[0]!.balance_amount);
  }, 30_000);

  // ===========================================================================
  // 18.3: Duas apostas de 80 BRL sobre saldo de 100 BRL (Cenário Seção 8 do README)
  // ===========================================================================
  it('Requirement 7.3 & 15.4: duas apostas de 80.00 BRL concorrentes sobre saldo de 100.00 BRL resultam em 1 PROCESSED e 1 REJECTED (INSUFFICIENT_FUNDS)', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial: exatamente 100.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 100.00, 1)`,
      [walletId, playerId],
    );

    const ext1 = `ext-race-1-${randomUUID()}`;
    const ext2 = `ext-race-2-${randomUUID()}`;

    const cmd1 = {
      idempotencyKey: `prov-1:${ext1}`,
      providerId: 'prov-1',
      externalTransactionId: ext1,
      playerId,
      walletId,
      roundId: 'round-race-1',
      gameId: 'gates-of-olympus',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
      correlationId: `corr-race-1`,
    };

    const cmd2 = {
      idempotencyKey: `prov-1:${ext2}`,
      providerId: 'prov-1',
      externalTransactionId: ext2,
      playerId,
      walletId,
      roundId: 'round-race-2',
      gameId: 'gates-of-olympus',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
      correlationId: `corr-race-2`,
    };

    // Dispara ambas simultaneamente
    const useCase1 = createUseCase();
    const useCase2 = createUseCase();

    const [res1, res2] = await Promise.all([
      useCase1.execute(cmd1),
      useCase2.execute(cmd2),
    ]);

    const results = [res1, res2];
    const processed = results.find((r) => r.status === WagerTransactionStatus.Processed);
    const rejected = results.find((r) => r.status === WagerTransactionStatus.Rejected);

    // 1. Exatamente 1 deve ser PROCESSED e 1 deve ser REJECTED
    expect(processed).toBeDefined();
    expect(rejected).toBeDefined();

    expect(processed?.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(rejected?.failureCode).toBe(FailureCode.BalanceInsufficient);
    expect(rejected?.balance).toEqual({ amount: '20.00', currency: 'BRL' });

    // 2. Verificação no banco de dados
    const walletRows = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows[0]?.balance_amount).toBe('20.00');
    expect(walletRows[0]?.version).toBe(2);

    // Exatamente 1 entrada no ledger de 80.00
    const ledgerRows = await conn.execute<Array<{ direction: string; money_amount: string; balance_after: string }>>(
      `SELECT direction, money_amount, balance_after FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0]?.direction).toBe('DEBIT');
    expect(ledgerRows[0]?.money_amount).toBe('80.00');
    expect(ledgerRows[0]?.balance_after).toBe('20.00');

    // 3. Invariante final de Ledger:
    // Saldo inicial (100.00) - Débito (80.00) = Saldo atual (20.00)
    let reconstructedBalance = new Decimal('100.00');
    for (const entry of ledgerRows) {
      if (entry.direction === 'DEBIT') {
        reconstructedBalance = reconstructedBalance.minus(entry.money_amount);
      }
    }
    expect(reconstructedBalance.toFixed(2)).toBe('20.00');
    expect(reconstructedBalance.toFixed(2)).toBe(walletRows[0]!.balance_amount);
  });

  // ===========================================================================
  // 18.4: Wallets distintas processadas em paralelo sem interferência
  // ===========================================================================
  it('Requirement 7.5 & 15.3: operações simultâneas em wallets distintas não bloqueiam nem interferem entre si', async () => {
    const conn = context.orm.em.getConnection();
    const walletCount = 5;
    const wallets: Array<{ walletId: string; playerId: string }> = [];

    // Cria 5 wallets independentes, cada uma com 500.00 BRL
    for (let i = 0; i < walletCount; i++) {
      const walletId = randomUUID();
      const playerId = randomUUID();
      wallets.push({ walletId, playerId });

      await conn.execute(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
         VALUES (?, ?, 'BRL', 500.00, 1)`,
        [walletId, playerId],
      );
    }

    // Dispara 5 operações concorrentes, 1 para cada carteira
    const promises = wallets.map((w, index) => {
      const extId = `ext-multi-${index}-${randomUUID()}`;
      const useCase = createUseCase();
      return useCase.execute({
        idempotencyKey: `prov-1:${extId}`,
        providerId: 'prov-1',
        externalTransactionId: extId,
        playerId: w.playerId,
        walletId: w.walletId,
        roundId: `round-multi-${index}`,
        gameId: 'fortune-ox',
        kind: WagerTransactionKind.Bet,
        money: { amount: '100.00', currency: 'BRL' },
        correlationId: `corr-multi-${index}`,
      });
    });

    const results = await Promise.all(promises);

    // Todas foram processadas com sucesso
    expect(results.length).toBe(walletCount);
    for (const res of results) {
      expect(res.status).toBe(WagerTransactionStatus.Processed);
      expect(res.balance).toEqual({ amount: '400.00', currency: 'BRL' });
      expect(res.idempotentReplay).toBe(false);
    }

    // Cada carteira tem saldo 400.00 e versão 2
    for (const w of wallets) {
      const rows = await conn.execute<Array<{ balance_amount: string; version: number }>>(
        `SELECT balance_amount, version FROM wallets WHERE id = ?`,
        [w.walletId],
      );
      expect(rows[0]?.balance_amount).toBe('400.00');
      expect(rows[0]?.version).toBe(2);

      const ledger = await conn.execute<Array<{ id: string }>>(
        `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
        [w.walletId],
      );
      expect(ledger.length).toBe(1);
    }
  });
});
