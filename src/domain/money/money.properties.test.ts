
import { describe, test, expect } from 'bun:test';
import { Money, type MoneyProps } from './money.js';
import { InvalidMoneyError, CurrencyMismatchError } from './money.errors.js';

function forAll<T>(
  label: string,
  inputs: T[],
  predicate: (input: T) => void,
): void {
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

// ---------------------------------------------------------------------------
// Property 1: Inputs monetários inválidos são rejeitados
// Validates: Requirements 1.2
// ---------------------------------------------------------------------------

describe('Property 1: Inputs monetários inválidos são rejeitados', () => {
  /**
   * Validates: Requirements 1.2
   *
   * For any amount string that is negative, has more than 2 decimal places,
   * uses scientific notation, is empty, is NaN, or Infinity, Money.from MUST
   * throw InvalidMoneyError.
   */

  // Scientific notation
  const scientificNotation: string[] = [
    '1e5', '1E5', '1e-2', '1E-2', '1.5e3', '2.5E+10',
    '1e0', '0e0', '1e1', '1.23e4', '9.99e-1', '1E+2',
    '3.14e2', '2.718e1', '1.0e3', '5e-5', '1.234e5',
    '1e10', '1e100', '1.5E-2', '0.1e1',
  ];

  // Negative amounts
  const negativeAmounts: string[] = [
    '-1', '-0.01', '-100.00', '-0.50', '-99.99',
    '-1.00', '-1000.00', '-0.10', '-10.50', '-999.99',
    '-0.1', '-1.1', '-100', '-0.001',
  ];

  // More than 2 decimal places
  const tooManyDecimalPlaces: string[] = [
    '1.001', '0.001', '99.999', '1.123', '0.111',
    '100.001', '1.1111', '0.0001', '10.123', '99.9999',
    '1.999', '0.123', '50.505', '1.100000001', '0.0000001',
    '1.005', '3.145', '2.718281', '0.333', '1.001',
  ];

  // Empty or whitespace
  const emptyOrWhitespace: string[] = [
    '', ' ', '  ', '\t', '\n', '\r\n',
  ];

  // NaN / Infinity / non-numeric
  const nonNumeric: string[] = [
    'NaN', 'Infinity', '-Infinity', 'abc', 'one', 'null', 'undefined',
    '1,5', '1 000', 'R$1', '$1.00', '1.00.00', '1..0', '--1',
    '1-', '1+', '1/2', '1*2', 'one.zero', 'true', 'false',
    '.', '..', '1.', '.1.', '1.a', 'a.1',
  ];

  const allInvalidInputs: Array<{ amount: string; currency: string }> = [
    ...scientificNotation,
    ...negativeAmounts,
    ...tooManyDecimalPlaces,
    ...emptyOrWhitespace,
    ...nonNumeric,
  ].map((amount) => ({ amount, currency: 'BRL' }));

  test('Money.from rejeita todos os inputs inválidos lançando InvalidMoneyError', () => {
    forAll(
      'invalid amount → InvalidMoneyError',
      allInvalidInputs,
      ({ amount, currency }) => {
        expect(() => Money.from({ amount, currency })).toThrow(InvalidMoneyError);
      },
    );
  });

  test('inputs de notação científica são rejeitados individualmente', () => {
    forAll('scientific notation', scientificNotation, (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });
  });

  test('amounts negativos são rejeitados individualmente', () => {
    forAll('negative amounts', negativeAmounts, (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });
  });

  test('amounts com mais de 2 casas decimais são rejeitados individualmente', () => {
    forAll('too many decimal places', tooManyDecimalPlaces, (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });
  });

  test('strings vazias ou whitespace são rejeitadas', () => {
    forAll('empty or whitespace', emptyOrWhitespace, (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });
  });

  test('valores NaN, Infinity e strings não-numéricas são rejeitados', () => {
    forAll('non-numeric strings', nonNumeric, (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });
  });

  test('inputs válidos NÃO lançam InvalidMoneyError (contraparte)', () => {
    const validInputs: string[] = [
      '0', '0.0', '0.00', '1', '1.0', '1.00',
      '99.99', '100.00', '0.01', '0.10', '999.99',
      '1000', '10000.50', '99999.99', '0.50',
    ];

    forAll('valid amounts should NOT throw', validInputs, (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' })).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Property 2: Conflito de moeda em operações aritméticas
// Validates: Requirements 1.3
// ---------------------------------------------------------------------------

describe('Property 2: Conflito de moeda em operações aritméticas', () => {
  /**
   * Validates: Requirements 1.3
   *
   * For any pair of Money instances with distinct currencies C1 ≠ C2, any
   * arithmetic operation (add, subtract) MUST throw CurrencyMismatchError
   * before any calculation.
   */

  // Representative set of currency pairs (all distinct)
  const currencyPairs: Array<[string, string]> = [
    ['BRL', 'USD'],
    ['USD', 'EUR'],
    ['EUR', 'GBP'],
    ['GBP', 'JPY'],
    ['JPY', 'BRL'],
    ['BRL', 'EUR'],
    ['USD', 'GBP'],
    ['EUR', 'JPY'],
    ['GBP', 'BRL'],
    ['AUD', 'CAD'],
    ['CAD', 'CHF'],
    ['CHF', 'AUD'],
    ['BRL', 'AUD'],
    ['USD', 'CAD'],
    ['EUR', 'CHF'],
  ];

  // Valid amounts to use for the currency pair tests
  const validAmounts: string[] = [
    '0.00', '0.01', '1.00', '10.00', '99.99', '100.00', '1000.00',
  ];

  test('add entre moedas distintas lança CurrencyMismatchError', () => {
    forAll(
      'add with different currencies',
      currencyPairs,
      ([c1, c2]) => {
        for (const amount of validAmounts) {
          const m1 = Money.from({ amount, currency: c1 });
          const m2 = Money.from({ amount, currency: c2 });
          expect(() => m1.add(m2)).toThrow(CurrencyMismatchError);
        }
      },
    );
  });

  test('subtract entre moedas distintas lança CurrencyMismatchError', () => {
    forAll(
      'subtract with different currencies',
      currencyPairs,
      ([c1, c2]) => {
        for (const amount of validAmounts) {
          const m1 = Money.from({ amount, currency: c1 });
          const m2 = Money.from({ amount, currency: c2 });
          expect(() => m1.subtract(m2)).toThrow(CurrencyMismatchError);
        }
      },
    );
  });

  test('add/subtract entre mesma moeda NÃO lança CurrencyMismatchError', () => {
    const sameCurrencies: string[] = ['BRL', 'USD', 'EUR', 'GBP', 'JPY', 'AUD'];

    forAll(
      'same currency operations should not throw',
      sameCurrencies,
      (currency) => {
        const m1 = Money.from({ amount: '10.00', currency });
        const m2 = Money.from({ amount: '5.00', currency });
        expect(() => m1.add(m2)).not.toThrow();
        expect(() => m1.subtract(m2)).not.toThrow();
      },
    );
  });

  test('o erro é lançado ANTES de qualquer cálculo (lado esquerdo vs direito é irrelevante)', () => {
    // Regardless of which side has the "bigger" amount, the error should still be thrown
    const cases: Array<{ a1: string; c1: string; a2: string; c2: string }> = [
      { a1: '0.00', c1: 'BRL', a2: '1000.00', c2: 'USD' },
      { a1: '1000.00', c1: 'USD', a2: '0.00', c2: 'BRL' },
      { a1: '100.00', c1: 'EUR', a2: '0.01', c2: 'GBP' },
    ];

    forAll(
      'error thrown regardless of amounts',
      cases,
      ({ a1, c1, a2, c2 }) => {
        const m1 = Money.from({ amount: a1, currency: c1 });
        const m2 = Money.from({ amount: a2, currency: c2 });
        expect(() => m1.add(m2)).toThrow(CurrencyMismatchError);
        expect(() => m1.subtract(m2)).toThrow(CurrencyMismatchError);
        expect(() => m2.add(m1)).toThrow(CurrencyMismatchError);
        expect(() => m2.subtract(m1)).toThrow(CurrencyMismatchError);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Imutabilidade do Money
// Validates: Requirements 1.4
// ---------------------------------------------------------------------------

describe('Property 3: Imutabilidade do Money', () => {
  /**
   * Validates: Requirements 1.4
   *
   * For any Money instance m, after calling add, subtract, or negate:
   *   1. The original m.toJSON() must be unchanged.
   *   2. The returned instance must be a different object reference.
   */

  // Representative set of valid amounts
  const amounts: string[] = [
    '0.00', '0.01', '0.10', '0.50', '1.00', '1.50', '5.00',
    '10.00', '50.00', '99.99', '100.00', '999.99', '1000.00',
    '10000.00', '99999.99',
  ];

  test('add retorna nova instância sem modificar o operando original', () => {
    forAll('add preserves original', amounts, (amount) => {
      const original = Money.from({ amount, currency: 'BRL' });
      const operand = Money.from({ amount: '1.00', currency: 'BRL' });

      const originalJson = original.toJSON();
      const result = original.add(operand);

      // Original unchanged
      expect(original.toJSON()).toEqual(originalJson);
      // Different reference
      expect(result).not.toBe(original);
    });
  });

  test('subtract retorna nova instância sem modificar o operando original', () => {
    // Use amounts >= 1.00 to avoid negative results (valid subtraction)
    const subtractAmounts = amounts.filter(
      (a) => parseFloat(a) >= 1.0,
    );

    forAll('subtract preserves original', subtractAmounts, (amount) => {
      const original = Money.from({ amount, currency: 'BRL' });
      const operand = Money.from({ amount: '0.01', currency: 'BRL' });

      const originalJson = original.toJSON();
      const result = original.subtract(operand);

      // Original unchanged
      expect(original.toJSON()).toEqual(originalJson);
      // Different reference
      expect(result).not.toBe(original);
    });
  });

  test('negate retorna nova instância sem modificar o original', () => {
    forAll('negate preserves original', amounts, (amount) => {
      const original = Money.from({ amount, currency: 'BRL' });
      const originalJson = original.toJSON();
      const result = original.negate();

      // Original unchanged
      expect(original.toJSON()).toEqual(originalJson);
      // Different reference
      expect(result).not.toBe(original);
    });
  });

  test('operando direito também permanece inalterado após add', () => {
    forAll('right operand preserved after add', amounts, (amount) => {
      const left = Money.from({ amount: '5.00', currency: 'BRL' });
      const right = Money.from({ amount, currency: 'BRL' });
      const rightJson = right.toJSON();

      left.add(right);

      expect(right.toJSON()).toEqual(rightJson);
    });
  });

  test('operando direito também permanece inalterado após subtract', () => {
    forAll('right operand preserved after subtract', amounts, (amount) => {
      const left = Money.from({ amount: '99999.99', currency: 'BRL' });
      const right = Money.from({ amount, currency: 'BRL' });
      const rightJson = right.toJSON();

      left.subtract(right);

      expect(right.toJSON()).toEqual(rightJson);
    });
  });

  test('cadeia de operações não afeta instâncias anteriores', () => {
    const base = Money.from({ amount: '100.00', currency: 'BRL' });
    const baseJson = base.toJSON();

    const step1 = base.add(Money.from({ amount: '10.00', currency: 'BRL' }));
    const step2 = step1.subtract(Money.from({ amount: '5.00', currency: 'BRL' }));
    const step3 = step2.negate();

    // None of the chain operations should mutate the original
    expect(base.toJSON()).toEqual(baseJson);
    expect(step1).not.toBe(base);
    expect(step2).not.toBe(step1);
    expect(step3).not.toBe(step2);
  });
});

// ---------------------------------------------------------------------------
// Property 4: Round-trip de serialização do Money
// Validates: Requirements 1.5
// ---------------------------------------------------------------------------

describe('Property 4: Round-trip de serialização do Money', () => {
  /**
   * Validates: Requirements 1.5
   *
   * For any valid Money instance:
   *   1. Money.from(money.toJSON()) produces an equivalent value.
   *   2. toJSON().amount always has exactly 2 decimal places.
   *   3. toJSON().currency matches the input currency.
   */

  const currencies: string[] = ['BRL', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD'];

  // Amounts with varying decimal representations — all valid
  const validAmountInputs: string[] = [
    '0', '0.0', '0.00',         // zero variants
    '1', '1.0', '1.00',         // integer variants
    '0.01', '0.10', '0.50',     // small decimals
    '1.01', '1.10', '1.50',
    '9.99', '10.00', '10.50',
    '99.99', '100.00', '100.50',
    '999.99', '1000.00',
    '9999.99', '10000.00',
    '99999.99',
  ];

  test('toJSON().amount sempre tem exatamente 2 casas decimais', () => {
    forAll(
      'toJSON amount has 2 decimal places',
      validAmountInputs.flatMap((amount) =>
        currencies.map((currency) => ({ amount, currency })),
      ),
      ({ amount, currency }) => {
        const money = Money.from({ amount, currency });
        const json = money.toJSON();

        // Must match XX.XX pattern (exactly 2 decimal places)
        expect(json.amount).toMatch(/^\d+\.\d{2}$/);
      },
    );
  });

  test('toJSON().currency corresponde ao currency de entrada (em maiúsculas)', () => {
    const mixedCaseCurrencies: Array<{ input: string; expected: string }> = [
      { input: 'brl', expected: 'BRL' },
      { input: 'Brl', expected: 'BRL' },
      { input: 'BRL', expected: 'BRL' },
      { input: 'usd', expected: 'USD' },
      { input: 'USD', expected: 'USD' },
      { input: 'Eur', expected: 'EUR' },
      { input: 'EUR', expected: 'EUR' },
    ];

    forAll(
      'currency normalized to uppercase',
      mixedCaseCurrencies,
      ({ input, expected }) => {
        const money = Money.from({ amount: '1.00', currency: input });
        expect(money.toJSON().currency).toBe(expected);
      },
    );
  });

  test('round-trip: Money.from(m.toJSON()) produz instância equivalente', () => {
    forAll(
      'serialization round-trip',
      validAmountInputs.flatMap((amount) =>
        currencies.map((currency) => ({ amount, currency })),
      ),
      ({ amount, currency }) => {
        const original = Money.from({ amount, currency });
        const serialized = original.toJSON();
        const reconstructed = Money.from(serialized);

        expect(reconstructed.toJSON()).toEqual(original.toJSON());
      },
    );
  });

  test('double round-trip permanece estável (idempotência de serialização)', () => {
    forAll(
      'double serialization round-trip',
      validAmountInputs,
      (amount) => {
        const m = Money.from({ amount, currency: 'BRL' });

        // First round-trip
        const rt1 = Money.from(m.toJSON());
        // Second round-trip
        const rt2 = Money.from(rt1.toJSON());

        expect(rt1.toJSON()).toEqual(m.toJSON());
        expect(rt2.toJSON()).toEqual(m.toJSON());
      },
    );
  });

  test('aritmética preserva 2 casas decimais no round-trip', () => {
    const operationCases: Array<{
      a: string;
      b: string;
      expectedAmount: string;
    }> = [
      { a: '1.00', b: '1.00', expectedAmount: '2.00' },
      { a: '0.01', b: '0.01', expectedAmount: '0.02' },
      { a: '99.99', b: '0.01', expectedAmount: '100.00' },
      { a: '10.50', b: '0.50', expectedAmount: '11.00' },
      { a: '0.10', b: '0.10', expectedAmount: '0.20' },
      { a: '5.00', b: '3.00', expectedAmount: '2.00' }, // subtract
    ];

    for (const { a, b, expectedAmount } of operationCases) {
      const m1 = Money.from({ amount: a, currency: 'BRL' });
      const m2 = Money.from({ amount: b, currency: 'BRL' });

      const sumJson = m1.add(m2).toJSON();
      expect(sumJson.amount).toMatch(/^\d+\.\d{2}$/);
      if (a === '5.00' && b === '3.00') {
        const diffJson = m1.subtract(m2).toJSON();
        expect(diffJson.amount).toBe(expectedAmount);
        expect(diffJson.amount).toMatch(/^\d+\.\d{2}$/);
      } else {
        expect(sumJson.amount).toBe(expectedAmount);
      }
    }
  });

  test('toJSON retorna objeto simples serializável (apenas tipos primitivos)', () => {
    forAll(
      'toJSON returns plain primitive object',
      validAmountInputs,
      (amount) => {
        const money = Money.from({ amount, currency: 'BRL' });
        const json = money.toJSON();

        // Should be re-serializable without loss
        const stringified = JSON.stringify(json);
        const parsed = JSON.parse(stringified) as MoneyProps;

        expect(parsed.amount).toBe(json.amount);
        expect(parsed.currency).toBe(json.currency);
      },
    );
  });
});
