export class InvalidMoneyError extends Error {
  override readonly name = 'InvalidMoneyError';

  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

export class CurrencyMismatchError extends Error {
  override readonly name = 'CurrencyMismatchError';

  constructor(left: string, right: string) {
    super(`Currency mismatch: cannot operate on ${left} and ${right}`);
  }
}
