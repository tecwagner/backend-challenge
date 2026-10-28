import { EntitySchema } from '@mikro-orm/core';

export interface WalletLedgerEntryOrmEntity {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  /** All monetary columns stored as NUMERIC(19,2); driver returns string. */
  moneyAmount: string;
  moneyCurrency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

// Re-export schema name constant for type-safe em.findOne() calls
export const WALLET_LEDGER_ENTRY_ENTITY = 'WalletLedgerEntry' as const;

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryOrmEntity>({
  name: 'WalletLedgerEntry',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    moneyAmount: { type: 'string', fieldName: 'money_amount', columnType: 'numeric(19,2)' },
    moneyCurrency: { type: 'string', fieldName: 'money_currency', length: 3, columnType: 'char(3)' },
    balanceBefore: { type: 'string', fieldName: 'balance_before', columnType: 'numeric(19,2)' },
    balanceAfter: { type: 'string', fieldName: 'balance_after', columnType: 'numeric(19,2)' },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
  },
  uniques: [{ properties: ['transactionId', 'walletId'] }],
  indexes: [{ properties: ['walletId', 'createdAt'] }],
});
