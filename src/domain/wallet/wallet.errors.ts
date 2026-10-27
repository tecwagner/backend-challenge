import type { MoneyProps } from '../money/money.js';

export class LedgerArithmeticError extends Error {
  override readonly name = 'LedgerArithmeticError';

  constructor(
    direction: 'DEBIT' | 'CREDIT',
    balanceBefore: MoneyProps,
    money: MoneyProps,
    balanceAfter: MoneyProps,
    expectedAfter: MoneyProps,
  ) {
    super(
      `Ledger arithmetic mismatch: direction=${direction}, ` +
        `balanceBefore=${balanceBefore.amount} ${balanceBefore.currency}, ` +
        `money=${money.amount} ${money.currency}, ` +
        `balanceAfter=${balanceAfter.amount} ${balanceAfter.currency} ` +
        `(expected ${expectedAfter.amount} ${expectedAfter.currency})`,
    );
  }
}

export class InsufficientBalanceError extends Error {
  override readonly name = 'InsufficientBalanceError';

  constructor(available: string, requested: string, currency: string) {
    super(
      `Insufficient balance: available ${available} ${currency}, requested ${requested} ${currency}`,
    );
  }
}

export class WalletCurrencyMismatchError extends Error {
  override readonly name = 'WalletCurrencyMismatchError';

  constructor(walletCurrency: string, moneyCurrency: string) {
    super(
      `Currency mismatch: wallet operates in ${walletCurrency}, got ${moneyCurrency}`,
    );
  }
}
