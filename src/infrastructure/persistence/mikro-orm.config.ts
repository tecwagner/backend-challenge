import { defineConfig } from '@mikro-orm/postgresql';
import { InboxMessageSchema } from './entities/inbox-message.orm-entity.js';
import { OutboxMessageSchema } from './entities/outbox-message.orm-entity.js';
import { WagerTransactionSchema } from './entities/wager-transaction.orm-entity.js';
import { WalletLedgerEntrySchema } from './entities/wallet-ledger-entry.orm-entity.js';
import { WalletSchema } from './entities/wallet.orm-entity.js';

export default defineConfig({
  clientUrl: process.env['DATABASE_URL'] ?? 'postgresql://wagering:wagering@localhost:5432/wagering',

  entities: [
    WalletSchema,
    WagerTransactionSchema,
    WalletLedgerEntrySchema,
    InboxMessageSchema,
    OutboxMessageSchema,
  ],

  migrations: {
    path: 'src/infrastructure/persistence/migrations',
    pathTs: 'src/infrastructure/persistence/migrations',
  },

  // Note: pg driver returns NUMERIC columns as strings by default (OID 1700),
  // preserving exact decimal representation without needing custom driverOptions.

  forceUtcTimezone: true,

  debug: process.env['NODE_ENV'] === 'development',
});
