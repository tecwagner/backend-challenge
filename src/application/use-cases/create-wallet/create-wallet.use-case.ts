import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Money } from '../../../domain/money/money.js';
import { Wallet } from '../../../domain/wallet/wallet.aggregate.js';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import { WagerTransaction } from '../../../domain/wager-transaction/wager-transaction.entity.js';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction.enums.js';
import { OutboxMessage } from '../../../domain/outbox/outbox-message.js';
import { WalletBalanceChanged, WagerTransactionProcessed } from '../../../domain/events/wager-events.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../ports/unit-of-work.port.js';
import { WALLET_REPOSITORY, type WalletRepositoryPort } from '../../ports/wallet.repository.port.js';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepositoryPort,
} from '../../ports/wager-transaction.repository.port.js';
import { LEDGER_REPOSITORY, type LedgerRepositoryPort } from '../../ports/ledger.repository.port.js';
import { OUTBOX_REPOSITORY, type OutboxRepositoryPort } from '../../ports/outbox.repository.port.js';
import { WalletAlreadyExistsError, isUniqueConstraintViolation } from '../../errors/application.errors.js';
import { PayloadHashService } from '../../services/payload-hash.service.js';
import type { CreateWalletCommand, CreateWalletResult } from './create-wallet.dto.js';

/** Internal provider id used for OPENING transactions — never accepted from API/SQS. */
export const INTERNAL_OPENING_PROVIDER = 'system';

/**
 * Opens a Wallet. When initialBalance > 0, persists an internal OPENING
 * WagerTransaction and a CREDIT ledger entry in the same SQL transaction.
 *
 * Requirements: 2.1, 2.2, 2.3, 6.1
 */
@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepositoryPort,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly wagerTx: WagerTransactionRepositoryPort,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepositoryPort,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepositoryPort,
    private readonly payloadHash: PayloadHashService,
  ) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    const currency = command.currency.toUpperCase();

    try {
      return await this.uow.transactional(async () => {
        const existing = await this.wallets.findByPlayerIdAndCurrency(command.playerId, currency);
        if (existing) {
          throw new WalletAlreadyExistsError(command.playerId, currency);
        }

        const initial =
          command.initialBalance !== undefined
            ? Money.from(command.initialBalance)
            : Money.zero(currency);

        const wallet = Wallet.open({
          id: randomUUID(),
          playerId: command.playerId,
          currency,
          initialBalance: initial.toJSON(),
        });

        await this.wallets.save(wallet);

        if (initial.isPositive()) {
          await this.persistOpening(wallet, initial, command.correlationId);
        }

        return {
          walletId: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (err) {
      if (err instanceof WalletAlreadyExistsError) {
        throw err;
      }
      if (isUniqueConstraintViolation(err)) {
        throw new WalletAlreadyExistsError(command.playerId, currency);
      }
      throw err;
    }
  }

  private async persistOpening(wallet: Wallet, money: Money, correlationId: string): Promise<void> {
    const now = new Date();
    const externalTransactionId = `opening:${wallet.id}`;
    const payloadHash = this.payloadHash.compute({
      providerId: INTERNAL_OPENING_PROVIDER,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `opening:${wallet.id}`,
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: money.toJSON(),
    });

    const tx = WagerTransaction.rehydrate({
      id: randomUUID(),
      providerId: INTERNAL_OPENING_PROVIDER,
      externalTransactionId,
      idempotencyKey: `${INTERNAL_OPENING_PROVIDER}:${externalTransactionId}`,
      payloadHash,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: `opening:${wallet.id}`,
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money,
      status: WagerTransactionStatus.Processed,
      processedAt: now,
      createdAt: now,
    });

    const entry = WalletLedgerEntry.create({
      walletId: wallet.id,
      transactionId: tx.id,
      direction: 'CREDIT',
      money,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance,
    });

    const ctx = { correlationId };
    await this.wagerTx.save(tx);
    await this.ledger.append(entry);
    await this.outbox.save(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx)));
    await this.outbox.save(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx)));
  }
}
