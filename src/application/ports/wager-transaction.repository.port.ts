import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction.entity.js';
import type { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction.enums.js';

export interface PendingReferenceCandidate {
  id: string;
  nextAttemptAt: Date;
}

export interface WagerTransactionRepositoryPort {
  findById(id: string): Promise<WagerTransaction | null>;

  /** Row lock used by the pending-reference worker to serialize reprocessing. */
  findByIdForUpdate(id: string): Promise<WagerTransaction | null>;

  /** Lookup by idempotency key — used for deduplication before acquiring wallet lock. */
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;

  /** Lookup by (providerId, externalTransactionId) — used to resolve references. */
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;

  /** Returns PENDING_REFERENCE transactions whose nextAttemptAt <= now, up to limit. */
  findDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]>;

  /**
   * Finds a PROCESSED reversal of the given kind that already points at the
   * referenced external transaction — used to detect duplicate REFUND/ROLLBACK.
   */
  findProcessedReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null>;

  save(tx: WagerTransaction): Promise<void>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WagerTransactionRepositoryPort');
