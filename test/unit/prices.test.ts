// Plan 15.2: the price table and the rules, with hand computed expectations in nano dollars.
import { describe, expect, it } from 'vitest';
import { PRICE_TABLE, PRICE_TABLE_DATE, PRICE_TABLE_VERSION, cacheWriteRemainder, isPricedModel, nanosToUsd, priceEventNanos, type PricedEvent } from '../../src/metrics/prices.ts';

function ev(over: Partial<PricedEvent> = {}): PricedEvent {
  return { model: 'claude-sonnet-5-5', input: 1000, output: 500, cacheRead: 2000, cacheWrite: 300, cacheWrite5m: 100, cacheWrite1h: 200, speed: 'standard', ...over };
}

describe('price table', () => {
  it('is dated, versioned and holds whole milli dollar rates only', () => {
    expect(PRICE_TABLE_DATE).toBe('2026-10-27');
    expect(Number.isInteger(PRICE_TABLE_VERSION)).toBe(true);
    for (const [model, p] of Object.entries(PRICE_TABLE)) {
      for (const r of [p.rates, ...(p.long === undefined ? [] : [p.long])]) {
        for (const [k, v] of Object.entries(r)) expect(Number.isInteger(v), `${model} ${k}`).toBe(true);
      }
    }
  });

  it('knows exactly the listed models', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001']) {
      expect(isPricedModel(m), m).toBe(true);
    }
    for (const m of ['claude-opus-5-5-20260101', 'Claude-Opus-5-5', 'claude-future-9', '', '<synthetic>', 'toString', '__proto__']) {
      expect(isPricedModel(m), m).toBe(false);
    }
  });
});

describe('price arithmetic per model', () => {
  // input 1000, output 500, cache read 2000, cache write 100 (5m) + 200 (1h)
  it('Opus 5.5: $4 / $20, writes 5 and 8, reads 0.20', () => {
    // 1000*4000 + 500*20000 + 100*5000 + 200*8000 + 2000*200
    expect(priceEventNanos(ev({ model: 'claude-opus-5-5' }))).toBe(4_000_000 + 10_000_000 + 500_000 + 1_600_000 + 400_000);
    expect(priceEventNanos(ev({ model: 'claude-opus-5-5' }))).toBe(16_500_000);
  });

  it('Sonnet 5.5: $2 / $10, writes 2.50 and 4, reads 0.10 (corrected 2026-10-27)', () => {
    // 1000*2000 + 500*10000 + 100*2500 + 200*4000 + 2000*100
    expect(priceEventNanos(ev())).toBe(8_250_000);
    expect(PRICE_TABLE['claude-sonnet-5-5']?.rates.read).toBe(100);
  });

  it('Sonnet 5: $2 / $10, writes 2.50 and 4, reads 0.20', () => {
    // 1000*2000 + 500*10000 + 100*2500 + 200*4000 + 2000*200
    expect(priceEventNanos(ev({ model: 'claude-sonnet-5' }))).toBe(8_450_000);
  });

  it('Haiku 5.5 normal tier: $0.10 / $0.50, writes 0.125 and 0.20, reads 0.01', () => {
    // prompt = 1000 + 2000 + 300 = 3300, far under 100,000
    expect(priceEventNanos(ev({ model: 'claude-haiku-5-5' }))).toBe(100_000 + 250_000 + 12_500 + 40_000 + 20_000);
    expect(priceEventNanos(ev({ model: 'claude-haiku-5-5' }))).toBe(422_500);
  });

  it('Haiku 4.5 and its dated name: $1 / $5, writes 1.25 and 2, reads 0.10', () => {
    expect(priceEventNanos(ev({ model: 'claude-haiku-4-5' }))).toBe(1_000_000 + 2_500_000 + 125_000 + 400_000 + 200_000);
    expect(priceEventNanos(ev({ model: 'claude-haiku-4-5-20251001' }))).toBe(4_225_000);
  });

  it('a whole number of nano dollars becomes dollars by one division', () => {
    expect(nanosToUsd(8_450_000)).toBe(0.00845);
    expect(nanosToUsd(1_000_000_000)).toBe(1);
  });

  it('an event with nothing to charge costs zero, not unknown', () => {
    expect(priceEventNanos(ev({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 }))).toBe(0);
  });
});

describe('Haiku 5.5 long prompt tier', () => {
  const haiku = (over: Partial<PricedEvent>): PricedEvent => ev({ model: 'claude-haiku-5-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...over });

  it('100,000 prompt tokens are the normal tier, 100,001 the long tier', () => {
    expect(priceEventNanos(haiku({ input: 100_000 }))).toBe(100_000 * 100);
    expect(priceEventNanos(haiku({ input: 100_001 }))).toBe(100_001 * 500);
  });

  it('the prompt is input plus cache read plus cache write, and the long tier changes every component', () => {
    const at = haiku({ input: 50_000, cacheRead: 40_000, cacheWrite: 10_000, cacheWrite5m: 10_000, output: 1000 });
    expect(priceEventNanos(at)).toBe(50_000 * 100 + 40_000 * 10 + 10_000 * 125 + 1000 * 500);
    const over = haiku({ input: 50_000, cacheRead: 40_000, cacheWrite: 10_001, cacheWrite5m: 10_001, output: 1000 });
    // 50,000 * 500 + 40,000 * 50 + 10,001 * 625 + 1000 * 2500
    expect(priceEventNanos(over)).toBe(25_000_000 + 2_000_000 + 6_250_625 + 2_500_000);
  });

  it('applies to Haiku 5.5 only', () => {
    expect(priceEventNanos(ev({ model: 'claude-haiku-4-5', input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 }))).toBe(200_000 * 1000);
    expect(priceEventNanos(ev({ model: 'claude-sonnet-5-5', input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 }))).toBe(200_000 * 2000);
  });
});

describe('Opus 5.5 fast mode', () => {
  it('doubles every rate when the speed is fast', () => {
    expect(priceEventNanos(ev({ model: 'claude-opus-5-5', speed: 'fast' }))).toBe(2 * 16_500_000);
  });

  it('is the same as standard for any other speed value and for other models', () => {
    for (const speed of ['standard', null, 'FAST', '']) expect(priceEventNanos(ev({ model: 'claude-opus-5-5', speed }))).toBe(16_500_000);
    expect(priceEventNanos(ev({ speed: 'fast' }))).toBe(8_250_000);
    expect(priceEventNanos(ev({ model: 'claude-haiku-5-5', speed: 'fast' }))).toBe(422_500);
  });
});

describe('cache write remainder', () => {
  const base = { input: 0, output: 0, cacheRead: 0 };

  it('prices the part that neither the 5 minute nor the 1 hour figure accounts for at the 5 minute rate', () => {
    // 300 written, 100 + 100 explained: 100 left over, priced as 5 minute: (100 + 100) * 2500 + 100 * 4000
    const e = ev({ ...base, cacheWrite: 300, cacheWrite5m: 100, cacheWrite1h: 100 });
    expect(cacheWriteRemainder(e)).toBe(100);
    expect(priceEventNanos(e)).toBe(900_000);
  });

  it('an older line with no breakdown prices all of it as 5 minute', () => {
    const e = ev({ ...base, cacheWrite: 300, cacheWrite5m: 0, cacheWrite1h: 0 });
    expect(cacheWriteRemainder(e)).toBe(300);
    expect(priceEventNanos(e)).toBe(750_000);
  });

  it('parts that add up have no remainder, and parts that exceed the total are used as given', () => {
    expect(cacheWriteRemainder(ev({ cacheWrite: 300, cacheWrite5m: 100, cacheWrite1h: 200 }))).toBe(0);
    const over = ev({ ...base, cacheWrite: 100, cacheWrite5m: 100, cacheWrite1h: 100 });
    expect(cacheWriteRemainder(over)).toBe(0);
    expect(priceEventNanos(over)).toBe(100 * 2500 + 100 * 4000);
  });
});

describe('US only inference (geo us)', () => {
  const only = (over: Partial<PricedEvent>): PricedEvent => ev({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...over });

  it('costs 1.1 times: (nanos * 11 + 5) integer divided by 10', () => {
    expect(priceEventNanos(ev({ geo: 'us' }))).toBe(Math.floor((8_250_000 * 11 + 5) / 10));
    expect(priceEventNanos(ev({ geo: 'us' }))).toBe(9_075_000);
  });

  it('rounds half up at the boundary', () => {
    // 1 Haiku 5.5 cache read token is 10 nanos: (10 * 11 + 5) / 10 = 11 (exactly 11.0, no rounding)
    expect(priceEventNanos(only({ model: 'claude-haiku-5-5', cacheRead: 1, geo: 'us' }))).toBe(11);
    // 1 Haiku 5.5 cache write token (5 minute) is 125 nanos: 125 * 1.1 = 137.5, which rounds up to 138
    expect(priceEventNanos(only({ model: 'claude-haiku-5-5', cacheWrite: 1, cacheWrite5m: 1, geo: 'us' }))).toBe(138);
    // 3 of them are 375 nanos: 375 * 1.1 = 412.5, rounds up to 413
    expect(priceEventNanos(only({ model: 'claude-haiku-5-5', cacheWrite: 3, cacheWrite5m: 3, geo: 'us' }))).toBe(413);
    // just under a half: 1 Haiku 5.5 input token is 100 nanos, 4 tokens 400 nanos: 440 exactly; 1 output token 500 -> 550
    expect(priceEventNanos(only({ model: 'claude-haiku-5-5', input: 4, geo: 'us' }))).toBe(440);
    // without the rule the same event is not rounded at all
    expect(priceEventNanos(only({ model: 'claude-haiku-5-5', cacheWrite: 1, cacheWrite5m: 1 }))).toBe(125);
  });

  it('applies only to the exact value us', () => {
    for (const geo of [null, undefined, 'global', 'US', 'eu', '']) expect(priceEventNanos(ev({ geo }))).toBe(8_250_000);
  });

  it('Opus fast mode and US only combine: fast doubles the rates, then the total is 1.1 times', () => {
    // fast opus event is 2 * 16_500_000 = 33_000_000 nanos; * 1.1 = 36_300_000
    expect(priceEventNanos(ev({ model: 'claude-opus-5-5', speed: 'fast', geo: 'us' }))).toBe(36_300_000);
    expect(priceEventNanos(ev({ model: 'claude-opus-5-5', speed: 'fast' }))).toBe(33_000_000);
  });

  it('an unpriced model stays null', () => {
    expect(priceEventNanos(ev({ model: 'claude-future-9', geo: 'us' }))).toBeNull();
  });

  it('stays exact for very large costs', () => {
    const big = priceEventNanos(only({ model: 'claude-opus-5-5', output: 500_000_000, geo: 'us' }));
    expect(big).toBe(Number((BigInt(500_000_000 * 20_000) * 11n + 5n) / 10n));
    expect(Number.isSafeInteger(big as number)).toBe(true);
  });
});

describe('unpriced models', () => {
  it('have no price: null, never zero', () => {
    expect(priceEventNanos(ev({ model: 'claude-future-9' }))).toBeNull();
    expect(priceEventNanos(ev({ model: '' }))).toBeNull();
    expect(priceEventNanos(ev({ model: 'claude-opus-5-5-20260101' }))).toBeNull();
  });
});

describe('exactness', () => {
  it('large token counts stay exact integers', () => {
    const big = priceEventNanos(ev({ model: 'claude-opus-5-5', input: 0, output: 500_000_000, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 }));
    expect(big).toBe(500_000_000 * 20_000);
    expect(Number.isSafeInteger(big as number)).toBe(true);
  });
});
