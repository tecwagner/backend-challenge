import { Injectable } from '@nestjs/common';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction.entity.js';
import { IdempotencyConflictError } from '../errors/application.errors.js';

export type IdempotencyDecision =
  | { kind: 'new' }
  | { kind: 'replay'; transaction: WagerTransaction };

/**
 * Persistent idempotency check against an already-stored WagerTransaction.
 *
 * Same key + same hash → replay the original result.
 * Same key + different hash → conflict (HTTP 409); never process the new payload.
 *
 * Requirements: 4.1, 4.2, 4.5
 */
@Injectable()
export class IdempotencyService {
  decide(existing: WagerTransaction | null, payloadHash: string, idempotencyKey: string): IdempotencyDecision {
    if (existing === null) {
      return { kind: 'new' };
    }
    if (existing.matchesPayload(payloadHash)) {
      return { kind: 'replay', transaction: existing };
    }
    throw new IdempotencyConflictError(idempotencyKey);
  }
}
