import { describe, expect, it } from 'bun:test';
import { CorrelationIdMiddleware } from './correlation-id.middleware.js';

describe('CorrelationIdMiddleware', () => {
  const middleware = new CorrelationIdMiddleware();

  it('Requirement 12.1: extracts existing x-correlation-id header and propagates to response', () => {
    let nextCalled = false;
    const req: any = {
      headers: {
        'x-correlation-id': 'client-corr-id-123',
      },
    };
    const resHeaders: Record<string, string> = {};
    const res: any = {
      setHeader(name: string, value: string) {
        resHeaders[name] = value;
      },
    };

    middleware.use(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(req.correlationId).toBe('client-corr-id-123');
    expect(resHeaders['X-Correlation-Id']).toBe('client-corr-id-123');
  });

  it('Requirement 12.1: generates a new UUID when correlation header is missing', () => {
    let nextCalled = false;
    const req: any = {
      headers: {},
      raw: {},
    };
    const resHeaders: Record<string, string> = {};
    const res: any = {
      header(name: string, value: string) {
        resHeaders[name] = value;
      },
    };

    middleware.use(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(typeof req.correlationId).toBe('string');
    expect(req.correlationId.length).toBeGreaterThan(10);
    expect(req.raw.correlationId).toBe(req.correlationId);
    expect(resHeaders['X-Correlation-Id']).toBe(req.correlationId);
  });
});
