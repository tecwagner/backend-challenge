import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction.enums.js';
import { createMemoryWorld } from '../_test/in-memory.js';

/**
 * Property 17: Reprocessamento de PENDING_REFERENCE é idempotente
 * Validates: Requirements 8.5
 */
describe('Property 17: Reprocessamento de PENDING_REFERENCE é idempotente', () => {
  const amounts = ['5.00', '12.50', '40.00', '80.00'];

  test('N reprocessamentos concorrentes aplicam o efeito financeiro exatamente uma vez', async () => {
    for (const amount of amounts) {
      const world = createMemoryWorld();
      const wallet = await world.createWallet.execute({
        playerId: randomUUID(),
        currency: 'BRL',
        initialBalance: { amount: '100.00', currency: 'BRL' },
        correlationId: 'c',
      });

      await world.processTx.execute({
        idempotencyKey: 'refund-1',
        providerId: 'prov-1',
        externalTransactionId: 'refund-1',
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund,
        money: { amount, currency: 'BRL' },
        referenceExternalTransactionId: 'bet-1',
        correlationId: 'c',
      });

      await world.processTx.execute({
        idempotencyKey: 'bet-1',
        providerId: 'prov-1',
        externalTransactionId: 'bet-1',
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount, currency: 'BRL' },
        correlationId: 'c',
      });

      await Promise.all([
        world.reprocess.execute(new Date(), 10),
        world.reprocess.execute(new Date(), 10),
        world.reprocess.execute(new Date(), 10),
      ]);

      const refunds = [...world.wagerTx.byId.values()].filter((tx) => tx.kind === WagerTransactionKind.Refund);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.status).toBe(WagerTransactionStatus.Processed);

      const stored = world.wallets.byId.get(wallet.walletId)!;
      expect(stored.balance.toJSON().amount).toBe('100.00');

      const credits = world.ledger.entries.filter(
        (e) => e.walletId === wallet.walletId && e.direction === 'CREDIT' && e.transactionId === refunds[0]!.id,
      );
      expect(credits).toHaveLength(1);
    }
  });
});
