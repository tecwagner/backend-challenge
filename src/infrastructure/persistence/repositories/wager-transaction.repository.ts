import { EntityManager, LockMode } from '@mikro-orm/core';
import type { WagerTransactionRepositoryPort } from '../../../application/ports/wager-transaction.repository.port.js';
import { WagerTransaction } from '../../../domain/wager-transaction/wager-transaction.entity.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction/wager-transaction.enums.js';
import type { FailureCode } from '../../../domain/wager-transaction/failure-codes.js';
import { Money } from '../../../domain/money/money.js';
import {
  WagerTransactionSchema,
  type WagerTransactionOrmEntity,
} from '../entities/wager-transaction.orm-entity.js';

export class WagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionSchema, { id });
    return row ? this.toDomain(row) : null;
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(
      WagerTransactionSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return row ? this.toDomain(row) : null;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionSchema, { idempotencyKey: key });
    return row ? this.toDomain(row) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionSchema, {
      providerId,
      externalTransactionId,
    });
    return row ? this.toDomain(row) : null;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]> {
    const conn = this.em.getConnection();
    const rows = await conn.execute<WagerTransactionOrmEntity[]>(
      `SELECT id, provider_id AS "providerId", external_transaction_id AS "externalTransactionId",
              idempotency_key AS "idempotencyKey", payload_hash AS "payloadHash",
              wallet_id AS "walletId", player_id AS "playerId", round_id AS "roundId",
              game_id AS "gameId", kind, money_amount AS "moneyAmount",
              money_currency AS "moneyCurrency",
              reference_external_transaction_id AS "referenceExternalTransactionId",
              reference_transaction_id AS "referenceTransactionId",
              status, failure_code AS "failureCode", processed_at AS "processedAt",
              next_attempt_at AS "nextAttemptAt", attempts, created_at AS "createdAt"
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY next_attempt_at ASC NULLS FIRST
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map((r: WagerTransactionOrmEntity) => this.toDomain(r));
  }

  async findProcessedReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionSchema, {
      providerId,
      referenceExternalTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return row ? this.toDomain(row) : null;
  }

  async save(tx: WagerTransaction): Promise<void> {
    const existing = await this.em.findOne(WagerTransactionSchema, { id: tx.id });

    if (existing) {
      existing.status = tx.status;
      existing.referenceTransactionId = tx.referenceTransactionId;
      existing.failureCode = tx.failureCode;
      existing.processedAt = tx.processedAt;
      existing.nextAttemptAt = tx.nextAttemptAt;
      existing.attempts = tx.attempts;
    } else {
      this.em.persist(this.em.create(WagerTransactionSchema, this.toOrm(tx)));
    }
    await this.em.flush();
  }

  private toDomain(row: WagerTransactionOrmEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind as WagerTransactionKind,
      money: Money.from({ amount: row.moneyAmount, currency: row.moneyCurrency }),
      referenceExternalTransactionId: row.referenceExternalTransactionId,
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: row.referenceTransactionId,
      failureCode: row.failureCode as FailureCode | undefined,
      processedAt: row.processedAt,
      nextAttemptAt: row.nextAttemptAt,
      attempts: row.attempts,
      createdAt: row.createdAt,
    });
  }

  private toOrm(tx: WagerTransaction): WagerTransactionOrmEntity {
    const money = tx.money.toJSON();
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      moneyAmount: money.amount,
      moneyCurrency: money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      status: tx.status,
      failureCode: tx.failureCode,
      processedAt: tx.processedAt,
      nextAttemptAt: tx.nextAttemptAt,
      attempts: tx.attempts,
      createdAt: tx.createdAt,
    };
  }
}
