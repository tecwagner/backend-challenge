import type { Wallet } from '../../domain/wallet/wallet.aggregate.js';

export interface WalletRepositoryPort {
  /** Finds a wallet by id and acquires a row-level write lock (SELECT FOR UPDATE). */
  findByIdForUpdate(id: string): Promise<Wallet | null>;

  findById(id: string): Promise<Wallet | null>;

  findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;

  save(wallet: Wallet): Promise<void>;
}

export const WALLET_REPOSITORY = Symbol('WalletRepositoryPort');
