import { describe, expect, it, beforeEach } from 'bun:test';
import { randomUUID } from 'crypto';
import {
  ConflictException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { WageringController } from './wagering.controller.js';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction/process-wager-transaction.use-case.js';
import {
  InMemoryInboxRepository,
  InMemoryLedgerRepository,
  InMemoryOutboxRepository,
  InMemoryWagerTransactionRepository,
  InMemoryWalletRepository,
  SerialUnitOfWork,
} from '../../application/use-cases/_test/in-memory.js';
import { PayloadHashService } from '../../application/services/payload-hash.service.js';
import { IdempotencyService } from '../../application/services/idempotency.service.js';
import { Wallet } from '../../domain/wallet/wallet.aggregate.js';
import { Money } from '../../domain/money/money.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../../domain/wager-transaction/failure-codes.js';

function mockReply(): { reply: FastifyReply; getStatus: () => number } {
  let statusCode = 200;
  const reply = {
    status(code: number) {
      statusCode = code;
      return this;
    },
  } as unknown as FastifyReply;

  return {
    reply,
    getStatus: () => statusCode,
  };
}

describe('WageringController', () => {
  let uow: SerialUnitOfWork;
  let walletsRepo: InMemoryWalletRepository;
  let wagerTxRepo: InMemoryWagerTransactionRepository;
  let ledgerRepo: InMemoryLedgerRepository;
  let outboxRepo: InMemoryOutboxRepository;
  let processWagerTransactionUseCase: ProcessWagerTransactionUseCase;
  let controller: WageringController;

  beforeEach(() => {
    uow = new SerialUnitOfWork();
    walletsRepo = new InMemoryWalletRepository();
    wagerTxRepo = new InMemoryWagerTransactionRepository();
    ledgerRepo = new InMemoryLedgerRepository();
    outboxRepo = new InMemoryOutboxRepository();

    const payloadHash = new PayloadHashService();
    const idempotency = new IdempotencyService();

    processWagerTransactionUseCase = new ProcessWagerTransactionUseCase(
      uow,
      walletsRepo,
      wagerTxRepo,
      ledgerRepo,
      outboxRepo,
      payloadHash,
      idempotency,
    );

    controller = new WageringController(processWagerTransactionUseCase, wagerTxRepo);
  });

  describe('POST /wagering/transactions', () => {
    it('throws UnprocessableEntityException (422) when Idempotency-Key header is missing', async () => {
      const { reply } = mockReply();
      const body = {
        providerId: 'provider-1',
        externalTransactionId: 'tx-1',
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      };

      await expect(
        controller.createTransaction(body, {}, reply),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws UnprocessableEntityException (422) when Idempotency-Key header is empty string', async () => {
      const { reply } = mockReply();
      const body = {
        providerId: 'provider-1',
        externalTransactionId: 'tx-1',
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      };

      await expect(
        controller.createTransaction(body, { 'idempotency-key': '   ' }, reply),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('processes BET successfully returning HTTP 200 OK and decrements balance', async () => {
      const { reply, getStatus } = mockReply();
      const playerId = randomUUID();
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId,
        currency: 'BRL',
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      await walletsRepo.save(wallet);

      const body = {
        providerId: 'provider-1',
        externalTransactionId: 'tx-100',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '30.00', currency: 'BRL' },
      };

      const res = await controller.createTransaction(
        body,
        { 'idempotency-key': 'idemp-key-1', 'x-correlation-id': 'corr-1' },
        reply,
      );

      expect(getStatus()).toBe(HttpStatus.OK);
      expect(res.status).toBe(WagerTransactionStatus.Processed);
      expect(res.balance.amount).toBe('70.00');
      expect(res.balance.currency).toBe('BRL');
      expect(res.idempotentReplay).toBe(false);
      expect(res.transactionId).toBeDefined();
    });

    it('returns original result with idempotentReplay: true on identical replay', async () => {
      const { reply, getStatus } = mockReply();
      const playerId = randomUUID();
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId,
        currency: 'BRL',
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      await walletsRepo.save(wallet);

      const body = {
        providerId: 'provider-1',
        externalTransactionId: 'tx-100',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '30.00', currency: 'BRL' },
      };

      const first = await controller.createTransaction(
        body,
        { 'idempotency-key': 'idemp-key-2' },
        reply,
      );
      expect(first.idempotentReplay).toBe(false);

      const second = await controller.createTransaction(
        body,
        { 'idempotency-key': 'idemp-key-2' },
        reply,
      );

      expect(getStatus()).toBe(HttpStatus.OK);
      expect(second.idempotentReplay).toBe(true);
      expect(second.transactionId).toBe(first.transactionId);
      expect(second.balance.amount).toBe('70.00');
    });

    it('throws ConflictException (409) when idempotency key is reused with different payload', async () => {
      const { reply } = mockReply();
      const playerId = randomUUID();
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId,
        currency: 'BRL',
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      await walletsRepo.save(wallet);

      const body1 = {
        providerId: 'provider-1',
        externalTransactionId: 'tx-100',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '30.00', currency: 'BRL' },
      };

      await controller.createTransaction(
        body1,
        { 'idempotency-key': 'idemp-key-conflict' },
        reply,
      );

      const body2 = {
        ...body1,
        money: { amount: '40.00', currency: 'BRL' },
      };

      await expect(
        controller.createTransaction(
          body2,
          { 'idempotency-key': 'idemp-key-conflict' },
          reply,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('returns HTTP 422 Unprocessable Entity with failureCode when rejected for insufficient funds', async () => {
      const { reply, getStatus } = mockReply();
      const playerId = randomUUID();
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId,
        currency: 'BRL',
        initialBalance: { amount: '20.00', currency: 'BRL' },
      });
      await walletsRepo.save(wallet);

      const body = {
        providerId: 'provider-1',
        externalTransactionId: 'tx-insufficient',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '50.00', currency: 'BRL' },
      };

      const res = await controller.createTransaction(
        body,
        { 'idempotency-key': 'idemp-key-insufficient' },
        reply,
      );

      expect(getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(res.status).toBe(WagerTransactionStatus.Rejected);
      expect(res.failureCode).toBe(FailureCode.BalanceInsufficient);
      expect(res.balance.amount).toBe('20.00');
    });

    it('returns HTTP 202 Accepted when REFUND arrives before referenced BET', async () => {
      const { reply, getStatus } = mockReply();
      const playerId = randomUUID();
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId,
        currency: 'BRL',
        initialBalance: { amount: '20.00', currency: 'BRL' },
      });
      await walletsRepo.save(wallet);

      const body = {
        providerId: 'provider-1',
        externalTransactionId: 'tx-refund-early',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund,
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-not-yet-received',
      };

      const res = await controller.createTransaction(
        body,
        { 'idempotency-key': 'idemp-key-pending-ref' },
        reply,
      );

      expect(getStatus()).toBe(HttpStatus.ACCEPTED);
      expect(res.status).toBe(WagerTransactionStatus.PendingReference);
      expect(res.balance.amount).toBe('20.00');
    });
  });

  describe('GET /wagering/transactions/:transactionId', () => {
    it('returns transaction details when found by id', async () => {
      const { reply } = mockReply();
      const playerId = randomUUID();
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId,
        currency: 'BRL',
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      await walletsRepo.save(wallet);

      const created = await controller.createTransaction(
        {
          providerId: 'provider-1',
          externalTransactionId: 'tx-detail-1',
          playerId,
          walletId: wallet.id,
          roundId: 'round-10',
          gameId: 'game-20',
          kind: WagerTransactionKind.Win,
          money: { amount: '50.00', currency: 'BRL' },
        },
        { 'idempotency-key': 'idemp-detail-1' },
        reply,
      );

      const detail = await controller.getTransactionById(created.transactionId);
      expect(detail.id).toBe(created.transactionId);
      expect(detail.providerId).toBe('provider-1');
      expect(detail.externalTransactionId).toBe('tx-detail-1');
      expect(detail.kind).toBe(WagerTransactionKind.Win);
      expect(detail.money.amount).toBe('50.00');
      expect(detail.status).toBe(WagerTransactionStatus.Processed);
      expect(detail.failureCode).toBeNull();
      expect(detail.processedAt).not.toBeNull();
      expect(detail.createdAt).toBeDefined();
    });

    it('throws NotFoundException (404) when transaction id does not exist', async () => {
      await expect(
        controller.getTransactionById(randomUUID()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /providers/:providerId/wagering/transactions/:externalTransactionId', () => {
    it('returns transaction details when found by provider and external ID', async () => {
      const { reply } = mockReply();
      const playerId = randomUUID();
      const wallet = Wallet.open({
        id: randomUUID(),
        playerId,
        currency: 'BRL',
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      await walletsRepo.save(wallet);

      await controller.createTransaction(
        {
          providerId: 'provider-omega',
          externalTransactionId: 'omega-tx-999',
          playerId,
          walletId: wallet.id,
          roundId: 'round-omega',
          gameId: 'game-omega',
          kind: WagerTransactionKind.Bet,
          money: { amount: '15.00', currency: 'BRL' },
        },
        { 'idempotency-key': 'idemp-omega-1' },
        reply,
      );

      const detail = await controller.getTransactionByExternalId(
        'provider-omega',
        'omega-tx-999',
      );

      expect(detail.providerId).toBe('provider-omega');
      expect(detail.externalTransactionId).toBe('omega-tx-999');
      expect(detail.kind).toBe(WagerTransactionKind.Bet);
      expect(detail.money.amount).toBe('15.00');
      expect(detail.status).toBe(WagerTransactionStatus.Processed);
    });

    it('throws NotFoundException (404) when external transaction is not found', async () => {
      await expect(
        controller.getTransactionByExternalId('provider-x', 'non-existent-tx'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
