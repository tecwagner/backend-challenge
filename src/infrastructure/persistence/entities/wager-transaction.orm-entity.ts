import { EntitySchema } from '@mikro-orm/core';

export interface WagerTransactionOrmEntity {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  /** Stored as NUMERIC(19,2); driver returns string to preserve precision. */
  moneyAmount: string;
  moneyCurrency: string;
  referenceExternalTransactionId: string | undefined;
  referenceTransactionId: string | undefined;
  status: string;
  failureCode: string | undefined;
  processedAt: Date | undefined;
  nextAttemptAt: Date | undefined;
  attempts: number;
  createdAt: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionOrmEntity>({
  name: 'WagerTransaction',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key', unique: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    moneyAmount: { type: 'string', fieldName: 'money_amount', columnType: 'numeric(19,2)' },
    moneyCurrency: { type: 'string', fieldName: 'money_currency', length: 3, columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'string', fieldName: 'reference_external_transaction_id', nullable: true },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    processedAt: { type: 'Date', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true },
    attempts: { type: 'integer' },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
  },
  uniques: [{ properties: ['providerId', 'externalTransactionId'] }],
});
