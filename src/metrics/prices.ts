// The API price table and the one function that prices a usage event.
//
// Source: Anthropic's pricing page, platform.claude.com/docs/en/about-claude/pricing, read 2026-10-27. Rates are kept as integer milli USD per
// million tokens (USD per million tokens times 1,000). Tokens times such a rate is a whole number of nano dollars, so a cost
// is an exact integer and nothing is rounded anywhere. The API converts to dollars only when it answers.
//
// Changing any number or rule below means bumping PRICE_TABLE_VERSION: the next start then recomputes every stored cost.

export const PRICE_TABLE_DATE = '2026-10-27';
export const PRICE_TABLE_VERSION = 3; // 3: US only inference rule wired through the stored inference_geo. 2: Sonnet 5.5 cache read corrected to 100
export const PRICE_TABLE_SOURCE = 'Anthropic pricing page, platform.claude.com/docs/en/about-claude/pricing, read 2026-10-27';

export const NANOS_PER_USD = 1_000_000_000;

// Milli USD per million tokens. Cache writes are 1.25 times input for 5 minute entries and 2 times input for 1 hour entries;
// cache reads are 0.1 times input, except Claude Opus 5.5 and Claude Sonnet 5.5 at 0.05 times.
export interface Rates {
  input: number;
  output: number;
  write5m: number;
  write1h: number;
  read: number;
}

interface ModelPrice {
  rates: Rates;
  // Haiku 5.5: a response whose prompt (input plus cache read plus cache write) is strictly over 100,000 tokens is priced at
  // the long tier for every component.
  long?: Rates;
  // Opus 5.5 fast mode: every rate doubled when the winning line says speed 'fast'.
  fastMultiplier?: number;
}

export const LONG_PROMPT_TOKENS = 100_000;

const SONNET: Rates = { input: 2000, output: 10_000, write5m: 2500, write1h: 4000, read: 200 };
const HAIKU_4_5: Rates = { input: 1000, output: 5000, write5m: 1250, write1h: 2000, read: 100 };

export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': { rates: { input: 4000, output: 20_000, write5m: 5000, write1h: 8000, read: 200 }, fastMultiplier: 2 },
  // Cache read corrected from 200 to 100 on 2026-10-27 (pricing page: 0.05 times input). Claude Code up to 2.1.292 priced it at
  // 0.20, so sessions it priced differ from their costUSD by exactly cache reads times $0.10.
  'claude-sonnet-5-5': { rates: { ...SONNET, read: 100 } },
  'claude-sonnet-5': { rates: SONNET },
  'claude-haiku-5-5': {
    rates: { input: 100, output: 500, write5m: 125, write1h: 200, read: 10 },
    long: { input: 500, output: 2500, write5m: 625, write1h: 1000, read: 50 },
  },
  'claude-haiku-4-5': { rates: HAIKU_4_5 },
  'claude-haiku-4-5-20251001': { rates: HAIKU_4_5 },
};

export interface PricedEvent {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number; // cache_creation_input_tokens, the total of both parts
  cacheWrite5m: number;
  cacheWrite1h: number;
  speed: string | null;
  // usage.inference_geo of the winning line. 'us' costs 1.1 times. Optional: callers that do not know it price as not US only.
  geo?: string | null;
}

// True when the table lists a price for the model.
export function isPricedModel(model: string): boolean {
  return Object.hasOwn(PRICE_TABLE, model);
}

// Cache write tokens that neither the 5 minute nor the 1 hour part accounts for (older lines without the breakdown).
// They are priced at the 5 minute rate. Never negative.
export function cacheWriteRemainder(e: Pick<PricedEvent, 'cacheWrite' | 'cacheWrite5m' | 'cacheWrite1h'>): number {
  return Math.max(0, e.cacheWrite - e.cacheWrite5m - e.cacheWrite1h);
}

// The rates one event is priced at, or null when the model has no price.
export function ratesFor(e: Pick<PricedEvent, 'model' | 'input' | 'cacheRead' | 'cacheWrite' | 'speed'>): Rates | null {
  if (!isPricedModel(e.model)) return null;
  const p = PRICE_TABLE[e.model] as ModelPrice;
  let r = p.rates;
  if (p.long !== undefined && e.input + e.cacheRead + e.cacheWrite > LONG_PROMPT_TOKENS) r = p.long;
  if (p.fastMultiplier !== undefined && e.speed === 'fast') {
    const k = p.fastMultiplier;
    r = { input: r.input * k, output: r.output * k, write5m: r.write5m * k, write1h: r.write1h * k, read: r.read * k };
  }
  return r;
}

// Cost of one usage event in nano dollars, or null when the model has no price (unpriced, never zero).
// Thinking tokens are part of output and are not priced twice.
// US only inference (geo 'us') costs 1.1 times: (exact nanos * 11 + 5) integer divided by 10, in BigInt so nothing is a float.
export function priceEventNanos(e: PricedEvent): number | null {
  const r = ratesFor(e);
  if (r === null) return null;
  const w5 = e.cacheWrite5m + cacheWriteRemainder(e);
  const nanos = e.input * r.input + e.output * r.output + w5 * r.write5m + e.cacheWrite1h * r.write1h + e.cacheRead * r.read;
  return e.geo === 'us' ? Number((BigInt(nanos) * 11n + 5n) / 10n) : nanos;
}

export const nanosToUsd = (nanos: number): number => nanos / NANOS_PER_USD;
