import { describe, expect, it, beforeEach } from 'bun:test';
import { randomUUID } from 'crypto';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { WalletController } from './wallet.controller.js';
import { decodeLedgerCursor, encodeLedgerCursor } from '../pagination/ledger-cursor.js';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet/reconcile-wallet.use-case.js';
import {
  InMemoryLedgerRepository,
  InMemoryOutboxRepository,
  SerialUnitOfWork,
  InMemoryWagerTransactionRepository,
  InMemoryWalletRepository,
} from '../../application/use-cases/_test/in-memory.js';
import { PayloadHashService } from '../../application/services/payload-hash.service.js';
import { NoopMetrics } from '../../application/ports/metrics.port.js';
import { Wallet } from '../../domain/wallet/wallet.aggregate.js';
import { Money } from '../../domain/money/money.js';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';

describe('Ledger Cursor pagination helper', () => {
  it('encodes and decodes valid cursor correctly (round-trip)', () => {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const encoded = encodeLedgerCursor({ id, createdAt });

    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = decodeLedgerCursor(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(id);
    expect(decoded?.createdAt).toBe(createdAt);
  });

  it('returns null for invalid base64 or malformed payload', () => {
    expect(decodeLedgerCursor('invalid-base64-content!@#$%')).toBeNull();
    expect(decodeLedgerCursor(Buffer.from('{"id": 123}').toString('base64url'))).toBeNull();
    expect(
      decodeLedgerCursor(
        Buffer.from('{"id": "abc", "createdAt": "not-a-date"}').toString('base64url'),
      ),
    ).toBeNull();
    expect(decodeLedgerCursor('')).toBeNull();
  });
});

describe('WalletController', () => {
  let uow: SerialUnitOfWork;
  let walletsRepo: InMemoryWalletRepository;
  let wagerTxRepo: InMemoryWagerTransactionRepository;
  let ledgerRepo: InMemoryLedgerRepository;
  let outboxRepo: InMemoryOutboxRepository;
  let createWalletUseCase: CreateWalletUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;
  let controller: WalletController;

  beforeEach(() => {
    uow = new SerialUnitOfWork();
    walletsRepo = new InMemoryWalletRepository();
    wagerTxRepo = new InMemoryWagerTransactionRepository();
    ledgerRepo = new InMemoryLedgerRepository();
    outboxRepo = new InMemoryOutboxRepository();

    createWalletUseCase = new CreateWalletUseCase(
      uow,
      walletsRepo,
      wagerTxRepo,
      ledgerRepo,
      outboxRepo,
      new PayloadHashService(),
    );

    reconcileWalletUseCase = new ReconcileWalletUseCase(
      uow,
      walletsRepo,
      ledgerRepo,
      new NoopMetrics(),
    );

    controller = new WalletController(
      createWalletUseCase,
      reconcileWalletUseCase,
      walletsRepo,
      ledgerRepo,
    );
  });

  describe('POST /wallets', () => {
    it('creates wallet without initial balance (201 Created)', async () => {
      const playerId = randomUUID();
      const res = await controller.createWallet({
        playerId,
        currency: 'BRL',
      });

      expect(res.id).toBeDefined();
      expect(res.playerId).toBe(playerId);
      expect(res.currency).toBe('BRL');
      expect(res.balance.amount).toBe('0.00');
      expect(res.balance.currency).toBe('BRL');
      expect(res.version).toBe(1);

      const saved = await walletsRepo.findById(res.id);
      expect(saved).not.toBeNull();
      expect(saved?.balance.toJSON().amount).toBe('0.00');
    });

    it('creates wallet with initial balance and generates OPENING and CREDIT ledger', async () => {
      const playerId = randomUUID();
      const res = await controller.createWallet({
        playerId,
        currency: 'USD',
        initialBalance: {
          amount: '150.00',
          currency: 'USD',
        },
      });

      expect(res.balance.amount).toBe('150.00');
      expect(res.balance.currency).toBe('USD');
      expect(res.version).toBe(1);

      // Verifies ledger entry exists
      const page = await ledgerRepo.findByWalletId(res.id, undefined, 10);
      expect(page.entries.length).toBe(1);
      expect(page.entries[0]?.direction).toBe('CREDIT');
      expect(page.entries[0]?.money.toJSON().amount).toBe('150.00');
    });

    it('throws UnprocessableEntityException when initialBalance currency does not match wallet currency', async () => {
      const playerId = randomUUID();
      await expect(
        controller.createWallet({
          playerId,
          currency: 'BRL',
          initialBalance: {
            amount: '50.00',
            currency: 'USD',
          },
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws ConflictException (409) when (playerId, currency) already exists', async () => {
      const playerId = randomUUID();
      await controller.createWallet({
        playerId,
        currency: 'EUR',
      });

      await expect(
        controller.createWallet({
          playerId,
          currency: 'EUR',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('GET /wallets/:walletId', () => {
    it('returns wallet details when wallet exists', async () => {
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId: randomUUID(),
        currency: 'BRL',
      });
      await walletsRepo.save(wallet);

      const res = await controller.getWallet(wallet.id);
      expect(res.id).toBe(wallet.id);
      expect(res.playerId).toBe(wallet.playerId);
      expect(res.currency).toBe('BRL');
      expect(res.balance.amount).toBe('0.00');
      expect(res.version).toBe(1);
    });

    it('throws NotFoundException (404) when wallet does not exist', async () => {
      await expect(controller.getWallet(randomUUID())).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /wallets/:walletId/ledger', () => {
    it('throws NotFoundException when wallet does not exist', async () => {
      await expect(
        controller.getLedger(randomUUID(), { limit: 10 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns empty list when wallet has no ledger entries', async () => {
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId: randomUUID(),
        currency: 'BRL',
      });
      await walletsRepo.save(wallet);

      const res = await controller.getLedger(wallet.id, { limit: 10 });
      expect(res.items).toEqual([]);
      expect(res.nextCursor).toBeNull();
    });

    it('returns chronological ledger entries with cursor pagination', async () => {
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId: randomUUID(),
        currency: 'BRL',
      });
      await walletsRepo.save(wallet);

      const entry1 = WalletLedgerEntry.rehydrate({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: randomUUID(),
        direction: 'CREDIT',
        money: { amount: '50.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '50.00', currency: 'BRL' },
        createdAt: new Date('2026-01-01T10:00:00.000Z'),
      });

      const entry2 = WalletLedgerEntry.rehydrate({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: randomUUID(),
        direction: 'DEBIT',
        money: { amount: '20.00', currency: 'BRL' },
        balanceBefore: { amount: '50.00', currency: 'BRL' },
        balanceAfter: { amount: '30.00', currency: 'BRL' },
        createdAt: new Date('2026-01-01T11:00:00.000Z'),
      });

      await ledgerRepo.append(entry1);
      await ledgerRepo.append(entry2);

      // Page 1 with limit 1
      const page1 = await controller.getLedger(wallet.id, { limit: 1 });
      expect(page1.items.length).toBe(1);
      expect(page1.items[0]?.id).toBe(entry1.id);
      expect(page1.nextCursor).not.toBeNull();

      // Page 2 using nextCursor
      const page2 = await controller.getLedger(wallet.id, {
        cursor: page1.nextCursor!,
        limit: 1,
      });
      expect(page2.items.length).toBe(1);
      expect(page2.items[0]?.id).toBe(entry2.id);
      expect(page2.nextCursor).toBeNull();
    });
  });

  describe('POST /wallets/:walletId/reconciliation', () => {
    it('throws NotFoundException when wallet does not exist', async () => {
      await expect(
        controller.reconcileWallet(randomUUID()),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns consistent: true when ledger matches balance', async () => {
      const created = await controller.createWallet({
        playerId: randomUUID(),
        currency: 'BRL',
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const res = await controller.reconcileWallet(created.id);
      expect(res.consistent).toBe(true);
      expect(res.storedBalance.amount).toBe('100.00');
      expect(res.calculatedBalance.amount).toBe('100.00');
      expect(res.difference.amount).toBe('0.00');
      expect(res.checkedEntries).toBe(1);
    });
  });
});
