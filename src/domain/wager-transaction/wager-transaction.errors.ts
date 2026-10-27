import type { WagerTransactionStatus } from './wager-transaction.enums.js';

export class InvalidTransactionStateError extends Error {
  override readonly name = 'InvalidTransactionStateError';

  constructor(currentStatus: WagerTransactionStatus, attemptedTransition: string) {
    super(
      `Cannot apply '${attemptedTransition}' to a transaction in terminal state '${currentStatus}'`,
    );
  }
}

export class OpeningKindForbiddenError extends Error {
  override readonly name = 'OpeningKindForbiddenError';

  constructor() {
    super('OPENING transactions cannot be created via API or queue — internal use only');
  }
}

export class ReferenceRequiredError extends Error {
  override readonly name = 'ReferenceRequiredError';

  constructor(kind: string) {
    super(`Transaction of kind '${kind}' requires a referenceExternalTransactionId`);
  }
}
