import { describe, expect, it } from 'vitest';
import { classify, newerSnapshot } from '../../src/ingest/classify.ts';
import { mergeUsage } from '../../src/ingest/merge.ts';
import {
  RANK_STOP_BONUS,
  type CostSnapshotFact,
  type Fact,
  type UsageFact,
} from '../../src/ingest/facts.ts';
import { classifyFixture, fixtureLines, fixtureNames, mainCtx, subCtx } from './helpers.ts';

function usage(f: Fact): UsageFact {
  if (f.kind !== 'usage') throw new Error(`expected usage, got ${f.kind}`);
  return f;
}

function cost(f: Fact): CostSnapshotFact {
  if (f.kind !== 'cost_snapshot') throw new Error(`expected cost_snapshot, got ${f.kind}`);
  return f;
}

describe('A1 streaming duplicates', () => {
  it('five lines share one key and the last line wins', () => {
    const facts = classifyFixture('streaming.jsonl').map(usage);
    expect(facts).toHaveLength(5);
    expect(new Set(facts.map((f) => f.key))).toEqual(new Set(['msg_one|req_one']));
    expect(facts.map((f) => f.output)).toEqual([5, 5, 40, 80, 120]);
    const winner = facts.reduce(mergeUsage);
    expect(winner.output).toBe(120);
    expect(winner.stopReason).toBe('tool_use');
    expect(winner.uuid).toBe('a5');
  });

  it('winner is the same when lines are folded in reverse order, except for ties', () => {
    const facts = classifyFixture('streaming.jsonl').map(usage);
    expect(facts.reduceRight((acc, f) => mergeUsage(f, acc)).uuid).toBe('a5');
  });

  it('parses every usage number, the key and the tool ids', () => {
    const last = usage(classifyFixture('streaming.jsonl')[4] as Fact);
    expect(last).toMatchObject({
      kind: 'usage',
      sessionId: 'sess-aaaa',
      ts: Date.parse('2026-10-01T10:00:05.000Z'),
      isSidechain: false,
      cwd: '/work/demo',
      gitBranch: 'main',
      version: '9.9.9',
      entrypoint: 'cli',
      model: 'claude-sonnet-5-5',
      input: 10,
      output: 120,
      cacheRead: 2000,
      cacheWrite: 300,
      cacheWrite5m: 100,
      cacheWrite1h: 200,
      thinking: 20,
      webSearch: 1,
      webFetch: 2,
      serviceTier: 'standard',
      speed: 'standard',
      agentId: null,
      isSubagentFile: false,
      missingFields: [],
    });
    expect(last.rank).toBe(RANK_STOP_BONUS + 120);
    const all = classifyFixture('streaming.jsonl').map(usage);
    expect(all.flatMap((f) => f.toolUses)).toEqual([
      { id: 'toolu_1', name: 'Read' },
      { id: 'toolu_2', name: 'Bash' },
    ]);
  });
});

describe('A2 stop reason beats a larger output', () => {
  it('the line with a stop reason wins over an earlier larger output', () => {
    const [a, b] = classifyFixture('larger_without_stop.jsonl').map(usage);
    expect(a?.output).toBe(500);
    expect(a?.stopReason).toBeNull();
    expect(b?.output).toBe(50);
    expect(a?.rank).toBe(500);
    expect(b?.rank).toBe(RANK_STOP_BONUS + 50);
    expect(mergeUsage(a as UsageFact, b as UsageFact).uuid).toBe('b2');
    expect(mergeUsage(b as UsageFact, a as UsageFact).uuid).toBe('b2');
  });

  it('without stop reasons the larger output wins, and an equal rank keeps the existing line', () => {
    const [a] = classifyFixture('larger_without_stop.jsonl').map(usage);
    const small = { ...(a as UsageFact), output: 1, rank: 1, uuid: 'small' };
    const tieEarly = { ...(a as UsageFact), uuid: 'early' };
    const tieLate = { ...(a as UsageFact), uuid: 'late' };
    expect(mergeUsage(a as UsageFact, small).uuid).toBe('b1');
    expect(mergeUsage(small, a as UsageFact).uuid).toBe('b1');
    expect(mergeUsage(tieEarly, tieLate).uuid).toBe('early');
    expect(mergeUsage(tieLate, tieEarly).uuid).toBe('late');
  });
});

describe('A3 synthetic error lines', () => {
  it('a synthetic assistant line without requestId is an api_error, not a response', () => {
    const [synthetic, systemErr, hook] = classifyFixture('synthetic_error.jsonl');
    expect(synthetic).toEqual({
      kind: 'api_error',
      uuid: 'e1',
      sessionId: 'sess-aaaa',
      ts: Date.parse('2026-10-01T12:00:00.000Z'),
    });
    expect(systemErr?.kind).toBe('api_error');
    expect(hook).toEqual({ kind: 'ignored', reason: 'system:stop_hook_summary' });
  });

  it('isApiErrorMessage alone is enough', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'z',
      timestamp: '2026-10-01T00:00:00Z',
      isApiErrorMessage: true,
      message: { id: 'm', model: 'claude-sonnet-5-5', usage: { output_tokens: 1 } },
    });
    expect(classify(line, mainCtx).kind).toBe('api_error');
  });
});

describe('A4 and A5 user kinds', () => {
  it('maps each user line to the right kind with the documented precedence', () => {
    const kinds = classifyFixture('users.jsonl').map((f) => (f.kind === 'message' ? f.messageKind : f.kind));
    expect(kinds).toEqual(['prompt', 'tool_result', 'meta', 'compact_summary', 'compact_summary', 'prompt']);
  });

  it('copies line meta for a prompt', () => {
    const [prompt] = classifyFixture('users.jsonl');
    expect(prompt).toMatchObject({
      kind: 'message',
      uuid: 'u1',
      sessionId: 'sess-aaaa',
      isSidechain: false,
      cwd: '/work/demo',
      gitBranch: 'main',
      version: '9.9.9',
      entrypoint: 'cli',
    });
  });
});

describe('A6 sidechain', () => {
  it('a sidechain prompt is still a prompt fact flagged isSidechain', () => {
    const [prompt, withAgent, noAgent] = classifyFixture('sidechain.jsonl');
    expect(prompt).toMatchObject({ kind: 'message', messageKind: 'prompt', isSidechain: true });
    expect(usage(withAgent as Fact)).toMatchObject({ isSidechain: true, agentId: 'agent-side-1' });
    expect(usage(noAgent as Fact).agentId).toBeNull();
  });

  it('agentId falls back to the file name agent id', () => {
    const noAgent = classify(fixtureLines('sidechain.jsonl')[2] as string, subCtx);
    expect(usage(noAgent)).toMatchObject({ agentId: 'agent-from-file', isSubagentFile: true });
  });
});

describe('A7 unknown types', () => {
  it('reports unknown types by name and version without throwing', () => {
    const facts = classifyFixture('unknown_and_extra.jsonl');
    expect(facts[0]).toEqual({ kind: 'unknown_type', type: 'future-thing', version: '9.9.9' });
    expect(facts[1]).toEqual({ kind: 'unknown_type', type: 'tools-used', version: '9.9.9' });
    expect(facts[2]).toEqual({ kind: 'unknown_type', type: '(missing)', version: null });
  });

  it('known ignorable types are ignored with a reason', () => {
    const facts = classifyFixture('unknown_and_extra.jsonl');
    expect(facts.slice(3, 7)).toEqual([
      { kind: 'ignored', reason: 'type:attachment' },
      { kind: 'ignored', reason: 'type:api-request-blob' },
      { kind: 'ignored', reason: 'type:queue-operation' },
      { kind: 'ignored', reason: 'type:file-history-snapshot' },
    ]);
  });

  it('every listed ignorable type is ignored', () => {
    for (const t of [
      'attachment', 'api-request-blob', 'api-request', 'api-request-shape', 'atis-latch', 'mode',
      'last-prompt', 'queue-operation', 'agent-name', 'file-history-snapshot', 'file-history-delta',
      'pr-link', 'fork-context-ref',
    ]) {
      expect(classify(JSON.stringify({ type: t }), mainCtx)).toEqual({ kind: 'ignored', reason: `type:${t}` });
    }
  });

  it('titles become session_title facts; empty ones are ignored', () => {
    const facts = classifyFixture('unknown_and_extra.jsonl');
    expect(facts[7]).toEqual({ kind: 'session_title', sessionId: 'sess-aaaa', source: 'ai', title: 'Placeholder title' });
    expect(facts[8]).toEqual({ kind: 'ignored', reason: 'type:ai-title' });
    expect(facts[9]).toEqual({ kind: 'session_title', sessionId: 'sess-aaaa', source: 'custom', title: 'Custom placeholder' });
  });
});

describe('A8 unknown usage fields and missing cache_creation', () => {
  it('parses, defaults missing numbers to 0 and lists them', () => {
    const f = usage(classifyFixture('unknown_and_extra.jsonl')[10] as Fact);
    expect(f).toMatchObject({ input: 4, output: 9, cacheRead: 11, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0, webSearch: 0, webFetch: 0 });
    expect(f.missingFields).toEqual([
      'cache_creation.ephemeral_5m_input_tokens',
      'cache_creation.ephemeral_1h_input_tokens',
      'output_tokens_details.thinking_tokens',
      'server_tool_use.web_search_requests',
      'server_tool_use.web_fetch_requests',
    ]);
    expect(f.toolUses).toEqual([]);
    expect(f.serviceTier).toBeNull();
  });

  it('non numeric values count as missing', () => {
    const line = JSON.stringify({
      type: 'assistant', uuid: 'q', timestamp: '2026-10-01T00:00:00Z', requestId: 'r',
      message: { id: 'm', model: 'x', usage: { input_tokens: 'seven', output_tokens: null, cache_read_input_tokens: -4 } },
    });
    const f = usage(classify(line, mainCtx));
    expect(f.input).toBe(0);
    expect(f.missingFields).toContain('input_tokens');
    expect(f.missingFields).toContain('output_tokens');
    expect(f.missingFields).toContain('cache_read_input_tokens');
  });

  it('assistant lines without usage or without a message id are ignored', () => {
    const facts = classifyFixture('unknown_and_extra.jsonl');
    expect(facts[11]).toEqual({ kind: 'ignored', reason: 'assistant:no_usage' });
    expect(facts[12]).toEqual({ kind: 'ignored', reason: 'assistant:no_key' });
  });

  it('a missing requestId uses the message id alone as the key', () => {
    expect(usage(classifyFixture('unknown_and_extra.jsonl')[13] as Fact).key).toBe('msg_norequest');
  });

  it('a bad timestamp makes a usage line malformed', () => {
    expect(classifyFixture('unknown_and_extra.jsonl')[14]).toEqual({ kind: 'malformed', error: 'bad timestamp' });
  });
});

describe('A9 cost-state', () => {
  it('keeps the snapshot with the larger totalDuration regardless of order', () => {
    const [empty, filled, odd] = classifyFixture('cost_state.jsonl').map(cost);
    expect(empty?.modelUsage).toEqual({});
    expect(filled?.totalCostUSD).toBe(1.25);
    expect(newerSnapshot(empty as CostSnapshotFact, filled as CostSnapshotFact)).toBe(filled);
    expect(newerSnapshot(filled as CostSnapshotFact, empty as CostSnapshotFact)).toBe(filled);
    expect(odd?.totalDuration).toBe(0);
    expect(newerSnapshot(filled as CostSnapshotFact, odd as CostSnapshotFact)).toBe(filled);
  });

  it('defaults missing per model numbers to 0 and keeps start time', () => {
    const filled = cost(classifyFixture('cost_state.jsonl')[1] as Fact);
    expect(filled.startTime).toBe(1790000000000);
    expect(filled.modelUsage['claude-haiku-5-5']).toEqual({
      inputTokens: 5, outputTokens: 6, thinkingTokens: 0, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0,
    });
    expect(filled.modelUsage['claude-sonnet-5-5']?.costUSD).toBe(1.2);
    const odd = cost(classifyFixture('cost_state.jsonl')[2] as Fact);
    expect(odd.modelUsage['claude-haiku-5-5']?.inputTokens).toBe(0);
    expect(odd.startTime).toBeNull();
    expect(odd.totalCostUSD).toBeNull();
  });

  it('a __proto__ model name does not pollute the result', () => {
    const f = cost(classify('{"type":"cost-state","modelUsage":{"__proto__":{"inputTokens":1}}}', mainCtx));
    expect(Object.keys(f.modelUsage)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>)['inputTokens']).toBeUndefined();
  });
});

describe('A10 malformed lines', () => {
  it('produces malformed facts with a short error and no line text', () => {
    const facts = classifyFixture('malformed.jsonl');
    expect(facts.map((f) => f.kind)).toEqual(Array(7).fill('malformed'));
    expect(facts.map((f) => (f.kind === 'malformed' ? f.error : ''))).toEqual([
      'invalid json', 'invalid json', 'not an object', 'not an object', 'not an object', 'bad timestamp', 'missing uuid',
    ]);
  });

  it('empty and whitespace lines are malformed, not thrown', () => {
    expect(classify('', mainCtx).kind).toBe('malformed');
    expect(classify('   ', mainCtx).kind).toBe('malformed');
  });
});

describe('compaction', () => {
  it('compact_boundary becomes a compaction fact', () => {
    const [boundary, summary, bare] = classifyFixture('compaction.jsonl');
    expect(boundary).toEqual({
      kind: 'compaction', uuid: 'c1', sessionId: 'sess-aaaa',
      ts: Date.parse('2026-10-01T14:00:00.000Z'), trigger: 'manual', preTokens: 123456,
    });
    expect(summary).toMatchObject({ kind: 'message', messageKind: 'compact_summary' });
    expect(bare).toMatchObject({ kind: 'compaction', trigger: null, preTokens: null });
  });
});

describe('fork copy across files', () => {
  it('parent and subagent copies share a key; attribution fields differ', () => {
    const parent = usage(classifyFixture('fork_parent.jsonl', mainCtx)[0] as Fact);
    const fork = usage(classifyFixture('fork_subagent.jsonl', subCtx)[0] as Fact);
    expect(fork.key).toBe(parent.key);
    expect(parent.isSubagentFile).toBe(false);
    expect(fork.isSubagentFile).toBe(true);
    expect(fork.agentId).toBe('agent-fork-1');
    expect(fork.rank).toBe(parent.rank);
  });
});

describe('robustness', () => {
  it('falls back to the session id from the file name', () => {
    const f = classify('{"type":"user","uuid":"u","timestamp":"2026-10-01T00:00:00Z","message":{"content":"x"}}', mainCtx);
    expect(f).toMatchObject({ kind: 'message', sessionId: 'sess-from-file', isSidechain: false, cwd: null });
  });

  it('never throws on 1000 random or truncated strings', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const base = ['streaming.jsonl', 'users.jsonl', 'cost_state.jsonl', 'unknown_and_extra.jsonl', 'compaction.jsonl']
      .flatMap((n) => fixtureLines(n));
    const alphabet = '{}[]":,\\ntruefalsnu0123456789-.eE<>|abc \u0000 \ud800';
    let count = 0;
    for (let i = 0; i < 1000; i++) {
      let s: string;
      const mode = i % 4;
      const src = base[Math.floor(rnd() * base.length)] as string;
      if (mode === 0) s = src.slice(0, Math.floor(rnd() * src.length));
      else if (mode === 1) {
        const at = Math.floor(rnd() * src.length);
        s = src.slice(0, at) + alphabet[Math.floor(rnd() * alphabet.length)] + src.slice(at + 1);
      } else if (mode === 2) {
        s = Array.from({ length: Math.floor(rnd() * 60) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
      } else {
        s = String.fromCharCode(...Array.from({ length: Math.floor(rnd() * 40) }, () => Math.floor(rnd() * 65536)));
      }
      const f = classify(s, i % 2 === 0 ? mainCtx : subCtx);
      expect(typeof f.kind).toBe('string');
      count++;
    }
    expect(count).toBe(1000);
    for (const odd of ['{"type":{"a":1}}', '{"type":"assistant","message":5}', '{"type":"assistant","message":{"usage":[]}}', '{"type":"system","subtype":{}}', '{"type":"cost-state","modelUsage":[1]}']) {
      expect(() => classify(odd, mainCtx)).not.toThrow();
    }
  });
});

describe('privacy', () => {
  const planted = ['SECRET_TEXT_X', 'SECRET_THINK_X', 'SECRET_INPUT_X', 'SECRET_RESULT_X'];

  it('fixtures really contain the planted strings (so the test is meaningful)', () => {
    const all = fixtureNames.flatMap((n) => fixtureLines(n)).join('\n');
    for (const p of planted) expect(all).toContain(p);
  });

  it('no fact from any fixture line contains planted content', () => {
    let lines = 0;
    for (const name of fixtureNames) {
      for (const ctx of [mainCtx, subCtx]) {
        for (const fact of classifyFixture(name, ctx)) {
          const json = JSON.stringify(fact);
          for (const p of planted) expect(json).not.toContain(p);
          lines++;
        }
      }
    }
    expect(lines).toBeGreaterThan(80);
  });

  it('tool uses carry only id and name', () => {
    for (const f of classifyFixture('streaming.jsonl').map(usage)) {
      for (const t of f.toolUses) expect(Object.keys(t).sort()).toEqual(['id', 'name']);
    }
  });

  it('odd type and subtype names are not copied into facts', () => {
    const f = classify(JSON.stringify({ type: 'SECRET_TEXT_X is long and has spaces' }), mainCtx);
    expect(f).toEqual({ kind: 'unknown_type', type: '(invalid)', version: null });
    const s = classify(JSON.stringify({ type: 'system', subtype: 'has spaces and SECRET_TEXT_X' }), mainCtx);
    expect(s).toEqual({ kind: 'ignored', reason: 'system:(invalid)' });
  });
});

describe('inference geo', () => {
  const line = (geo: unknown, withKey = true): string =>
    JSON.stringify({
      type: 'assistant',
      uuid: 'g1',
      sessionId: 'sess-geo',
      timestamp: '2026-10-01T10:00:00.000Z',
      requestId: 'req_geo',
      message: {
        id: 'msg_geo',
        model: 'claude-sonnet-5-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, ...(withKey ? { inference_geo: geo } : {}) },
      },
    });

  it('copies usage.inference_geo, a tame identifier, into the fact', () => {
    for (const geo of ['us', 'global', 'not_available']) expect(usage(classify(line(geo), mainCtx)).inferenceGeo).toBe(geo);
  });

  it('is null when the field is absent, null, not a string, empty or not a tame name', () => {
    expect(usage(classify(line(undefined, false), mainCtx)).inferenceGeo).toBeNull();
    for (const geo of [null, 5, true, {}, [], '', 'has spaces and SECRET_TEXT_X', 'x'.repeat(65)]) {
      expect(usage(classify(line(geo), mainCtx)).inferenceGeo, JSON.stringify(geo)).toBeNull();
    }
  });
});
