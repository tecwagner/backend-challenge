import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'crypto';
import type { EntityManager } from '@mikro-orm/core';
import {
  startTestEnvironment,
  stopTestEnvironment,
  cleanDatabase,
  purgeTestQueues,
  type TestEnvironmentContext,
} from './setup.js';
import { UnitOfWorkAdapter } from '../../src/infrastructure/persistence/unit-of-work.adapter.js';
import { WalletRepository } from '../../src/infrastructure/persistence/repositories/wallet.repository.js';
import { WagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/wager-transaction.repository.js';
import { LedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository.js';
import { OutboxRepository } from '../../src/infrastructure/persistence/repositories/outbox.repository.js';
import { InboxRepository } from '../../src/infrastructure/persistence/repositories/inbox.repository.js';
import { PayloadHashService } from '../../src/application/services/payload-hash.service.js';
import { IdempotencyService } from '../../src/application/services/idempotency.service.js';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction/process-wager-transaction.use-case.js';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction.enums.js';
import { SqsClient } from '../../src/infrastructure/messaging/sqs.client.js';
import { SqsConsumerService } from '../../src/infrastructure/messaging/sqs-consumer.service.js';

describe('Property Tests: Isolation and SQS Redelivery (Properties 11 & 16)', () => {
  let context: TestEnvironmentContext;
  let sqsClientWrapper: SqsClient;

  beforeAll(async () => {
    context = await startTestEnvironment();
    sqsClientWrapper = new SqsClient(context.sqsClient);
  }, 60_000);

  afterAll(async () => {
    await stopTestEnvironment();
  }, 30_000);

  beforeEach(async () => {
    await cleanDatabase(context.orm);
    await purgeTestQueues(context.sqsClient);
  });

  function createStack(em: EntityManager = context.orm.em.fork({ useContext: true })) {
    const uow = new UnitOfWorkAdapter(em);
    const wallets = new WalletRepository(em);
    const wagerTx = new WagerTransactionRepository(em);
    const ledger = new LedgerRepository(em);
    const outbox = new OutboxRepository(em);
    const inbox = new InboxRepository(em);
    const payloadHash = new PayloadHashService();
    const idempotency = new IdempotencyService();

    const safeSqsClient = new Proxy(sqsClientWrapper, {
      get(target, prop, receiver) {
        if (prop === 'deleteMessage') {
          return async (queueUrl: string, receiptHandle: string) => {
            if (receiptHandle.startsWith('dummy-')) return;
            return target.deleteMessage(queueUrl, receiptHandle);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const processUseCase = new ProcessWagerTransactionUseCase(
      uow,
      wallets,
      wagerTx,
      ledger,
      outbox,
      payloadHash,
      idempotency,
    );

    const consumer = new SqsConsumerService(
      safeSqsClient,
      uow,
      inbox,
      processUseCase,
      payloadHash,
      {
        queueUrl: context.queueUrl,
        consumerName: 'wagering-processor',
        maxMessages: 10,
        waitTimeSeconds: 1,
      },
    );

    return { em, uow, wallets, wagerTx, ledger, outbox, inbox, payloadHash, idempotency, processUseCase, consumer };
  }

  // ===========================================================================
  // Property 11: Redelivery SQS não duplica efeitos financeiros
  // Validates: Requirements 4.4, 9.8
  // ===========================================================================
  it('Property 11: Para qualquer mensagem SQS reenviada N vezes, resulta em zero alterações no saldo e zero novas entradas no ledger', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 1000.00, 1)`,
      [walletId, playerId],
    );

    const messageId = `prop11-msg-${randomUUID()}`;
    const extTxId = `prop11-ext-${randomUUID()}`;
    const idempotencyKey = `prov-1:${extTxId}`;

    const rawPayload = JSON.stringify({
      messageId,
      data: {
        idempotencyKey,
        providerId: 'prov-1',
        externalTransactionId: extTxId,
        playerId,
        walletId,
        roundId: 'round-p11',
        gameId: 'fortune-tiger',
        kind: WagerTransactionKind.Bet,
        money: { amount: '100.00', currency: 'BRL' },
      },
    });

    const stack = createStack();

    // 1. Primeira entrega
    await stack.consumer.processSingleMessage({
      MessageId: randomUUID(),
      ReceiptHandle: 'dummy-handle-1',
      Body: rawPayload,
    });

    const [walletAfterFirst] = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletAfterFirst?.balance_amount).toBe('900.00');
    expect(walletAfterFirst?.version).toBe(2);

    // 2. N redeliveries consecutivos (ex: 5 redeliveries da mesma mensagem)
    const redeliveryCount = 5;
    for (let i = 2; i <= redeliveryCount + 1; i++) {
      const redeliveryStack = createStack();
      await redeliveryStack.consumer.processSingleMessage({
        MessageId: randomUUID(),
        ReceiptHandle: `dummy-handle-${i}`,
        Body: rawPayload,
      });

      // Invariante Property 11: saldo e versão não se alteram
      const [walletCheck] = await conn.execute<Array<{ balance_amount: string; version: number }>>(
        `SELECT balance_amount, version FROM wallets WHERE id = ?`,
        [walletId],
      );
      expect(walletCheck?.balance_amount).toBe('900.00');
      expect(walletCheck?.version).toBe(2);

      const ledgerEntries = await conn.execute<Array<{ id: string }>>(
        `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
        [walletId],
      );
      expect(ledgerEntries.length).toBe(1);
    }
  });

  // ===========================================================================
  // Property 16: Isolamento entre wallets distintas
  // Validates: Requirements 7.5
  // ===========================================================================
  it('Property 16: Para qualquer par de wallets W1 e W2, operações sobre W1 não alteram o saldo ou o ledger de W2 e vice-versa', async () => {
    const conn = context.orm.em.getConnection();
    const w1Id = randomUUID();
    const w2Id = randomUUID();
    const p1PlayerId = randomUUID();
    const p2PlayerId = randomUUID();

    // Saldo inicial: W1 = 300.00, W2 = 700.00
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 300.00, 1), (?, ?, 'BRL', 700.00, 1)`,
      [w1Id, p1PlayerId, w2Id, p2PlayerId],
    );

    // Lista de operações mistas e simultâneas para W1 e W2
    const operationsW1 = [
      { kind: WagerTransactionKind.Bet, amount: '50.00' },
      { kind: WagerTransactionKind.Bet, amount: '30.00' },
      { kind: WagerTransactionKind.Win, amount: '100.00' },
    ];

    const operationsW2 = [
      { kind: WagerTransactionKind.Bet, amount: '200.00' },
      { kind: WagerTransactionKind.Win, amount: '50.00' },
      { kind: WagerTransactionKind.Bet, amount: '150.00' },
    ];

    const promisesW1 = operationsW1.map((op, idx) => {
      const extId = `w1-op-${idx}-${randomUUID()}`;
      const stack = createStack();
      return stack.processUseCase.execute({
        idempotencyKey: `prov-1:${extId}`,
        providerId: 'prov-1',
        externalTransactionId: extId,
        playerId: p1PlayerId,
        walletId: w1Id,
        roundId: `r1-${idx}`,
        gameId: 'game-1',
        kind: op.kind,
        money: { amount: op.amount, currency: 'BRL' },
        correlationId: `corr-w1-${idx}`,
      });
    });

    const promisesW2 = operationsW2.map((op, idx) => {
      const extId = `w2-op-${idx}-${randomUUID()}`;
      const stack = createStack();
      return stack.processUseCase.execute({
        idempotencyKey: `prov-1:${extId}`,
        providerId: 'prov-1',
        externalTransactionId: extId,
        playerId: p2PlayerId,
        walletId: w2Id,
        roundId: `r2-${idx}`,
        gameId: 'game-2',
        kind: op.kind,
        money: { amount: op.amount, currency: 'BRL' },
        correlationId: `corr-w2-${idx}`,
      });
    });

    // Dispara todas as 6 operações de W1 e W2 simultaneamente
    await Promise.all([...promisesW1, ...promisesW2]);

    // Verificação de W1:
    // Saldo inicial: 300 - 50 - 30 + 100 = 320.00
    const [finalW1] = await conn.execute<Array<{ balance_amount: string }>>(
      `SELECT balance_amount FROM wallets WHERE id = ?`,
      [w1Id],
    );
    expect(finalW1?.balance_amount).toBe('320.00');

    const ledgerW1 = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [w1Id],
    );
    expect(ledgerW1.length).toBe(3);

    // Verificação de W2:
    // Saldo inicial: 700 - 200 + 50 - 150 = 400.00
    const [finalW2] = await conn.execute<Array<{ balance_amount: string }>>(
      `SELECT balance_amount FROM wallets WHERE id = ?`,
      [w2Id],
    );
    expect(finalW2?.balance_amount).toBe('400.00');

    const ledgerW2 = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [w2Id],
    );
    expect(ledgerW2.length).toBe(3);
  });
});
