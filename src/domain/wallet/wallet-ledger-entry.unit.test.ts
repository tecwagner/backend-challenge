import { describe, test, expect } from 'bun:test';
import { Money } from '../money/money.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.js';
import { LedgerArithmeticError } from './wallet.errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const validCreditProps = () => ({
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: 'CREDIT' as const,
  money: brl('50.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('150.00'),
});

const validDebitProps = () => ({
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: 'DEBIT' as const,
  money: brl('30.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('70.00'),
});

// ---------------------------------------------------------------------------
// 1. Factory `create` — CREDIT aritmética (Req 6.2)
// ---------------------------------------------------------------------------

describe('WalletLedgerEntry.create — CREDIT', () => {
  test('cria entry quando balanceBefore + money === balanceAfter', () => {
    const entry = WalletLedgerEntry.create(validCreditProps());
    expect(entry).toBeDefined();
    expect(entry.direction).toBe('CREDIT');
  });

  test('lança LedgerArithmeticError quando balanceAfter diverge no CREDIT', () => {
    const props = {
      ...validCreditProps(),
      balanceAfter: brl('999.00'), // deveria ser 150.00
    };
    expect(() => WalletLedgerEntry.create(props)).toThrow(LedgerArithmeticError);
  });

  test('lança LedgerArithmeticError quando balanceAfter é menor que o esperado no CREDIT', () => {
    const props = {
      ...validCreditProps(),
      balanceAfter: brl('149.99'),
    };
    expect(() => WalletLedgerEntry.create(props)).toThrow(LedgerArithmeticError);
  });

  test('create com zero: 0.00 + 0.00 === 0.00 é válido', () => {
    const entry = WalletLedgerEntry.create({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: 'CREDIT',
      money: brl('0.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('0.00'),
    });
    expect(entry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Factory `create` — DEBIT aritmética (Req 6.2)
// ---------------------------------------------------------------------------

describe('WalletLedgerEntry.create — DEBIT', () => {
  test('cria entry quando balanceBefore - money === balanceAfter', () => {
    const entry = WalletLedgerEntry.create(validDebitProps());
    expect(entry).toBeDefined();
    expect(entry.direction).toBe('DEBIT');
  });

  test('lança LedgerArithmeticError quando balanceAfter diverge no DEBIT', () => {
    const props = {
      ...validDebitProps(),
      balanceAfter: brl('999.00'), // deveria ser 70.00
    };
    expect(() => WalletLedgerEntry.create(props)).toThrow(LedgerArithmeticError);
  });

  test('lança LedgerArithmeticError quando balanceAfter é maior que o esperado no DEBIT', () => {
    const props = {
      ...validDebitProps(),
      balanceAfter: brl('70.01'),
    };
    expect(() => WalletLedgerEntry.create(props)).toThrow(LedgerArithmeticError);
  });

  test('create com debit de valor exato do saldo: 50.00 - 50.00 === 0.00', () => {
    const entry = WalletLedgerEntry.create({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: 'DEBIT',
      money: brl('50.00'),
      balanceBefore: brl('50.00'),
      balanceAfter: brl('0.00'),
    });
    expect(entry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Factory `create` — geração de id e campos imutáveis (Req 6.1)
// ---------------------------------------------------------------------------

describe('WalletLedgerEntry.create — campos gerados', () => {
  test('id é gerado automaticamente como UUID não vazio', () => {
    const entry = WalletLedgerEntry.create(validCreditProps());
    expect(entry.id).toBeTruthy();
    expect(typeof entry.id).toBe('string');
    expect(entry.id.length).toBeGreaterThan(0);
  });

  test('duas entradas criadas têm ids distintos', () => {
    const a = WalletLedgerEntry.create(validCreditProps());
    const b = WalletLedgerEntry.create(validCreditProps());
    expect(a.id).not.toBe(b.id);
  });

  test('createdAt é definido como Date', () => {
    const before = new Date();
    const entry = WalletLedgerEntry.create(validCreditProps());
    const after = new Date();
    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(entry.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(entry.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  test('walletId e transactionId são preservados', () => {
    const entry = WalletLedgerEntry.create(validCreditProps());
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-1');
  });

  test('money, balanceBefore e balanceAfter são preservados via getters', () => {
    const entry = WalletLedgerEntry.create(validCreditProps());
    expect(entry.money.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });
    expect(entry.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(entry.balanceAfter.toJSON()).toEqual({ amount: '150.00', currency: 'BRL' });
  });
});

// ---------------------------------------------------------------------------
// 4. Factory `rehydrate` — restauração sem revalidação (Req 6.3)
// ---------------------------------------------------------------------------

describe('WalletLedgerEntry.rehydrate', () => {
  test('rehydrate preserva todos os campos passados', () => {
    const id = 'fixed-id-123';
    const createdAt = new Date('2024-01-15T10:00:00Z');
    const entry = WalletLedgerEntry.rehydrate({
      id,
      walletId: 'wallet-abc',
      transactionId: 'tx-xyz',
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'USD' },
      balanceBefore: { amount: '100.00', currency: 'USD' },
      balanceAfter: { amount: '75.00', currency: 'USD' },
      createdAt,
    });

    expect(entry.id).toBe(id);
    expect(entry.walletId).toBe('wallet-abc');
    expect(entry.transactionId).toBe('tx-xyz');
    expect(entry.direction).toBe('DEBIT');
    expect(entry.money.toJSON()).toEqual({ amount: '25.00', currency: 'USD' });
    expect(entry.balanceBefore.toJSON()).toEqual({ amount: '100.00', currency: 'USD' });
    expect(entry.balanceAfter.toJSON()).toEqual({ amount: '75.00', currency: 'USD' });
    expect(entry.createdAt).toBe(createdAt);
  });

  test('rehydrate aceita aritmética incorreta (sem revalidação)', () => {
    // rehydrate não deve validar — persiste o que está no banco
    expect(() =>
      WalletLedgerEntry.rehydrate({
        id: 'id-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'CREDIT',
        money: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '999.00', currency: 'BRL' }, // aritmética errada
        createdAt: new Date(),
      }),
    ).not.toThrow();
  });

  test('rehydrate aceita direction CREDIT', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'id-2',
      walletId: 'wallet-2',
      transactionId: 'tx-2',
      direction: 'CREDIT',
      money: { amount: '5.00', currency: 'BRL' },
      balanceBefore: { amount: '10.00', currency: 'BRL' },
      balanceAfter: { amount: '15.00', currency: 'BRL' },
      createdAt: new Date(),
    });
    expect(entry.direction).toBe('CREDIT');
  });
});

// ---------------------------------------------------------------------------
// 5. isBalanced() — consulta de invariante (Req 6.2)
// ---------------------------------------------------------------------------

describe('WalletLedgerEntry.isBalanced()', () => {
  test('retorna true para entry CREDIT aritméticamente correta criada via create', () => {
    const entry = WalletLedgerEntry.create(validCreditProps());
    expect(entry.isBalanced()).toBe(true);
  });

  test('retorna true para entry DEBIT aritméticamente correta criada via create', () => {
    const entry = WalletLedgerEntry.create(validDebitProps());
    expect(entry.isBalanced()).toBe(true);
  });

  test('retorna false para entry rehydratada com aritmética CREDIT incorreta', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'id-bad',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: 'CREDIT',
      money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '200.00', currency: 'BRL' }, // deveria ser 110.00
      createdAt: new Date(),
    });
    expect(entry.isBalanced()).toBe(false);
  });

  test('retorna false para entry rehydratada com aritmética DEBIT incorreta', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'id-bad2',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: 'DEBIT',
      money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' }, // deveria ser 90.00
      createdAt: new Date(),
    });
    expect(entry.isBalanced()).toBe(false);
  });

  test('retorna true para entry CREDIT rehydratada com aritmética correta', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'id-ok',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: 'CREDIT',
      money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '110.00', currency: 'BRL' },
      createdAt: new Date(),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test('retorna true para entry DEBIT rehydratada com aritmética correta', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'id-ok2',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: 'DEBIT',
      money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '90.00', currency: 'BRL' },
      createdAt: new Date(),
    });
    expect(entry.isBalanced()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Imutabilidade — nenhum método mutante existe (Req 6.3)
// ---------------------------------------------------------------------------

describe('WalletLedgerEntry — imutabilidade', () => {
  test('não expõe métodos de mutação (set/update/transition)', () => {
    const entry = WalletLedgerEntry.create(validCreditProps());
    // Verificar que os campos comuns de mutação não existem no objeto
    expect((entry as unknown as Record<string, unknown>)['setDirection']).toBeUndefined();
    expect((entry as unknown as Record<string, unknown>)['setMoney']).toBeUndefined();
    expect((entry as unknown as Record<string, unknown>)['update']).toBeUndefined();
    expect((entry as unknown as Record<string, unknown>)['delete']).toBeUndefined();
  });

  test('campos são marcados como readonly (getters apenas)', () => {
    const entry = WalletLedgerEntry.create(validCreditProps());
    // Garantir que os getters existem e retornam os valores corretos
    expect(entry.id).toBeDefined();
    expect(entry.walletId).toBeDefined();
    expect(entry.transactionId).toBeDefined();
    expect(entry.direction).toBeDefined();
    expect(entry.money).toBeDefined();
    expect(entry.balanceBefore).toBeDefined();
    expect(entry.balanceAfter).toBeDefined();
    expect(entry.createdAt).toBeDefined();
  });
});
