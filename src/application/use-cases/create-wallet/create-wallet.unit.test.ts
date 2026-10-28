import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { WagerTransactionKind } from '../../../domain/wager-transaction/wager-transaction.enums.js';
import { WalletAlreadyExistsError } from '../../errors/application.errors.js';
import { createMemoryWorld } from '../_test/in-memory.js';

describe('CreateWalletUseCase', () => {
  test('abre wallet com saldo zero sem OPENING nem ledger', async () => {
    const world = createMemoryWorld();
    const result = await world.createWallet.execute({
      playerId: randomUUID(),
      currency: 'brl',
      correlationId: 'c-1',
    });

    expect(result.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.version).toBe(1);
    expect(world.wagerTx.byId.size).toBe(0);
    expect(world.ledger.entries).toHaveLength(0);
  });

  test('abre wallet com saldo inicial gerando OPENING + CREDIT + outbox', async () => {
    const world = createMemoryWorld();
    const result = await world.createWallet.execute({
      playerId: randomUUID(),
      currency: 'BRL',
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: 'c-1',
    });

    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(result.version).toBe(1);
    expect(world.wagerTx.byId.size).toBe(1);
    const tx = [...world.wagerTx.byId.values()][0]!;
    expect(tx.kind).toBe(WagerTransactionKind.Opening);
    expect(world.ledger.entries).toHaveLength(1);
    expect(world.ledger.entries[0]!.direction).toBe('CREDIT');
    expect(world.outbox.messages.map((m) => m.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('rejeita duplicata (playerId, currency)', async () => {
    const world = createMemoryWorld();
    const playerId = randomUUID();
    await world.createWallet.execute({ playerId, currency: 'BRL', correlationId: 'c-1' });

    await expect(
      world.createWallet.execute({ playerId, currency: 'BRL', correlationId: 'c-2' }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    expect(world.wallets.byId.size).toBe(1);
  });
});
