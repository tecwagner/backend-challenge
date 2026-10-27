import { describe, test, expect } from 'bun:test';
import { Money } from './money.js';
import { InvalidMoneyError, CurrencyMismatchError } from './money.errors.js';

// ---------------------------------------------------------------------------
// 1. Escala fixa de 2 casas decimais (Req 1.1)
// ---------------------------------------------------------------------------

describe('Escala fixa de 2 casas decimais', () => {
  test('inteiro "1" é serializado como "1.00"', () => {
    expect(Money.from({ amount: '1', currency: 'BRL' }).toJSON().amount).toBe('1.00');
  });

  test('"1.5" é serializado como "1.50"', () => {
    expect(Money.from({ amount: '1.5', currency: 'BRL' }).toJSON().amount).toBe('1.50');
  });

  test('"1.00" permanece "1.00"', () => {
    expect(Money.from({ amount: '1.00', currency: 'BRL' }).toJSON().amount).toBe('1.00');
  });

  test('Money.zero produz "0.00"', () => {
    expect(Money.zero('BRL').toJSON().amount).toBe('0.00');
  });

  test('add preserva 2 casas decimais no resultado', () => {
    const a = Money.from({ amount: '1.10', currency: 'BRL' });
    const b = Money.from({ amount: '2.20', currency: 'BRL' });
    expect(a.add(b).toJSON().amount).toMatch(/^\d+\.\d{2}$/);
    expect(a.add(b).toJSON().amount).toBe('3.30');
  });

  test('subtract preserva 2 casas decimais no resultado', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '3.50', currency: 'BRL' });
    expect(a.subtract(b).toJSON().amount).toMatch(/^\d+\.\d{2}$/);
    expect(a.subtract(b).toJSON().amount).toBe('6.50');
  });

  test('"0" é serializado como "0.00"', () => {
    expect(Money.from({ amount: '0', currency: 'BRL' }).toJSON().amount).toBe('0.00');
  });

  test('"100.50" permanece "100.50"', () => {
    expect(Money.from({ amount: '100.50', currency: 'BRL' }).toJSON().amount).toBe('100.50');
  });
});

// ---------------------------------------------------------------------------
// 2. Entradas inválidas lançam InvalidMoneyError (Req 1.2)
// ---------------------------------------------------------------------------

describe('Entradas inválidas lançam InvalidMoneyError', () => {
  test('string vazia lança InvalidMoneyError', () => {
    expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('string com apenas espaço lança InvalidMoneyError', () => {
    expect(() => Money.from({ amount: ' ', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('valor negativo "-1.00" lança InvalidMoneyError', () => {
    expect(() => Money.from({ amount: '-1.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('mais de 2 casas decimais "1.001" lança InvalidMoneyError', () => {
    expect(() => Money.from({ amount: '1.001', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('notação científica "1e5" lança InvalidMoneyError', () => {
    expect(() => Money.from({ amount: '1e5', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('notação científica "1E-2" lança InvalidMoneyError', () => {
    expect(() => Money.from({ amount: '1E-2', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('string "abc" lança InvalidMoneyError', () => {
    expect(() => Money.from({ amount: 'abc', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('string "NaN" lança InvalidMoneyError', () => {
    expect(() => Money.from({ amount: 'NaN', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('string "Infinity" lança InvalidMoneyError', () => {
    expect(() => Money.from({ amount: 'Infinity', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('ponto isolado "." lança InvalidMoneyError', () => {
    expect(() => Money.from({ amount: '.', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('input válido "0" NÃO lança', () => {
    expect(() => Money.from({ amount: '0', currency: 'BRL' })).not.toThrow();
  });

  test('input válido "0.00" NÃO lança', () => {
    expect(() => Money.from({ amount: '0.00', currency: 'BRL' })).not.toThrow();
  });

  test('input válido "100.50" NÃO lança', () => {
    expect(() => Money.from({ amount: '100.50', currency: 'BRL' })).not.toThrow();
  });

  test('input válido "0.01" NÃO lança', () => {
    expect(() => Money.from({ amount: '0.01', currency: 'BRL' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Conflito de moeda lança CurrencyMismatchError (Req 1.3)
// ---------------------------------------------------------------------------

describe('Conflito de moeda lança CurrencyMismatchError', () => {
  const brl = Money.from({ amount: '10.00', currency: 'BRL' });
  const usd = Money.from({ amount: '10.00', currency: 'USD' });

  test('add BRL + USD lança CurrencyMismatchError', () => {
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
  });

  test('subtract BRL - USD lança CurrencyMismatchError', () => {
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
  });

  test('isLessThan BRL vs USD lança CurrencyMismatchError', () => {
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('add mesma moeda BRL + BRL NÃO lança', () => {
    const other = Money.from({ amount: '5.00', currency: 'BRL' });
    expect(() => brl.add(other)).not.toThrow();
  });

  test('subtract mesma moeda BRL - BRL NÃO lança', () => {
    const other = Money.from({ amount: '5.00', currency: 'BRL' });
    expect(() => brl.subtract(other)).not.toThrow();
  });

  test('isLessThan mesma moeda NÃO lança', () => {
    const other = Money.from({ amount: '5.00', currency: 'BRL' });
    expect(() => brl.isLessThan(other)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Imutabilidade — operações retornam novas instâncias (Req 1.4)
// ---------------------------------------------------------------------------

describe('Imutabilidade', () => {
  test('add retorna referência diferente do original', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const b = Money.from({ amount: '3.00', currency: 'BRL' });
    const result = a.add(b);
    expect(result).not.toBe(a);
  });

  test('subtract retorna referência diferente do original', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const b = Money.from({ amount: '3.00', currency: 'BRL' });
    const result = a.subtract(b);
    expect(result).not.toBe(a);
  });

  test('negate retorna referência diferente do original', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const result = a.negate();
    expect(result).not.toBe(a);
  });

  test('add não altera o operando esquerdo', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const b = Money.from({ amount: '3.00', currency: 'BRL' });
    const beforeJson = a.toJSON();
    a.add(b);
    expect(a.toJSON()).toEqual(beforeJson);
  });

  test('subtract não altera o operando esquerdo', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const b = Money.from({ amount: '3.00', currency: 'BRL' });
    const beforeJson = a.toJSON();
    a.subtract(b);
    expect(a.toJSON()).toEqual(beforeJson);
  });

  test('negate não altera o original', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const beforeJson = a.toJSON();
    a.negate();
    expect(a.toJSON()).toEqual(beforeJson);
  });

  test('add não altera o operando direito', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const b = Money.from({ amount: '3.00', currency: 'BRL' });
    const beforeJson = b.toJSON();
    a.add(b);
    expect(b.toJSON()).toEqual(beforeJson);
  });
});

// ---------------------------------------------------------------------------
// 5. Serialização toJSON — formato exato (Req 1.5)
// ---------------------------------------------------------------------------

describe('Serialização toJSON', () => {
  test('toJSON retorna { amount, currency } com 2 casas decimais', () => {
    const m = Money.from({ amount: '42.50', currency: 'BRL' });
    expect(m.toJSON()).toEqual({ amount: '42.50', currency: 'BRL' });
  });

  test('currency em minúsculas é normalizada para maiúsculas no toJSON', () => {
    const m = Money.from({ amount: '1.00', currency: 'brl' });
    expect(m.toJSON().currency).toBe('BRL');
  });

  test('toString retorna formato "X.XX CUR"', () => {
    const m = Money.from({ amount: '1.00', currency: 'BRL' });
    expect(m.toString()).toBe('1.00 BRL');
  });

  test('round-trip: Money.from(m.toJSON()).toJSON() é igual ao original', () => {
    const m = Money.from({ amount: '99.99', currency: 'BRL' });
    expect(Money.from(m.toJSON()).toJSON()).toEqual(m.toJSON());
  });

  test('toJSON retorna apenas primitivos JSON (sem instâncias de Money)', () => {
    const m = Money.from({ amount: '10.00', currency: 'USD' });
    const json = m.toJSON();
    expect(typeof json.amount).toBe('string');
    expect(typeof json.currency).toBe('string');
    // Deve ser re-serializável sem perdas
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('toString com currency minúscula ainda produz uppercase', () => {
    const m = Money.from({ amount: '5.00', currency: 'usd' });
    expect(m.toString()).toBe('5.00 USD');
  });
});

// ---------------------------------------------------------------------------
// 6. Predicates (Req 1.1)
// ---------------------------------------------------------------------------

describe('Predicates', () => {
  test('isZero() retorna true para "0.00"', () => {
    expect(Money.from({ amount: '0.00', currency: 'BRL' }).isZero()).toBe(true);
  });

  test('isZero() retorna false para "0.01"', () => {
    expect(Money.from({ amount: '0.01', currency: 'BRL' }).isZero()).toBe(false);
  });

  test('isPositive() retorna true para "0.01"', () => {
    expect(Money.from({ amount: '0.01', currency: 'BRL' }).isPositive()).toBe(true);
  });

  test('isPositive() retorna false para "0.00"', () => {
    expect(Money.from({ amount: '0.00', currency: 'BRL' }).isPositive()).toBe(false);
  });

  test('isPositive() retorna false para valor negado', () => {
    const negative = Money.from({ amount: '1.00', currency: 'BRL' }).negate();
    expect(negative.isPositive()).toBe(false);
  });

  test('isNegative() retorna true para valor negado positivo', () => {
    const negative = Money.from({ amount: '1.00', currency: 'BRL' }).negate();
    expect(negative.isNegative()).toBe(true);
  });

  test('isNegative() retorna false para zero', () => {
    expect(Money.zero('BRL').isNegative()).toBe(false);
  });

  test('isNegative() retorna false para valor positivo', () => {
    expect(Money.from({ amount: '1.00', currency: 'BRL' }).isNegative()).toBe(false);
  });

  test('equals() retorna true para mesmo amount e currency', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.equals(b)).toBe(true);
  });

  test('equals() retorna false para amounts diferentes', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.01', currency: 'BRL' });
    expect(a.equals(b)).toBe(false);
  });

  test('equals() retorna false para currencies diferentes', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'USD' });
    expect(a.equals(b)).toBe(false);
  });

  test('isLessThan() retorna true para "5.00" < "10.00"', () => {
    const five = Money.from({ amount: '5.00', currency: 'BRL' });
    const ten = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(five.isLessThan(ten)).toBe(true);
  });

  test('isLessThan() retorna false para "10.00" < "5.00"', () => {
    const five = Money.from({ amount: '5.00', currency: 'BRL' });
    const ten = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(ten.isLessThan(five)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Money.zero factory (Req 1.1)
// ---------------------------------------------------------------------------

describe('Money.zero factory', () => {
  test('cria amount zero com a currency fornecida', () => {
    const z = Money.zero('BRL');
    expect(z.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('isZero() retorna true', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
  });

  test('adicionar a zero funciona corretamente', () => {
    const z = Money.zero('BRL');
    const ten = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(z.add(ten).toJSON().amount).toBe('10.00');
  });

  test('Money.zero normaliza currency para maiúsculas', () => {
    expect(Money.zero('usd').toJSON().currency).toBe('USD');
  });
});
