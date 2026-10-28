import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { Money } from '../../../domain/money/money.js';
import { Wallet } from '../../../domain/wallet/wallet.aggregate.js';
import { WagerTransactionKind } from '../../../domain/wager-transaction/wager-transaction.enums.js';
import { createMemoryWorld } from '../_test/in-memory.js';

describe('ReconcileWalletUseCase', () => {
  test('wallet consistente retorna difference 0.00', async () => {
    const world = createMemoryWorld();
    const wallet = await world.createWallet.execute({
      playerId: randomUUID(),
      currency: 'BRL',
      initialBalance: { amount: '50.00', currency: 'BRL' },
      correlationId: 'c',
    });
    await world.processTx.execute({
      idempotencyKey: 'k-bet',
      providerId: 'prov-1',
      externalTransactionId: 'bet-1',
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'r',
      gameId: 'g',
      kind: WagerTransactionKind.Bet,
      money: { amount: '20.00', currency: 'BRL' },
      correlationId: 'c',
    });

    const result = await world.reconcile.execute(wallet.walletId);
    expect(result.consistent).toBe(true);
    expect(result.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.checkedEntries).toBe(2);
    expect(result.storedBalance).toEqual({ amount: '30.00', currency: 'BRL' });
    expect(world.metrics.divergences).toBe(0);
  });

  test('divergência incrementa métrica e não corrige o saldo', async () => {
    const world = createMemoryWorld();
    const created = await world.createWallet.execute({
      playerId: randomUUID(),
      currency: 'BRL',
      initialBalance: { amount: '50.00', currency: 'BRL' },
      correlationId: 'c',
    });

    const original = world.wallets.byId.get(created.walletId)!;
    world.wallets.byId.set(
      created.walletId,
      Wallet.rehydrate({
        id: original.id,
        playerId: original.playerId,
        currency: original.currency,
        balance: { amount: '1.00', currency: 'BRL' },
        version: original.version,
        createdAt: original.createdAt,
        updatedAt: original.updatedAt,
      }),
    );

    const result = await world.reconcile.execute(created.walletId);
    expect(result.consistent).toBe(false);
    expect(result.storedBalance).toEqual({ amount: '1.00', currency: 'BRL' });
    expect(result.calculatedBalance).toEqual({ amount: '50.00', currency: 'BRL' });
    expect(result.difference).toEqual({ amount: '49.00', currency: 'BRL' });
    expect(world.metrics.divergences).toBe(1);
    expect(world.wallets.byId.get(created.walletId)!.balance.equals(Money.from({ amount: '1.00', currency: 'BRL' }))).toBe(
      true,
    );
  });
});
