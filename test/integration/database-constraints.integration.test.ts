import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'crypto';
import {
  startTestEnvironment,
  stopTestEnvironment,
  cleanDatabase,
  type TestEnvironmentContext,
} from './setup.js';
import { LedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry.js';
import { Money } from '../../src/domain/money/money.js';

describe('Integration Tests: Database Schema, Migrations & Constraints', () => {
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

  // ===========================================================================
  // 1. Reversibilidade de Migrations (Requirement 14.7, 15.2)
  // ===========================================================================
  describe('Requirement 14.7: Reversibilidade das Migrations', () => {
    it('executa migrator.down() revertendo o schema e migrator.up() recriando todas as tabelas', async () => {
      const migrator = context.orm.migrator;

      // 1. Reverter todas as migrations
      await migrator.down({ to: 0 });

      const conn = context.orm.em.getConnection();
      const rowsAfterDown = await conn.execute<Array<{ tablename: string }>>(`
        SELECT tablename FROM pg_catalog.pg_tables
        WHERE schemaname = 'public' AND tablename IN (
          'wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages'
        );
      `);
      expect(rowsAfterDown.length).toBe(0);

      // 2. Re-aplicar todas as migrations
      await migrator.up();

      const rowsAfterUp = await conn.execute<Array<{ tablename: string }>>(`
        SELECT tablename FROM pg_catalog.pg_tables
        WHERE schemaname = 'public' AND tablename IN (
          'wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages'
        );
      `);
      expect(rowsAfterUp.length).toBe(5);
    });
  });

  // ===========================================================================
  // 2. Constraints da Tabela `wallets` (Requirements 14.1, 14.2)
  // ===========================================================================
  describe('Tabela `wallets` — Constraints de Negócio', () => {
    it('Requirement 14.1: aplica constraint UNIQUE (player_id, currency)', async () => {
      const conn = context.orm.em.getConnection();
      const playerId = randomUUID();
      const walletId1 = randomUUID();
      const walletId2 = randomUUID();

      // Primeira carteira BRL para o jogador: sucesso
      await conn.execute(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
         VALUES (?, ?, 'BRL', 100.00, 1)`,
        [walletId1, playerId],
      );

      // Segunda carteira BRL para o MESMO jogador: violação de unicidade
      let error: any;
      try {
        await conn.execute(
          `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
           VALUES (?, ?, 'BRL', 50.00, 1)`,
          [walletId2, playerId],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error)).toMatch(/wallets_player_currency_uq|unique constraint|23505/i);

      // Mesma jogador com moeda DIFERENTE (USD): deve permitir
      const walletIdUsd = randomUUID();
      await conn.execute(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
         VALUES (?, ?, 'USD', 0.00, 1)`,
        [walletIdUsd, playerId],
      );

      const rows = await conn.execute<Array<{ id: string; currency: string }>>(
        `SELECT id, currency FROM wallets WHERE player_id = ? ORDER BY currency ASC`,
        [playerId],
      );
      expect(rows.length).toBe(2);
    });

    it('Requirement 14.2: aplica constraint CHECK (balance_amount >= 0)', async () => {
      const conn = context.orm.em.getConnection();
      const playerId = randomUUID();
      const walletId = randomUUID();

      // Tentativa de criar carteira com saldo negativo
      let insertError: any;
      try {
        await conn.execute(
          `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
           VALUES (?, ?, 'BRL', -10.00, 1)`,
          [walletId, playerId],
        );
      } catch (err) {
        insertError = err;
      }

      expect(insertError).toBeDefined();
      expect(String(insertError)).toMatch(/wallets_balance_non_negative|check constraint|23514/i);

      // Inserir com saldo válido
      await conn.execute(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
         VALUES (?, ?, 'BRL', 50.00, 1)`,
        [walletId, playerId],
      );

      // Tentativa de update que resulte em saldo negativo
      let updateError: any;
      try {
        await conn.execute(
          `UPDATE wallets SET balance_amount = -0.01 WHERE id = ?`,
          [walletId],
        );
      } catch (err) {
        updateError = err;
      }

      expect(updateError).toBeDefined();
      expect(String(updateError)).toMatch(/wallets_balance_non_negative|check constraint|23514/i);
    });

    it('aplica constraint CHECK (version >= 1)', async () => {
      const conn = context.orm.em.getConnection();
      const playerId = randomUUID();
      const walletId = randomUUID();

      let error: any;
      try {
        await conn.execute(
          `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
           VALUES (?, ?, 'BRL', 100.00, 0)`,
          [walletId, playerId],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error)).toMatch(/wallets_version_positive|check constraint|23514/i);
    });
  });

  // ===========================================================================
  // 3. Constraints da Tabela `wager_transactions` (Requirements 14.3, 14.4)
  // ===========================================================================
  describe('Tabela `wager_transactions` — Constraints de Negócio', () => {
    let walletId: string;
    let playerId: string;

    beforeEach(async () => {
      const conn = context.orm.em.getConnection();
      walletId = randomUUID();
      playerId = randomUUID();
      await conn.execute(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
         VALUES (?, ?, 'BRL', 1000.00, 1)`,
        [walletId, playerId],
      );
    });

    it('Requirement 14.3: aplica constraint UNIQUE (idempotency_key)', async () => {
      const conn = context.orm.em.getConnection();
      const txId1 = randomUUID();
      const txId2 = randomUUID();
      const idempotencyKey = 'prov-1:tx-unique-idemp-1';

      await conn.execute(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
         ) VALUES (?, 'prov-1', 'ext-1', ?, 'hash1', ?, ?, 'round-1', 'game-1', 'BET', 100.00, 'BRL', 'PROCESSED')`,
        [txId1, idempotencyKey, walletId, playerId],
      );

      // Tentativa de duplicar idempotency_key
      let error: any;
      try {
        await conn.execute(
          `INSERT INTO wager_transactions (
             id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
           ) VALUES (?, 'prov-1', 'ext-2', ?, 'hash2', ?, ?, 'round-1', 'game-1', 'BET', 50.00, 'BRL', 'PROCESSED')`,
          [txId2, idempotencyKey, walletId, playerId],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error)).toMatch(/wt_idempotency_key_uq|unique constraint|23505/i);
    });

    it('Requirement 14.4: aplica constraint UNIQUE (provider_id, external_transaction_id)', async () => {
      const conn = context.orm.em.getConnection();
      const txId1 = randomUUID();
      const txId2 = randomUUID();

      await conn.execute(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
         ) VALUES (?, 'prov-A', 'shared-ext-id', 'key-A', 'hashA', ?, ?, 'round-1', 'game-1', 'BET', 100.00, 'BRL', 'PROCESSED')`,
        [txId1, walletId, playerId],
      );

      // Mesmo provider e mesmo external_transaction_id com chave de idempotência diferente
      let error: any;
      try {
        await conn.execute(
          `INSERT INTO wager_transactions (
             id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
           ) VALUES (?, 'prov-A', 'shared-ext-id', 'key-B', 'hashB', ?, ?, 'round-1', 'game-1', 'BET', 100.00, 'BRL', 'PROCESSED')`,
          [txId2, walletId, playerId],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error)).toMatch(/wt_provider_external_uq|unique constraint|23505/i);

      // Provedor DIFERENTE com o mesmo external_transaction_id: deve permitir
      const txId3 = randomUUID();
      await conn.execute(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
         ) VALUES (?, 'prov-B', 'shared-ext-id', 'key-C', 'hashC', ?, ?, 'round-1', 'game-1', 'BET', 100.00, 'BRL', 'PROCESSED')`,
        [txId3, walletId, playerId],
      );

      const rows = await conn.execute<Array<{ id: string }>>(
        `SELECT id FROM wager_transactions WHERE external_transaction_id = 'shared-ext-id'`,
      );
      expect(rows.length).toBe(2);
    });

    it('aplica constraint CHECK (money_amount > 0)', async () => {
      const conn = context.orm.em.getConnection();
      const txId = randomUUID();

      let error: any;
      try {
        await conn.execute(
          `INSERT INTO wager_transactions (
             id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
           ) VALUES (?, 'prov-1', 'ext-zero', 'key-zero', 'hash', ?, ?, 'round-1', 'game-1', 'BET', 0.00, 'BRL', 'PROCESSED')`,
          [txId, walletId, playerId],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error)).toMatch(/wt_money_amount_positive|check constraint|23514/i);
    });

    it('aplica constraint CHECK de validação de kind e status', async () => {
      const conn = context.orm.em.getConnection();

      // Kind inválido
      let kindError: any;
      try {
        await conn.execute(
          `INSERT INTO wager_transactions (
             id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
           ) VALUES (?, 'prov-1', 'ext-k', 'key-k', 'hash', ?, ?, 'round-1', 'game-1', 'INVALID_KIND', 10.00, 'BRL', 'PROCESSED')`,
          [randomUUID(), walletId, playerId],
        );
      } catch (err) {
        kindError = err;
      }
      expect(kindError).toBeDefined();
      expect(String(kindError)).toMatch(/wt_kind_valid|check constraint|23514/i);

      // Status inválido
      let statusError: any;
      try {
        await conn.execute(
          `INSERT INTO wager_transactions (
             id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
           ) VALUES (?, 'prov-1', 'ext-s', 'key-s', 'hash', ?, ?, 'round-1', 'game-1', 'BET', 10.00, 'BRL', 'INVALID_STATUS')`,
          [randomUUID(), walletId, playerId],
        );
      } catch (err) {
        statusError = err;
      }
      expect(statusError).toBeDefined();
      expect(String(statusError)).toMatch(/wt_status_valid|check constraint|23514/i);
    });

    it('aplica constraint CHECK que exige reference_external_transaction_id em REFUND e ROLLBACK', async () => {
      const conn = context.orm.em.getConnection();

      let error: any;
      try {
        await conn.execute(
          `INSERT INTO wager_transactions (
             id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
             reference_external_transaction_id, status
           ) VALUES (?, 'prov-1', 'ext-ref-missing', 'key-ref', 'hash', ?, ?, 'round-1', 'game-1', 'REFUND', 50.00, 'BRL', NULL, 'PROCESSED')`,
          [randomUUID(), walletId, playerId],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error)).toMatch(/wt_reference_required|check constraint|23514/i);
    });
  });

  // ===========================================================================
  // 4. Constraints da Tabela `wallet_ledger_entries` (Requirements 14.6)
  // ===========================================================================
  describe('Tabela `wallet_ledger_entries` — Constraints e Integridade Aritmética', () => {
    let walletId: string;
    let playerId: string;
    let transactionId: string;

    beforeEach(async () => {
      const conn = context.orm.em.getConnection();
      walletId = randomUUID();
      playerId = randomUUID();
      transactionId = randomUUID();

      await conn.execute(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
         VALUES (?, ?, 'BRL', 1000.00, 1)`,
        [walletId, playerId],
      );

      await conn.execute(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
         ) VALUES (?, 'prov-1', 'ext-1', 'key-1', 'hash', ?, ?, 'round-1', 'game-1', 'BET', 100.00, 'BRL', 'PROCESSED')`,
        [transactionId, walletId, playerId],
      );
    });

    it('aplica constraint UNIQUE (transaction_id, wallet_id)', async () => {
      const conn = context.orm.em.getConnection();

      // Inserir primeiro ledger entry
      await conn.execute(
        `INSERT INTO wallet_ledger_entries (
           id, wallet_id, transaction_id, direction, money_amount, money_currency, balance_before, balance_after
         ) VALUES (?, ?, ?, 'DEBIT', 100.00, 'BRL', 1000.00, 900.00)`,
        [randomUUID(), walletId, transactionId],
      );

      // Tentativa de duplicar entrada para o mesmo (transaction_id, wallet_id)
      let error: any;
      try {
        await conn.execute(
          `INSERT INTO wallet_ledger_entries (
             id, wallet_id, transaction_id, direction, money_amount, money_currency, balance_before, balance_after
           ) VALUES (?, ?, ?, 'DEBIT', 100.00, 'BRL', 900.00, 800.00)`,
          [randomUUID(), walletId, transactionId],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error)).toMatch(/wle_transaction_wallet_uq|unique constraint|23505/i);
    });

    it('aplica constraint CHECK (direction IN (\'DEBIT\', \'CREDIT\'))', async () => {
      const conn = context.orm.em.getConnection();

      let error: any;
      try {
        await conn.execute(
          `INSERT INTO wallet_ledger_entries (
             id, wallet_id, transaction_id, direction, money_amount, money_currency, balance_before, balance_after
           ) VALUES (?, ?, ?, 'TRANSFER', 100.00, 'BRL', 1000.00, 900.00)`,
          [randomUUID(), walletId, transactionId],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error)).toMatch(/wle_direction_valid|check constraint|23514/i);
    });

    it('aplica constraint CHECK de consistência aritmética (balance_after = balance_before ± money_amount)', async () => {
      const conn = context.orm.em.getConnection();

      // DEBIT com matemática incorreta (1000 - 100 deveria ser 900, tenta salvar 850)
      let debitMathError: any;
      try {
        await conn.execute(
          `INSERT INTO wallet_ledger_entries (
             id, wallet_id, transaction_id, direction, money_amount, money_currency, balance_before, balance_after
           ) VALUES (?, ?, ?, 'DEBIT', 100.00, 'BRL', 1000.00, 850.00)`,
          [randomUUID(), walletId, transactionId],
        );
      } catch (err) {
        debitMathError = err;
      }
      expect(debitMathError).toBeDefined();
      expect(String(debitMathError)).toMatch(/wle_balance_arithmetic|check constraint|23514/i);

      // CREDIT com matemática incorreta (1000 + 100 deveria ser 1100, tenta salvar 1200)
      let creditMathError: any;
      try {
        await conn.execute(
          `INSERT INTO wallet_ledger_entries (
             id, wallet_id, transaction_id, direction, money_amount, money_currency, balance_before, balance_after
           ) VALUES (?, ?, ?, 'CREDIT', 100.00, 'BRL', 1000.00, 1200.00)`,
          [randomUUID(), walletId, transactionId],
        );
      } catch (err) {
        creditMathError = err;
      }
      expect(creditMathError).toBeDefined();
      expect(String(creditMathError)).toMatch(/wle_balance_arithmetic|check constraint|23514/i);
    });
  });

  // ===========================================================================
  // 5. Constraints da Tabela `inbox_messages` (Requirement 14.5)
  // ===========================================================================
  describe('Tabela `inbox_messages` — Deduplicação Atômica', () => {
    it('Requirement 14.5: aplica constraint UNIQUE (consumer_name, message_id)', async () => {
      const conn = context.orm.em.getConnection();
      const messageId = 'sqs-dedup-msg-123';
      const consumerA = 'wagering-processor';

      await conn.execute(
        `INSERT INTO inbox_messages (message_id, consumer_name, payload_hash)
         VALUES (?, ?, 'hash123')`,
        [messageId, consumerA],
      );

      // Tentativa de duplicar para o mesmo consumer_name
      let error: any;
      try {
        await conn.execute(
          `INSERT INTO inbox_messages (message_id, consumer_name, payload_hash)
           VALUES (?, ?, 'hash123')`,
          [messageId, consumerA],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error)).toMatch(/inbox_consumer_message_uq|unique constraint|23505/i);

      // Consumer DIFERENTE com o mesmo messageId: deve permitir
      const consumerB = 'another-worker';
      await conn.execute(
        `INSERT INTO inbox_messages (message_id, consumer_name, payload_hash)
         VALUES (?, ?, 'hash123')`,
        [messageId, consumerB],
      );

      const rows = await conn.execute<Array<{ message_id: string }>>(
        `SELECT message_id FROM inbox_messages WHERE message_id = ?`,
        [messageId],
      );
      expect(rows.length).toBe(2);
    });
  });

  // ===========================================================================
  // 6. Imutabilidade do Ledger: Ausência e Bloqueio de DELETE/UPDATE (Requirement 14.6)
  // ===========================================================================
  describe('Requirement 14.6: Imutabilidade do Ledger e Bloqueio de DELETE', () => {
    it('garante que LedgerRepository é append-only e não possui métodos de mutação (delete/update)', () => {
      const repo = new LedgerRepository(context.orm.em);

      // Verifica ausência de métodos destrutivos na interface do repositório
      expect((repo as any).delete).toBeUndefined();
      expect((repo as any).remove).toBeUndefined();
      expect((repo as any).update).toBeUndefined();
      expect((repo as any).deleteByWalletId).toBeUndefined();

      // Métodos válidos de append e consulta
      expect(typeof repo.append).toBe('function');
      expect(typeof repo.findByWalletId).toBe('function');
      expect(typeof repo.sumByWalletId).toBe('function');
    });

    it('append insere registro imutável no banco com precisão de 2 casas decimais', async () => {
      const conn = context.orm.em.getConnection();
      const walletId = randomUUID();
      const playerId = randomUUID();
      const transactionId = randomUUID();

      await conn.execute(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
         VALUES (?, ?, 'BRL', 500.00, 1)`,
        [walletId, playerId],
      );

      await conn.execute(
        `INSERT INTO wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
         ) VALUES (?, 'prov-1', 'ext-test', 'key-test', 'hash', ?, ?, 'round-1', 'game-1', 'BET', 150.25, 'BRL', 'PROCESSED')`,
        [transactionId, walletId, playerId],
      );

      const em = context.orm.em.fork();
      const repo = new LedgerRepository(em);
      const entry = WalletLedgerEntry.create({
        walletId,
        transactionId,
        direction: 'DEBIT',
        money: Money.from({ amount: '150.25', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '500.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '349.75', currency: 'BRL' }),
      });

      await repo.append(entry);
      await em.flush();

      // Verifica persistência e leitura
      const page = await repo.findByWalletId(walletId, undefined, 10);
      expect(page.entries.length).toBe(1);
      expect(page.entries[0]?.money.toJSON()).toEqual({ amount: '150.25', currency: 'BRL' });
      expect(page.entries[0]?.balanceAfter.toJSON()).toEqual({ amount: '349.75', currency: 'BRL' });
    });
  });
});
