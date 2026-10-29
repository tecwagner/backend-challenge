import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './money.errors.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_EVEN });

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_REGEX = /^\d+(\.\d{1,2})?$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  static from({ amount, currency }: MoneyProps): Money {
    if (!amount || amount.trim() === '') {
      throw new InvalidMoneyError('empty amount');
    }
    if (!AMOUNT_REGEX.test(amount)) {
      throw new InvalidMoneyError(`invalid format: ${amount}`);
    }
    const d = new Decimal(amount);
    if (d.isNaN() || !d.isFinite()) {
      throw new InvalidMoneyError('NaN or Infinity');
    }
    if (d.isNegative()) {
      throw new InvalidMoneyError('negative amount');
    }
    if (d.decimalPlaces() > 2) {
      throw new InvalidMoneyError('too many decimal places');
    }
    return new Money(d, currency.toUpperCase());
  }

  static zero(currency: string): Money {
    return new Money(new Decimal('0'), currency.toUpperCase());
  }

  // -------------------------------------------------------------------------
  // Arithmetic — each operation returns a new Money instance (immutability)
  // -------------------------------------------------------------------------

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  // -------------------------------------------------------------------------
  // Predicates
  // -------------------------------------------------------------------------

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  /** Serializes with exactly 2 decimal places as required by the external contract. */
  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
