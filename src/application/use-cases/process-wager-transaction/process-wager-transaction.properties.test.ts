import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../../../domain/wager-transaction/failure-codes.js';
import { createMemoryWorld, type MemoryWorld } from '../_test/in-memory.js';
import type { ProcessWagerTransactionCommand } from './process-wager-transaction.dto.js';

async function fundedWallet(world: MemoryWorld, amount: string) {
  return world.createWallet.execute({
    playerId: randomUUID(),
    currency: 'BRL',
    initialBalance: { amount, currency: 'BRL' },
    correlationId: 'open',
  });
}

function betCmd(
  walletId: string,
  playerId: string,
  amount: string,
  extras: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  const externalTransactionId = extras.externalTransactionId ?? randomUUID();
  return {
    idempotencyKey: extras.idempotencyKey ?? `prov-1:${externalTransactionId}`,
    providerId: 'prov-1',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: 'BRL' },
    correlationId: 'corr',
    ...extras,
  };
}

function reconstructedBalance(world: MemoryWorld, walletId: string): string {
  const entries = world.ledger.entries.filter((e) => e.walletId === walletId);
  let amount = 0;
  for (const entry of entries) {
    const value = Number(entry.money.toJSON().amount);
    amount += entry.direction === 'CREDIT' ? value : -value;
  }
  return amount.toFixed(2);
}

/**
 * Property 10: Idempotência persistente — replay retorna resposta original
 * Validates: Requirements 4.1
 */
describe('Property 10: Idempotência persistente — replay retorna resposta original', () => {
  const amounts = ['1.00', '10.50', '25.00', '40.00', '99.99'];

  test('replay de qualquer BET processada devolve o resultado original sem novo ledger', async () => {
    for (const amount of amounts) {
      const world = createMemoryWorld();
      const wallet = await fundedWallet(world, '100.00');
      const cmd = betCmd(wallet.walletId, wallet.playerId, amount, { idempotencyKey: `k-${amount}` });
      const first = await world.processTx.execute(cmd);
      const ledgerCount = world.ledger.entries.length;
      const second = await world.processTx.execute(cmd);

      expect(second.idempotentReplay).toBe(true);
      expect(second.transactionId).toBe(first.transactionId);
      expect(second.status).toBe(first.status);
      expect(second.balance).toEqual(first.balance);
      expect(world.ledger.entries).toHaveLength(ledgerCount);
    }
  });
});

/**
 * Property 12: Transações REJECTED não alteram saldo nem geram ledger
 * Validates: Requirements 5.11, 6.1
 */
describe('Property 12: Transações REJECTED não alteram saldo nem geram ledger', () => {
  const cases: Array<{ amount: string; bet: string }> = [
    { amount: '10.00', bet: '10.01' },
    { amount: '20.00', bet: '50.00' },
    { amount: '0.00', bet: '1.00' },
    { amount: '5.50', bet: '5.51' },
    { amount: '100.00', bet: '100.01' },
  ];

  test('BET rejeitada por saldo insuficiente não move saldo nem cria débito', async () => {
    for (const fixture of cases) {
      const world = createMemoryWorld();
      const wallet =
        fixture.amount === '0.00'
          ? await world.createWallet.execute({
              playerId: randomUUID(),
              currency: 'BRL',
              correlationId: 'open',
            })
          : await fundedWallet(world, fixture.amount);

      const ledgerBefore = world.ledger.entries.filter((e) => e.walletId === wallet.walletId).length;
      const result = await world.processTx.execute(betCmd(wallet.walletId, wallet.playerId, fixture.bet));

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.BalanceInsufficient);
      expect(result.balance.amount).toBe(fixture.amount === '0.00' ? '0.00' : fixture.amount);
      expect(world.ledger.entries.filter((e) => e.walletId === wallet.walletId)).toHaveLength(ledgerBefore);
    }
  });
});

/**
 * Property 15: Cenário de concorrência — exatamente um PROCESSED
 * Validates: Requirements 7.3
 */
describe('Property 15: Cenário de concorrência — exatamente um PROCESSED', () => {
  test('duas BET 80.00 concorrentes sobre 100.00: um PROCESSED e um REJECTED', async () => {
    const world = createMemoryWorld();
    const wallet = await fundedWallet(world, '100.00');

    const [a, b] = await Promise.all([
      world.processTx.execute(betCmd(wallet.walletId, wallet.playerId, '80.00', { externalTransactionId: 'a' })),
      world.processTx.execute(betCmd(wallet.walletId, wallet.playerId, '80.00', { externalTransactionId: 'b' })),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);

    const rejected = a.status === WagerTransactionStatus.Rejected ? a : b;
    expect(rejected.failureCode).toBe(FailureCode.BalanceInsufficient);

    const stored = world.wallets.byId.get(wallet.walletId)!;
    expect(stored.balance.toJSON().amount).toBe('20.00');
    expect(reconstructedBalance(world, wallet.walletId)).toBe('20.00');

    const debitEntries = world.ledger.entries.filter(
      (e) => e.walletId === wallet.walletId && e.direction === 'DEBIT',
    );
    expect(debitEntries).toHaveLength(1);
  });
});
