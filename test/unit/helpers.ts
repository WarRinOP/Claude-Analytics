import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../../src/ingest/classify.ts';
import type { Fact, LineContext } from '../../src/ingest/facts.ts';

const here = dirname(fileURLToPath(import.meta.url));

export const mainCtx: LineContext = {
  sessionIdFromFile: 'sess-from-file',
  isSubagentFile: false,
  agentIdFromFile: null,
};

export const subCtx: LineContext = {
  sessionIdFromFile: 'sess-from-file',
  isSubagentFile: true,
  agentIdFromFile: 'agent-from-file',
};

export function fixtureLines(name: string): string[] {
  return readFileSync(join(here, '..', 'fixtures', name), 'utf8').split('\n').filter((l) => l !== '');
}

export function classifyFixture(name: string, ctx: LineContext = mainCtx): Fact[] {
  return fixtureLines(name).map((l) => classify(l, ctx));
}

export const fixtureNames = [
  'compaction.jsonl',
  'cost_state.jsonl',
  'fork_parent.jsonl',
  'fork_subagent.jsonl',
  'larger_without_stop.jsonl',
  'malformed.jsonl',
  'sidechain.jsonl',
  'streaming.jsonl',
  'synthetic_error.jsonl',
  'unknown_and_extra.jsonl',
  'users.jsonl',
];
