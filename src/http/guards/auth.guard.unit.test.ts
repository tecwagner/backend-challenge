import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from './auth.guard.js';

describe('AuthGuard (no-op)', () => {
  it('returns true allowing all requests', () => {
    const guard = new AuthGuard();
    const mockContext = {} as ExecutionContext;
    expect(guard.canActivate(mockContext)).toBe(true);
  });
});
