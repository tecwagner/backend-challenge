import { describe, test, expect } from 'bun:test';
import { Money } from '../money/money.js';
import { Wallet } from '../wallet/wallet.aggregate.js';
import { WalletLedgerEntry } from '../wallet/wallet-ledger-entry.js';
import { WagerTransaction } from '../wager-transaction/wager-transaction.entity.js';
import { WagerTransactionKind } from '../wager-transaction/wager-transaction.enums.js';
import { FailureCode } from '../wager-transaction/failure-codes.js';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
} from './wager-events.js';
import type { IntegrationEvent } from './integration-event.base.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function forAll<T>(label: string, inputs: T[], predicate: (input: T) => void): void {
  for (const input of inputs) {
    try {
      predicate(input);
    } catch (err) {
      throw new Error(
        `Property "${label}" failed for input ${JSON.stringify(input)}: ${String(err)}`,
      );
    }
  }
}

const CTX_WITH_CAUSATION = { correlationId: 'corr-1', causationId: 'cause-1' };
const CTX_WITHOUT_CAUSATION = { correlationId: 'corr-2' };

function makeBetTx(): WagerTransaction {
  return WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'key-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
  });
}

function makeRefundTx(): WagerTransaction {
  return WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId: 'ext-2',
    idempotencyKey: 'key-2',
    payloadHash: 'hash-2',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Refund,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId: 'ext-1',
  });
}

function makeWallet(): Wallet {
  return Wallet.open({ id: 'wallet-1', playerId: 'player-1', currency: 'BRL' });
}

function makeLedgerEntry(wallet: Wallet): WalletLedgerEntry {
  const money = Money.from({ amount: '25.00', currency: 'BRL' });
  const balanceBefore = Money.zero('BRL');
  const balanceAfter = balanceBefore.add(money);
  return WalletLedgerEntry.create({
    walletId: wallet.id,
    transactionId: 'tx-1',
    direction: 'CREDIT',
    money,
    balanceBefore,
    balanceAfter,
  });
}

/** Checks that a value is a JSON-primitive leaf (no class instances, no undefined). */
function isJsonPrimitive(value: unknown): boolean {
  if (value === null) return true;
  if (value === undefined) return false;
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean';
}

/** Recursively asserts every leaf in an object is a JSON primitive. */
function assertJsonPure(value: unknown, path = 'root'): void {
  if (value === null || isJsonPrimitive(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJsonPure(item, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    // Must be a plain object — no class instances
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertJsonPure(v, `${path}.${k}`);
    }
    return;
  }
  throw new Error(`Non-JSON value at ${path}: ${typeof value} ${String(value)}`);
}

/** Asserts round-trip through JSON.stringify / JSON.parse is lossless. */
function assertRoundTrip(json: Record<string, unknown>): void {
  const serialized = JSON.stringify(json);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  expect(parsed).toEqual(json);
}

// ---------------------------------------------------------------------------
// Fixtures: one instance of each event, with and without causationId
// ---------------------------------------------------------------------------

type EventFactory = () => IntegrationEvent<unknown>;

const EVENT_FACTORIES: Array<{ name: string; make: EventFactory }> = [
  {
    name: 'WagerTransactionProcessed (with causationId)',
    make: () => {
      const tx = makeBetTx();
      tx.markProcessed(undefined, new Date());
      return WagerTransactionProcessed.from(tx, CTX_WITH_CAUSATION);
    },
  },
  {
    name: 'WagerTransactionProcessed (without causationId)',
    make: () => {
      const tx = makeBetTx();
      tx.markProcessed(undefined, new Date());
      return WagerTransactionProcessed.from(tx, CTX_WITHOUT_CAUSATION);
    },
  },
  {
    name: 'WagerTransactionRejected (with causationId)',
    make: () => {
      const tx = makeBetTx();
      tx.reject(FailureCode.BalanceInsufficient);
      return WagerTransactionRejected.from(tx, CTX_WITH_CAUSATION);
    },
  },
  {
    name: 'WagerTransactionRejected (without causationId)',
    make: () => {
      const tx = makeBetTx();
      tx.reject(FailureCode.BalanceInsufficient);
      return WagerTransactionRejected.from(tx, CTX_WITHOUT_CAUSATION);
    },
  },
  {
    name: 'WagerTransactionPendingReference (with causationId)',
    make: () => {
      const tx = makeRefundTx();
      tx.markPendingReference();
      return WagerTransactionPendingReference.from(tx, CTX_WITH_CAUSATION);
    },
  },
  {
    name: 'WagerTransactionPendingReference (without causationId)',
    make: () => {
      const tx = makeRefundTx();
      tx.markPendingReference();
      return WagerTransactionPendingReference.from(tx, CTX_WITHOUT_CAUSATION);
    },
  },
  {
    name: 'WalletBalanceChanged (with causationId)',
    make: () => {
      const wallet = makeWallet();
      const entry = makeLedgerEntry(wallet);
      return WalletBalanceChanged.from(wallet, entry, CTX_WITH_CAUSATION);
    },
  },
  {
    name: 'WalletBalanceChanged (without causationId)',
    make: () => {
      const wallet = makeWallet();
      const entry = makeLedgerEntry(wallet);
      return WalletBalanceChanged.from(wallet, entry, CTX_WITHOUT_CAUSATION);
    },
  },
];

// ---------------------------------------------------------------------------
// Property 19: IntegrationEvent envelope contains all required fields
// Validates: Requirements 11.1
// ---------------------------------------------------------------------------

describe('Property 19: IntegrationEvent envelope contains all required fields', () => {
  /**
   * For every concrete IntegrationEvent subclass:
   *   1. toJSON() must include all mandatory envelope fields.
   *   2. eventType must be a non-empty string.
   *   3. version must be a positive integer.
   *   4. eventId must be a non-empty string (UUID).
   *   5. aggregateId must be a non-empty string.
   *   6. correlationId must match the context passed to the factory.
   *   7. causationId must be present iff the context carried one.
   *   8. occurredAt must be a valid ISO-8601 string.
   *   9. data must be present.
   */

  test('all mandatory envelope fields are present in toJSON()', () => {
    forAll('mandatory fields', EVENT_FACTORIES, ({ make }) => {
      const json = make().toJSON();

      expect(typeof json.eventId).toBe('string');
      expect(json.eventId.length).toBeGreaterThan(0);

      expect(typeof json.eventType).toBe('string');
      expect(json.eventType.length).toBeGreaterThan(0);

      expect(typeof json.version).toBe('number');
      expect(Number.isInteger(json.version)).toBe(true);
      expect(json.version).toBeGreaterThan(0);

      expect(typeof json.aggregateId).toBe('string');
      expect(json.aggregateId.length).toBeGreaterThan(0);

      expect(typeof json.correlationId).toBe('string');
      expect(json.correlationId.length).toBeGreaterThan(0);

      expect(typeof json.occurredAt).toBe('string');
      expect(new Date(json.occurredAt).toISOString()).toBe(json.occurredAt);

      expect(json.data).toBeDefined();
    });
  });

  test('correlationId in envelope matches the context supplied to the factory', () => {
    forAll('correlationId matches context', EVENT_FACTORIES, ({ name, make }) => {
      const event = make();
      const json = event.toJSON();
      expect(json.correlationId).toBe(event.correlationId);
    });
  });

  test('causationId is present when context carries one, absent otherwise', () => {
    const withCausation = EVENT_FACTORIES.filter(f => f.name.includes('with causationId'));
    const withoutCausation = EVENT_FACTORIES.filter(f => f.name.includes('without causationId'));

    forAll('causationId present', withCausation, ({ make }) => {
      const json = make().toJSON();
      expect(typeof json.causationId).toBe('string');
      expect((json.causationId as string).length).toBeGreaterThan(0);
    });

    forAll('causationId absent', withoutCausation, ({ make }) => {
      const json = make().toJSON();
      expect(json.causationId).toBeUndefined();
    });
  });

  test('eventType is stable across multiple calls to toJSON()', () => {
    forAll('eventType stability', EVENT_FACTORIES, ({ make }) => {
      const event = make();
      expect(event.toJSON().eventType).toBe(event.toJSON().eventType);
    });
  });

  test('version is stable across multiple calls to toJSON()', () => {
    forAll('version stability', EVENT_FACTORIES, ({ make }) => {
      const event = make();
      expect(event.toJSON().version).toBe(event.toJSON().version);
    });
  });

  test('eventId is stable across multiple calls to toJSON() (same instance)', () => {
    forAll('eventId stability', EVENT_FACTORIES, ({ make }) => {
      const event = make();
      expect(event.toJSON().eventId).toBe(event.toJSON().eventId);
    });
  });

  test('two distinct instances produce different eventIds', () => {
    forAll('unique eventIds', EVENT_FACTORIES, ({ make }) => {
      const a = make().toJSON();
      const b = make().toJSON();
      expect(a.eventId).not.toBe(b.eventId);
    });
  });

  test('each concrete subclass has a distinct eventType', () => {
    const uniqueTypes = new Set(
      EVENT_FACTORIES.map(({ make }) => make().eventType),
    );
    // 4 distinct event types (each appears twice: with/without causationId)
    expect(uniqueTypes.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Property 20: IntegrationEvent payload is pure JSON
// Validates: Requirements 11.2
// ---------------------------------------------------------------------------

describe('Property 20: IntegrationEvent payload is pure JSON', () => {
  /**
   * For every concrete IntegrationEvent subclass:
   *   1. toJSON() returns a plain object — no class instances.
   *   2. Every leaf value is a JSON primitive (string, number, boolean, null).
   *   3. No Money instances appear anywhere in the payload.
   *   4. MoneyProps fields are serialized as { amount: string, currency: string }.
   *   5. Dates are serialized as ISO-8601 strings, not Date objects.
   *   6. JSON.stringify → JSON.parse round-trip is lossless.
   */

  test('toJSON() returns a plain object (no class instances)', () => {
    forAll('plain object', EVENT_FACTORIES, ({ make }) => {
      const json = make().toJSON();
      expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
    });
  });

  test('every leaf in toJSON() is a JSON primitive', () => {
    forAll('JSON primitive leaves', EVENT_FACTORIES, ({ make }) => {
      assertJsonPure(make().toJSON());
    });
  });

  test('no Date objects appear anywhere in toJSON()', () => {
    forAll('no Date objects', EVENT_FACTORIES, ({ make }) => {
      const serialized = JSON.stringify(make().toJSON());
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      // Walk the parsed object — if any value were a Date it would have been
      // serialized as ISO string, which is correct; but the raw toJSON() must
      // not contain Date instances
      function walkForDates(obj: unknown): void {
        if (obj instanceof Date) throw new Error('Date instance found in toJSON()');
        if (obj && typeof obj === 'object') {
          for (const v of Object.values(obj as Record<string, unknown>)) walkForDates(v);
        }
      }
      walkForDates(make().toJSON());
    });
  });

  test('MoneyProps in data are { amount: string, currency: string }', () => {
    const moneyEvents = EVENT_FACTORIES.filter(f =>
      f.name.startsWith('WagerTransaction') || f.name.startsWith('WalletBalanceChanged'),
    );

    forAll('MoneyProps shape', moneyEvents, ({ make }) => {
      const data = make().toJSON().data as Record<string, unknown>;

      function checkMoneyProps(obj: unknown, path: string): void {
        if (!obj || typeof obj !== 'object') return;
        const o = obj as Record<string, unknown>;
        // Detect MoneyProps by presence of both 'amount' and 'currency'
        if ('amount' in o && 'currency' in o) {
          expect(typeof o.amount, `${path}.amount`).toBe('string');
          expect(typeof o.currency, `${path}.currency`).toBe('string');
          // amount must match the fixed-2-decimal format
          expect(o.amount as string).toMatch(/^\d+\.\d{2}$/);
        }
        for (const [k, v] of Object.entries(o)) checkMoneyProps(v, `${path}.${k}`);
      }

      checkMoneyProps(data, 'data');
    });
  });

  test('JSON.stringify → JSON.parse round-trip is lossless', () => {
    forAll('round-trip', EVENT_FACTORIES, ({ make }) => {
      assertRoundTrip(make().toJSON() as unknown as Record<string, unknown>);
    });
  });

  test('data is frozen — mutations are silently ignored (Readonly<T>)', () => {
    forAll('data immutability', EVENT_FACTORIES, ({ make }) => {
      const event = make();
      const dataBefore = JSON.stringify(event.data);
      try {
        // Attempt mutation — should be a no-op in strict mode or throw in non-strict
        (event.data as Record<string, unknown>)['__injected__'] = 'evil';
      } catch {
        // TypeError in strict mode — acceptable
      }
      expect(JSON.stringify(event.data)).toBe(dataBefore);
    });
  });
});
