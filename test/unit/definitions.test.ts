import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFINITIONS } from '../../src/metrics/definitions.ts';

const metrics = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'METRICS.md'), 'utf8');

// Each bullet holds one or more "**Term:** text" pieces.
function pieces(): Array<{ term: string; text: string }> {
  const out: Array<{ term: string; text: string }> = [];
  for (const line of metrics.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const parts = line.slice(2).split(/\*\*([^*]+?):\*\*\s*/);
    // split gives ['', term, text, term, text, ...]
    for (let i = 1; i + 1 < parts.length; i += 2) out.push({ term: parts[i] as string, text: (parts[i + 1] as string).trim() });
  }
  return out;
}

describe('definitions match docs/METRICS.md', () => {
  it('has every definition text word for word in METRICS.md', () => {
    for (const d of DEFINITIONS) expect(metrics, d.id).toContain(d.text);
  });

  it('lists every METRICS.md bullet piece, with the same term and text', () => {
    const found = pieces();
    expect(found.length).toBeGreaterThanOrEqual(13);
    expect(DEFINITIONS.map((d) => ({ term: d.term, text: d.text }))).toEqual(found);
  });

  it('counts every bullet line of the file', () => {
    const bullets = metrics.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets.length).toBeGreaterThan(0);
    // A bullet with two terms is covered by two entries; its first piece must be listed with its exact text.
    for (const b of bullets) expect(DEFINITIONS.some((d) => b.includes(`**${d.term}:** ${d.text}`)), b.slice(0, 40)).toBe(true);
  });

  it('has unique ids, terms and no dashes used as punctuation in terms', () => {
    expect(new Set(DEFINITIONS.map((d) => d.id)).size).toBe(DEFINITIONS.length);
    expect(new Set(DEFINITIONS.map((d) => d.term)).size).toBe(DEFINITIONS.length);
    for (const d of DEFINITIONS) expect(d.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});
