import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'crypto';
import type { EntityManager } from '@mikro-orm/core';
import {
  startTestEnvironment,
  stopTestEnvironment,
  cleanDatabase,
  type TestEnvironmentContext,
} from './setup.js';
import { LedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { PayloadHashService } from '../../src/application/services/payload-hash.service.js';

describe('Property Tests: Ledger Keyset Pagination & Canonical Payload Hash (Properties 7 & 8)', () => {
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
  // Property 7: Paginação do ledger — completude e ausência de duplicatas
  // Validates: Requirements 2.7
  // ===========================================================================
  it('Property 7: Para qualquer Wallet com N lançamentos, iterar todas as páginas com qualquer limit retorna exatamente N lançamentos na ordem cronológica sem duplicatas nem omissões', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 0.00, 1)`,
      [walletId, playerId],
    );

    const totalEntries = 35;
    const insertedIds: string[] = [];

    // Insere 35 entradas com timestamps progressivos para simular histórico real
    for (let i = 0; i < totalEntries; i++) {
      const entryId = randomUUID();
      const txId = randomUUID();
      insertedIds.push(entryId);
      const createdAt = new Date(Date.now() - (totalEntries - i) * 1000);

      await conn.execute(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status, created_at
        ) VALUES (?, 'prov', ?, ?, 'hash', ?, ?, 'round-1', 'game-1', 'OPENING', 10.00, 'BRL', 'PROCESSED', ?)`,
        [txId, `ext-${txId}`, `idem-${txId}`, walletId, playerId, createdAt],
      );

      await conn.execute(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, money_amount, money_currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'CREDIT', 10.00, 'BRL', ?, ?, ?)`,
        [entryId, walletId, txId, (i * 10).toFixed(2), ((i + 1) * 10).toFixed(2), createdAt],
      );
    }

    const em = context.orm.em.fork({ useContext: true });
    const ledgerRepo = new LedgerRepository(em);

    // Testa com diferentes tamanhos de página (limits: 3, 7, 10, 20)
    const testLimits = [3, 7, 10, 20];

    for (const limit of testLimits) {
      let cursor: string | undefined = undefined;
      const collectedIds: string[] = [];
      let pagesCount = 0;

      while (true) {
        pagesCount++;
        const page = await ledgerRepo.findByWalletId(walletId, cursor, limit);

        for (const entry of page.entries) {
          collectedIds.push(entry.id);
        }

        if (!page.nextCursor) {
          break;
        }
        cursor = page.nextCursor;

        // Proteção contra loop infinito em caso de bug de paginação
        if (pagesCount > 20) {
          throw new Error(`Infinite pagination loop detected for limit ${limit}`);
        }
      }

      // 1. Total coletado é exatamente N
      expect(collectedIds.length).toBe(totalEntries);

      // 2. Sem duplicatas
      expect(new Set(collectedIds).size).toBe(totalEntries);

      // 3. Ordem exata respeitada (created_at ASC, id ASC)
      expect(collectedIds).toEqual(insertedIds);
    }
  });

  // ===========================================================================
  // Property 8: Hash canônico é determinístico independente da ordem de chaves
  // Validates: Requirements 3.3
  // ===========================================================================
  it('Property 8: Qualquer permutação de chaves no payload produz o mesmo hash SHA-256 canônico', () => {
    const hashService = new PayloadHashService();

    const baseObj = {
      idempotencyKey: 'prov-1:tx-100',
      providerId: 'prov-1',
      externalTransactionId: 'tx-100',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '100.00', currency: 'BRL' },
      referenceExternalTransactionId: 'ref-1',
    };

    // Gera 10 permutações de chaves do objeto
    const hashes = new Set<string>();
    const keys = Object.keys(baseObj);

    for (let i = 0; i < 20; i++) {
      // Embaralha as chaves
      const shuffledKeys = [...keys].sort(() => Math.random() - 0.5);
      const permutedObj: Record<string, unknown> = {};
      for (const k of shuffledKeys) {
        permutedObj[k] = (baseObj as Record<string, unknown>)[k];
      }

      const hash = hashService.compute(permutedObj as unknown as Parameters<typeof hashService.compute>[0]);
      hashes.add(hash);
    }

    // Todas as 20 permutações geram exatamente o mesmo hash SHA-256
    expect(hashes.size).toBe(1);
  });
});
