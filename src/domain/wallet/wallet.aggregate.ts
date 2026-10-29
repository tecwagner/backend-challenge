import { Money, type MoneyProps } from '../money/money.js';
import { InsufficientBalanceError, WalletCurrencyMismatchError } from './wallet.errors.js';

// ---------------------------------------------------------------------------
// Props used to open a new Wallet
// ---------------------------------------------------------------------------

export interface WalletOpenProps {
  id: string;
  playerId: string;
  currency: string;
  initialBalance?: MoneyProps;
}

// ---------------------------------------------------------------------------
// Props used to rehydrate a Wallet from persistence (no revalidation)
// ---------------------------------------------------------------------------

export interface WalletRehydrateProps {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Wallet Aggregate Root
// ---------------------------------------------------------------------------

/**
 * Wallet is the aggregate root that encapsulates a player's balance in a
 * single currency.
 *
 * Invariant: balance is never negative (Requirements 2.5, 5.2).
 * Version is incremented only when the balance changes (Requirement 2.4).
 */
export class Wallet {
  private _id: string;
  private _playerId: string;
  private _currency: string;
  private _balance: Money;
  private _version: number;
  private _createdAt: Date;
  private _updatedAt: Date;

  // Private constructor — use static factories
  private constructor(
    id: string,
    playerId: string,
    currency: string,
    balance: Money,
    version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this._id = id;
    this._playerId = playerId;
    this._currency = currency;
    this._balance = balance;
    this._version = version;
    this._createdAt = createdAt;
    this._updatedAt = updatedAt;
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /**
   * Creates a brand-new Wallet.
   * version starts at 1 (Requirement 2.4).
   * If initialBalance is not provided, the wallet opens with zero balance.
   */
  static open(props: WalletOpenProps): Wallet {
    const { id, playerId, currency, initialBalance } = props;
    const balance =
      initialBalance !== undefined
        ? Money.from(initialBalance)
        : Money.zero(currency);

    // Ensure the initialBalance currency matches the wallet currency
    if (balance.currency !== currency.toUpperCase()) {
      throw new WalletCurrencyMismatchError(currency.toUpperCase(), balance.currency);
    }

    const now = new Date();
    return new Wallet(id, playerId, currency.toUpperCase(), balance, 1, now, now);
  }

  /**
   * Restores a Wallet from persistence without revalidation.
   * Used by the repository mapper — does not apply domain rules.
   */
  static rehydrate(props: WalletRehydrateProps): Wallet {
    const { id, playerId, currency, balance, version, createdAt, updatedAt } = props;
    return new Wallet(
      id,
      playerId,
      currency,
      Money.from(balance),
      version,
      createdAt,
      updatedAt,
    );
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Debits the given amount from the wallet.
   *
   * Throws InsufficientBalanceError if the resulting balance would be negative.
   * Throws WalletCurrencyMismatchError if currencies differ.
   * Increments version on success (Requirement 2.4).
   *
   * Requirements: 2.4, 2.5, 5.1, 5.2
   */
  debit(money: Money): void {
    this.assertSameCurrency(money);

    const resultingBalance = this._balance.subtract(money);
    if (resultingBalance.isNegative()) {
      const available = this._balance.toJSON();
      const requested = money.toJSON();
      throw new InsufficientBalanceError(
        available.amount,
        requested.amount,
        this._currency,
      );
    }

    this._balance = resultingBalance;
    this._version += 1;
    this._updatedAt = new Date();
  }

  /**
   * Credits the given amount to the wallet.
   *
   * Throws WalletCurrencyMismatchError if currencies differ.
   * Increments version on success (Requirement 2.4).
   *
   * Requirements: 2.4, 5.1
   */
  credit(money: Money): void {
    this.assertSameCurrency(money);

    this._balance = this._balance.add(money);
    this._version += 1;
    this._updatedAt = new Date();
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get id(): string {
    return this._id;
  }

  get playerId(): string {
    return this._playerId;
  }

  get currency(): string {
    return this._currency;
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this._currency) {
      throw new WalletCurrencyMismatchError(this._currency, money.currency);
    }
  }
}
