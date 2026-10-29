import type { MoneyProps } from '../money/money.js';
import type { LedgerDirection } from '../wallet/wallet-ledger-entry.js';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry.js';
import type { Wallet } from '../wallet/wallet.aggregate.js';
import type { WagerTransaction } from '../wager-transaction/wager-transaction.entity.js';
import type { FailureCode } from '../wager-transaction/failure-codes.js';
import type { WagerTransactionKind, WagerTransactionStatus } from '../wager-transaction/wager-transaction.enums.js';
import { IntegrationEvent, type EventContext, type IntegrationEventProps } from './integration-event.base.js';

// ---------------------------------------------------------------------------
// WagerTransactionProcessed
// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  processedAt: string; // ISO-8601
}

/**
 * Emitted for every transaction that reaches PROCESSED status,
 * including LOSS (which does not affect balance).
 *
 * Requirements: 11.1
 */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed' as const;
  readonly version = 1 as const;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined && { causationId: ctx.causationId }),
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        playerId: tx.playerId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        status: tx.status,
        money: tx.money.toJSON(),
        processedAt: (tx.processedAt ?? new Date()).toISOString(),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// WagerTransactionRejected
// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
}

/**
 * Emitted when a transaction is rejected by a business rule.
 *
 * Requirements: 11.2
 */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected' as const;
  readonly version = 1 as const;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) {
      throw new Error(`WagerTransaction ${tx.id} has no failureCode — cannot emit WagerTransactionRejected`);
    }
    return new WagerTransactionRejected({
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined && { causationId: ctx.causationId }),
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        playerId: tx.playerId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: tx.failureCode,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// WagerTransactionPendingReference
// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string;
}

/**
 * Emitted when a REFUND or ROLLBACK arrives before its reference transaction.
 *
 * Requirements: 11.3
 */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference' as const;
  readonly version = 1 as const;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!tx.referenceExternalTransactionId) {
      throw new Error(`WagerTransaction ${tx.id} has no referenceExternalTransactionId`);
    }
    return new WagerTransactionPendingReference({
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined && { causationId: ctx.causationId }),
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        playerId: tx.playerId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// WalletBalanceChanged
// ---------------------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/**
 * Emitted only when the wallet balance actually changes (not for LOSS or REJECTED).
 *
 * Requirements: 11.4
 */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged' as const;
  readonly version = 1 as const;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined && { causationId: ctx.causationId }),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
