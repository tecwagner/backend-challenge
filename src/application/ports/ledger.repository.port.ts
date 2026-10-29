import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Opaque cursor for the next page; undefined when no more pages exist. */
  nextCursor: string | undefined;
}

export interface LedgerRepositoryPort {
  /** Persists a new ledger entry. No update or delete — ledger is append-only. */
  append(entry: WalletLedgerEntry): Promise<void>;

  /** Returns a stable cursor-paginated page of entries for a wallet, newest first. */
  findByWalletId(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage>;

  /** Sums all entries for a wallet to reconstruct the balance from scratch (reconciliation). */
  sumByWalletId(walletId: string): Promise<{ calculatedAmount: string; currency: string; checkedEntries: number }>;
}

export const LEDGER_REPOSITORY = Symbol('LedgerRepositoryPort');
