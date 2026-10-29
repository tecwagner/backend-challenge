import { describe, test, expect } from 'bun:test';
import { Money } from '../money/money.js';
import { WagerTransaction } from './wager-transaction.entity.js';
import { WagerTransactionKind, WagerTransactionStatus } from './wager-transaction.enums.js';
import { FailureCode } from './failure-codes.js';
import { InvalidTransactionStateError } from './wager-transaction.errors.js';

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

const MONEY = Money.from({ amount: '10.00', currency: 'BRL' });

function makePending(kind: WagerTransactionKind = WagerTransactionKind.Bet): WagerTransaction {
  const needsRef =
    kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;

  return WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId: `ext-${Math.random()}`,
    idempotencyKey: `key-${Math.random()}`,
    payloadHash: 'hash-abc',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: MONEY,
    ...(needsRef ? { referenceExternalTransactionId: 'ext-ref-1' } : {}),
  });
}

/** All transitions that mutate state. */
type Transition = (tx: WagerTransaction) => void;

const ALL_TRANSITIONS: Array<{ name: string; fn: Transition }> = [
  { name: 'markProcessed', fn: (tx) => tx.markProcessed(undefined, new Date()) },
  { name: 'markPendingReference', fn: (tx) => tx.markPendingReference() },
  { name: 'reject', fn: (tx) => tx.reject(FailureCode.BalanceInsufficient) },
  { name: 'fail', fn: (tx) => tx.fail(FailureCode.InfraPermanent) },
];

const TERMINAL_STATUSES: WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

/** Drives a transaction to the given terminal status. */
function driveToTerminal(status: WagerTransactionStatus): WagerTransaction {
  const tx = makePending();
  switch (status) {
    case WagerTransactionStatus.Processed:
      tx.markProcessed(undefined, new Date());
      break;
    case WagerTransactionStatus.Rejected:
      tx.reject(FailureCode.BalanceInsufficient);
      break;
    case WagerTransactionStatus.Failed:
      tx.fail(FailureCode.InfraPermanent);
      break;
  }
  return tx;
}

// ---------------------------------------------------------------------------
// Property 9: State transitions — terminal states are irreversible
// Validates: Requirements 3.6
// ---------------------------------------------------------------------------

describe('Property 9: State transitions — terminal states are irreversible', () => {
  /**
   * Validates: Requirements 3.6
   *
   * For any transaction in a terminal state (PROCESSED, REJECTED, FAILED):
   *   1. Every transition (markProcessed, markPendingReference, reject, fail)
   *      MUST throw InvalidTransactionStateError.
   *   2. The status MUST remain unchanged after the failed transition attempt.
   *   3. isTerminal() MUST return true for all terminal statuses.
   *   4. Non-terminal statuses (PENDING, PENDING_REFERENCE) MUST NOT be terminal.
   */

  test('every transition on a PROCESSED transaction throws InvalidTransactionStateError', () => {
    forAll(
      'PROCESSED → any transition throws',
      ALL_TRANSITIONS,
      ({ name, fn }) => {
        const tx = driveToTerminal(WagerTransactionStatus.Processed);
        expect(() => fn(tx)).toThrow(InvalidTransactionStateError);
      },
    );
  });

  test('every transition on a REJECTED transaction throws InvalidTransactionStateError', () => {
    forAll(
      'REJECTED → any transition throws',
      ALL_TRANSITIONS,
      ({ name, fn }) => {
        const tx = driveToTerminal(WagerTransactionStatus.Rejected);
        expect(() => fn(tx)).toThrow(InvalidTransactionStateError);
      },
    );
  });

  test('every transition on a FAILED transaction throws InvalidTransactionStateError', () => {
    forAll(
      'FAILED → any transition throws',
      ALL_TRANSITIONS,
      ({ name, fn }) => {
        const tx = driveToTerminal(WagerTransactionStatus.Failed);
        expect(() => fn(tx)).toThrow(InvalidTransactionStateError);
      },
    );
  });

  test('status remains unchanged after a rejected transition attempt on terminal state', () => {
    forAll(
      'status unchanged after failed transition',
      TERMINAL_STATUSES,
      (terminalStatus) => {
        for (const { fn } of ALL_TRANSITIONS) {
          const tx = driveToTerminal(terminalStatus);
          try {
            fn(tx);
          } catch {
            // expected
          }
          expect(tx.status).toBe(terminalStatus);
        }
      },
    );
  });

  test('isTerminal() returns true for all terminal statuses', () => {
    forAll(
      'isTerminal() === true for terminal statuses',
      TERMINAL_STATUSES,
      (terminalStatus) => {
        const tx = driveToTerminal(terminalStatus);
        expect(tx.isTerminal()).toBe(true);
      },
    );
  });

  test('isTerminal() returns false for PENDING and PENDING_REFERENCE', () => {
    const nonTerminal = [
      makePending(),
      (() => { const tx = makePending(WagerTransactionKind.Refund); tx.markPendingReference(); return tx; })(),
    ];

    forAll(
      'isTerminal() === false for non-terminal statuses',
      nonTerminal,
      (tx) => {
        expect(tx.isTerminal()).toBe(false);
      },
    );
  });

  test('PENDING_REFERENCE can still transition to terminal states', () => {
    const transitions: Array<{ name: string; fn: Transition; expectedStatus: WagerTransactionStatus }> = [
      {
        name: 'markProcessed',
        fn: (tx) => tx.markProcessed(undefined, new Date()),
        expectedStatus: WagerTransactionStatus.Processed,
      },
      {
        name: 'reject',
        fn: (tx) => tx.reject(FailureCode.ReferenceNotFound),
        expectedStatus: WagerTransactionStatus.Rejected,
      },
      {
        name: 'fail',
        fn: (tx) => tx.fail(FailureCode.InfraPermanent),
        expectedStatus: WagerTransactionStatus.Failed,
      },
    ];

    forAll(
      'PENDING_REFERENCE → terminal transitions succeed',
      transitions,
      ({ fn, expectedStatus }) => {
        const tx = makePending(WagerTransactionKind.Refund);
        tx.markPendingReference();
        expect(tx.isTerminal()).toBe(false);
        fn(tx);
        expect(tx.status).toBe(expectedStatus);
        expect(tx.isTerminal()).toBe(true);
      },
    );
  });

  test('once terminal, repeated transition attempts always throw (idempotent guard)', () => {
    // Apply the same transition 10 times — must always throw
    const REPEAT = 10;

    forAll(
      'repeated transitions on terminal always throw',
      TERMINAL_STATUSES,
      (terminalStatus) => {
        for (const { fn } of ALL_TRANSITIONS) {
          const tx = driveToTerminal(terminalStatus);
          for (let i = 0; i < REPEAT; i++) {
            expect(() => fn(tx)).toThrow(InvalidTransactionStateError);
            expect(tx.status).toBe(terminalStatus);
          }
        }
      },
    );
  });

  test('failureCode and processedAt are preserved after rejected transition attempt', () => {
    const tx = driveToTerminal(WagerTransactionStatus.Rejected);
    const codeBeforeAttempt = tx.failureCode;

    try {
      tx.markProcessed(undefined, new Date());
    } catch {
      // expected
    }

    expect(tx.failureCode).toBe(codeBeforeAttempt);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
  });

  test('processedAt is preserved after rejected transition attempt on PROCESSED', () => {
    const processedAt = new Date('2024-01-01T00:00:00.000Z');
    const tx = makePending();
    tx.markProcessed(undefined, processedAt);
    const capturedAt = tx.processedAt;

    try {
      tx.reject(FailureCode.BalanceInsufficient);
    } catch {
      // expected
    }

    expect(tx.processedAt).toEqual(capturedAt);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });
});
