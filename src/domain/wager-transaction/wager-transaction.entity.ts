import { randomUUID } from 'crypto';
import type { Money } from '../money/money.js';
import type { LedgerDirection } from '../wallet/wallet-ledger-entry.js';
import type { FailureCode } from './failure-codes.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.enums.js';
import {
  InvalidTransactionStateError,
  OpeningKindForbiddenError,
  ReferenceRequiredError,
} from './wager-transaction.errors.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CreateWagerTransactionProps {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  nextAttemptAt?: Date | undefined;
  attempts?: number | undefined;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Terminal states set — used for guard checks
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

// ---------------------------------------------------------------------------
// WagerTransaction entity
// ---------------------------------------------------------------------------

/**
 * WagerTransaction models the lifecycle of a single wagering operation.
 *
 * State machine:
 *   PENDING            → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE  → PROCESSED | REJECTED | FAILED
 *   PROCESSED          (terminal)
 *   REJECTED           (terminal)
 *   FAILED             (terminal)
 *
 * Requirements: 3.1, 3.4, 3.5, 3.6, 5.3, 5.4, 5.5, 5.6
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _nextAttemptAt?: Date,
    private _attempts: number = 0,
  ) {}

  // -------------------------------------------------------------------------
  // Factories
  // -------------------------------------------------------------------------

  /**
   * Creates a new transaction in PENDING status.
   * Blocks OPENING kind (internal only) and validates reference requirement.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new OpeningKindForbiddenError();
    }

    const needsRef =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;

    if (needsRef && !props.referenceExternalTransactionId) {
      throw new ReferenceRequiredError(props.kind);
    }

    return new WagerTransaction(
      randomUUID(),
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(),
      WagerTransactionStatus.Pending,
      undefined, // referenceTransactionId
      undefined, // failureCode
      undefined, // processedAt
      undefined, // nextAttemptAt
      0, // attempts
    );
  }

  /** Restores from persistence without revalidating domain rules. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.nextAttemptAt,
      state.attempts ?? 0,
    );
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get attempts(): number {
    return this._attempts;
  }

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  /**
   * Incrementa tentativas e agenda próximo retry com backoff exponencial.
   * Usado pelo worker de reprocessamento de PENDING_REFERENCE.
   * Backoff: min(2^attempts * 1000ms, 300s)
   */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delayMs = Math.min(Math.pow(2, this._attempts) * 1_000, 300_000);
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }

  // -------------------------------------------------------------------------
  // Domain queries
  // -------------------------------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /**
   * Returns true when the transaction produces a balance movement.
   * LOSS records the outcome without touching the balance.
   */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** REFUND and ROLLBACK require a referenceExternalTransactionId. */
  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Returns the ledger direction this transaction produces.
   *
   * BET                → DEBIT
   * WIN / REFUND       → CREDIT
   * ROLLBACK           → inverse of the referenced transaction's direction
   * OPENING (internal) → CREDIT
   *
   * LOSS has no ledger entry — callers should guard with affectsBalance().
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return 'DEBIT';

      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return 'CREDIT';

      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new Error('ROLLBACK requires a reference transaction to determine ledger direction');
        }
        // Invert the reference direction
        return reference.ledgerDirectionFor() === 'DEBIT' ? 'CREDIT' : 'DEBIT';
      }

      case WagerTransactionKind.Loss:
        throw new Error('LOSS does not produce a ledger entry — check affectsBalance() first');
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, transition);
    }
  }
}
