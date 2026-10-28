import { randomUUID } from 'crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';

export interface RequestWithCorrelation {
  correlationId?: string;
  raw?: { correlationId?: string };
  headers: Record<string, string | string[] | undefined>;
}

export interface ResponseWithHeader {
  setHeader?(name: string, value: string): void;
  header?(name: string, value: string): void;
}

/**
 * Middleware that extracts or generates a correlationId for each HTTP request,
 * attaches it to the request context, and sets the X-Correlation-Id response header.
 *
 * Requirements: 12.1
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(
    req: RequestWithCorrelation,
    res: ResponseWithHeader,
    next: () => void,
  ): void {
    const rawHeader =
      req.headers?.['x-correlation-id'] ??
      req.headers?.['X-Correlation-Id'] ??
      req.headers?.['correlation-id'];

    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const correlationId =
      typeof headerValue === 'string' && headerValue.trim().length > 0
        ? headerValue.trim()
        : randomUUID();

    req.correlationId = correlationId;
    if (req.raw) {
      req.raw.correlationId = correlationId;
    }

    if (typeof res.setHeader === 'function') {
      res.setHeader('X-Correlation-Id', correlationId);
    } else if (typeof res.header === 'function') {
      res.header('X-Correlation-Id', correlationId);
    }

    next();
  }
}
