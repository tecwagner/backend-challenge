import { randomUUID } from 'crypto';
import { Money, type MoneyProps } from '../money/money.js';
import { LedgerArithmeticError } from './wallet.errors.js';

// ---------------------------------------------------------------------------
// Direction type
// ---------------------------------------------------------------------------

export type LedgerDirection = 'DEBIT' | 'CREDIT';

// ---------------------------------------------------------------------------
// Props used to create a new WalletLedgerEntry
// ---------------------------------------------------------------------------

export interface WalletLedgerEntryCreateProps {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

// ---------------------------------------------------------------------------
// Props used to rehydrate a WalletLedgerEntry from persistence
// ---------------------------------------------------------------------------

export interface WalletLedgerEntryRehydrateProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// WalletLedgerEntry — Immutable Domain Object
// ---------------------------------------------------------------------------

/**
 * WalletLedgerEntry is an immutable record of a single wallet balance movement.
 *
 * Invariant: balanceBefore ± money === balanceAfter, verified in `create`.
 * No mutation methods — once created, the record is permanent.
 *
 * Requirements: 6.1, 6.2, 6.3
 */
export class WalletLedgerEntry {
  private readonly _id: string;
  private readonly _walletId: string;
  private readonly _transactionId: string;
  private readonly _direction: LedgerDirection;
  private readonly _money: Money;
  private readonly _balanceBefore: Money;
  private readonly _balanceAfter: Money;
  private readonly _createdAt: Date;

  // Private constructor — use static factories
  private constructor(
    id: string,
    walletId: string,
    transactionId: string,
    direction: LedgerDirection,
    money: Money,
    balanceBefore: Money,
    balanceAfter: Money,
    createdAt: Date,
  ) {
    this._id = id;
    this._walletId = walletId;
    this._transactionId = transactionId;
    this._direction = direction;
    this._money = money;
    this._balanceBefore = balanceBefore;
    this._balanceAfter = balanceAfter;
    this._createdAt = createdAt;
  }

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /**
   * Creates a new WalletLedgerEntry, validating the arithmetic invariant.
   *
   * CREDIT: balanceBefore + money === balanceAfter
   * DEBIT:  balanceBefore - money === balanceAfter
   *
   * Throws LedgerArithmeticError if the arithmetic does not hold.
   *
   * Requirements: 6.2
   */
  static create(props: WalletLedgerEntryCreateProps): WalletLedgerEntry {
    const { walletId, transactionId, direction, money, balanceBefore, balanceAfter } = props;

    const expectedAfter =
      direction === 'CREDIT'
        ? balanceBefore.add(money)
        : balanceBefore.subtract(money);

    if (!expectedAfter.equals(balanceAfter)) {
      throw new LedgerArithmeticError(
        direction,
        balanceBefore.toJSON(),
        money.toJSON(),
        balanceAfter.toJSON(),
        expectedAfter.toJSON(),
      );
    }

    return new WalletLedgerEntry(
      randomUUID(),
      walletId,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      new Date(),
    );
  }

  /**
   * Restores a WalletLedgerEntry from persistence without revalidation.
   * Used by the repository mapper — does not apply domain rules.
   *
   * Requirements: 6.3
   */
  static rehydrate(props: WalletLedgerEntryRehydrateProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      Money.from(props.money),
      Money.from(props.balanceBefore),
      Money.from(props.balanceAfter),
      props.createdAt,
    );
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Returns true if the arithmetic invariant holds:
   *   CREDIT: balanceBefore + money === balanceAfter
   *   DEBIT:  balanceBefore - money === balanceAfter
   *
   * Requirements: 6.2
   */
  isBalanced(): boolean {
    const expected =
      this._direction === 'CREDIT'
        ? this._balanceBefore.add(this._money)
        : this._balanceBefore.subtract(this._money);

    return expected.equals(this._balanceAfter);
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get id(): string {
    return this._id;
  }

  get walletId(): string {
    return this._walletId;
  }

  get transactionId(): string {
    return this._transactionId;
  }

  get direction(): LedgerDirection {
    return this._direction;
  }

  get money(): Money {
    return this._money;
  }

  get balanceBefore(): Money {
    return this._balanceBefore;
  }

  get balanceAfter(): Money {
    return this._balanceAfter;
  }

  get createdAt(): Date {
    return this._createdAt;
  }
}
