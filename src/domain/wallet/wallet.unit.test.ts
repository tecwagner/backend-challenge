import { describe, test, expect } from 'bun:test';
import { Money } from '../money/money.js';
import { Wallet } from './wallet.aggregate.js';
import { InsufficientBalanceError, WalletCurrencyMismatchError } from './wallet.errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const openBrlWallet = () =>
  Wallet.open({ id: 'wallet-1', playerId: 'player-1', currency: 'BRL' });

// ---------------------------------------------------------------------------
// 1. Wallet.open() — estado inicial correto (Req 2.4)
// ---------------------------------------------------------------------------

describe('Wallet.open()', () => {
  test('cria carteira com saldo zero quando initialBalance não é fornecido', () => {
    const wallet = openBrlWallet();
    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('cria carteira com version 1 (Req 2.4)', () => {
    const wallet = openBrlWallet();
    expect(wallet.version).toBe(1);
  });

  test('preserva id e playerId fornecidos', () => {
    const wallet = openBrlWallet();
    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
  });

  test('normaliza currency para maiúsculas', () => {
    const wallet = Wallet.open({ id: 'w', playerId: 'p', currency: 'brl' });
    expect(wallet.currency).toBe('BRL');
  });

  test('cria carteira com initialBalance fornecido', () => {
    const wallet = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-1',
      currency: 'BRL',
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });
    expect(wallet.balance.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });
  });

  test('lança WalletCurrencyMismatchError quando initialBalance tem moeda divergente', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-3',
        playerId: 'player-1',
        currency: 'BRL',
        initialBalance: { amount: '50.00', currency: 'USD' },
      }),
    ).toThrow(WalletCurrencyMismatchError);
  });

  test('createdAt e updatedAt são definidos como Date', () => {
    const before = new Date();
    const wallet = openBrlWallet();
    const after = new Date();
    expect(wallet.createdAt).toBeInstanceOf(Date);
    expect(wallet.updatedAt).toBeInstanceOf(Date);
    expect(wallet.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(wallet.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ---------------------------------------------------------------------------
// 2. Wallet.rehydrate() — restauração sem revalidação (Req 2.4)
// ---------------------------------------------------------------------------

describe('Wallet.rehydrate()', () => {
  const fixedDate = new Date('2024-01-01T00:00:00Z');
  const fixedDate2 = new Date('2024-06-01T00:00:00Z');

  test('restaura todos os campos passados', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-abc',
      playerId: 'player-xyz',
      currency: 'USD',
      balance: { amount: '250.00', currency: 'USD' },
      version: 7,
      createdAt: fixedDate,
      updatedAt: fixedDate2,
    });

    expect(wallet.id).toBe('wallet-abc');
    expect(wallet.playerId).toBe('player-xyz');
    expect(wallet.currency).toBe('USD');
    expect(wallet.balance.toJSON()).toEqual({ amount: '250.00', currency: 'USD' });
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toBe(fixedDate);
    expect(wallet.updatedAt).toBe(fixedDate2);
  });

  test('rehydrate aceita versão arbitrária sem revalidação', () => {
    expect(() =>
      Wallet.rehydrate({
        id: 'w',
        playerId: 'p',
        currency: 'BRL',
        balance: { amount: '100.00', currency: 'BRL' },
        version: 999,
        createdAt: fixedDate,
        updatedAt: fixedDate,
      }),
    ).not.toThrow();
  });

  test('rehydrate não altera versão ao ser chamado', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: { amount: '10.00', currency: 'BRL' },
      version: 5,
      createdAt: fixedDate,
      updatedAt: fixedDate,
    });
    expect(wallet.version).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 3. credit() — aumenta saldo e incrementa versão (Req 2.4, 2.5)
// ---------------------------------------------------------------------------

describe('Wallet.credit()', () => {
  test('aumenta o saldo pelo valor creditado', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('100.00'));
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('incrementa versão exatamente uma vez por credit (Req 2.4)', () => {
    const wallet = openBrlWallet();
    expect(wallet.version).toBe(1);
    wallet.credit(brl('50.00'));
    expect(wallet.version).toBe(2);
  });

  test('múltiplos credits acumulam saldo corretamente', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('100.00'));
    wallet.credit(brl('50.00'));
    wallet.credit(brl('25.00'));
    expect(wallet.balance.toJSON()).toEqual({ amount: '175.00', currency: 'BRL' });
  });

  test('versão é incrementada a cada credit', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('10.00'));
    wallet.credit(brl('20.00'));
    expect(wallet.version).toBe(3);
  });

  test('credit com zero é aceito e incrementa versão', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('0.00'));
    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(2);
  });

  test('lança WalletCurrencyMismatchError para moeda diferente', () => {
    const wallet = openBrlWallet();
    expect(() => wallet.credit(usd('10.00'))).toThrow(WalletCurrencyMismatchError);
  });

  test('versão não muda quando credit lança WalletCurrencyMismatchError', () => {
    const wallet = openBrlWallet();
    const versionBefore = wallet.version;
    try { wallet.credit(usd('10.00')); } catch { /* esperado */ }
    expect(wallet.version).toBe(versionBefore);
  });
});

// ---------------------------------------------------------------------------
// 4. debit() — diminui saldo e incrementa versão (Req 2.4, 2.5)
// ---------------------------------------------------------------------------

describe('Wallet.debit()', () => {
  test('diminui o saldo pelo valor debitado', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('100.00'));
    wallet.debit(brl('30.00'));
    expect(wallet.balance.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
  });

  test('incrementa versão exatamente uma vez por debit (Req 2.4)', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('100.00'));
    const versionAfterCredit = wallet.version; // 2
    wallet.debit(brl('10.00'));
    expect(wallet.version).toBe(versionAfterCredit + 1);
  });

  test('debit que zera o saldo é aceito', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('50.00'));
    wallet.debit(brl('50.00'));
    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('lança WalletCurrencyMismatchError para moeda diferente', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('100.00'));
    expect(() => wallet.debit(usd('10.00'))).toThrow(WalletCurrencyMismatchError);
  });

  test('versão não muda quando debit lança WalletCurrencyMismatchError', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('100.00'));
    const versionBefore = wallet.version;
    try { wallet.debit(usd('10.00')); } catch { /* esperado */ }
    expect(wallet.version).toBe(versionBefore);
  });
});

// ---------------------------------------------------------------------------
// 5. debit() com saldo insuficiente — InsufficientBalanceError (Req 2.5, 5.2)
// ---------------------------------------------------------------------------

describe('Wallet.debit() — saldo insuficiente', () => {
  test('lança InsufficientBalanceError quando debit > saldo', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('50.00'));
    expect(() => wallet.debit(brl('51.00'))).toThrow(InsufficientBalanceError);
  });

  test('saldo permanece inalterado após InsufficientBalanceError', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('50.00'));
    const balanceBefore = wallet.balance.toJSON();
    try { wallet.debit(brl('51.00')); } catch { /* esperado */ }
    expect(wallet.balance.toJSON()).toEqual(balanceBefore);
  });

  test('versão permanece inalterada após InsufficientBalanceError (Req 2.4)', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('50.00'));
    const versionBefore = wallet.version;
    try { wallet.debit(brl('51.00')); } catch { /* esperado */ }
    expect(wallet.version).toBe(versionBefore);
  });

  test('lança InsufficientBalanceError ao debitar de carteira com saldo zero', () => {
    const wallet = openBrlWallet();
    expect(() => wallet.debit(brl('0.01'))).toThrow(InsufficientBalanceError);
  });

  test('debit de 0.01 acima do saldo disponível lança erro (caso extremo)', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('10.00'));
    expect(() => wallet.debit(brl('10.01'))).toThrow(InsufficientBalanceError);
  });

  test('debit exato do saldo NÃO lança erro', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('10.00'));
    expect(() => wallet.debit(brl('10.00'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. Invariante: saldo nunca fica negativo (Req 2.5, 6.2)
// ---------------------------------------------------------------------------

describe('Invariante de saldo não-negativo', () => {
  test('saldo inicial é não-negativo', () => {
    const wallet = openBrlWallet();
    expect(wallet.balance.isNegative()).toBe(false);
  });

  test('saldo após credit é não-negativo', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('100.00'));
    expect(wallet.balance.isNegative()).toBe(false);
  });

  test('saldo após debit válido é não-negativo', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('100.00'));
    wallet.debit(brl('40.00'));
    expect(wallet.balance.isNegative()).toBe(false);
  });

  test('tentativa de debit que geraria saldo negativo é rejeitada', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('30.00'));
    expect(() => wallet.debit(brl('30.01'))).toThrow(InsufficientBalanceError);
    // Saldo permanece positivo
    expect(wallet.balance.isNegative()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Versão incrementa somente quando saldo muda (Req 2.4)
// ---------------------------------------------------------------------------

describe('Versionamento (Req 2.4)', () => {
  test('versão começa em 1 após open', () => {
    expect(openBrlWallet().version).toBe(1);
  });

  test('versão NÃO muda em operações rejeitadas (saldo insuficiente)', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('10.00')); // version 2
    const v = wallet.version;
    try { wallet.debit(brl('999.00')); } catch { /* esperado */ }
    expect(wallet.version).toBe(v);
  });

  test('versão NÃO muda em operações rejeitadas (moeda errada)', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('10.00')); // version 2
    const v = wallet.version;
    try { wallet.debit(usd('1.00')); } catch { /* esperado */ }
    expect(wallet.version).toBe(v);
  });

  test('versão incrementa uma vez por credit e uma vez por debit', () => {
    const wallet = openBrlWallet(); // version 1
    wallet.credit(brl('100.00'));   // version 2
    wallet.credit(brl('50.00'));    // version 3
    wallet.debit(brl('30.00'));     // version 4
    expect(wallet.version).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 8. Sequência de operações — saldo correto ao longo do tempo (Req 2.5, 15.1)
// ---------------------------------------------------------------------------

describe('Sequência de operações debit/credit', () => {
  test('sequência: credit, debit, credit produz saldo correto', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('200.00')); // 200.00
    wallet.debit(brl('50.00'));   // 150.00
    wallet.credit(brl('75.00'));  // 225.00
    expect(wallet.balance.toJSON()).toEqual({ amount: '225.00', currency: 'BRL' });
  });

  test('múltiplos debits reduzem saldo progressivamente', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('100.00'));
    wallet.debit(brl('10.00'));
    wallet.debit(brl('20.00'));
    wallet.debit(brl('30.00'));
    expect(wallet.balance.toJSON()).toEqual({ amount: '40.00', currency: 'BRL' });
  });

  test('debit falho no meio da sequência não altera saldo nem versão dos demais', () => {
    const wallet = openBrlWallet();
    wallet.credit(brl('100.00')); // saldo 100, version 2
    wallet.debit(brl('50.00'));   // saldo 50,  version 3
    try { wallet.debit(brl('60.00')); } catch { /* saldo insuficiente */ }
    wallet.credit(brl('20.00'));  // saldo 70,  version 4
    expect(wallet.balance.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(wallet.version).toBe(4);
  });

  test('saldo final após 10 credits e 5 debits é calculado corretamente', () => {
    const wallet = openBrlWallet();
    for (let i = 0; i < 10; i++) wallet.credit(brl('10.00'));  // +100
    for (let i = 0; i < 5; i++) wallet.debit(brl('5.00'));     // -25
    expect(wallet.balance.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(wallet.version).toBe(16); // 1 (open) + 10 credits + 5 debits
  });
});
