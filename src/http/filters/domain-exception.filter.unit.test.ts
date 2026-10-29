import { describe, expect, it } from 'bun:test';
import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DomainExceptionFilter } from './domain-exception.filter.js';
import {
  IdempotencyConflictError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors/application.errors.js';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../../domain/money/money.errors.js';
import {
  InsufficientBalanceError,
  WalletCurrencyMismatchError,
} from '../../domain/wallet/wallet.errors.js';
import {
  InvalidTransactionStateError,
  OpeningKindForbiddenError,
  ReferenceRequiredError,
} from '../../domain/wager-transaction/wager-transaction.errors.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction.enums.js';

function createMockHost(): {
  host: ArgumentsHost;
  getStatus: () => number;
  getBody: () => unknown;
} {
  let statusCode = 200;
  let sentBody: unknown;

  const reply = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    send(body: unknown) {
      sentBody = body;
      return this;
    },
  } as unknown as FastifyReply;

  const request = {
    url: '/test-path',
  } as unknown as FastifyRequest;

  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return {
    host,
    getStatus: () => statusCode,
    getBody: () => sentBody,
  };
}

describe('DomainExceptionFilter', () => {
  const filter = new DomainExceptionFilter();

  it('maps WalletNotFoundError to 404 Not Found', () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new WalletNotFoundError('wallet-123'), host);

    expect(getStatus()).toBe(HttpStatus.NOT_FOUND);
    const body = getBody() as Record<string, unknown>;
    expect(body['statusCode']).toBe(404);
    expect(body['error']).toBe('Not Found');
    expect(body['path']).toBe('/test-path');
  });

  it('maps WalletAlreadyExistsError to 409 Conflict', () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new WalletAlreadyExistsError('player-1', 'BRL'), host);

    expect(getStatus()).toBe(HttpStatus.CONFLICT);
    const body = getBody() as Record<string, unknown>;
    expect(body['statusCode']).toBe(409);
    expect(body['error']).toBe('Conflict');
  });

  it('maps IdempotencyConflictError to 409 Conflict', () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new IdempotencyConflictError('key-conflict'), host);

    expect(getStatus()).toBe(HttpStatus.CONFLICT);
    const body = getBody() as Record<string, unknown>;
    expect(body['statusCode']).toBe(409);
  });

  it('maps InvalidMoneyError to 422 Unprocessable Entity', () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new InvalidMoneyError('negative amount'), host);

    expect(getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    const body = getBody() as Record<string, unknown>;
    expect(body['statusCode']).toBe(422);
    expect(body['error']).toBe('Unprocessable Entity');
  });

  it('maps CurrencyMismatchError to 422 Unprocessable Entity', () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new CurrencyMismatchError('BRL', 'USD'), host);

    expect(getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  it('maps WalletCurrencyMismatchError to 422 Unprocessable Entity', () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new WalletCurrencyMismatchError('BRL', 'EUR'), host);

    expect(getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  it('maps InsufficientBalanceError to 422 Unprocessable Entity', () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new InsufficientBalanceError('10.00', '20.00', 'BRL'), host);

    expect(getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  it('maps OpeningKindForbiddenError to 422 Unprocessable Entity', () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new OpeningKindForbiddenError(), host);

    expect(getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  it('maps ReferenceRequiredError to 422 Unprocessable Entity', () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new ReferenceRequiredError('REFUND'), host);

    expect(getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  it('maps InvalidTransactionStateError to 422 Unprocessable Entity', () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(
      new InvalidTransactionStateError(WagerTransactionStatus.Processed, 'reject'),
      host,
    );

    expect(getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  it('maps lock timeout error to 503 Service Unavailable', () => {
    const { host, getStatus, getBody } = createMockHost();
    const lockError = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    filter.catch(lockError, host);

    expect(getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    const body = getBody() as Record<string, unknown>;
    expect(body['statusCode']).toBe(503);
    expect(body['error']).toBe('Service Unavailable');
  });

  it('preserves status code and message from existing HttpException', () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new HttpException('Custom forbidden message', HttpStatus.FORBIDDEN), host);

    expect(getStatus()).toBe(HttpStatus.FORBIDDEN);
    const body = getBody() as Record<string, unknown>;
    expect(body['statusCode']).toBe(403);
    expect(body['message']).toBe('Custom forbidden message');
  });

  it('maps unknown generic errors to 500 Internal Server Error with safe message', () => {
    const { host, getStatus, getBody } = createMockHost();
    filter.catch(new Error('Secret internal database connection string error'), host);

    expect(getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = getBody() as Record<string, unknown>;
    expect(body['statusCode']).toBe(500);
    expect(body['error']).toBe('Internal Server Error');
    expect(body['message']).toBe('An unexpected error occurred');
  });
});
