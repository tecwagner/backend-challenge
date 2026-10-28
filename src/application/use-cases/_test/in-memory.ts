import { Money } from '../../../domain/money/money.js';
import { Wallet } from '../../../domain/wallet/wallet.aggregate.js';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import { WagerTransaction } from '../../../domain/wager-transaction/wager-transaction.entity.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction/wager-transaction.enums.js';
import { OutboxMessage } from '../../../domain/outbox/outbox-message.js';
import type { UnitOfWorkPort } from '../../ports/unit-of-work.port.js';
import type { WalletRepositoryPort } from '../../ports/wallet.repository.port.js';
import type { WagerTransactionRepositoryPort } from '../../ports/wager-transaction.repository.port.js';
import type { LedgerRepositoryPort, LedgerPage } from '../../ports/ledger.repository.port.js';
import type { OutboxRepositoryPort } from '../../ports/outbox.repository.port.js';
import type { MetricsPort } from '../../ports/metrics.port.js';
import { PayloadHashService } from '../../services/payload-hash.service.js';
import { IdempotencyService } from '../../services/idempotency.service.js';
import { CreateWalletUseCase } from '../create-wallet/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from '../process-wager-transaction/process-wager-transaction.use-case.js';
import { ReconcileWalletUseCase } from '../reconcile-wallet/reconcile-wallet.use-case.js';
import { ReprocessPendingReferencesUseCase } from '../reprocess-pending-references/reprocess-pending-references.use-case.js';

export class SerialUnitOfWork implements UnitOfWorkPort {
  private queue: Promise<unknown> = Promise.resolve();

  transactional<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => work());
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export class InMemoryWalletRepository implements WalletRepositoryPort {
  readonly byId = new Map<string, Wallet>();

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    return this.byId.get(id) ?? null;
  }

  async findById(id: string): Promise<Wallet | null> {
    return this.byId.get(id) ?? null;
  }

  async findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    for (const wallet of this.byId.values()) {
      if (wallet.playerId === playerId && wallet.currency === currency.toUpperCase()) {
        return wallet;
      }
    }
    return null;
  }

  async save(wallet: Wallet): Promise<void> {
    this.byId.set(wallet.id, wallet);
  }
}

export class InMemoryWagerTransactionRepository implements WagerTransactionRepositoryPort {
  readonly byId = new Map<string, WagerTransaction>();

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    for (const tx of this.byId.values()) {
      if (tx.idempotencyKey === key) return tx;
    }
    return null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    for (const tx of this.byId.values()) {
      if (tx.providerId === providerId && tx.externalTransactionId === externalTransactionId) {
        return tx;
      }
    }
    return null;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]> {
    const due: WagerTransaction[] = [];
    for (const tx of this.byId.values()) {
      if (tx.status !== WagerTransactionStatus.PendingReference) continue;
      if (tx.nextAttemptAt !== undefined && tx.nextAttemptAt > now) continue;
      due.push(tx);
      if (due.length >= limit) break;
    }
    return due;
  }

  async findProcessedReversal(
    providerId: string,
    referenceExternalTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null> {
    for (const tx of this.byId.values()) {
      if (
        tx.providerId === providerId &&
        tx.referenceExternalTransactionId === referenceExternalTransactionId &&
        tx.kind === kind &&
        tx.status === WagerTransactionStatus.Processed
      ) {
        return tx;
      }
    }
    return null;
  }

  async save(tx: WagerTransaction): Promise<void> {
    const existing = await this.findByIdempotencyKey(tx.idempotencyKey);
    if (existing && existing.id !== tx.id) {
      const err = new Error('unique violation') as Error & { code: string };
      err.code = '23505';
      throw err;
    }
    this.byId.set(tx.id, tx);
  }
}

export class InMemoryLedgerRepository implements LedgerRepositoryPort {
  readonly entries: WalletLedgerEntry[] = [];

  async append(entry: WalletLedgerEntry): Promise<void> {
    if (this.entries.some((e) => e.transactionId === entry.transactionId && e.walletId === entry.walletId)) {
      throw new Error('duplicate ledger entry');
    }
    this.entries.push(entry);
  }

  async findByWalletId(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const { decodeLedgerCursor, encodeLedgerCursor } = await import('../../../http/pagination/ledger-cursor.js');
    const decoded = cursor ? decodeLedgerCursor(cursor) : null;
    const sorted = this.entries
      .filter((e) => e.walletId === walletId)
      .sort((a, b) => {
        const diff = a.createdAt.getTime() - b.createdAt.getTime();
        if (diff !== 0) return diff;
        return a.id.localeCompare(b.id);
      });

    const filtered = decoded
      ? sorted.filter((e) => {
          const eTime = e.createdAt.getTime();
          const cTime = new Date(decoded.createdAt).getTime();
          if (eTime > cTime) return true;
          if (eTime === cTime && e.id > decoded.id) return true;
          return false;
        })
      : sorted;

    const hasMore = filtered.length > limit;
    const page = hasMore ? filtered.slice(0, limit) : filtered;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeLedgerCursor({
            id: last.id,
            createdAt: last.createdAt.toISOString(),
          })
        : undefined;

    return { entries: page, nextCursor };
  }

  async sumByWalletId(
    walletId: string,
  ): Promise<{ calculatedAmount: string; currency: string; checkedEntries: number }> {
    const entries = this.entries.filter((e) => e.walletId === walletId);
    if (entries.length === 0) {
      return { calculatedAmount: '0.00', currency: 'BRL', checkedEntries: 0 };
    }
    let total = Money.zero(entries[0]!.money.currency);
    for (const entry of entries) {
      total = entry.direction === 'CREDIT' ? total.add(entry.money) : total.subtract(entry.money);
    }
    return {
      calculatedAmount: total.toJSON().amount,
      currency: total.currency,
      checkedEntries: entries.length,
    };
  }
}

export class InMemoryOutboxRepository implements OutboxRepositoryPort {
  readonly messages: OutboxMessage[] = [];

  async save(message: OutboxMessage): Promise<void> {
    this.messages.push(message);
  }

  async claimDue(_now: Date, _limit: number): Promise<OutboxMessage[]> {
    return this.messages.filter((m) => m.isPending());
  }

  async update(_message: OutboxMessage): Promise<void> {
    // no-op for use-case tests
  }
}

export class RecordingMetrics implements MetricsPort {
  divergences = 0;
  incrementReconciliationDivergences(): void {
    this.divergences += 1;
  }
}

export interface MemoryWorld {
  uow: SerialUnitOfWork;
  wallets: InMemoryWalletRepository;
  wagerTx: InMemoryWagerTransactionRepository;
  ledger: InMemoryLedgerRepository;
  outbox: InMemoryOutboxRepository;
  metrics: RecordingMetrics;
  createWallet: CreateWalletUseCase;
  processTx: ProcessWagerTransactionUseCase;
  reconcile: ReconcileWalletUseCase;
  reprocess: ReprocessPendingReferencesUseCase;
}

export function createMemoryWorld(): MemoryWorld {
  const uow = new SerialUnitOfWork();
  const wallets = new InMemoryWalletRepository();
  const wagerTx = new InMemoryWagerTransactionRepository();
  const ledger = new InMemoryLedgerRepository();
  const outbox = new InMemoryOutboxRepository();
  const metrics = new RecordingMetrics();
  const payloadHash = new PayloadHashService();
  const idempotency = new IdempotencyService();

  return {
    uow,
    wallets,
    wagerTx,
    ledger,
    outbox,
    metrics,
    createWallet: new CreateWalletUseCase(uow, wallets, wagerTx, ledger, outbox, payloadHash),
    processTx: new ProcessWagerTransactionUseCase(uow, wallets, wagerTx, ledger, outbox, payloadHash, idempotency),
    reconcile: new ReconcileWalletUseCase(uow, wallets, ledger, metrics),
    reprocess: new ReprocessPendingReferencesUseCase(uow, wallets, wagerTx, ledger, outbox),
  };
}
