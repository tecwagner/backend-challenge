export class WalletNotFoundError extends Error {
  override readonly name = 'WalletNotFoundError';

  constructor(walletId: string) {
    super(`Wallet not found: ${walletId}`);
  }
}

export class WalletAlreadyExistsError extends Error {
  override readonly name = 'WalletAlreadyExistsError';

  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player ${playerId} and currency ${currency}`);
  }
}

export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';

  constructor(idempotencyKey: string) {
    super(`Idempotency key '${idempotencyKey}' was reused with a different payload`);
  }
}

export function isUniqueConstraintViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const candidate = err as { name?: string; code?: string };
  return candidate.name === 'UniqueConstraintViolationException' || candidate.code === '23505';
}
