import { Global, Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { UNIT_OF_WORK } from '../../application/ports/unit-of-work.port.js';
import { WALLET_REPOSITORY } from '../../application/ports/wallet.repository.port.js';
import { WAGER_TRANSACTION_REPOSITORY } from '../../application/ports/wager-transaction.repository.port.js';
import { LEDGER_REPOSITORY } from '../../application/ports/ledger.repository.port.js';
import { OUTBOX_REPOSITORY } from '../../application/ports/outbox.repository.port.js';
import { INBOX_REPOSITORY } from '../../application/ports/inbox.repository.port.js';
import { UnitOfWorkAdapter } from './unit-of-work.adapter.js';
import { WalletRepository } from './repositories/wallet.repository.js';
import { WagerTransactionRepository } from './repositories/wager-transaction.repository.js';
import { LedgerRepository } from './repositories/ledger.repository.js';
import { OutboxRepository } from './repositories/outbox.repository.js';
import { InboxRepository } from './repositories/inbox.repository.js';

const providers = [
  {
    provide: UNIT_OF_WORK,
    useFactory: (em: EntityManager) => new UnitOfWorkAdapter(em),
    inject: [EntityManager],
  },
  {
    provide: WALLET_REPOSITORY,
    useFactory: (em: EntityManager) => new WalletRepository(em),
    inject: [EntityManager],
  },
  {
    provide: WAGER_TRANSACTION_REPOSITORY,
    useFactory: (em: EntityManager) => new WagerTransactionRepository(em),
    inject: [EntityManager],
  },
  {
    provide: LEDGER_REPOSITORY,
    useFactory: (em: EntityManager) => new LedgerRepository(em),
    inject: [EntityManager],
  },
  {
    provide: OUTBOX_REPOSITORY,
    useFactory: (em: EntityManager) => new OutboxRepository(em),
    inject: [EntityManager],
  },
  {
    provide: INBOX_REPOSITORY,
    useFactory: (em: EntityManager) => new InboxRepository(em),
    inject: [EntityManager],
  },
];

@Global()
@Module({
  providers,
  exports: providers,
})
export class PersistenceModule {}
