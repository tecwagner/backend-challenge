/**
 * Stable, machine-readable failure codes carried by rejected/failed transactions.
 *
 * Taxonomy:
 *
 * BALANCE_* — business rejections related to wallet balance.
 *   BALANCE_INSUFFICIENT          : BET debit would produce a negative balance.
 *   BALANCE_REVERSAL_INSUFFICIENT : REFUND/ROLLBACK credit reversal would produce a
 *                                   negative balance (operationally distinct from a
 *                                   plain insufficient-balance bet rejection).
 *
 * REFERENCE_* — business rejections related to the referenced transaction.
 *   REFERENCE_NOT_FOUND           : reference exhausted retry limit without resolving.
 *   REFERENCE_ALREADY_REVERSED    : the referenced transaction was already reversed by
 *                                   the same operation kind.
 *   REFERENCE_INVALID_KIND        : REFUND targeting a non-BET, or ROLLBACK targeting
 *                                   an unsupported kind.
 *   REFERENCE_AMOUNT_MISMATCH     : reversal amount differs from the reference amount.
 *   REFERENCE_CONTEXT_MISMATCH    : reference belongs to a different provider, player,
 *                                   wallet, currency or round.
 *   REFERENCE_NOT_PROCESSED       : referenced transaction is not in PROCESSED state.
 *
 * IDEMPOTENCY_* — conflicts on the idempotency key.
 *   IDEMPOTENCY_PAYLOAD_CONFLICT  : same key resubmitted with a different payload hash.
 *
 * KIND_* — structural/domain violations on the transaction kind.
 *   KIND_OPENING_FORBIDDEN        : OPENING submitted via API or queue (internal only).
 *   KIND_REFERENCE_REQUIRED       : REFUND or ROLLBACK submitted without a reference.
 *
 * CURRENCY_* — currency-related violations.
 *   CURRENCY_MISMATCH             : transaction currency differs from wallet currency.
 *
 * INFRA_* — permanent infrastructure failures (status = FAILED, not REJECTED).
 *   INFRA_PERMANENT               : unrecoverable infrastructure error after retries.
 */
export enum FailureCode {
  // Balance
  BalanceInsufficient = 'BALANCE_INSUFFICIENT',
  BalanceReversalInsufficient = 'BALANCE_REVERSAL_INSUFFICIENT',

  // Reference
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',

  // Idempotency
  IdempotencyPayloadConflict = 'IDEMPOTENCY_PAYLOAD_CONFLICT',

  // Kind
  KindOpeningForbidden = 'KIND_OPENING_FORBIDDEN',
  KindReferenceRequired = 'KIND_REFERENCE_REQUIRED',

  // Currency
  CurrencyMismatch = 'CURRENCY_MISMATCH',

  // Infrastructure (terminal, auditável)
  InfraPermanent = 'INFRA_PERMANENT',
}
