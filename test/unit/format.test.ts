// The token total in words (web/src/lib/format.ts): exact boundaries of the unit choice and the two decimals.
import { describe, expect, it } from 'vitest';
import { tokenWords } from '../../web/src/lib/format.ts';

describe('tokenWords', () => {
  const cases: Array<[number, string | null]> = [
    [0, null],
    [999, null],
    [1_000, '1.00 Thousand'],
    [1_234, '1.23 Thousand'],
    [999_995, '1.00 Million'],
    [999_994_999, '999.99 Million'],
    [999_995_000, '1.00 Billion'],
    [8_668_208_738, '8.67 Billion'],
    [9_250_000_000, '9.25 Billion'],
    [999_995_000_000, '1.00 Trillion'],
    [987_654_321_098_766, '987.65 Trillion'],
    [1_234_000_000_000_000, '1,234.00 Trillion'],
  ];
  for (const [n, expected] of cases) {
    it(`${n} gives ${expected === null ? 'null' : `"${expected}"`}`, () => {
      expect(tokenWords(n)).toBe(expected);
    });
  }
  it('gives null for a value that is not a number', () => {
    expect(tokenWords(Number.NaN)).toBeNull();
    expect(tokenWords(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
