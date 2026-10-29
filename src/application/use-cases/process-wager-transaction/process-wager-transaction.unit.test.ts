import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../../../domain/wager-transaction/failure-codes.js';
import { IdempotencyConflictError } from '../../errors/application.errors.js';
import { createMemoryWorld, type MemoryWorld } from '../_test/in-memory.js';
import type { ProcessWagerTransactionCommand } from './process-wager-transaction.dto.js';

async function fundedWallet(world: MemoryWorld, amount = '100.00') {
  return world.createWallet.execute({
    playerId: randomUUID(),
    currency: 'BRL',
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'open',
  });
}

function command(
  walletId: string,
  playerId: string,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  const externalTransactionId = overrides.externalTransactionId ?? randomUUID();
  const providerId = overrides.providerId ?? 'prov-1';
  return {
    idempotencyKey: overrides.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '30.00', currency: 'BRL' },
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('ProcessWagerTransactionUseCase', () => {
  test('BET debita saldo e gera ledger DEBIT', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world);
    const result = await world.processTx.execute(command(wallet.walletId, wallet.playerId));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.idempotentReplay).toBe(false);
    expect(result.balance).toEqual({ amount: '70.00', currency: 'BRL' });
    const financial = world.ledger.entries.filter((e) => e.walletId === wallet.walletId);
    expect(financial).toHaveLength(2); // OPENING + BET
    expect(financial[1]!.direction).toBe('DEBIT');
  });

  test('BET com saldo insuficiente é REJECTED sem ledger extra', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world, '10.00');
    const result = await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, { money: { amount: '30.00', currency: 'BRL' } }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.BalanceInsufficient);
    expect(result.balance).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(world.ledger.entries.filter((e) => e.direction === 'DEBIT')).toHaveLength(0);
  });

  test('WIN credita saldo', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world, '10.00');
    const result = await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        kind: WagerTransactionKind.Win,
        money: { amount: '15.00', currency: 'BRL' },
      }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('LOSS registra PROCESSED sem alterar saldo nem ledger financeiro extra', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world);
    const ledgerBefore = world.ledger.entries.length;
    const result = await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, { kind: WagerTransactionKind.Loss }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(world.ledger.entries).toHaveLength(ledgerBefore);
  });

  test('REFUND de BET PROCESSED credita o valor da referência', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world);
    const bet = await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        externalTransactionId: 'bet-1',
        money: { amount: '40.00', currency: 'BRL' },
      }),
    );
    expect(bet.balance).toEqual({ amount: '60.00', currency: 'BRL' });

    const refund = await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'refund-1',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('REFUND antes da BET fica PENDING_REFERENCE', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world);
    const refund = await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        kind: WagerTransactionKind.Refund,
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-missing',
      }),
    );
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(world.outbox.messages.some((m) => m.eventType === 'WagerTransactionPendingReference')).toBe(true);
  });

  test('ROLLBACK inverte WIN (débito) e rejeita se saldo insuficiente com código distinto', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world, '10.00');
    await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        kind: WagerTransactionKind.Win,
        externalTransactionId: 'win-1',
        money: { amount: '5.00', currency: 'BRL' },
      }),
    );
    await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        money: { amount: '12.00', currency: 'BRL' },
        externalTransactionId: 'bet-drain',
      }),
    );

    const rollback = await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        kind: WagerTransactionKind.Rollback,
        externalTransactionId: 'rb-1',
        money: { amount: '5.00', currency: 'BRL' },
        referenceExternalTransactionId: 'win-1',
      }),
    );
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.BalanceReversalInsufficient);
  });

  test('REFUND duplicado é REJECTED com REFERENCE_ALREADY_REVERSED', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world);
    await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        externalTransactionId: 'bet-1',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );
    await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'refund-1',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    const second = await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        kind: WagerTransactionKind.Refund,
        externalTransactionId: 'refund-2',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test('REFUND com valor divergente é rejeitado', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world);
    await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        externalTransactionId: 'bet-1',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );
    const refund = await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        kind: WagerTransactionKind.Refund,
        money: { amount: '9.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
  });

  test('OPENING via use case é REJECTED', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world);
    const result = await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, { kind: WagerTransactionKind.Opening }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.KindOpeningForbidden);
  });

  test('replay idêntico retorna a resposta original', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world);
    const cmd = command(wallet.walletId, wallet.playerId, { idempotencyKey: 'key-1' });
    const first = await world.processTx.execute(cmd);
    const second = await world.processTx.execute(cmd);

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.status).toBe(first.status);
    expect(second.balance).toEqual(first.balance);
  });

  test('mesma key com payload diferente lança conflito', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world);
    await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, {
        idempotencyKey: 'key-1',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );
    await expect(
      world.processTx.execute(
        command(wallet.walletId, wallet.playerId, {
          idempotencyKey: 'key-1',
          money: { amount: '11.00', currency: 'BRL' },
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test('moeda divergente da wallet é REJECTED', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world);
    const result = await world.processTx.execute(
      command(wallet.walletId, wallet.playerId, { money: { amount: '10.00', currency: 'USD' } }),
    );
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });
});
