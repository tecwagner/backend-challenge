import { EntityManager } from '@mikro-orm/core';
import type { LedgerPage, LedgerRepositoryPort } from '../../../application/ports/ledger.repository.port.js';
import { WalletLedgerEntry, type LedgerDirection } from '../../../domain/wallet/wallet-ledger-entry.js';
import {
  WalletLedgerEntrySchema,
  type WalletLedgerEntryOrmEntity,
} from '../entities/wallet-ledger-entry.orm-entity.js';

import { decodeLedgerCursor, encodeLedgerCursor } from '../../../http/pagination/ledger-cursor.js';

export class LedgerRepository implements LedgerRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(
      this.em.create(WalletLedgerEntrySchema, {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        moneyAmount: entry.money.toJSON().amount,
        moneyCurrency: entry.money.toJSON().currency,
        balanceBefore: entry.balanceBefore.toJSON().amount,
        balanceAfter: entry.balanceAfter.toJSON().amount,
        createdAt: entry.createdAt,
      }),
    );
  }

  async findByWalletId(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LedgerPage> {
    const decoded = cursor ? decodeLedgerCursor(cursor) : null;

    const conn = this.em.getConnection();
    const params: unknown[] = [walletId];
    let cursorClause = '';

    if (decoded) {
      cursorClause = 'AND (created_at > ? OR (created_at = ? AND id > ?))';
      const cursorDate = new Date(decoded.createdAt);
      params.push(cursorDate, cursorDate, decoded.id);
    }

    params.push(limit + 1);

    const rows = await conn.execute<WalletLedgerEntryOrmEntity[]>(
      `SELECT id, wallet_id AS "walletId", transaction_id AS "transactionId",
              direction, money_amount AS "moneyAmount", money_currency AS "moneyCurrency",
              balance_before AS "balanceBefore", balance_after AS "balanceAfter",
              created_at AS "createdAt"
       FROM wallet_ledger_entries
       WHERE wallet_id = ? ${cursorClause}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      params,
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeLedgerCursor({
            id: lastRow.id,
            createdAt: new Date(lastRow.createdAt).toISOString(),
          })
        : undefined;

    return { entries: page.map((r: WalletLedgerEntryOrmEntity) => this.toDomain(r)), nextCursor };
  }

  async sumByWalletId(
    walletId: string,
  ): Promise<{ calculatedAmount: string; currency: string; checkedEntries: number }> {
    const conn = this.em.getConnection();
    const rows = await conn.execute<
      Array<{ calculated_amount: string; currency: string; checked_entries: string }>
    >(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN money_amount ELSE -money_amount END), 0)::text AS calculated_amount,
         COALESCE(MAX(money_currency), 'BRL') AS currency,
         COUNT(*)::text AS checked_entries
       FROM wallet_ledger_entries
       WHERE wallet_id = ?`,
      [walletId],
    );

    const row = rows[0];
    return {
      calculatedAmount: row?.calculated_amount ?? '0.00',
      currency: row?.currency ?? 'BRL',
      checkedEntries: Number(row?.checked_entries ?? 0),
    };
  }

  private toDomain(row: WalletLedgerEntryOrmEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.walletId,
      transactionId: row.transactionId,
      direction: row.direction as LedgerDirection,
      money: { amount: row.moneyAmount, currency: row.moneyCurrency },
      balanceBefore: { amount: row.balanceBefore, currency: row.moneyCurrency },
      balanceAfter: { amount: row.balanceAfter, currency: row.moneyCurrency },
      createdAt: new Date(row.createdAt),
    });
  }
}
