import { Injectable, LoggerService, Optional } from '@nestjs/common';
import pino, { type Logger, type LoggerOptions } from 'pino';

export interface FinancialLogContext {
  correlationId: string;
  messageId?: string | null;
  transactionId?: string | null;
  walletId?: string | null;
  providerId?: string | null;
  event?: string;
  status?: string;
  kind?: string;
  playerId?: string;
  [key: string]: unknown;
}

const REDACTED_KEYS = new Set([
  'amount',
  'balance',
  'initialbalance',
  'money',
  'balancebefore',
  'balanceafter',
  'password',
  'secret',
  'token',
  'authorization',
  'creditcard',
  'cpf',
  'email',
]);

/**
 * Recursively redacts sensitive values and financial balances from logs.
 * Requirements: 12.2
 */
export function sanitizeLogData<T>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input !== 'object') {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => sanitizeLogData(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    if (REDACTED_KEYS.has(normalizedKey)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeLogData(value);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

/**
 * StructuredLogger wraps Pino to provide JSON logging with required financial fields
 * (correlationId, messageId, transactionId, walletId, providerId) and strict
 * redaction of financial balances and sensitive data.
 *
 * Requirements: 12.1, 12.2
 */
@Injectable()
export class StructuredLogger implements LoggerService {
  private readonly pino: Logger;

  constructor(@Optional() customLoggerOrOptions?: Logger | LoggerOptions) {
    if (customLoggerOrOptions && typeof (customLoggerOrOptions as Logger).info === 'function') {
      this.pino = customLoggerOrOptions as Logger;
    } else {
      const options: LoggerOptions = {
        level: process.env['LOG_LEVEL'] ?? 'info',
        base: { service: 'wagering-processor' },
        timestamp: pino.stdTimeFunctions.isoTime,
        ...(customLoggerOrOptions as LoggerOptions),
      };
      this.pino = pino(options);
    }
  }

  getPino(): Logger {
    return this.pino;
  }

  /**
   * Logs a financial processing event with all mandatory fields:
   * correlationId, messageId, transactionId, walletId, providerId.
   *
   * Requirements: 12.1, 12.2
   */
  financial(event: string, context: FinancialLogContext, message?: string): void {
    const payload = sanitizeLogData({
      event,
      ...context,
      messageId: context.messageId ?? null,
      transactionId: context.transactionId ?? null,
      walletId: context.walletId ?? null,
      providerId: context.providerId ?? null,
    });

    this.pino.info(payload, message ?? `Financial event: ${event}`);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.callPino('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.callPino('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.callPino('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.callPino('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.callPino('trace', message, optionalParams);
  }

  child(bindings: Record<string, unknown>): StructuredLogger {
    const childPino = this.pino.child(sanitizeLogData(bindings));
    return new StructuredLogger(childPino);
  }

  private callPino(level: 'info' | 'error' | 'warn' | 'debug' | 'trace', message: unknown, optionalParams: unknown[]): void {
    let context: Record<string, unknown> | undefined;
    let msg = typeof message === 'string' ? message : '';

    if (typeof message === 'object' && message !== null) {
      context = message as Record<string, unknown>;
    }

    if (optionalParams.length > 0) {
      const last = optionalParams[optionalParams.length - 1];
      if (typeof last === 'object' && last !== null) {
        context = { ...(context ?? {}), ...(last as Record<string, unknown>) };
      } else if (typeof last === 'string' && !msg) {
        msg = last;
      }
    }

    if (context) {
      this.pino[level](sanitizeLogData(context), msg);
    } else {
      this.pino[level](msg);
    }
  }
}
