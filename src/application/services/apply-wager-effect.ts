import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.aggregate.js';
import { InsufficientBalanceError, WalletCurrencyMismatchError } from '../../domain/wallet/wallet.errors.js';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction.entity.js';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../../domain/wager-transaction/failure-codes.js';
import {
  OpeningKindForbiddenError,
  ReferenceRequiredError,
} from '../../domain/wager-transaction/wager-transaction.errors.js';

export const PENDING_REFERENCE_MAX_ATTEMPTS = 10;

export interface ApplyEffectResult {
  ledgerEntry: WalletLedgerEntry | undefined;
}

/**
 * Applies the financial effect of a WagerTransaction on a locked Wallet.
 * Mutates `tx` (status/failureCode) and `wallet` (balance/version).
 * Returns a ledger entry only when the balance actually changes.
 */
export function applyProcessedEffect(
  wallet: Wallet,
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  at: Date,
): ApplyEffectResult {
  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, at);
    return { ledgerEntry: undefined };
  }

  const direction = tx.ledgerDirectionFor(reference);
  const balanceBefore = wallet.balance;

  try {
    if (direction === 'DEBIT') {
      wallet.debit(tx.money);
    } else {
      wallet.credit(tx.money);
    }
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      tx.reject(
        tx.kind === WagerTransactionKind.Bet
          ? FailureCode.BalanceInsufficient
          : FailureCode.BalanceReversalInsufficient,
      );
      return { ledgerEntry: undefined };
    }
    throw err;
  }

  const entry = WalletLedgerEntry.create({
    walletId: wallet.id,
    transactionId: tx.id,
    direction,
    money: tx.money,
    balanceBefore,
    balanceAfter: wallet.balance,
  });
  tx.markProcessed(reference?.id, at);
  return { ledgerEntry: entry };
}

export function rejectOpeningOrMissingReference(err: unknown, commandKind: WagerTransactionKind): FailureCode | null {
  if (err instanceof OpeningKindForbiddenError || commandKind === WagerTransactionKind.Opening) {
    return FailureCode.KindOpeningForbidden;
  }
  if (err instanceof ReferenceRequiredError) {
    return FailureCode.KindReferenceRequired;
  }
  return null;
}

export function validateReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): FailureCode | undefined {
  if (alreadyReversed) {
    return FailureCode.ReferenceAlreadyReversed;
  }

  const sameContext =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.roundId === tx.roundId &&
    reference.money.currency === tx.money.currency;

  if (!sameContext) {
    return FailureCode.ReferenceContextMismatch;
  }

  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }

  if (tx.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) {
    return FailureCode.ReferenceInvalidKind;
  }

  if (
    tx.kind === WagerTransactionKind.Rollback &&
    reference.kind !== WagerTransactionKind.Bet &&
    reference.kind !== WagerTransactionKind.Win &&
    reference.kind !== WagerTransactionKind.Refund
  ) {
    return FailureCode.ReferenceInvalidKind;
  }

  if (!reference.money.equals(tx.money)) {
    return FailureCode.ReferenceAmountMismatch;
  }

  return undefined;
}

export function currencyMismatchCode(wallet: Wallet, money: Money): FailureCode | undefined {
  if (wallet.currency !== money.currency) {
    return FailureCode.CurrencyMismatch;
  }
  return undefined;
}

export function isCurrencyDomainError(err: unknown): boolean {
  return err instanceof WalletCurrencyMismatchError;
}
