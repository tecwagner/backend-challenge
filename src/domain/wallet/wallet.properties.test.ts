import { describe, test, expect } from 'bun:test';
import { Money } from '../money/money.js';
import { Wallet } from './wallet.aggregate.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.js';
import { InsufficientBalanceError, LedgerArithmeticError } from './wallet.errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function forAll<T>(
  label: string,
  inputs: T[],
  predicate: (input: T) => void,
): void {
  for (const input of inputs) {
    try {
      predicate(input);
    } catch (err) {
      throw new Error(
        `Property "${label}" failed for input ${JSON.stringify(input)}: ${String(err)}`,
      );
    }
  }
}

const CURRENCY = 'BRL';

/** Generates a reproducible set of valid cent amounts (integer cents, >= 0). */
function generateAmountCents(count: number): number[] {
  const amounts: number[] = [];
  // deterministic spread: 0, 1, small, medium, large, boundary values
  const fixed = [0, 1, 50, 100, 999, 1000, 5000, 10000, 50000, 99999];
  amounts.push(...fixed);
  // fill the rest with a simple LCG-like sequence for determinism
  let seed = 42;
  while (amounts.length < count) {
    seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
    amounts.push(seed % 100000); // 0..99999 cents  → 0..999.99
  }
  return amounts;
}

/** Convert integer cents to a Money instance */
function centsToMoney(cents: number): Money {
  const amount = (cents / 100).toFixed(2);
  return Money.from({ amount, currency: CURRENCY });
}

function openWallet(): Wallet {
  return Wallet.open({
    id: 'wallet-prop-test',
    playerId: 'player-prop-test',
    currency: CURRENCY,
  });
}

// ---------------------------------------------------------------------------
// Property 5: Wallet balance never goes negative
// Validates: Requirements 2.5, 5.2
// ---------------------------------------------------------------------------

describe('Property 5: Wallet balance never goes negative', () => {
  /**
   * Validates: Requirements 2.5, 5.2
   *
   * For any arbitrary sequence of debit/credit operations with valid Money amounts:
   *   1. wallet.balance is never negative after any operation.
   *   2. When a debit would result in a negative balance, InsufficientBalanceError
   *      is thrown and the balance remains unchanged.
   */

  test('balance never goes negative across 1000 random credit operations', () => {
    const amounts = generateAmountCents(1000);

    forAll('balance >= 0 after credit', amounts, (cents) => {
      const wallet = openWallet();
      wallet.credit(centsToMoney(cents));
      expect(wallet.balance.isNegative()).toBe(false);
    });
  });

  test('debit that would go negative throws InsufficientBalanceError and balance is unchanged', () => {
    const debitAmounts = generateAmountCents(1000).filter((c) => c > 0);

    forAll('debit > balance throws and balance unchanged', debitAmounts, (cents) => {
      const wallet = openWallet(); // starts at 0.00
      const debitMoney = centsToMoney(cents);
      const balanceBefore = wallet.balance.toJSON();

      expect(() => wallet.debit(debitMoney)).toThrow(InsufficientBalanceError);
      // Balance must be unchanged after the rejected debit
      expect(wallet.balance.toJSON()).toEqual(balanceBefore);
    });
  });

  test('balance never goes negative across 1000 mixed credit/debit sequences', () => {
    const N = 1000;
    const creditAmounts = generateAmountCents(N);
    // Use a different seed offset for debit amounts
    const debitAmounts = generateAmountCents(N).map((c) => Math.floor(c / 3));

    for (let i = 0; i < N; i++) {
      const wallet = openWallet();
      // Credit first so we have some balance, then attempt debit
      wallet.credit(centsToMoney(creditAmounts[i]));

      try {
        wallet.debit(centsToMoney(debitAmounts[i]));
      } catch (err) {
        if (!(err instanceof InsufficientBalanceError)) throw err;
        // If debit was rejected, balance should still be >= 0
      }

      if (wallet.balance.isNegative()) {
        throw new Error(
          `Property 5 violated: balance became negative (${wallet.balance.toJSON().amount}) ` +
            `after credit(${creditAmounts[i]}) / debit(${debitAmounts[i]})`,
        );
      }
    }
  });

  test('cumulative credits and debits keep balance >= 0 (multi-step sequence)', () => {
    const wallet = openWallet();

    // Amounts to credit then debit in a sequence
    const steps: Array<{ op: 'credit' | 'debit'; cents: number }> = [
      { op: 'credit', cents: 10000 }, // +100.00 → 100.00
      { op: 'debit', cents: 3000 },   // -30.00  → 70.00
      { op: 'debit', cents: 7000 },   // -70.00  → 0.00
      { op: 'credit', cents: 1 },     // +0.01   → 0.01
      { op: 'debit', cents: 2 },      // -0.02   → should throw
      { op: 'credit', cents: 99999 }, // +999.99 → 1000.00
      { op: 'debit', cents: 99999 },  // -999.99 → 0.01
    ];

    for (const { op, cents } of steps) {
      const money = centsToMoney(cents);
      try {
        if (op === 'credit') {
          wallet.credit(money);
        } else {
          wallet.debit(money);
        }
      } catch (err) {
        if (!(err instanceof InsufficientBalanceError)) throw err;
      }

      expect(wallet.balance.isNegative()).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 6: version increments only on balance change
// Validates: Requirements 2.4
// ---------------------------------------------------------------------------

describe('Property 6: version increments only on balance change', () => {
  /**
   * Validates: Requirements 2.4
   *
   * 1. version starts at 1 after Wallet.open().
   * 2. version increments by exactly 1 on each successful credit or debit.
   * 3. version does NOT change when an operation is rejected (insufficient balance).
   */

  test('version starts at 1 after Wallet.open()', () => {
    const wallet = openWallet();
    expect(wallet.version).toBe(1);
  });

  test('version increments by exactly 1 for each successful credit', () => {
    const amounts = generateAmountCents(1000);

    forAll('version += 1 on credit', amounts, (cents) => {
      const wallet = openWallet();
      const vBefore = wallet.version;
      wallet.credit(centsToMoney(cents));
      expect(wallet.version).toBe(vBefore + 1);
    });
  });

  test('version increments by exactly 1 for each successful debit', () => {
    const amounts = generateAmountCents(500).filter((c) => c > 0);

    forAll('version += 1 on debit', amounts, (cents) => {
      const wallet = openWallet();
      // Seed with enough credit to allow the debit
      wallet.credit(centsToMoney(cents));
      const vBefore = wallet.version;
      wallet.debit(centsToMoney(cents));
      expect(wallet.version).toBe(vBefore + 1);
    });
  });

  test('version does NOT change when debit is rejected for insufficient balance', () => {
    const amounts = generateAmountCents(1000).filter((c) => c > 0);

    forAll('version unchanged on rejected debit', amounts, (cents) => {
      const wallet = openWallet(); // balance = 0.00
      const vBefore = wallet.version;

      expect(() => wallet.debit(centsToMoney(cents))).toThrow(InsufficientBalanceError);
      expect(wallet.version).toBe(vBefore);
    });
  });

  test('version increments monotonically across a sequence of operations', () => {
    const wallet = openWallet();
    expect(wallet.version).toBe(1);

    // Credit 5 times
    for (let i = 0; i < 5; i++) {
      wallet.credit(centsToMoney(1000));
      expect(wallet.version).toBe(2 + i);
    }

    // Debit 3 times
    for (let i = 0; i < 3; i++) {
      wallet.debit(centsToMoney(500));
      expect(wallet.version).toBe(7 + i);
    }

    // Attempt a rejected debit (would make balance negative), version must stay at 9
    expect(() => wallet.debit(centsToMoney(999999))).toThrow(InsufficientBalanceError);
    expect(wallet.version).toBe(9);

    // One more successful credit → version becomes 10
    wallet.credit(centsToMoney(1));
    expect(wallet.version).toBe(10);
  });

  test('version always equals 1 + number of successful operations', () => {
    const N = 500;
    const amounts = generateAmountCents(N * 2);

    const wallet = openWallet();
    let successfulOps = 0;

    for (let i = 0; i < N; i++) {
      const creditCents = amounts[i * 2]!;
      const debitCents = amounts[i * 2 + 1]! % (creditCents + 1); // ensure debit ≤ credit

      wallet.credit(centsToMoney(creditCents));
      successfulOps += 1;
      expect(wallet.version).toBe(1 + successfulOps);

      if (debitCents > 0 && !wallet.balance.isNegative()) {
        try {
          wallet.debit(centsToMoney(debitCents));
          successfulOps += 1;
          expect(wallet.version).toBe(1 + successfulOps);
        } catch (err) {
          if (!(err instanceof InsufficientBalanceError)) throw err;
          // version must remain unchanged
          expect(wallet.version).toBe(1 + successfulOps);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Property 13: Ledger arithmetic is always balanced
// Validates: Requirements 6.2
// ---------------------------------------------------------------------------

describe('Property 13: Ledger arithmetic is always balanced', () => {
  /**
   * Validates: Requirements 6.2
   *
   * For any valid WalletLedgerEntry created via WalletLedgerEntry.create(...):
   *   - isBalanced() returns true
   *   - CREDIT: balanceBefore.add(money).equals(balanceAfter)
   *   - DEBIT:  balanceBefore.subtract(money).equals(balanceAfter)
   *
   * Additionally, WalletLedgerEntry.create() throws LedgerArithmeticError
   * when the arithmetic invariant does not hold.
   */

  test('isBalanced() returns true for all valid CREDIT entries across 1000 combinations', () => {
    const balanceAmounts = generateAmountCents(1000);
    const moneyAmounts = generateAmountCents(1000);

    forAll(
      'isBalanced() === true for CREDIT',
      balanceAmounts.map((b, i) => ({ balanceCents: b, moneyCents: moneyAmounts[i] })),
      ({ balanceCents, moneyCents }) => {
        const balanceBefore = centsToMoney(balanceCents);
        const money = centsToMoney(moneyCents);
        const balanceAfter = balanceBefore.add(money);

        const entry = WalletLedgerEntry.create({
          walletId: 'wallet-prop',
          transactionId: 'tx-prop',
          direction: 'CREDIT',
          money,
          balanceBefore,
          balanceAfter,
        });

        expect(entry.isBalanced()).toBe(true);
      },
    );
  });

  test('isBalanced() returns true for all valid DEBIT entries across 1000 combinations', () => {
    const balanceAmounts = generateAmountCents(1000);
    const moneyAmounts = generateAmountCents(1000);

    forAll(
      'isBalanced() === true for DEBIT',
      balanceAmounts.map((b, i) => ({
        // ensure balanceBefore >= money so debit is valid
        balanceCents: b + moneyAmounts[i],
        moneyCents: moneyAmounts[i],
      })),
      ({ balanceCents, moneyCents }) => {
        const balanceBefore = centsToMoney(balanceCents);
        const money = centsToMoney(moneyCents);
        const balanceAfter = balanceBefore.subtract(money);

        const entry = WalletLedgerEntry.create({
          walletId: 'wallet-prop',
          transactionId: 'tx-prop',
          direction: 'DEBIT',
          money,
          balanceBefore,
          balanceAfter,
        });

        expect(entry.isBalanced()).toBe(true);
      },
    );
  });

  test('WalletLedgerEntry.create() throws LedgerArithmeticError when CREDIT arithmetic is wrong', () => {
    const cases = generateAmountCents(500);

    forAll(
      'create throws on wrong CREDIT balanceAfter',
      cases,
      (balanceCents) => {
        const balanceBefore = centsToMoney(balanceCents);
        const money = centsToMoney(100); // 1.00
        // Intentionally wrong: add 2 cents extra so it doesn't match
        const wrongBalanceAfter = balanceBefore.add(money).add(centsToMoney(1));

        expect(() =>
          WalletLedgerEntry.create({
            walletId: 'wallet-prop',
            transactionId: 'tx-prop',
            direction: 'CREDIT',
            money,
            balanceBefore,
            balanceAfter: wrongBalanceAfter,
          }),
        ).toThrow(LedgerArithmeticError);
      },
    );
  });

  test('WalletLedgerEntry.create() throws LedgerArithmeticError when DEBIT arithmetic is wrong', () => {
    const cases = generateAmountCents(500).map((c) => c + 200); // ensure >= 2.00 for safe subtraction

    forAll(
      'create throws on wrong DEBIT balanceAfter',
      cases,
      (balanceCents) => {
        const balanceBefore = centsToMoney(balanceCents);
        const money = centsToMoney(100); // 1.00
        // Intentionally wrong: subtract 1 cent too many
        const wrongBalanceAfter = balanceBefore.subtract(money).subtract(centsToMoney(1));

        expect(() =>
          WalletLedgerEntry.create({
            walletId: 'wallet-prop',
            transactionId: 'tx-prop',
            direction: 'DEBIT',
            money,
            balanceBefore,
            balanceAfter: wrongBalanceAfter,
          }),
        ).toThrow(LedgerArithmeticError);
      },
    );
  });

  test('CREDIT: balanceBefore.add(money).equals(balanceAfter) holds for all entries', () => {
    const amounts = generateAmountCents(1000);

    forAll(
      'CREDIT arithmetic identity',
      amounts,
      (cents) => {
        const balanceBefore = centsToMoney(cents);
        const money = centsToMoney(50); // fixed 0.50
        const balanceAfter = balanceBefore.add(money);

        const entry = WalletLedgerEntry.create({
          walletId: 'w',
          transactionId: 'tx',
          direction: 'CREDIT',
          money,
          balanceBefore,
          balanceAfter,
        });

        // The identity: balanceBefore + money === balanceAfter
        expect(entry.balanceBefore.add(entry.money).equals(entry.balanceAfter)).toBe(true);
        expect(entry.isBalanced()).toBe(true);
      },
    );
  });

  test('DEBIT: balanceBefore.subtract(money).equals(balanceAfter) holds for all entries', () => {
    const moneyAmounts = generateAmountCents(1000);

    forAll(
      'DEBIT arithmetic identity',
      moneyAmounts,
      (moneyCents) => {
        // Give enough balance so subtraction is valid (balance = money + 100)
        const balanceBefore = centsToMoney(moneyCents + 100);
        const money = centsToMoney(moneyCents);
        const balanceAfter = balanceBefore.subtract(money);

        const entry = WalletLedgerEntry.create({
          walletId: 'w',
          transactionId: 'tx',
          direction: 'DEBIT',
          money,
          balanceBefore,
          balanceAfter,
        });

        // The identity: balanceBefore - money === balanceAfter
        expect(entry.balanceBefore.subtract(entry.money).equals(entry.balanceAfter)).toBe(true);
        expect(entry.isBalanced()).toBe(true);
      },
    );
  });

  test('zero-amount CREDIT and DEBIT entries are always balanced', () => {
    const balanceAmounts = generateAmountCents(200);

    forAll('zero-amount entries are balanced', balanceAmounts, (cents) => {
      const balanceBefore = centsToMoney(cents);
      const zero = centsToMoney(0);

      const creditEntry = WalletLedgerEntry.create({
        walletId: 'w',
        transactionId: 'tx-c',
        direction: 'CREDIT',
        money: zero,
        balanceBefore,
        balanceAfter: balanceBefore.add(zero),
      });
      expect(creditEntry.isBalanced()).toBe(true);

      const debitEntry = WalletLedgerEntry.create({
        walletId: 'w',
        transactionId: 'tx-d',
        direction: 'DEBIT',
        money: zero,
        balanceBefore,
        balanceAfter: balanceBefore.subtract(zero),
      });
      expect(debitEntry.isBalanced()).toBe(true);
    });
  });
});
