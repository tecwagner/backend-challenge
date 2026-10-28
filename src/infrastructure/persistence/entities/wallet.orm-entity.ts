import { EntitySchema } from '@mikro-orm/core';

export interface WalletOrmEntity {
  id: string;
  playerId: string;
  currency: string;
  /** Stored as NUMERIC(19,2); driver returns string to preserve precision. */
  balanceAmount: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletOrmEntity>({
  name: 'Wallet',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', length: 3, columnType: 'char(3)' },
    balanceAmount: { type: 'string', fieldName: 'balance_amount', columnType: 'numeric(19,2)' },
    version: { type: 'integer' },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', fieldName: 'updated_at', columnType: 'timestamptz' },
  },
  uniques: [{ properties: ['playerId', 'currency'] }],
  indexes: [],
});
