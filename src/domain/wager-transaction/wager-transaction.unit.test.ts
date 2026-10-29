import { describe, test, expect } from 'bun:test';
import { Money } from '../money/money.js';
import { WagerTransaction } from './wager-transaction.entity.js';
import { WagerTransactionKind, WagerTransactionStatus } from './wager-transaction.enums.js';
import { FailureCode } from './failure-codes.js';
import {
  InvalidTransactionStateError,
  OpeningKindForbiddenError,
  ReferenceRequiredError,
} from './wager-transaction.errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

let seq = 0;
function makeProps(
  kind: WagerTransactionKind,
  extra: Partial<{ referenceExternalTransactionId: string }> = {},
) {
  seq++;
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `key-${seq}`,
    payloadHash: `hash-${seq}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('25.00'),
    ...extra,
  };
}

function makeBet() {
  return WagerTransaction.create(makeProps(WagerTransactionKind.Bet));
}

function makeRefund() {
  return WagerTransaction.create(
    makeProps(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'ext-ref-1' }),
  );
}

function makeRollback() {
  return WagerTransaction.create(
    makeProps(WagerTransactionKind.Rollback, { referenceExternalTransactionId: 'ext-ref-1' }),
  );
}

// ---------------------------------------------------------------------------
// 1. WagerTransaction.create() — estado inicial e campos (Req 3.1)
// ---------------------------------------------------------------------------

describe('WagerTransaction.create() — estado inicial', () => {
  test('nasce em status PENDING', () => {
    expect(makeBet().status).toBe(WagerTransactionStatus.Pending);
  });

  test('id é gerado automaticamente como string não vazia', () => {
    const tx = makeBet();
    expect(typeof tx.id).toBe('string');
    expect(tx.id.length).toBeGreaterThan(0);
  });

  test('dois creates geram ids distintos', () => {
    expect(makeBet().id).not.toBe(makeBet().id);
  });

  test('createdAt é definido como Date dentro do intervalo da chamada', () => {
    const before = new Date();
    const tx = makeBet();
    const after = new Date();
    expect(tx.createdAt).toBeInstanceOf(Date);
    expect(tx.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(tx.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  test('campos de entrada são preservados', () => {
    const props = makeProps(WagerTransactionKind.Bet);
    const tx = WagerTransaction.create(props);
    expect(tx.providerId).toBe(props.providerId);
    expect(tx.externalTransactionId).toBe(props.externalTransactionId);
    expect(tx.idempotencyKey).toBe(props.idempotencyKey);
    expect(tx.payloadHash).toBe(props.payloadHash);
    expect(tx.walletId).toBe(props.walletId);
    expect(tx.playerId).toBe(props.playerId);
    expect(tx.roundId).toBe(props.roundId);
    expect(tx.gameId).toBe(props.gameId);
    expect(tx.money.toJSON()).toEqual(brl('25.00').toJSON());
  });

  test('failureCode, referenceTransactionId e processedAt são undefined no início', () => {
    const tx = makeBet();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. OPENING bloqueado em create() (Req 3.4, 5.6)
// ---------------------------------------------------------------------------

describe('WagerTransaction.create() — OPENING bloqueado', () => {
  test('lança OpeningKindForbiddenError ao tentar criar OPENING via create', () => {
    expect(() =>
      WagerTransaction.create(makeProps(WagerTransactionKind.Opening)),
    ).toThrow(OpeningKindForbiddenError);
  });

  test('rehydrate aceita OPENING sem lançar erro', () => {
    expect(() =>
      WagerTransaction.rehydrate({
        ...makeProps(WagerTransactionKind.Opening),
        id: 'internal-id',
        status: WagerTransactionStatus.Processed,
        createdAt: new Date(),
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Exigência de referência por kind (Req 3.5)
// ---------------------------------------------------------------------------

describe('WagerTransaction.create() — exigência de referência', () => {
  test('REFUND sem referenceExternalTransactionId lança ReferenceRequiredError', () => {
    expect(() =>
      WagerTransaction.create(makeProps(WagerTransactionKind.Refund)),
    ).toThrow(ReferenceRequiredError);
  });

  test('ROLLBACK sem referenceExternalTransactionId lança ReferenceRequiredError', () => {
    expect(() =>
      WagerTransaction.create(makeProps(WagerTransactionKind.Rollback)),
    ).toThrow(ReferenceRequiredError);
  });

  test('REFUND com referenceExternalTransactionId é criado com sucesso', () => {
    expect(() => makeRefund()).not.toThrow();
  });

  test('ROLLBACK com referenceExternalTransactionId é criado com sucesso', () => {
    expect(() => makeRollback()).not.toThrow();
  });

  test('BET, WIN e LOSS não exigem referência', () => {
    for (const kind of [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
    ]) {
      expect(() => WagerTransaction.create(makeProps(kind))).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. WagerTransaction.rehydrate() — restauração sem revalidação (Req 3.1)
// ---------------------------------------------------------------------------

describe('WagerTransaction.rehydrate()', () => {
  const fixedDate = new Date('2024-01-01T00:00:00Z');

  test('restaura todos os campos passados', () => {
    const state = {
      id: 'fixed-id',
      providerId: 'prov',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'key-1',
      payloadHash: 'hash-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl('50.00'),
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: 'ref-internal',
      processedAt: fixedDate,
      createdAt: fixedDate,
    };
    const tx = WagerTransaction.rehydrate(state);
    expect(tx.id).toBe('fixed-id');
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('ref-internal');
    expect(tx.processedAt).toBe(fixedDate);
    expect(tx.createdAt).toBe(fixedDate);
  });

  test('rehydrate aceita status terminal sem lançar erro', () => {
    for (const status of [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ]) {
      expect(() =>
        WagerTransaction.rehydrate({
          ...makeProps(WagerTransactionKind.Bet),
          id: 'id',
          status,
          createdAt: new Date(),
        }),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. markProcessed() (Req 3.6)
// ---------------------------------------------------------------------------

describe('markProcessed()', () => {
  test('transiciona PENDING → PROCESSED', () => {
    const tx = makeBet();
    tx.markProcessed(undefined, new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  test('transiciona PENDING_REFERENCE → PROCESSED', () => {
    const tx = makeRefund();
    tx.markPendingReference();
    tx.markProcessed('internal-ref-id', new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  test('define processedAt com o Date fornecido', () => {
    const at = new Date('2024-06-01T12:00:00Z');
    const tx = makeBet();
    tx.markProcessed(undefined, at);
    expect(tx.processedAt).toBe(at);
  });

  test('define referenceTransactionId quando fornecido', () => {
    const tx = makeRefund();
    tx.markProcessed('internal-ref-id', new Date());
    expect(tx.referenceTransactionId).toBe('internal-ref-id');
  });

  test('lança InvalidTransactionStateError em PROCESSED', () => {
    const tx = makeBet();
    tx.markProcessed(undefined, new Date());
    expect(() => tx.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
  });

  test('lança InvalidTransactionStateError em REJECTED', () => {
    const tx = makeBet();
    tx.reject(FailureCode.BalanceInsufficient);
    expect(() => tx.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
  });

  test('lança InvalidTransactionStateError em FAILED', () => {
    const tx = makeBet();
    tx.fail(FailureCode.InfraPermanent);
    expect(() => tx.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
  });
});

// ---------------------------------------------------------------------------
// 6. markPendingReference() (Req 3.6, 7.1)
// ---------------------------------------------------------------------------

describe('markPendingReference()', () => {
  test('transiciona PENDING → PENDING_REFERENCE', () => {
    const tx = makeRefund();
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });

  test('lança InvalidTransactionStateError em PROCESSED', () => {
    const tx = makeBet();
    tx.markProcessed(undefined, new Date());
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('lança InvalidTransactionStateError em REJECTED', () => {
    const tx = makeBet();
    tx.reject(FailureCode.BalanceInsufficient);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('lança InvalidTransactionStateError em FAILED', () => {
    const tx = makeBet();
    tx.fail(FailureCode.InfraPermanent);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });
});

// ---------------------------------------------------------------------------
// 7. reject() (Req 3.6, 5.3)
// ---------------------------------------------------------------------------

describe('reject()', () => {
  test('transiciona PENDING → REJECTED e define failureCode', () => {
    const tx = makeBet();
    tx.reject(FailureCode.BalanceInsufficient);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.BalanceInsufficient);
  });

  test('transiciona PENDING_REFERENCE → REJECTED', () => {
    const tx = makeRefund();
    tx.markPendingReference();
    tx.reject(FailureCode.ReferenceNotFound);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('lança InvalidTransactionStateError em PROCESSED', () => {
    const tx = makeBet();
    tx.markProcessed(undefined, new Date());
    expect(() => tx.reject(FailureCode.BalanceInsufficient)).toThrow(InvalidTransactionStateError);
  });

  test('lança InvalidTransactionStateError em REJECTED', () => {
    const tx = makeBet();
    tx.reject(FailureCode.BalanceInsufficient);
    expect(() => tx.reject(FailureCode.BalanceInsufficient)).toThrow(InvalidTransactionStateError);
  });

  test('lança InvalidTransactionStateError em FAILED', () => {
    const tx = makeBet();
    tx.fail(FailureCode.InfraPermanent);
    expect(() => tx.reject(FailureCode.BalanceInsufficient)).toThrow(InvalidTransactionStateError);
  });
});

// ---------------------------------------------------------------------------
// 8. fail() (Req 3.6, 5.4)
// ---------------------------------------------------------------------------

describe('fail()', () => {
  test('transiciona PENDING → FAILED e define failureCode', () => {
    const tx = makeBet();
    tx.fail(FailureCode.InfraPermanent);
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.failureCode).toBe(FailureCode.InfraPermanent);
  });

  test('transiciona PENDING_REFERENCE → FAILED', () => {
    const tx = makeRefund();
    tx.markPendingReference();
    tx.fail(FailureCode.InfraPermanent);
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
  });

  test('lança InvalidTransactionStateError em PROCESSED', () => {
    const tx = makeBet();
    tx.markProcessed(undefined, new Date());
    expect(() => tx.fail(FailureCode.InfraPermanent)).toThrow(InvalidTransactionStateError);
  });

  test('lança InvalidTransactionStateError em REJECTED', () => {
    const tx = makeBet();
    tx.reject(FailureCode.BalanceInsufficient);
    expect(() => tx.fail(FailureCode.InfraPermanent)).toThrow(InvalidTransactionStateError);
  });

  test('lança InvalidTransactionStateError em FAILED', () => {
    const tx = makeBet();
    tx.fail(FailureCode.InfraPermanent);
    expect(() => tx.fail(FailureCode.InfraPermanent)).toThrow(InvalidTransactionStateError);
  });
});

// ---------------------------------------------------------------------------
// 9. isTerminal() (Req 3.6)
// ---------------------------------------------------------------------------

describe('isTerminal()', () => {
  test('retorna false para PENDING', () => {
    expect(makeBet().isTerminal()).toBe(false);
  });

  test('retorna false para PENDING_REFERENCE', () => {
    const tx = makeRefund();
    tx.markPendingReference();
    expect(tx.isTerminal()).toBe(false);
  });

  test('retorna true para PROCESSED', () => {
    const tx = makeBet();
    tx.markProcessed(undefined, new Date());
    expect(tx.isTerminal()).toBe(true);
  });

  test('retorna true para REJECTED', () => {
    const tx = makeBet();
    tx.reject(FailureCode.BalanceInsufficient);
    expect(tx.isTerminal()).toBe(true);
  });

  test('retorna true para FAILED', () => {
    const tx = makeBet();
    tx.fail(FailureCode.InfraPermanent);
    expect(tx.isTerminal()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. affectsBalance() — regras por kind (Req 3.4)
// ---------------------------------------------------------------------------

describe('affectsBalance()', () => {
  test('BET afeta saldo', () => {
    expect(WagerTransaction.create(makeProps(WagerTransactionKind.Bet)).affectsBalance()).toBe(true);
  });

  test('WIN afeta saldo', () => {
    expect(WagerTransaction.create(makeProps(WagerTransactionKind.Win)).affectsBalance()).toBe(true);
  });

  test('LOSS NÃO afeta saldo', () => {
    expect(WagerTransaction.create(makeProps(WagerTransactionKind.Loss)).affectsBalance()).toBe(false);
  });

  test('REFUND afeta saldo', () => {
    expect(makeRefund().affectsBalance()).toBe(true);
  });

  test('ROLLBACK afeta saldo', () => {
    expect(makeRollback().affectsBalance()).toBe(true);
  });

  test('OPENING (via rehydrate) afeta saldo', () => {
    const tx = WagerTransaction.rehydrate({
      ...makeProps(WagerTransactionKind.Opening),
      id: 'id',
      status: WagerTransactionStatus.Processed,
      createdAt: new Date(),
    });
    expect(tx.affectsBalance()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. requiresReference() — regras por kind (Req 3.5)
// ---------------------------------------------------------------------------

describe('requiresReference()', () => {
  test('REFUND requer referência', () => {
    expect(makeRefund().requiresReference()).toBe(true);
  });

  test('ROLLBACK requer referência', () => {
    expect(makeRollback().requiresReference()).toBe(true);
  });

  test('BET não requer referência', () => {
    expect(makeBet().requiresReference()).toBe(false);
  });

  test('WIN não requer referência', () => {
    expect(WagerTransaction.create(makeProps(WagerTransactionKind.Win)).requiresReference()).toBe(false);
  });

  test('LOSS não requer referência', () => {
    expect(WagerTransaction.create(makeProps(WagerTransactionKind.Loss)).requiresReference()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. matchesPayload() (Req 5.5)
// ---------------------------------------------------------------------------

describe('matchesPayload()', () => {
  test('retorna true para o mesmo hash', () => {
    const props = makeProps(WagerTransactionKind.Bet);
    const tx = WagerTransaction.create(props);
    expect(tx.matchesPayload(props.payloadHash)).toBe(true);
  });

  test('retorna false para hash diferente', () => {
    const tx = WagerTransaction.create(makeProps(WagerTransactionKind.Bet));
    expect(tx.matchesPayload('different-hash')).toBe(false);
  });

  test('retorna false para string vazia', () => {
    const tx = WagerTransaction.create(makeProps(WagerTransactionKind.Bet));
    expect(tx.matchesPayload('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. ledgerDirectionFor() — direção por kind (Req 3.4)
// ---------------------------------------------------------------------------

describe('ledgerDirectionFor()', () => {
  test('BET → DEBIT', () => {
    expect(makeBet().ledgerDirectionFor()).toBe('DEBIT');
  });

  test('WIN → CREDIT', () => {
    expect(
      WagerTransaction.create(makeProps(WagerTransactionKind.Win)).ledgerDirectionFor(),
    ).toBe('CREDIT');
  });

  test('REFUND → CREDIT', () => {
    expect(makeRefund().ledgerDirectionFor()).toBe('CREDIT');
  });

  test('OPENING (via rehydrate) → CREDIT', () => {
    const tx = WagerTransaction.rehydrate({
      ...makeProps(WagerTransactionKind.Opening),
      id: 'id',
      status: WagerTransactionStatus.Processed,
      createdAt: new Date(),
    });
    expect(tx.ledgerDirectionFor()).toBe('CREDIT');
  });

  test('ROLLBACK de BET (DEBIT) → CREDIT', () => {
    const bet = makeBet();
    const rollback = makeRollback();
    expect(rollback.ledgerDirectionFor(bet)).toBe('CREDIT');
  });

  test('ROLLBACK de WIN (CREDIT) → DEBIT', () => {
    const win = WagerTransaction.create(makeProps(WagerTransactionKind.Win));
    const rollback = makeRollback();
    expect(rollback.ledgerDirectionFor(win)).toBe('DEBIT');
  });

  test('ROLLBACK de REFUND (CREDIT) → DEBIT', () => {
    const refund = makeRefund();
    const rollback = makeRollback();
    expect(rollback.ledgerDirectionFor(refund)).toBe('DEBIT');
  });

  test('ROLLBACK sem referência lança Error', () => {
    expect(() => makeRollback().ledgerDirectionFor()).toThrow(Error);
  });

  test('LOSS lança Error (sem ledger entry)', () => {
    expect(() =>
      WagerTransaction.create(makeProps(WagerTransactionKind.Loss)).ledgerDirectionFor(),
    ).toThrow(Error);
  });
});

// ---------------------------------------------------------------------------
// 14. Regras de negócio por kind — BET (Req 3.4)
// ---------------------------------------------------------------------------

describe('Regras de negócio — BET', () => {
  test('BET: affectsBalance=true, requiresReference=false, direction=DEBIT', () => {
    const tx = makeBet();
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
    expect(tx.ledgerDirectionFor()).toBe('DEBIT');
  });

  test('BET pode ser rejeitado por saldo insuficiente com failureCode correto', () => {
    const tx = makeBet();
    tx.reject(FailureCode.BalanceInsufficient);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.BalanceInsufficient);
  });
});

// ---------------------------------------------------------------------------
// 15. Regras de negócio por kind — WIN (Req 3.4)
// ---------------------------------------------------------------------------

describe('Regras de negócio — WIN', () => {
  test('WIN: affectsBalance=true, requiresReference=false, direction=CREDIT', () => {
    const tx = WagerTransaction.create(makeProps(WagerTransactionKind.Win));
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
    expect(tx.ledgerDirectionFor()).toBe('CREDIT');
  });
});

// ---------------------------------------------------------------------------
// 16. Regras de negócio por kind — LOSS (Req 3.4)
// ---------------------------------------------------------------------------

describe('Regras de negócio — LOSS', () => {
  test('LOSS: affectsBalance=false, requiresReference=false', () => {
    const tx = WagerTransaction.create(makeProps(WagerTransactionKind.Loss));
    expect(tx.affectsBalance()).toBe(false);
    expect(tx.requiresReference()).toBe(false);
  });

  test('LOSS pode ser processado (registra resultado sem mover saldo)', () => {
    const tx = WagerTransaction.create(makeProps(WagerTransactionKind.Loss));
    tx.markProcessed(undefined, new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  test('LOSS lança Error ao chamar ledgerDirectionFor (sem ledger entry)', () => {
    const tx = WagerTransaction.create(makeProps(WagerTransactionKind.Loss));
    expect(() => tx.ledgerDirectionFor()).toThrow(Error);
  });
});

// ---------------------------------------------------------------------------
// 17. Regras de negócio por kind — REFUND (Req 3.4, 3.5)
// ---------------------------------------------------------------------------

describe('Regras de negócio — REFUND', () => {
  test('REFUND: affectsBalance=true, requiresReference=true, direction=CREDIT', () => {
    const tx = makeRefund();
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(true);
    expect(tx.ledgerDirectionFor()).toBe('CREDIT');
  });

  test('REFUND preserva referenceExternalTransactionId', () => {
    const tx = makeRefund();
    expect(tx.referenceExternalTransactionId).toBe('ext-ref-1');
  });

  test('REFUND pode ser rejeitado com ReferenceAlreadyReversed', () => {
    const tx = makeRefund();
    tx.reject(FailureCode.ReferenceAlreadyReversed);
    expect(tx.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test('REFUND pode ir para PENDING_REFERENCE quando referência não existe ainda', () => {
    const tx = makeRefund();
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });
});

// ---------------------------------------------------------------------------
// 18. Regras de negócio por kind — ROLLBACK (Req 3.4, 3.5)
// ---------------------------------------------------------------------------

describe('Regras de negócio — ROLLBACK', () => {
  test('ROLLBACK: affectsBalance=true, requiresReference=true', () => {
    const tx = makeRollback();
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(true);
  });

  test('ROLLBACK preserva referenceExternalTransactionId', () => {
    const tx = makeRollback();
    expect(tx.referenceExternalTransactionId).toBe('ext-ref-1');
  });

  test('ROLLBACK pode ser rejeitado com BalanceReversalInsufficient', () => {
    const tx = makeRollback();
    tx.reject(FailureCode.BalanceReversalInsufficient);
    expect(tx.failureCode).toBe(FailureCode.BalanceReversalInsufficient);
  });

  test('ROLLBACK pode ir para PENDING_REFERENCE quando referência não existe ainda', () => {
    const tx = makeRollback();
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
  });
});

// ---------------------------------------------------------------------------
// 19. Idempotency key com payload divergente (Req 5.5)
// ---------------------------------------------------------------------------

describe('matchesPayload() — conflito de payload', () => {
  test('mesma idempotencyKey com payloadHash diferente é detectado via matchesPayload', () => {
    const props = makeProps(WagerTransactionKind.Bet);
    const original = WagerTransaction.create(props);

    // Simula resubmissão com payload diferente
    const incomingHash = 'completely-different-hash';
    expect(original.matchesPayload(incomingHash)).toBe(false);
  });

  test('mesma idempotencyKey com mesmo payloadHash é replay legítimo', () => {
    const props = makeProps(WagerTransactionKind.Bet);
    const original = WagerTransaction.create(props);
    expect(original.matchesPayload(props.payloadHash)).toBe(true);
  });
});
