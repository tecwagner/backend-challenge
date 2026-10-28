import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../../../domain/wager-transaction/failure-codes.js';
import { PENDING_REFERENCE_MAX_ATTEMPTS } from '../../services/apply-wager-effect.js';
import { createMemoryWorld } from '../_test/in-memory.js';

describe('ReprocessPendingReferencesUseCase', () => {
  test('resolve REFUND quando a BET chega depois e aplica o crédito uma vez', async () => {
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
      money: { amount: '40.00', currency: 'BRL' },
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
      money: { amount: '40.00', currency: 'BRL' },
      correlationId: 'c',
    });

    const summary = await world.reprocess.execute(new Date());
    expect(summary.processed).toBe(1);

    const stored = world.wallets.byId.get(wallet.walletId)!;
    expect(stored.balance.toJSON().amount).toBe('100.00');
    const refund = [...world.wagerTx.byId.values()].find((tx) => tx.kind === WagerTransactionKind.Refund)!;
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
  });

  test('esgota tentativas e rejeita com REFERENCE_NOT_FOUND + outbox', async () => {
    const world = createMemoryWorld();
    const wallet = await world.createWallet.execute({
      playerId: randomUUID(),
      currency: 'BRL',
      initialBalance: { amount: '10.00', currency: 'BRL' },
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
      money: { amount: '5.00', currency: 'BRL' },
      referenceExternalTransactionId: 'missing',
      correlationId: 'c',
    });

    const farFuture = new Date('2099-01-01T00:00:00.000Z');
    for (let i = 0; i < PENDING_REFERENCE_MAX_ATTEMPTS; i++) {
      await world.reprocess.execute(new Date(farFuture.getTime() + i * 400_000), 1);
    }

    const refund = [...world.wagerTx.byId.values()].find((tx) => tx.kind === WagerTransactionKind.Refund)!;
    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(world.outbox.messages.some((m) => m.eventType === 'WagerTransactionRejected')).toBe(true);
    expect(world.wallets.byId.get(wallet.walletId)!.balance.toJSON().amount).toBe('10.00');
  });
});
