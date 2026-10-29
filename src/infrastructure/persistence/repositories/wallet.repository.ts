import { EntityManager, LockMode } from '@mikro-orm/core';
import type { WalletRepositoryPort } from '../../../application/ports/wallet.repository.port.js';
import { Wallet } from '../../../domain/wallet/wallet.aggregate.js';
import { WalletSchema, type WalletOrmEntity } from '../entities/wallet.orm-entity.js';

export class WalletRepository implements WalletRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return row ? this.toDomain(row) : null;
  }

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletSchema, { id });
    return row ? this.toDomain(row) : null;
  }

  async findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletSchema, { playerId, currency });
    return row ? this.toDomain(row) : null;
  }

  async save(wallet: Wallet): Promise<void> {
    const existing = await this.em.findOne(WalletSchema, { id: wallet.id });

    if (existing) {
      existing.balanceAmount = wallet.balance.toJSON().amount;
      existing.version = wallet.version;
      existing.updatedAt = wallet.updatedAt;
    } else {
      this.em.persist(this.em.create(WalletSchema, this.toOrm(wallet)));
    }
    await this.em.flush();
  }

  private toDomain(row: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance: { amount: row.balanceAmount, currency: row.currency },
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private toOrm(wallet: Wallet): WalletOrmEntity {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balanceAmount: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }
}
