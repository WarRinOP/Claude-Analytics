// Synthetic Claude Code transcripts for the end to end tests. Everything is invented: the prompt text is a fixed placeholder,
// the sessions, projects, models and token counts exist only to give the dashboard something to count. Times are counted back
// from "now", so the 7, 30 and 90 day presets always have the same shape: activity today and on a few days since,
// and an archive that starts 41 days ago (so 90d reaches before the archive and the coverage note appears).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

export const PROJECTS = [
  { cwd: '/work/ledger-demo', folder: '-work-ledger-demo', name: 'ledger-demo' },
  { cwd: '/work/atlas', folder: '-work-atlas', name: 'atlas' },
  { cwd: '/work/notes', folder: '-work-notes', name: 'notes' },
] as const;

export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;

interface SessionPlan {
  id: string;
  project: 0 | 1 | 2;
  daysAgo: number;
  minutesAgo: number; // start of the session, counted back from now on that day
  utcHour?: number; // when set, the session starts at this UTC hour of that day (plus minutesAgo as minutes), whatever the time of day now is
  turns: number;
  model: (typeof MODELS)[number];
  subagent?: boolean;
  backgroundModel?: string; // a cost-state model that never appears in the transcript
}

const PLAN: SessionPlan[] = [
  { id: 'sess-0001', project: 0, daysAgo: 0, minutesAgo: 90, turns: 4, model: 'claude-sonnet-5-5', subagent: true },
  { id: 'sess-0002', project: 1, daysAgo: 1, minutesAgo: 40, turns: 3, model: 'claude-opus-5-5' },
  { id: 'sess-0003', project: 0, daysAgo: 2, minutesAgo: 300, turns: 5, model: 'claude-sonnet-5-5', backgroundModel: 'claude-haiku-5-5' },
  { id: 'sess-0004', project: 2, daysAgo: 4, minutesAgo: 120, turns: 2, model: 'claude-haiku-5-5' },
  { id: 'sess-0005', project: 1, daysAgo: 6, minutesAgo: 600, turns: 4, model: 'claude-opus-5-5' },
  { id: 'sess-0006', project: 0, daysAgo: 9, minutesAgo: 200, turns: 3, model: 'claude-sonnet-5-5' },
  { id: 'sess-0007', project: 2, daysAgo: 15, minutesAgo: 15, turns: 6, model: 'claude-sonnet-5-5' },
  { id: 'sess-0008', project: 1, daysAgo: 22, minutesAgo: 480, turns: 2, model: 'claude-opus-5-5' },
  { id: 'sess-0009', project: 0, daysAgo: 33, minutesAgo: 60, turns: 3, model: 'claude-sonnet-5-5' },
  { id: 'sess-0010', project: 2, daysAgo: 41, minutesAgo: 30, turns: 2, model: 'claude-haiku-5-5' },
  // Seven sessions on one day, so the heatmap tally has a full group of five and a group of two.
  { id: 'sess-0011', project: 0, daysAgo: 12, minutesAgo: 0, utcHour: 6, turns: 2, model: 'claude-sonnet-5-5' },
  { id: 'sess-0012', project: 1, daysAgo: 12, minutesAgo: 20, utcHour: 7, turns: 2, model: 'claude-opus-5-5' },
  { id: 'sess-0013', project: 2, daysAgo: 12, minutesAgo: 5, utcHour: 9, turns: 2, model: 'claude-haiku-5-5' },
  { id: 'sess-0014', project: 0, daysAgo: 12, minutesAgo: 40, utcHour: 10, turns: 2, model: 'claude-sonnet-5-5' },
  { id: 'sess-0015', project: 1, daysAgo: 12, minutesAgo: 15, utcHour: 13, turns: 2, model: 'claude-sonnet-5-5' },
  { id: 'sess-0016', project: 0, daysAgo: 12, minutesAgo: 50, utcHour: 15, turns: 2, model: 'claude-opus-5-5' },
  { id: 'sess-0017', project: 2, daysAgo: 12, minutesAgo: 10, utcHour: 18, turns: 2, model: 'claude-sonnet-5-5' },
];

// Midnight UTC of the day that holds `ms` (the tests run with LEDGER_TZ=UTC).
function midnight(ms: number): number {
  return ms - (ms % DAY);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function prompt(sid: string, n: number, ts: number, cwd: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${sid}-${n}`,
    sessionId: sid,
    timestamp: iso(ts),
    version: '9.9.9',
    entrypoint: 'cli',
    cwd,
    isSidechain: false,
    message: { role: 'user', content: 'Synthetic prompt for the end to end tests.' },
  });
}

function response(sid: string, n: number, ts: number, o: { cwd: string; model: string; sidechain?: boolean; salt: number }): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${sid}-${n}`,
    sessionId: sid,
    timestamp: iso(ts),
    version: '9.9.9',
    entrypoint: 'cli',
    cwd: o.cwd,
    isSidechain: o.sidechain === true,
    requestId: `req_${sid}_${n}`,
    message: {
      id: `msg_${sid}_${n}`,
      model: o.model,
      role: 'assistant',
      content: [],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 40 + o.salt,
        cache_read_input_tokens: 9_000 + o.salt * 311,
        cache_creation_input_tokens: 500 + o.salt * 17,
        cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
        output_tokens: 150 + o.salt * 7,
        output_tokens_details: { thinking_tokens: 0 },
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        speed: 'standard',
      },
    },
  });
}

function costState(sid: string, background: string): string {
  return JSON.stringify({
    type: 'cost-state',
    sessionId: sid,
    startTime: 1,
    totalCostUSD: 0.4,
    totalDuration: 120_000,
    totalAPIDuration: 60_000,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    modelUsage: { [background]: { inputTokens: 25, outputTokens: 60, cacheReadInputTokens: 1200, cacheCreationInputTokens: 90, costUSD: 0.0123 } },
  });
}

function put(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n');
}

// Writes the whole synthetic projects folder under `projectsRoot` (the value Claude Code keeps in <config dir>/projects).
export function writeTranscripts(projectsRoot: string, now: number = Date.now()): void {
  let salt = 1;
  for (const s of PLAN) {
    const p = PROJECTS[s.project];
    const start = s.utcHour === undefined ? now - s.daysAgo * DAY - s.minutesAgo * MIN : midnight(now - s.daysAgo * DAY) + s.utcHour * HOUR + s.minutesAgo * MIN;
    const lines: string[] = [];
    let n = 0;
    for (let t = 0; t < s.turns; t++) {
      const at = start + t * 4 * MIN;
      lines.push(prompt(s.id, ++n, at, p.cwd));
      const replies = 1 + (t % 2);
      for (let r = 0; r < replies; r++) {
        lines.push(response(s.id, ++n, at + 30_000 + r * 25_000, { cwd: p.cwd, model: s.model, salt: salt++ }));
      }
    }
    if (s.backgroundModel !== undefined) lines.push(costState(s.id, s.backgroundModel));
    put(join(projectsRoot, p.folder, `${s.id}.jsonl`), lines);
    if (s.subagent === true) {
      put(join(projectsRoot, p.folder, s.id, 'subagents', 'agent-synth1.jsonl'), [
        response(s.id, 900, start + 2 * MIN, { cwd: p.cwd, model: 'claude-haiku-5-5', sidechain: true, salt: salt++ }),
        response(s.id, 901, start + 3 * MIN, { cwd: p.cwd, model: 'claude-haiku-5-5', sidechain: true, salt: salt++ }),
      ]);
    }
  }
}

// One more prompt and answer appended to a session file, as Claude Code would write while a session is open.
export function appendTurn(projectsRoot: string, now: number = Date.now()): void {
  const s = PLAN[0] as SessionPlan;
  const p = PROJECTS[s.project];
  const file = join(projectsRoot, p.folder, `${s.id}.jsonl`);
  const lines = [prompt(s.id, 700, now - 20_000, p.cwd), response(s.id, 701, now - 5_000, { cwd: p.cwd, model: s.model, salt: 77 })];
  // appendFileSync keeps the earlier lines byte for byte
  writeFileSync(file, lines.join('\n') + '\n', { flag: 'a' });
}
