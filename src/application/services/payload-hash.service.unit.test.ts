import { describe, expect, test } from 'bun:test';
import { PayloadHashService } from './payload-hash.service.js';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction.enums.js';

const hash = new PayloadHashService();

function payload(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'prov-1',
    externalTransactionId: 'ext-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

describe('PayloadHashService', () => {
  test('produz hash SHA-256 hex de 64 caracteres', () => {
    const digest = hash.compute(payload());
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('mesmo payload produz o mesmo hash', () => {
    expect(hash.compute(payload())).toBe(hash.compute(payload()));
  });

  test('campo de negócio diferente altera o hash', () => {
    expect(hash.compute(payload({ roundId: 'round-2' }))).not.toBe(hash.compute(payload()));
  });

  test('reference ausente e omitida produzem o mesmo hash', () => {
    const without = hash.compute(payload());
    const explicitUndefined = hash.compute(payload({ referenceExternalTransactionId: undefined }));
    expect(without).toBe(explicitUndefined);
  });

  test('reference presente altera o hash', () => {
    expect(hash.compute(payload({ referenceExternalTransactionId: 'ext-ref' }))).not.toBe(
      hash.compute(payload()),
    );
  });
});
