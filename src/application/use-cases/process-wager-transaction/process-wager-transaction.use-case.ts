import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Money } from '../../../domain/money/money.js';
import type { Wallet } from '../../../domain/wallet/wallet.aggregate.js';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../../../domain/wager-transaction/wager-transaction.entity.js';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../../../domain/wager-transaction/failure-codes.js';
import { OutboxMessage } from '../../../domain/outbox/outbox-message.js';
import {
  WagerTransactionPendingReference,
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
  IdempotencyConflictError,
  WalletNotFoundError,
  isUniqueConstraintViolation,
} from '../../errors/application.errors.js';
import { PayloadHashService } from '../../services/payload-hash.service.js';
import { IdempotencyService } from '../../services/idempotency.service.js';
import {
  applyProcessedEffect,
  currencyMismatchCode,
  rejectOpeningOrMissingReference,
  validateReference,
} from '../../services/apply-wager-effect.js';
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from './process-wager-transaction.dto.js';

/**
 * Processes a wagering transaction with persistent idempotency and
 * pessimistic locking on the Wallet row.
 *
 * Requirements: 3.1, 4.1, 4.2, 4.5, 5.1–5.11, 6.1, 7.1, 9.1, 10.1, 10.6
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagerTx: WagerTransactionRepositoryPort,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepositoryPort,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepositoryPort,
    private readonly payloadHash: PayloadHashService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const payloadHash = this.payloadHash.compute(command);

    try {
      return await this.uow.transactional(() => this.processInsideTransaction(command, payloadHash));
    } catch (err) {
      if (err instanceof IdempotencyConflictError || err instanceof WalletNotFoundError) {
        throw err;
      }
      if (isUniqueConstraintViolation(err)) {
        return this.uow.transactional(async () => {
          const existing = await this.wagerTx.findByIdempotencyKey(command.idempotencyKey);
          const decision = this.idempotency.decide(existing, payloadHash, command.idempotencyKey);
          if (decision.kind === 'replay') {
            return this.toReplayResult(decision.transaction);
          }
          throw new IdempotencyConflictError(command.idempotencyKey);
        });
      }
      throw err;
    }
  }

  private async processInsideTransaction(
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const existing = await this.wagerTx.findByIdempotencyKey(command.idempotencyKey);
    const decision = this.idempotency.decide(existing, payloadHash, command.idempotencyKey);
    if (decision.kind === 'replay') {
      return this.toReplayResult(decision.transaction);
    }

    const wallet = await this.wallets.findByIdForUpdate(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    const money = Money.from(command.money);
    const ctx: EventContext = { correlationId: command.correlationId };
    const now = new Date();

    const contractFailure = this.contractFailure(command);
    if (contractFailure) {
      const tx = this.buildRejected(command, payloadHash, money, contractFailure, now);
      await this.persistRejected(tx, ctx);
      return this.toResult(tx, wallet, false);
    }

    const mismatch = currencyMismatchCode(wallet, money);
    if (mismatch) {
      const tx = WagerTransaction.create(this.toCreateProps(command, payloadHash, money));
      tx.reject(mismatch);
      await this.persistRejected(tx, ctx);
      return this.toResult(tx, wallet, false);
    }

    const tx = WagerTransaction.create(this.toCreateProps(command, payloadHash, money));

    if (tx.requiresReference()) {
      return this.processReversal(command, wallet, tx, ctx, now);
    }

    const { ledgerEntry } = applyProcessedEffect(wallet, tx, undefined, now);
    await this.persistOutcome(wallet, tx, ledgerEntry, ctx);
    return this.toResult(tx, wallet, false);
  }

  private async processReversal(
    command: ProcessWagerTransactionCommand,
    wallet: Wallet,
    tx: WagerTransaction,
    ctx: EventContext,
    now: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const referenceExternalId = command.referenceExternalTransactionId as string;
    const reference = await this.wagerTx.findByProviderAndExternalId(command.providerId, referenceExternalId);

    if (!reference) {
      tx.markPendingReference();
      await this.wagerTx.save(tx);
      await this.outbox.save(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, ctx)));
      return this.toResult(tx, wallet, false);
    }

    const alreadyReversed = await this.wagerTx.findProcessedReversal(
      command.providerId,
      referenceExternalId,
      tx.kind,
    );
    const failure = validateReference(tx, reference, alreadyReversed !== null);
    if (failure) {
      tx.reject(failure);
      await this.persistRejected(tx, ctx);
      return this.toResult(tx, wallet, false);
    }

    const { ledgerEntry } = applyProcessedEffect(wallet, tx, reference, now);
    await this.persistOutcome(wallet, tx, ledgerEntry, ctx);
    return this.toResult(tx, wallet, false);
  }

  private contractFailure(command: ProcessWagerTransactionCommand): FailureCode | undefined {
    try {
      WagerTransaction.create(this.toCreateProps(command, 'probe', Money.from(command.money)));
      return undefined;
    } catch (err) {
      return rejectOpeningOrMissingReference(err, command.kind) ?? undefined;
    }
  }

  private toCreateProps(
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
    money: Money,
  ): CreateWagerTransactionProps {
    const props: CreateWagerTransactionProps = {
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
    };
    if (command.referenceExternalTransactionId !== undefined) {
      props.referenceExternalTransactionId = command.referenceExternalTransactionId;
    }
    return props;
  }

  private buildRejected(
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
    money: Money,
    code: FailureCode,
    now: Date,
  ): WagerTransaction {
    const tx = WagerTransaction.rehydrate({
      id: randomUUID(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      status: WagerTransactionStatus.Pending,
      createdAt: now,
    });
    tx.reject(code);
    return tx;
  }

  private async persistRejected(tx: WagerTransaction, ctx: EventContext): Promise<void> {
    await this.wagerTx.save(tx);
    await this.outbox.save(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, ctx)));
  }

  private async persistOutcome(
    wallet: Wallet,
    tx: WagerTransaction,
    ledgerEntry: WalletLedgerEntry | undefined,
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

  private async toReplayResult(tx: WagerTransaction): Promise<ProcessWagerTransactionResult> {
    const wallet = await this.wallets.findById(tx.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(tx.walletId);
    }
    return this.toResult(tx, wallet, true);
  }

  private toResult(
    tx: WagerTransaction,
    wallet: Wallet,
    idempotentReplay: boolean,
  ): ProcessWagerTransactionResult {
    const result: ProcessWagerTransactionResult = {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay,
    };
    if (tx.failureCode !== undefined) {
      result.failureCode = tx.failureCode;
    }
    return result;
  }
}
