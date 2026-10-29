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
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../../src/domain/wager-transaction/failure-codes.js';
import { SqsClient } from '../../src/infrastructure/messaging/sqs.client.js';
import { SqsConsumerService } from '../../src/infrastructure/messaging/sqs-consumer.service.js';

describe('Integration Tests: SQS Consumer Retry & DLQ Routing (Requirements 9.4, 9.5, 9.6, 15.2)', () => {
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

  /**
   * Helper that builds an SqsConsumerService stack with optional proxy over SqsClient
   * to accelerate visibility timeouts (setting to 0 for instant retry during test).
   */
  function createConsumerStack(options?: {
    em?: EntityManager;
    instantVisibilityRetry?: boolean;
    processUseCaseOverride?: ProcessWagerTransactionUseCase;
  }) {
    const em = options?.em ?? context.orm.em.fork({ useContext: true });
    const uow = new UnitOfWorkAdapter(em);
    const wallets = new WalletRepository(em);
    const wagerTx = new WagerTransactionRepository(em);
    const ledger = new LedgerRepository(em);
    const outbox = new OutboxRepository(em);
    const inbox = new InboxRepository(em);
    const payloadHash = new PayloadHashService();
    const idempotency = new IdempotencyService();

    const processUseCase =
      options?.processUseCaseOverride ??
      new ProcessWagerTransactionUseCase(
        uow,
        wallets,
        wagerTx,
        ledger,
        outbox,
        payloadHash,
        idempotency,
      );

    // Fast retry proxy: converts backoff seconds to 0 in LocalStack so tests don't sleep
    const effectiveSqsClient = options?.instantVisibilityRetry
      ? (new Proxy(sqsClientWrapper, {
          get(target, prop, receiver) {
            if (prop === 'changeMessageVisibility') {
              return async (queueUrl: string, receiptHandle: string) => {
                return target.changeMessageVisibility(queueUrl, receiptHandle, 0);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as SqsClient)
      : sqsClientWrapper;

    const consumer = new SqsConsumerService(
      effectiveSqsClient,
      uow,
      inbox,
      processUseCase,
      payloadHash,
      {
        queueUrl: context.queueUrl,
        consumerName: 'wagering-processor',
        maxMessages: 1,
        waitTimeSeconds: 1,
      },
    );

    return { em, uow, wallets, wagerTx, ledger, outbox, inbox, payloadHash, processUseCase, consumer };
  }

  // ===========================================================================
  // 1. Erro transitório repetido até maxReceiveCount -> Redirecionamento para DLQ
  // ===========================================================================
  it('Requirement 9.5 & 9.6: simula erro transitório repetido até atingir maxReceiveCount (5) e verifica roteamento para wager-transactions-dlq.fifo', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial de 1000.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 1000.00, 1)`,
      [walletId, playerId],
    );

    const externalTransactionId = `ext-transient-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;
    const messageId = `msg-transient-${randomUUID()}`;

    const payload = {
      messageId,
      correlationId: `corr-${randomUUID()}`,
      data: {
        idempotencyKey,
        providerId: 'prov-1',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-dlq-1',
        gameId: 'gates-of-olympus',
        kind: WagerTransactionKind.Bet,
        money: { amount: '100.00', currency: 'BRL' },
      },
    };

    // Publica mensagem na fila principal
    await sqsClientWrapper.sendMessage(
      context.queueUrl,
      JSON.stringify(payload),
      {
        messageGroupId: walletId,
        messageDeduplicationId: `sqs-dlq-${randomUUID()}`,
      },
    );

    // Mock UseCase que sempre lança erro transitório de infraestrutura
    const failingUseCase = {
      execute: async () => {
        throw new Error('SIMULATED_TRANSIENT_DATABASE_CONNECTION_TIMEOUT');
      },
    } as unknown as ProcessWagerTransactionUseCase;

    const stack = createConsumerStack({
      instantVisibilityRetry: true,
      processUseCaseOverride: failingUseCase,
    });

    // Executa pollOnce 5 vezes (correspondente ao maxReceiveCount: 5 do RedrivePolicy)
    for (let attempt = 1; attempt <= 5; attempt++) {
      await stack.consumer.pollOnce();
    }

    // Na 6ª tentativa, a fila principal não entrega mais a mensagem pois o SQS já a moveu para a DLQ
    const mainQueueMessages = await sqsClientWrapper.receiveMessages(context.queueUrl, 1, 1, 0);
    expect(mainQueueMessages.length).toBe(0);

    // -------------------------------------------------------------------------
    // Verificação na Fila DLQ (wager-transactions-dlq.fifo) - Requirement 9.6
    // -------------------------------------------------------------------------
    const dlqMessages = await sqsClientWrapper.receiveMessages(context.dlqUrl, 1, 2, 5);
    expect(dlqMessages.length).toBe(1);

    const dlqPayload = JSON.parse(dlqMessages[0]?.Body ?? '{}');
    expect(dlqPayload.messageId).toBe(messageId);
    expect(dlqPayload.data.idempotencyKey).toBe(idempotencyKey);
    expect(dlqPayload.data.money.amount).toBe('100.00');

    // -------------------------------------------------------------------------
    // Verificação de Integridade no Banco (Rollback Total) - Requirement 9.5
    // -------------------------------------------------------------------------
    // 1. Wallets: saldo e versão permanecem intactos
    const walletRows = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows[0]?.balance_amount).toBe('1000.00');
    expect(walletRows[0]?.version).toBe(1);

    // 2. Wager Transactions: nenhum registro persistido
    const txRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wager_transactions WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
    expect(txRows.length).toBe(0);

    // 3. Ledger: zero lançamentos criados
    const ledgerRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows.length).toBe(0);

    // 4. Outbox: zero eventos gerados
    const outboxRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM outbox_messages WHERE aggregate_id = ?`,
      [walletId],
    );
    expect(outboxRows.length).toBe(0);

    // Limpa a DLQ após o teste
    if (dlqMessages[0]?.ReceiptHandle) {
      await sqsClientWrapper.deleteMessage(context.dlqUrl, dlqMessages[0].ReceiptHandle);
    }
  });

  // ===========================================================================
  // 2. Rejeição de Negócio NÃO vai para a DLQ (Requirement 9.4)
  // ===========================================================================
  it('Requirement 9.4: rejeição negocial (saldo insuficiente) faz ACK e NUNCA é enviada para a DLQ', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial: 50.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 50.00, 1)`,
      [walletId, playerId],
    );

    const externalTransactionId = `ext-rej-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;
    const messageId = `msg-rej-${randomUUID()}`;

    // Aposta de 200.00 BRL (maior que o saldo de 50.00)
    const payload = {
      messageId,
      correlationId: `corr-${randomUUID()}`,
      data: {
        idempotencyKey,
        providerId: 'prov-1',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-rej-dlq-1',
        gameId: 'fortune-tiger',
        kind: WagerTransactionKind.Bet,
        money: { amount: '200.00', currency: 'BRL' },
      },
    };

    await sqsClientWrapper.sendMessage(
      context.queueUrl,
      JSON.stringify(payload),
      {
        messageGroupId: walletId,
        messageDeduplicationId: `sqs-rej-${randomUUID()}`,
      },
    );

    const stack = createConsumerStack();
    await stack.consumer.pollOnce();

    // 1. Mensagem foi confirmada (ACK/deleteMessage) e não existe mais na fila principal
    const mainQueueMessages = await sqsClientWrapper.receiveMessages(context.queueUrl, 1, 1, 0);
    expect(mainQueueMessages.length).toBe(0);

    // 2. Mensagem NÃO está na DLQ (permanece vazia)
    const dlqMessages = await sqsClientWrapper.receiveMessages(context.dlqUrl, 1, 1, 0);
    expect(dlqMessages.length).toBe(0);

    // 3. No banco: persistido como REJECTED
    const txRows = await conn.execute<Array<{ status: string; failure_code: string }>>(
      `SELECT status, failure_code FROM wager_transactions WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
    expect(txRows.length).toBe(1);
    expect(txRows[0]?.status).toBe(WagerTransactionStatus.Rejected);
    expect(txRows[0]?.failure_code).toBe(FailureCode.BalanceInsufficient);
  });

  // ===========================================================================
  // 3. Auto-recuperação antes de atingir maxReceiveCount
  // ===========================================================================
  it('Requirement 9.5: erro transitório nas tentativas 1 e 2, resolvido na tentativa 3; processa com sucesso sem ir para DLQ', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 500.00, 1)`,
      [walletId, playerId],
    );

    const externalTransactionId = `ext-recover-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;
    const messageId = `msg-recover-${randomUUID()}`;

    const payload = {
      messageId,
      correlationId: `corr-${randomUUID()}`,
      data: {
        idempotencyKey,
        providerId: 'prov-1',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-rec-1',
        gameId: 'sweet-bonanza',
        kind: WagerTransactionKind.Bet,
        money: { amount: '150.00', currency: 'BRL' },
      },
    };

    await sqsClientWrapper.sendMessage(
      context.queueUrl,
      JSON.stringify(payload),
      {
        messageGroupId: walletId,
        messageDeduplicationId: `sqs-rec-${randomUUID()}`,
      },
    );

    let attemptsCount = 0;
    const realStack = createConsumerStack({ instantVisibilityRetry: true });

    // UseCase que falha nas duas primeiras tentativas e sucede a partir da 3ª
    const recoveringUseCase = {
      execute: async (cmd: any) => {
        attemptsCount++;
        if (attemptsCount <= 2) {
          throw new Error(`TRANSIENT_FAILURE_ATTEMPT_${attemptsCount}`);
        }
        return realStack.processUseCase.execute(cmd);
      },
    } as unknown as ProcessWagerTransactionUseCase;

    const consumerStack = createConsumerStack({
      instantVisibilityRetry: true,
      processUseCaseOverride: recoveringUseCase,
    });

    // Tentativas 1 e 2 falham e fazem rollback
    await consumerStack.consumer.pollOnce();
    await consumerStack.consumer.pollOnce();

    // Tentativa 3 sucede
    await consumerStack.consumer.pollOnce();

    // Verificações:
    // - Carteira debitada com sucesso (500 - 150 = 350)
    const walletRows = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(Number(walletRows[0]?.balance_amount)).toBe(350);
    expect(walletRows[0]?.version).toBe(2);

    // - Fila principal vazia
    const mainMessages = await sqsClientWrapper.receiveMessages(context.queueUrl, 1, 1, 0);
    expect(mainMessages.length).toBe(0);

    // - DLQ permanece completamente vazia
    const dlqMessages = await sqsClientWrapper.receiveMessages(context.dlqUrl, 1, 1, 0);
    expect(dlqMessages.length).toBe(0);
  });
});
