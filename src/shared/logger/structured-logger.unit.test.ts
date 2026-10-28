import { describe, expect, it, mock } from 'bun:test';
import { StructuredLogger, sanitizeLogData } from './structured-logger.js';

describe('StructuredLogger', () => {
  it('Requirement 12.2: sanitizeLogData recursively redacts financial balances and sensitive data', () => {
    const raw = {
      playerId: 'player-1',
      walletId: 'wallet-1',
      money: { amount: '100.00', currency: 'BRL' },
      balance: '500.00',
      initialBalance: '250.00',
      balanceBefore: '600.00',
      balanceAfter: '500.00',
      password: 'super-secret-password',
      secret: 'api-secret',
      token: 'jwt-token-123',
      creditCard: '1234-5678-9012-3456',
      cpf: '123.456.789-00',
      email: 'user@example.com',
      nested: {
        amount: '50.00',
        safeField: 'safe-value',
      },
    };

    const sanitized = sanitizeLogData(raw);

    expect(sanitized.playerId).toBe('player-1');
    expect(sanitized.walletId).toBe('wallet-1');
    expect(sanitized.money).toBe('[REDACTED]');
    expect(sanitized.balance).toBe('[REDACTED]');
    expect(sanitized.initialBalance).toBe('[REDACTED]');
    expect(sanitized.balanceBefore).toBe('[REDACTED]');
    expect(sanitized.balanceAfter).toBe('[REDACTED]');
    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.secret).toBe('[REDACTED]');
    expect(sanitized.token).toBe('[REDACTED]');
    expect(sanitized.creditCard).toBe('[REDACTED]');
    expect(sanitized.cpf).toBe('[REDACTED]');
    expect(sanitized.email).toBe('[REDACTED]');
    expect(sanitized.nested.amount).toBe('[REDACTED]');
    expect(sanitized.nested.safeField).toBe('safe-value');
  });

  it('Requirement 12.1: financial() includes mandatory fields correlationId, messageId, transactionId, walletId, providerId', () => {
    let capturedPayload: any;
    let capturedMsg: string | undefined;

    const mockPino = {
      info: mock((payload: any, msg: string) => {
        capturedPayload = payload;
        capturedMsg = msg;
      }),
      error: mock(() => {}),
      warn: mock(() => {}),
      debug: mock(() => {}),
      trace: mock(() => {}),
      child: mock(() => mockPino),
    } as any;

    const logger = new StructuredLogger(mockPino);

    logger.financial('wager_transaction_processed', {
      correlationId: 'corr-123',
      messageId: 'msg-456',
      transactionId: 'tx-789',
      walletId: 'wal-101',
      providerId: 'prov-202',
      status: 'PROCESSED',
      kind: 'BET',
    });

    expect(capturedMsg).toBe('Financial event: wager_transaction_processed');
    expect(capturedPayload.event).toBe('wager_transaction_processed');
    expect(capturedPayload.correlationId).toBe('corr-123');
    expect(capturedPayload.messageId).toBe('msg-456');
    expect(capturedPayload.transactionId).toBe('tx-789');
    expect(capturedPayload.walletId).toBe('wal-101');
    expect(capturedPayload.providerId).toBe('prov-202');
    expect(capturedPayload.status).toBe('PROCESSED');
    expect(capturedPayload.kind).toBe('BET');
  });

  it('Requirement 12.1: financial() populates null for optional mandatory fields when not provided', () => {
    let capturedPayload: any;
    const mockPino = {
      info: mock((payload: any) => {
        capturedPayload = payload;
      }),
      child: mock(() => mockPino),
    } as any;

    const logger = new StructuredLogger(mockPino);

    logger.financial('opening_created', {
      correlationId: 'corr-999',
    });

    expect(capturedPayload.correlationId).toBe('corr-999');
    expect(capturedPayload.messageId).toBeNull();
    expect(capturedPayload.transactionId).toBeNull();
    expect(capturedPayload.walletId).toBeNull();
    expect(capturedPayload.providerId).toBeNull();
  });

  it('child logger inherits and sanitizes bindings', () => {
    let childBindings: any;
    const mockPino = {
      child: mock((b: any) => {
        childBindings = b;
        return mockPino;
      }),
      info: mock(() => {}),
    } as any;

    const logger = new StructuredLogger(mockPino);
    const child = logger.child({
      service: 'test-service',
      amount: '999.00', // sensitive
    });

    expect(childBindings.service).toBe('test-service');
    expect(childBindings.amount).toBe('[REDACTED]');
    expect(child).toBeInstanceOf(StructuredLogger);
  });
});
