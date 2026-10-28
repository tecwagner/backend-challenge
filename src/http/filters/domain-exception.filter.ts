import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
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
  LedgerArithmeticError,
  WalletCurrencyMismatchError,
} from '../../domain/wallet/wallet.errors.js';
import {
  InvalidTransactionStateError,
  OpeningKindForbiddenError,
  ReferenceRequiredError,
} from '../../domain/wager-transaction/wager-transaction.errors.js';

interface ErrorResponsePayload {
  statusCode: number;
  error: string;
  message: string | string[];
  timestamp: string;
  path?: string;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const path = request?.url;
    const timestamp = new Date().toISOString();

    let statusCode: number;
    let errorName: string;
    let message: string | string[];

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, unknown>;
        message = (resObj['message'] as string | string[]) ?? exception.message;
        errorName = (resObj['error'] as string) ?? exception.name;
      } else {
        message = typeof res === 'string' ? res : exception.message;
        errorName = exception.name;
      }
    } else if (exception instanceof WalletNotFoundError) {
      statusCode = HttpStatus.NOT_FOUND;
      errorName = 'Not Found';
      message = exception.message;
    } else if (
      exception instanceof WalletAlreadyExistsError ||
      exception instanceof IdempotencyConflictError
    ) {
      statusCode = HttpStatus.CONFLICT;
      errorName = 'Conflict';
      message = exception.message;
    } else if (
      exception instanceof InvalidMoneyError ||
      exception instanceof CurrencyMismatchError ||
      exception instanceof WalletCurrencyMismatchError ||
      exception instanceof InsufficientBalanceError ||
      exception instanceof OpeningKindForbiddenError ||
      exception instanceof ReferenceRequiredError ||
      exception instanceof InvalidTransactionStateError
    ) {
      statusCode = HttpStatus.UNPROCESSABLE_ENTITY;
      errorName = 'Unprocessable Entity';
      message = exception.message;
    } else if (this.isLockTimeoutError(exception)) {
      statusCode = HttpStatus.SERVICE_UNAVAILABLE;
      errorName = 'Service Unavailable';
      message = 'Resource lock acquisition timeout, retry recommended';
    } else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      errorName = 'Internal Server Error';
      message = 'An unexpected error occurred';

      this.logger.error(
        `Unhandled exception: ${exception instanceof Error ? exception.message : String(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const payload: ErrorResponsePayload = {
      statusCode,
      error: errorName,
      message,
      timestamp,
      ...(path ? { path } : {}),
    };

    response.status(statusCode).send(payload);
  }

  private isLockTimeoutError(exception: unknown): boolean {
    if (!exception || typeof exception !== 'object') {
      return false;
    }
    const err = exception as { code?: string; message?: string; name?: string };
    return (
      err.code === '55P03' || // PostgreSQL lock_not_available
      err.code === '57014' || // query_canceled / statement_timeout
      (typeof err.message === 'string' &&
        (err.message.includes('lock timeout') ||
          err.message.includes('could not obtain lock')))
    );
  }
}
