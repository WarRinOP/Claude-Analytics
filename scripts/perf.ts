// pnpm perf: synthetic ten times history, then timings for ingest, sync and every API endpoint.
//
// Not part of `pnpm verify`. Everything happens in temp folders under os.tmpdir(), which are deleted at the end.
// The data is invented: short placeholder text, same record mix as real Claude Code transcripts. The clock is fixed, so the same seed
// gives the same database and identical API answers, which is how a query change is proven to change no result.
//
// Options:
//   --scale N          multiplier on today's size (default 10)
//   --seed N           random seed (default 1)
//   --snapshot FILE    write every endpoint answer (health without volatile fields) to FILE, for a before and after diff
//   --out FILE         write every timing to FILE as JSON (the console shows only the slowest)
//   --source DIR       reuse a history made by an earlier run with --keep (it is never deleted)
//   --keep             keep the generated history and print its folder
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { dbPath } from '../src/config/paths.ts';
import { runIngest, type RunSummary } from '../src/ingest/ingest.ts';
import { createSync } from '../src/ingest/scheduler.ts';
import { createQueryCache } from '../src/metrics/cache.ts';
import { ensureRollups } from '../src/metrics/rollups.ts';
import { handleApi, type ApiDeps } from '../src/server/routes.ts';
import { handlePass } from '../src/server/live.ts';
import { createSseHub } from '../src/server/sse.ts';
import { openAndMigrate } from '../src/store/migrate.ts';

// ---------------------------------------------------------------- options

const argv = process.argv.slice(2);
function opt(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}
const SCALE = Number(opt('--scale') ?? 10);
const SEED = Number(opt('--seed') ?? 1);
const SNAPSHOT = opt('--snapshot');
const OUT = opt('--out');
const REUSE = opt('--source');
const KEEP = argv.includes('--keep');

const TZ = 'Asia/Dhaka';
const END = Date.UTC(2026, 9, 27, 12, 0, 0); // the fixed "now" of the history
const NOW = END + 10 * 60_000;
const MONTHS = 18;
const SPAN_MS = MONTHS * 30.4 * 86_400_000;

// ---------------------------------------------------------------- synthetic history

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const between = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
// A count with the given mean: the whole part plus one more with the fractional probability.
const count = (mean: number): number => Math.floor(mean) + (rnd() < mean - Math.floor(mean) ? 1 : 0);

const MODELS: ReadonlyArray<[string, number]> = [
  ['claude-sonnet-5-5', 0.79],
  ['claude-opus-5-5', 0.165],
  ['claude-sonnet-5', 0.043],
  ['claude-haiku-5-5', 0.002],
];
function pickModel(): string {
  let r = rnd();
  for (const [m, w] of MODELS) {
    r -= w;
    if (r <= 0) return m;
  }
  return 'claude-sonnet-5-5';
}
const TOOLS = ['Read', 'Bash', 'Edit', 'Grep', 'Write', 'Glob', 'Task', 'WebFetch'] as const;
const PROJECTS = Array.from({ length: Math.max(8, Math.round(3 * SCALE)) }, (_, i) => `/work/proj${i}`);
const encode = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

let serial = 0;
const nextId = (p: string): string => `${p}_${(++serial).toString(36)}`;
const iso = (ms: number): string => new Date(ms).toISOString();

interface Gen {
  files: number;
  lines: number;
  sessions: number;
  responses: number;
  lastMain: string; // the main transcript with the latest event, used for the append test
  lastTs: number;
}

function usageBlock(model: string, final: boolean): Record<string, unknown> {
  const big = rnd() < 0.15;
  return {
    input_tokens: between(1, 60),
    cache_read_input_tokens: between(2000, big ? 190_000 : 60_000),
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    output_tokens: final ? between(40, 3000) : between(1, 40),
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    speed: model === 'claude-opus-5-5' && rnd() < 0.02 ? 'fast' : 'standard',
    inference_geo: 'x',
  };
}

interface SessionCtx {
  sid: string;
  cwd: string;
  sidechain: boolean;
  agentId: string | null;
  ts: number;
}

function stamp(c: SessionCtx): number {
  // Mostly seconds apart, sometimes a long pause (a resumed session).
  c.ts += rnd() < 0.003 ? between(6 * 3600_000, 5 * 86_400_000) : between(500, 14_000);
  if (c.ts > END - 1000) c.ts = END - between(1000, 60_000);
  return c.ts;
}

function base(c: SessionCtx, type: string, ts: number): Record<string, unknown> {
  return {
    type,
    uuid: nextId('u'),
    parentUuid: null,
    sessionId: c.sid,
    timestamp: iso(ts),
    version: '9.9.9',
    entrypoint: 'cli',
    cwd: c.cwd,
    gitBranch: 'main',
    isSidechain: c.sidechain,
    userType: 'external',
  };
}

// The lines of one response: streaming duplicates (same message id and request id, rising output), tool use blocks,
// the matching tool results and the odd extra record.
function response(c: SessionCtx, out: string[]): number {
  const model = pickModel();
  const mid = nextId('msg');
  const rid = nextId('req');
  const n = Math.max(1, count(2.1));
  const toolIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const block: Record<string, unknown> =
      rnd() < 0.5
        ? (() => {
            const id = nextId('toolu');
            toolIds.push(id);
            return { type: 'tool_use', id, name: pick(TOOLS), input: { p: 'x' } };
          })()
        : rnd() < 0.5
          ? { type: 'thinking', thinking: 'x' }
          : { type: 'text', text: 'x' };
    const rec = base(c, 'assistant', stamp(c));
    rec['requestId'] = rid;
    if (c.agentId !== null) rec['agentId'] = c.agentId;
    rec['message'] = {
      id: mid,
      model,
      role: 'assistant',
      type: 'message',
      content: [block],
      stop_reason: last ? 'end_turn' : null,
      stop_sequence: null,
      usage: usageBlock(model, last),
    };
    out.push(JSON.stringify(rec));
  }
  for (const id of toolIds) {
    const rec = base(c, 'user', stamp(c));
    rec['message'] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'r' }] };
    out.push(JSON.stringify(rec));
  }
  return n + toolIds.length;
}

function noise(c: SessionCtx, out: string[], mix: Record<string, number>): void {
  const ts = (): number => stamp(c);
  for (const [type, mean] of Object.entries(mix)) {
    for (let i = count(mean); i > 0; i--) {
      const rec: Record<string, unknown> = { type, sessionId: c.sid, timestamp: iso(ts()), uuid: nextId('n') };
      if (type === 'api-request-blob') rec['blob'] = 'b'.repeat(between(40, 400));
      else if (type === 'ai-title') rec['aiTitle'] = `Session ${c.sid.slice(-6)}`;
      else if (type === 'system') {
        const r = rnd();
        rec['subtype'] = r < 0.93 ? 'stop_hook_summary' : r < 0.97 ? 'api_error' : r < 0.99 ? 'informational' : 'compact_boundary';
        if (rec['subtype'] === 'compact_boundary') rec['compactMetadata'] = { trigger: 'manual', preTokens: between(50_000, 190_000) };
      } else if (type === 'attachment') rec['attachment'] = { type: 'x' };
      out.push(JSON.stringify(rec));
    }
  }
}

// Expected extra lines per response, from counts measured on real transcripts divided by about 23,000 responses.
const NOISE_MIX: Record<string, number> = {
  attachment: 1.4,
  'api-request-blob': 0.7,
  'api-request': 0.64,
  'atis-latch': 0.45,
  mode: 0.3,
  'last-prompt': 0.3,
  'queue-operation': 0.3,
  'ai-title': 0.55,
  system: 0.073,
  'file-history-snapshot': 0.062,
  'file-history-delta': 0.037,
  'pr-link': 0.027,
};

function writeSession(root: string, projectCwd: string, sid: string, responses: number, start: number, gen: Gen): void {
  const dir = join(root, encode(projectCwd));
  mkdirSync(dir, { recursive: true });
  const c: SessionCtx = { sid, cwd: projectCwd, sidechain: false, agentId: null, ts: start };
  const out: string[] = [];
  const subagents: Array<{ agentId: string; ts: number; n: number }> = [];
  for (let r = 0; r < responses; r++) {
    if (r === 0 || rnd() < 0.083) {
      const rec = base(c, 'user', stamp(c));
      rec['message'] = { role: 'user', content: 'p' };
      out.push(JSON.stringify(rec));
    }
    if (rnd() < 0.011) {
      const rec = base(c, 'user', stamp(c));
      rec['isMeta'] = true;
      rec['message'] = { role: 'user', content: 'm' };
      out.push(JSON.stringify(rec));
    }
    response(c, out);
    noise(c, out, NOISE_MIX);
    if (rnd() < 0.0078) {
      out.push(
        JSON.stringify({
          type: 'cost-state',
          sessionId: sid,
          startTime: start,
          totalCostUSD: 1.5,
          totalDuration: c.ts - start,
          totalAPIDuration: 1000,
          totalLinesAdded: 1,
          totalLinesRemoved: 0,
          modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 10, thinkingTokens: 0, cacheReadInputTokens: 10, cacheCreationInputTokens: 10, webSearchRequests: 0, costUSD: 0.5 } },
        }),
      );
    }
    if (rnd() < 0.0006) subagents.push({ agentId: `a${(++serial).toString(36)}`, ts: c.ts, n: between(40, 80) });
    if (rnd() < 0.00005) out.push('{"type":"assistant","uuid":"bad'); // a few malformed lines in total
  }
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, out.join('\n') + '\n');
  gen.files += 1;
  gen.lines += out.length;
  if (c.ts >= gen.lastTs) {
    gen.lastTs = c.ts;
    gen.lastMain = file;
  }
  for (const s of subagents) {
    const sub: SessionCtx = { sid, cwd: projectCwd, sidechain: true, agentId: s.agentId, ts: s.ts };
    const lines: string[] = [];
    for (let i = 0; i < s.n; i++) response(sub, lines);
    mkdirSync(join(dir, sid, 'subagents'), { recursive: true });
    writeFileSync(join(dir, sid, 'subagents', `agent-${s.agentId}.jsonl`), lines.join('\n') + '\n');
    gen.files += 1;
    gen.lines += lines.length;
  }
}

function generate(root: string): Gen {
  const sessions = Math.round(165 * SCALE);
  const totalResponses = Math.round(23_000 * SCALE);
  const weights = Array.from({ length: sessions }, () => Math.exp((rnd() + rnd() + rnd() - 1.5) * 2.2));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const gen: Gen = { files: 0, lines: 0, sessions, responses: 0, lastMain: '', lastTs: 0 };
  for (let i = 0; i < sessions; i++) {
    const responses = Math.max(2, Math.round((totalResponses * (weights[i] as number)) / wSum));
    const start = END - SPAN_MS + Math.floor(rnd() * (SPAN_MS - 3 * 86_400_000));
    gen.responses += responses;
    writeSession(root, pick(PROJECTS), `s${i.toString(36).padStart(5, '0')}-${(i * 2654435761 >>> 0).toString(16)}`, responses, start, gen);
  }
  return gen;
}

// ---------------------------------------------------------------- measuring

const ms = (t0: number): number => performance.now() - t0;
const f1 = (n: number): string => n.toFixed(n < 10 ? 1 : 0);
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

function dirBytes(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return total;
}

interface Timing {
  label: string;
  cold: number;
  warm: number;
}

function endpointList(project: string): Array<[string, string]> {
  const list: Array<[string, string]> = [];
  const add = (label: string, path: string, qs = ''): void => void list.push([label, `${path}?${qs}`]);
  const metrics = ['messages', 'tokens', 'sessions', 'cost'];
  add('summary', '/api/summary');
  add('models', '/api/models');
  add('projects', '/api/projects');
  add('sessions start', '/api/sessions');
  add('sessions tokens', '/api/sessions', 'sort=tokens');
  add('sessions active', '/api/sessions', 'sort=active&page=3');
  add('filters', '/api/filters');
  add('health', '/api/health');
  add('definitions', '/api/definitions');
  for (const m of metrics) add(`hours ${m}`, '/api/hours', `metric=${m}`);
  for (const m of metrics) add(`heatmap ${m}`, '/api/heatmap', `metric=${m}`);
  for (const m of metrics) add(`daily ${m}`, '/api/daily', `metric=${m}`);
  add('daily tokens hideCache', '/api/daily', 'metric=tokens&hideCacheRead=1');
  for (const p of ['month', 'week', 'day']) add(`breakdown ${p}`, '/api/breakdown', `period=${p}`);
  for (const p of ['month', 'week', 'day']) add(`breakdown.csv ${p}`, '/api/breakdown.csv', `period=${p}`);
  add('day detail', '/api/day', 'date=2026-09-15');
  add('day detail recent', '/api/day', 'date=2026-10-26');
  const filt = `models=claude-opus-5-5&projects=${encodeURIComponent(project)}`;
  const fm = 'models=claude-sonnet-5-5';
  const fp = `projects=${encodeURIComponent(project)}`;
  for (const [tag, qs] of [['model', fm], ['project', fp], ['both', filt]] as const) {
    add(`summary ${tag}`, '/api/summary', qs);
    add(`models ${tag}`, '/api/models', qs);
    add(`projects ${tag}`, '/api/projects', qs);
    add(`sessions ${tag}`, '/api/sessions', qs);
    add(`hours ${tag}`, '/api/hours', qs);
    add(`heatmap cost ${tag}`, '/api/heatmap', `metric=cost&${qs}`);
    add(`heatmap sessions ${tag}`, '/api/heatmap', `metric=sessions&${qs}`);
    add(`daily tokens ${tag}`, '/api/daily', `metric=tokens&${qs}`);
    add(`breakdown day ${tag}`, '/api/breakdown', `period=day&${qs}`);
    add(`breakdown month ${tag}`, '/api/breakdown', `period=month&${qs}`);
  }
  add('summary no subagents', '/api/summary', 'includeSubagents=0');
  add('summary background', '/api/summary', 'includeBackground=1');
  return list;
}

function call(deps: ApiDeps, target: string): string {
  const [path, qs] = target.split('?') as [string, string];
  const r = handleApi(deps, path, new URLSearchParams(qs));
  if (r.status !== 200) throw new Error(`${target} answered ${r.status}`);
  return r.file !== undefined ? r.file.text : JSON.stringify(r.body);
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

// Volatile fields of the answers that depend on the real clock, removed so two runs can be compared.
const volatile = (k: string, v: unknown): unknown => (k === 'durationMs' ? undefined : v);

// ---------------------------------------------------------------- run

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'ledger-perf-'));
  const dataDir = join(work, 'data');
  mkdirSync(dataDir);
  process.env['LEDGER_DATA_DIR'] = dataDir;
  const sessionsDir = join(work, 'sessions');
  mkdirSync(sessionsDir);
  const out: string[] = [];
  const say = (s: string): void => void out.push(s);
  let sourceDir: string;
  let gen: Gen | null = null;

  try {
    // 1. history
    let t0 = performance.now();
    if (REUSE !== null) {
      sourceDir = REUSE;
    } else {
      sourceDir = join(work, 'projects');
      mkdirSync(sourceDir);
      gen = generate(sourceDir);
    }
    const genMs = ms(t0);
    const bytes = dirBytes(sourceDir);
    if (gen !== null) say(`history: ${fmt(gen.lines)} lines, ${fmt(gen.files)} files, ${gen.sessions} sessions, ${f1(bytes / 1e6)} MB, made in ${f1(genMs / 1000)} s (seed ${SEED}, scale ${SCALE})`);
    else say(`history: reused ${sourceDir}, ${f1(bytes / 1e6)} MB`);

    // 2. full ingest, then the rollups the way `serve` builds them
    const { db } = openAndMigrate(dbPath());
    t0 = performance.now();
    const sum = await runIngest(db, { roots: [sourceDir], full: false, trigger: 'cli', now: () => NOW });
    const ingestMs = ms(t0);
    t0 = performance.now();
    ensureRollups(db, TZ);
    const rollMs = ms(t0);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dbBytes = statSync(dbPath()).size;
    say(`ingest: ${f1(ingestMs / 1000)} s, ${fmt(sum.linesRead / (ingestMs / 1000))} lines/s, ${fmt(sum.linesRead)} lines, ${fmt(sum.eventsUpserted)} usage events, ${sum.errors} errors; rollup build ${f1(rollMs / 1000)} s`);
    say(`database: ${f1(dbBytes / 1e6)} MB (${f1(dbBytes / bytes * 100)}% of the source)`);

    // 3. every endpoint, cold (first call on a fresh connection) and warm (median of five more)
    db.close();
    const cold = openAndMigrate(dbPath()).db;
    const deps: ApiDeps = {
      db: cold,
      tz: TZ,
      now: () => NOW,
      retentionDays: 30,
      sourceRoot: sourceDir,
      sessionsDir,
      cache: createQueryCache(),
      syncStatus: () => ({ running: false, lastPassAt: NOW, lastSuccessAt: NOW, lastError: null, watcherAlive: true }),
    };
    const project = (cold.prepare('SELECT project_key FROM sessions GROUP BY project_key ORDER BY COUNT(*) DESC LIMIT 1').get() as { project_key: string }).project_key;
    const timings: Timing[] = [];
    let differing = 0; // warm answers (from the cache) that differ from the cold answer
    const snapshot: Record<string, unknown> = {};
    const list = endpointList(project);
    for (const [label, target] of list) {
      t0 = performance.now();
      const body = call(deps, target);
      const coldMs = ms(t0);
      const warm: number[] = [];
      for (let i = 0; i < 5; i++) {
        t0 = performance.now();
        const again = call(deps, target);
        warm.push(ms(t0));
        if (again !== body) differing += 1;
      }
      timings.push({ label, cold: coldMs, warm: median(warm) });
      if (SNAPSHOT !== null) snapshot[`${label} | ${target}`] = label === 'health' ? JSON.parse(JSON.stringify(JSON.parse(body), volatile)) : target.includes('.csv') ? body : JSON.parse(body);
    }
    if (SNAPSHOT !== null) writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 1).split(work).join('<work>'));
    const slow = [...timings].sort((a, b) => b.warm - a.warm);
    const over = timings.filter((t) => t.warm >= 150);
    if (differing > 0) say(`WARNING: ${differing} warm answers differ from the cold answer`);
    say(`endpoints: ${timings.length} requests, warm worst ${f1(slow[0]?.warm ?? 0)} ms, ${over.length} at or over 150 ms warm; cold worst ${f1(Math.max(...timings.map((t) => t.cold)))} ms`);
    say('slowest by warm time (cold / warm ms):');
    for (const t of slow.slice(0, 10)) say(`  ${t.label.padEnd(26)} ${f1(t.cold).padStart(7)} / ${f1(t.warm).padStart(7)}`);
    if (OUT !== null) writeFileSync(OUT, JSON.stringify(timings, null, 1));

    // 4. unchanged reconcile pass, then append 100 lines under the running scheduler with the real watcher
    cold.close();
    const live = openAndMigrate(dbPath()).db;
    const liveDeps: ApiDeps = { ...deps, db: live, cache: createQueryCache() };
    const hub = createSseHub();
    hub.broadcast = (): void => liveDeps.cache?.clear(); // what the server does when its hub announces a synced event
    const before = JSON.parse(call(liveDeps, '/api/summary?')) as { responses: number; prompts: number };
    let resolvePass: (s: RunSummary) => void = () => undefined;
    let passes: Promise<RunSummary> = new Promise((r) => (resolvePass = r));
    const nextPass = (): void => void (passes = new Promise((r) => (resolvePass = r)));
    const sync = createSync({
      db: live,
      roots: [sourceDir],
      pollMs: 600_000,
      clock: () => NOW,
      onPass: (s) => {
        handlePass(live, TZ, hub, s, () => NOW);
        resolvePass(s);
      },
    });
    t0 = performance.now();
    await sync.start();
    const startup = await passes;
    const reconcileMs = ms(t0);
    say(`reconcile (unchanged, ${fmt(startup.filesScanned)} files): ${f1(reconcileMs)} ms wall, ${startup.filesChanged} changed, pass ${startup.durationMs} ms`);

    // 40 responses and 20 prompts, 100 lines in all, to the main transcript with the latest event.
    const target = gen?.lastMain ?? latestFile(sourceDir);
    const sid = (target.split('/').pop() as string).replace('.jsonl', '');
    const lines: string[] = [];
    const c: SessionCtx = { sid, cwd: PROJECTS[0] as string, sidechain: false, agentId: null, ts: END + 60_000 };
    c.ts = END + 60_000;
    for (let i = 0; i < 20; i++) {
      c.ts += 5000;
      const rec = base(c, 'user', c.ts);
      rec['message'] = { role: 'user', content: 'p' };
      lines.push(JSON.stringify(rec));
    }
    for (let i = 0; i < 40; i++) {
      c.ts += 5000;
      const rec = base(c, 'assistant', c.ts);
      rec['requestId'] = nextId('req');
      rec['message'] = { id: nextId('msg'), model: 'claude-sonnet-5-5', role: 'assistant', type: 'message', content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', stop_sequence: null, usage: usageBlock('claude-sonnet-5-5', true) };
      lines.push(JSON.stringify(rec));
      c.ts += 1000;
      const res = base(c, 'user', c.ts);
      res['message'] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'none', content: 'r' }] };
      lines.push(JSON.stringify(res));
    }
    lines.length = 100;
    nextPass();
    t0 = performance.now();
    appendFileSync(target, lines.join('\n') + '\n');
    let appended: RunSummary;
    let waited = 0;
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<RunSummary>((_, rej) => (timer = setTimeout(() => rej(new Error('no pass within 20 s')), 20_000)));
      try {
        appended = await Promise.race([passes, limit]);
      } finally {
        clearTimeout(timer);
      }
      if (appended.linesRead >= 100 || ++waited > 5) break;
      nextPass();
    }
    const after = JSON.parse(call(liveDeps, '/api/summary?')) as { responses: number; prompts: number };
    const visibleMs = ms(t0);
    const seen = after.responses - before.responses + (after.prompts - before.prompts);
    say(`append 100 lines: visible in the API after ${f1(visibleMs / 1000)} s (${seen} new messages seen, ${appended.linesRead} lines read, debounce 1.5 s)`);
    await sync.stop();
    live.close();
    if (seen === 0) say('WARNING: the appended lines did not change /api/summary');
  } finally {
    if (KEEP) say(`kept: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
  console.log(out.join('\n'));
}

function latestFile(root: string): string {
  let best = '';
  let bestM = 0;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!p.includes('/subagents/') && statSync(p).mtimeMs >= bestM) {
        bestM = statSync(p).mtimeMs;
        best = p;
      }
    }
  };
  walk(root);
  return best;
}

await main();
