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
import { SqsClient } from '../../src/infrastructure/messaging/sqs.client.js';
import { SqsConsumerService } from '../../src/infrastructure/messaging/sqs-consumer.service.js';

describe('Integration Tests: SQS Redelivery & Inbox Deduplication (Requirements 9.8, 4.4, 15.2)', () => {
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

  function createConsumerStack(em: EntityManager = context.orm.em.fork({ useContext: true })) {
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
            if (receiptHandle.startsWith('dummy-')) {
              return;
            }
            return target.deleteMessage(queueUrl, receiptHandle);
          };
        }
        if (prop === 'changeMessageVisibility') {
          return async (queueUrl: string, receiptHandle: string, timeout: number) => {
            if (receiptHandle.startsWith('dummy-')) {
              return;
            }
            return target.changeMessageVisibility(queueUrl, receiptHandle, timeout);
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

    return { em, uow, wallets, wagerTx, ledger, outbox, inbox, payloadHash, processUseCase, consumer };
  }

  // ===========================================================================
  // 1. Redelivery SQS com mesmo messageId (Requirements 9.8, 4.4, 15.2)
  // ===========================================================================
  it('Requirement 9.8 & 4.4: redelivery da MESMA mensagem SQS com mesmo messageId é reconhecida no inbox e não gera duplicidade financeira', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial de 1000.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 1000.00, 1)`,
      [walletId, playerId],
    );

    const messageId = `msg-redelivery-${randomUUID()}`;
    const externalTransactionId = `ext-redelivery-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;

    const payload = {
      messageId,
      correlationId: `corr-${randomUUID()}`,
      data: {
        idempotencyKey,
        providerId: 'prov-1',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-redelivery-1',
        gameId: 'sweet-bonanza',
        kind: WagerTransactionKind.Bet,
        money: { amount: '200.00', currency: 'BRL' },
      },
    };

    // 1. Envia a primeira mensagem para o SQS FIFO real no LocalStack
    await sqsClientWrapper.sendMessage(
      context.queueUrl,
      JSON.stringify(payload),
      {
        messageGroupId: walletId,
        messageDeduplicationId: `sqs-dedup-1-${randomUUID()}`,
      },
    );

    // 2. Primeiro consumo pelo worker
    const stack1 = createConsumerStack();
    await stack1.consumer.pollOnce();

    // Verificações após primeira execução:
    // - Carteira debitada: 1000.00 -> 800.00, version = 2
    const walletRows1 = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows1[0]?.balance_amount).toBe('800.00');
    expect(walletRows1[0]?.version).toBe(2);

    // - 1 transação registrada como PROCESSED
    const txRows1 = await conn.execute<Array<{ id: string; status: string }>>(
      `SELECT id, status FROM wager_transactions WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
    expect(txRows1.length).toBe(1);
    expect(txRows1[0]?.status).toBe(WagerTransactionStatus.Processed);

    // - 1 lançamento no ledger (DEBIT de 200.00)
    const ledgerRows1 = await conn.execute<Array<{ direction: string; money_amount: string }>>(
      `SELECT direction, money_amount FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows1.length).toBe(1);
    expect(ledgerRows1[0]?.direction).toBe('DEBIT');
    expect(ledgerRows1[0]?.money_amount).toBe('200.00');

    // - 1 registro no inbox marcado como processed_at
    const inboxRows1 = await conn.execute<Array<{ message_id: string; processed_at: Date | null }>>(
      `SELECT message_id, processed_at FROM inbox_messages WHERE message_id = ?`,
      [messageId],
    );
    expect(inboxRows1.length).toBe(1);
    expect(inboxRows1[0]?.processed_at).not.toBeNull();

    // - 2 eventos outbox gerados (WalletBalanceChanged e WagerTransactionProcessed)
    const outboxRows1 = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM outbox_messages WHERE aggregate_id = ?`,
      [walletId],
    );
    expect(outboxRows1.length).toBe(2);

    // 3. Simula REDELIVERY da MESMA mensagem pelo SQS (ex: timeout de visibilidade ou retry de rede do broker)
    // Reenviamos exatamente o mesmo payload com o mesmo messageId
    await sqsClientWrapper.sendMessage(
      context.queueUrl,
      JSON.stringify(payload),
      {
        messageGroupId: walletId,
        messageDeduplicationId: `sqs-dedup-2-${randomUUID()}`,
      },
    );

    // 4. Segundo consumo pelo worker (nova instância ou polling subsequente)
    const stack2 = createConsumerStack();
    await stack2.consumer.pollOnce();

    // 5. Verificações de ZERO EFEITO FINANCEIRO DUPLICADO:
    // - Carteira permanece estritamente em 800.00 e version permanece 2
    const walletRows2 = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows2[0]?.balance_amount).toBe('800.00');
    expect(walletRows2[0]?.version).toBe(2);

    // - Ledger continua com exatamente 1 registro
    const ledgerRows2 = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows2.length).toBe(1);

    // - Wager Transactions continua com exatamente 1 registro
    const txRows2 = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wager_transactions WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
    expect(txRows2.length).toBe(1);

    // - Nenhuma mensagem extra no outbox
    const outboxRows2 = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM outbox_messages WHERE aggregate_id = ?`,
      [walletId],
    );
    expect(outboxRows2.length).toBe(2);

    // - Fila SQS vazia (a mensagem duplicada foi reconhecida e deletada com sucesso)
    const remainingMessages = await sqsClientWrapper.receiveMessages(context.queueUrl, 10, 1);
    expect(remainingMessages.length).toBe(0);
  });

  // ===========================================================================
  // 2. Concorrência: duas entregas simultâneas da mesma mensagem (Requirement 9.8, 15.2)
  // ===========================================================================
  it('Requirement 9.8 & 15.2: mensagens concorrentes com o mesmo messageId são deduplicadas atomicamente no banco sem race condition', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial: 500.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 500.00, 1)`,
      [walletId, playerId],
    );

    const messageId = `msg-concurrent-${randomUUID()}`;
    const externalTransactionId = `ext-concurrent-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;

    const rawMessageBody = JSON.stringify({
      messageId,
      correlationId: `corr-${randomUUID()}`,
      data: {
        idempotencyKey,
        providerId: 'prov-1',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-concurrent-1',
        gameId: 'fortune-ox',
        kind: WagerTransactionKind.Bet,
        money: { amount: '150.00', currency: 'BRL' },
      },
    });

    const stackA = createConsumerStack();
    const stackB = createConsumerStack();

    // Duas instâncias recebem a mesma mensagem com mesmo messageId e tentam processar em paralelo
    const simulatedSqsMessage = {
      MessageId: randomUUID(),
      ReceiptHandle: 'dummy-receipt-handle-1',
      Body: rawMessageBody,
    };

    // Dispara processamento simultâneo
    await Promise.all([
      stackA.consumer.processSingleMessage(simulatedSqsMessage),
      stackB.consumer.processSingleMessage({
        ...simulatedSqsMessage,
        ReceiptHandle: 'dummy-receipt-handle-2',
      }),
    ]);

    // Verificações:
    // - Saldo debitado exatamente UMA vez: 500.00 - 150.00 = 350.00, version = 2
    const walletRows = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows[0]?.balance_amount).toBe('350.00');
    expect(walletRows[0]?.version).toBe(2);

    // - Apenas 1 lançamento no ledger
    const ledgerRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows.length).toBe(1);

    // - Apenas 1 transação no banco
    const txRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wager_transactions WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
    expect(txRows.length).toBe(1);

    // - Exatamente 1 registro no inbox
    const inboxRows = await conn.execute<Array<{ message_id: string }>>(
      `SELECT message_id FROM inbox_messages WHERE message_id = ?`,
      [messageId],
    );
    expect(inboxRows.length).toBe(1);
  });

  // ===========================================================================
  // 3. Replay Idempotente de Mensagem: messageId novo mas idempotencyKey existente
  // ===========================================================================
  it('Requirement 4.1 & 4.4: mensagens com messageId diferente mas mesma idempotencyKey ativam replay idempotente sem duplicar saldo', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial: 300.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 300.00, 1)`,
      [walletId, playerId],
    );

    const externalTransactionId = `ext-replay-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;

    const message1Payload = {
      messageId: `msg-id-1-${randomUUID()}`,
      data: {
        idempotencyKey,
        providerId: 'prov-1',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-replay-1',
        gameId: 'gates-of-olympus',
        kind: WagerTransactionKind.Bet,
        money: { amount: '100.00', currency: 'BRL' },
      },
    };

    const message2Payload = {
      messageId: `msg-id-2-${randomUUID()}`, // messageId DIFERENTE no SQS!
      data: {
        idempotencyKey, // MESMA idempotencyKey
        providerId: 'prov-1',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-replay-1',
        gameId: 'gates-of-olympus',
        kind: WagerTransactionKind.Bet,
        money: { amount: '100.00', currency: 'BRL' },
      },
    };

    // 1. Envia e processa a primeira mensagem
    await sqsClientWrapper.sendMessage(
      context.queueUrl,
      JSON.stringify(message1Payload),
      {
        messageGroupId: walletId,
        messageDeduplicationId: `dedup-1-${randomUUID()}`,
      },
    );
    const stack1 = createConsumerStack();
    await stack1.consumer.pollOnce();

    // Saldo agora é 200.00
    const walletRows1 = await conn.execute<Array<{ balance_amount: string }>>(
      `SELECT balance_amount FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows1[0]?.balance_amount).toBe('200.00');

    // 2. Envia e processa a segunda mensagem (novo messageId, mesma chave de idempotência)
    await sqsClientWrapper.sendMessage(
      context.queueUrl,
      JSON.stringify(message2Payload),
      {
        messageGroupId: walletId,
        messageDeduplicationId: `dedup-2-${randomUUID()}`,
      },
    );
    const stack2 = createConsumerStack();
    await stack2.consumer.pollOnce();

    // 3. Verificações:
    // - O inbox registrou ambos os messageIds
    const inboxRows = await conn.execute<Array<{ message_id: string }>>(
      `SELECT message_id FROM inbox_messages WHERE message_id IN (?, ?)`,
      [message1Payload.messageId, message2Payload.messageId],
    );
    expect(inboxRows.length).toBe(2);

    // - Mas o saldo da carteira permanece estritamente em 200.00 (camada de negócio barrou via IdempotencyService)
    const walletRows2 = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      `SELECT balance_amount, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows2[0]?.balance_amount).toBe('200.00');
    expect(walletRows2[0]?.version).toBe(2);

    // - Ledger permanece com apenas 1 registro
    const ledgerRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows.length).toBe(1);

    // - Transações permanece com apenas 1 registro
    const txRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wager_transactions WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
    expect(txRows.length).toBe(1);
  });

  // ===========================================================================
  // 4. Fallback para SQS MessageId quando payload não contém messageId
  // ===========================================================================
  it('Requirement 9.8: redelivery de mensagem após fallback para message.MessageId do SQS quando payload não contém messageId', async () => {
    const conn = context.orm.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Saldo inicial: 400.00 BRL
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 400.00, 1)`,
      [walletId, playerId],
    );

    const externalTransactionId = `ext-fallback-${randomUUID()}`;
    const idempotencyKey = `prov-1:${externalTransactionId}`;

    // Payload plano sem campo 'messageId'
    const rawPayload = JSON.stringify({
      idempotencyKey,
      providerId: 'prov-1',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-fb-1',
      gameId: 'fortune-rabbit',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });

    const fixedSqsMessageId = `sqs-native-msg-${randomUUID()}`;
    const simulatedMessage = {
      MessageId: fixedSqsMessageId,
      ReceiptHandle: 'dummy-receipt-fallback',
      Body: rawPayload,
    };

    // 1. Primeira execução: usa MessageId nativo do SQS como chave do inbox
    const stack1 = createConsumerStack();
    await stack1.consumer.processSingleMessage(simulatedMessage);

    const walletRows1 = await conn.execute<Array<{ balance_amount: string }>>(
      `SELECT balance_amount FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows1[0]?.balance_amount).toBe('350.00');

    // 2. Redelivery da mesma mensagem nativa do SQS (mesmo SQS MessageId)
    const stack2 = createConsumerStack();
    await stack2.consumer.processSingleMessage(simulatedMessage);

    // 3. Saldo permanece 350.00, sem débito duplicado
    const walletRows2 = await conn.execute<Array<{ balance_amount: string }>>(
      `SELECT balance_amount FROM wallets WHERE id = ?`,
      [walletId],
    );
    expect(walletRows2[0]?.balance_amount).toBe('350.00');

    // Ledger contém apenas 1 entrada
    const ledgerRows = await conn.execute<Array<{ id: string }>>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(ledgerRows.length).toBe(1);
  });
});
