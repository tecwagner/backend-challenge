import { describe, expect, test } from 'bun:test';
import { PayloadHashService } from './payload-hash.service.js';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction.enums.js';

const hash = new PayloadHashService();

function permuteKeys<T extends Record<string, unknown>>(obj: T, order: string[]): T {
  const next: Record<string, unknown> = {};
  for (const key of order) {
    if (key in obj) {
      next[key] = obj[key];
    }
  }
  return next as T;
}

/**
 * Property 8: Hash canônico é determinístico independente da ordem de chaves
 * Validates: Requirements 3.3
 */
describe('Property 8: Hash canônico é determinístico independente da ordem de chaves', () => {
  const base = {
    providerId: 'prov-1',
    externalTransactionId: 'ext-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Refund,
    money: { amount: '25.50', currency: 'BRL' },
    referenceExternalTransactionId: 'ext-ref',
  };

  const keyOrders = [
    Object.keys(base),
    [...Object.keys(base)].reverse(),
    ['money', 'kind', 'walletId', 'playerId', 'gameId', 'roundId', 'providerId', 'externalTransactionId', 'referenceExternalTransactionId'],
    ['kind', 'money', 'referenceExternalTransactionId', 'providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId'],
    ['walletId', 'playerId', 'providerId', 'gameId', 'roundId', 'kind', 'externalTransactionId', 'money', 'referenceExternalTransactionId'],
  ];

  const moneyOrders = [
    { amount: '25.50', currency: 'BRL' },
    { currency: 'BRL', amount: '25.50' },
  ];

  test('qualquer permutação de chaves do payload produz o mesmo digest', () => {
    const expected = hash.compute(base);
    for (const order of keyOrders) {
      for (const money of moneyOrders) {
        const candidate = permuteKeys({ ...base, money }, order);
        expect(hash.compute(candidate)).toBe(expected);
      }
    }
  });
});
