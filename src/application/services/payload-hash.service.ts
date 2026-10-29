import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import type { MoneyProps } from '../../domain/money/money.js';
import type { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction.enums.js';

/**
 * Canonical business fields included in the payload hash.
 * Transport metadata (correlationId, timestamps, Idempotency-Key header)
 * is intentionally excluded.
 */
export interface HashableTransactionPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind | string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

const CANONICAL_FIELDS: ReadonlyArray<keyof HashableTransactionPayload> = [
  'externalTransactionId',
  'gameId',
  'kind',
  'money',
  'playerId',
  'providerId',
  'referenceExternalTransactionId',
  'roundId',
  'walletId',
];

/**
 * SHA-256 of a canonical JSON representation of business fields.
 *
 * Canonicalization rules (documented in ARCHITECTURE.md):
 * 1. Only the business fields listed in CANONICAL_FIELDS participate.
 * 2. Undefined fields are omitted (so optional reference is stable).
 * 3. Object keys are sorted lexicographically at every nesting level.
 * 4. Money is represented as `{ amount, currency }` with those keys sorted.
 *
 * Requirements: 3.3, 4.1, 4.2, 4.5
 */
@Injectable()
export class PayloadHashService {
  compute(payload: HashableTransactionPayload): string {
    const canonical = canonicalize(selectBusinessFields(payload));
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }
}

function selectBusinessFields(payload: HashableTransactionPayload): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of CANONICAL_FIELDS) {
    const value = payload[key];
    if (value !== undefined) {
      selected[key] = value;
    }
  }
  return selected;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonicalize(v)]);
    return Object.fromEntries(entries);
  }
  return value;
}
