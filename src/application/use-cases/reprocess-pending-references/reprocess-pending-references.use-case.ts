import { Inject, Injectable } from '@nestjs/common';
import type { Wallet } from '../../../domain/wallet/wallet.aggregate.js';
import { WagerTransaction } from '../../../domain/wager-transaction/wager-transaction.entity.js';
import { WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../../../domain/wager-transaction/failure-codes.js';
import { OutboxMessage } from '../../../domain/outbox/outbox-message.js';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../domain/events/wager-events.js';
import type { EventContext } from '../../../domain/events/integration-event.base.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../ports/unit-of-work.port.js';
import { WALLET_REPOSITORY, type WalletRepositoryPort } from '../../ports/wallet.repository.port.js';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepositoryPort,
} from '../../ports/wager-transaction.repository.port.js';
import { LEDGER_REPOSITORY, type LedgerRepositoryPort } from '../../ports/ledger.repository.port.js';
import { OUTBOX_REPOSITORY, type OutboxRepositoryPort } from '../../ports/outbox.repository.port.js';
import {
  PENDING_REFERENCE_MAX_ATTEMPTS,
  applyProcessedEffect,
  validateReference,
} from '../../services/apply-wager-effect.js';
import { WalletNotFoundError } from '../../errors/application.errors.js';

export interface ReprocessPendingReferencesResult {
  processed: number;
  rejected: number;
  stillPending: number;
}

/**
 * Reprocesses due PENDING_REFERENCE transactions.
 * Idempotent under concurrent workers via row locks (FOR UPDATE SKIP LOCKED).
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */
@Injectable()
export class ReprocessPendingReferencesUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagerTx: WagerTransactionRepositoryPort,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepositoryPort,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepositoryPort,
  ) {}

  async execute(now: Date = new Date(), limit = 50): Promise<ReprocessPendingReferencesResult> {
    const summary: ReprocessPendingReferencesResult = {
      processed: 0,
      rejected: 0,
      stillPending: 0,
    };

    for (let i = 0; i < limit; i++) {
      const outcome = await this.uow.transactional(() => this.processNextDue(now));
      if (outcome === 'empty') {
        break;
      }
      summary[outcome] += 1;
    }

    return summary;
  }

  private async processNextDue(
    now: Date,
  ): Promise<'processed' | 'rejected' | 'stillPending' | 'empty'> {
    const due = await this.wagerTx.findDuePendingReferences(now, 1);
    const tx = due[0];
    if (!tx) {
      return 'empty';
    }
    if (tx.status !== WagerTransactionStatus.PendingReference) {
      return 'empty';
    }

    const wallet = await this.wallets.findByIdForUpdate(tx.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(tx.walletId);
    }

    const referenceExternalId = tx.referenceExternalTransactionId;
    if (!referenceExternalId) {
      tx.reject(FailureCode.KindReferenceRequired);
      await this.persistRejected(tx);
      return 'rejected';
    }

    const reference = await this.wagerTx.findByProviderAndExternalId(tx.providerId, referenceExternalId);
    if (!reference) {
      return this.retryOrExpire(tx, now);
    }

    const alreadyReversed = await this.wagerTx.findProcessedReversal(
      tx.providerId,
      referenceExternalId,
      tx.kind,
    );
    const failure = validateReference(tx, reference, alreadyReversed !== null && alreadyReversed.id !== tx.id);
    if (failure) {
      tx.reject(failure);
      await this.persistRejected(tx);
      return 'rejected';
    }

    const ctx: EventContext = { correlationId: `reprocess:${tx.id}` };
    const { ledgerEntry } = applyProcessedEffect(wallet, tx, reference, now);
    await this.persistProcessed(wallet, tx, ledgerEntry, ctx);
    return 'processed';
  }

  private async retryOrExpire(
    tx: WagerTransaction,
    now: Date,
  ): Promise<'rejected' | 'stillPending'> {
    tx.scheduleRetry(now);
    if (tx.attempts >= PENDING_REFERENCE_MAX_ATTEMPTS) {
      tx.reject(FailureCode.ReferenceNotFound);
      await this.persistRejected(tx);
      return 'rejected';
    }
    await this.wagerTx.save(tx);
    return 'stillPending';
  }

  private async persistRejected(tx: WagerTransaction): Promise<void> {
    const ctx: EventContext = { correlationId: `reprocess:${tx.id}` };
    await this.wagerTx.save(tx);
    await this.outbox.save(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, ctx)));
  }

  private async persistProcessed(
    wallet: Wallet,
    tx: WagerTransaction,
    ledgerEntry: ReturnType<typeof applyProcessedEffect>['ledgerEntry'],
    ctx: EventContext,
  ): Promise<void> {
    await this.wagerTx.save(tx);
    if (tx.status === WagerTransactionStatus.Rejected) {
      await this.outbox.save(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, ctx)));
      return;
    }
    await this.wallets.save(wallet);
    if (ledgerEntry) {
      await this.ledger.append(ledgerEntry);
      await this.outbox.save(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, ctx)));
    }
    await this.outbox.save(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx)));
  }
}
