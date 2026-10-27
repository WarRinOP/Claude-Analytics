import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Daily, Sessions, Summary } from '../../src/api/types.ts';
import { csvField, toCsv } from '../../src/cli/export.ts';
import { rebuildAll, resolvePromptModels, setMeta } from '../../src/metrics/rollups.ts';
import { dayBounds } from '../../src/metrics/time.ts';
import { HOUR, MIN, seeder, type Seeder } from '../unit/metricsHelpers.ts';
import { useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const DHAKA = 'Asia/Dhaka';
const local = (day: string, hh: number, mm = 0): number => dayBounds(day, DHAKA)[0] + hh * HOUR + mm * MIN;

let env: TempEnv;
let work: string;
beforeEach(() => {
  env = useTempDataDir();
  work = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-export-')));
});
afterEach(() => {
  env.restore();
  rmSync(work, { recursive: true, force: true });
});

// Minimal RFC 4180 reader for the checks below.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function table(text: string): Array<Record<string, string>> {
  const [head, ...rest] = parseCsv(text);
  return rest.map((r) => Object.fromEntries((head as string[]).map((h, i) => [h, r[i] as string])));
}

// Reference archive (Asia/Dhaka):
//   2026-10-20  session A (/work/a): p 09:00, R opus 09:01, p 14:00, R sonnet 14:01, R sonnet 14:02, subagent sonnet 14:03
//   2026-10-21  session B (/work/b): p 23:30, R opus 23:31
//   2026-10-22  session A: R sonnet 00:30
function build(): Seeder {
  const s = seeder(env.dir, DHAKA);
  s.prompt('A', local('2026-10-20', 9), { cwd: '/work/a' });
  s.response('A', local('2026-10-20', 9, 1), { model: 'claude-opus-5-5', cwd: '/work/a', input: 7, output: 11, cacheRead: 13, cacheWrite: 17 });
  s.prompt('A', local('2026-10-20', 14), { cwd: '/work/a' });
  s.response('A', local('2026-10-20', 14, 1), { cwd: '/work/a' });
  s.response('A', local('2026-10-20', 14, 2), { cwd: '/work/a', tools: 2 });
  s.response('A', local('2026-10-20', 14, 3), { sub: true });
  s.prompt('B', local('2026-10-21', 23, 30), { cwd: '/work/b' });
  s.response('B', local('2026-10-21', 23, 31), { model: 'claude-opus-5-5', cwd: '/work/b' });
  s.response('A', local('2026-10-22', 0, 30), { cwd: '/work/a' });
  resolvePromptModels(s.db);
  rebuildAll(s.db, DHAKA);
  return s;
}

// Reads the API numbers, then closes the database and gives it the name the command line uses.
function publish(s: Seeder): void {
  s.db.close();
  const file = readdirSync(env.dir).find((f) => /^ledger-\d+\.db$/.test(f)) as string;
  renameSync(join(env.dir, file), join(env.dir, 'ledger.db'));
}

function run(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['src/cli.ts', 'export', ...args], {
    cwd: ROOT,
    env: { ...process.env, LEDGER_DATA_DIR: env.dir, CLAUDE_CONFIG_DIR: join(work, 'claude'), LEDGER_TZ: DHAKA, ...extra },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const body = <T>(s: Seeder, path: string): T => {
  const r = s.get(path);
  if (r.status !== 200) throw new Error(`${path} gave ${r.status}`);
  return r.body as T;
};

describe('csv quoting', () => {
  it('quotes commas, quotes and line breaks, and leaves plain text alone', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('cr\rhere')).toBe('"cr\rhere"');
    expect(csvField(12)).toBe('12');
    expect(csvField(true)).toBe('true');
    expect(csvField('')).toBe('');
  });

  it('marks text that a spreadsheet would read as a formula', () => {
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('@x')).toBe("'@x");
    expect(csvField(-5)).toBe('-5');
  });

  it('ends every row with CRLF and round trips through a reader', () => {
    const rows = [
      ['a,b', 'say "hi"', 'x\ny'],
      ['', 'plain', 3],
    ];
    const text = toCsv(['one', 'two', 'three'], rows);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.split('\r\n')).toHaveLength(4);
    expect(parseCsv(text)).toEqual([
      ['one', 'two', 'three'],
      ['a,b', 'say "hi"', 'x\ny'],
      ['', 'plain', '3'],
    ]);
  });
});

describe('export --csv', () => {
  it('daily numbers equal the API for the same range', () => {
    const s = build();
    const q = 'from=2026-10-19&to=2026-10-23';
    const tokens = body<Daily>(s, `/api/daily?metric=tokens&${q}`);
    const messages = body<Daily>(s, `/api/daily?metric=messages&${q}`);
    const sessions = body<Daily>(s, `/api/daily?metric=sessions&${q}`);
    const sum = body<Summary>(s, `/api/summary?${q}`);
    const cost = body<Daily>(s, `/api/daily?metric=cost&${q}`);
    publish(s);

    const r = run(['--stdout', 'daily', '--from', '2026-10-19', '--to', '2026-10-23']);
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\r\n')[0]).toBe('day,prompts,responses,sessions,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,partial,cost_usd');
    const rows = table(r.out);
    expect(rows.map((x) => x['day'])).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
    rows.forEach((row, i) => {
      expect(Number(row['prompts']) + Number(row['responses']), row['day']).toBe((messages.days[i] as { total: number }).total);
      expect(Number(row['total_tokens']), row['day']).toBe((tokens.days[i] as { total: number }).total);
      expect(Number(row['sessions']), row['day']).toBe((sessions.days[i] as { total: number }).total);
      // six decimals, the same value the API answers
      expect(row['cost_usd'], row['day']).toMatch(/^\d+\.\d{6}$/);
      expect(row['cost_usd'], row['day']).toBe((cost.days[i] as { total: number }).total.toFixed(6));
    });
    const add = (k: string): number => rows.reduce((n, x) => n + Number(x[k]), 0);
    expect(add('prompts')).toBe(sum.prompts);
    expect(add('responses')).toBe(sum.responses);
    expect(add('input_tokens')).toBe(sum.tokens.input);
    expect(add('output_tokens')).toBe(sum.tokens.output);
    expect(add('cache_read_tokens')).toBe(sum.tokens.cacheRead);
    expect(add('cache_write_tokens')).toBe(sum.tokens.cacheWrite);
    expect(add('total_tokens')).toBe(sum.tokens.total);
    expect(add('cost_usd')).toBeCloseTo(sum.cost.usd, 6);
    expect(rows.find((x) => x['day'] === '2026-10-20')).toMatchObject({ prompts: '2', responses: '3', sessions: '1' });
    expect(rows.find((x) => x['day'] === '2026-10-23')).toMatchObject({ prompts: '0', responses: '0', sessions: '0', total_tokens: '0' });
  });

  it('sessions numbers equal the API, with local times and no titles by default', () => {
    const s = build();
    const api = body<Sessions>(s, '/api/sessions?from=2026-10-19&to=2026-10-23&pageSize=200');
    s.db.prepare("INSERT INTO session_titles (session_id, source, title, updated_at) VALUES ('A', 'ai', 'Fix, \"quote\"\nline', 1)").run();
    publish(s);

    const r = run(['--stdout', 'sessions', '--from', '2026-10-19', '--to', '2026-10-23']);
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\r\n')[0]).toBe('session_id,project,start_local,end_local,active_minutes,prompts,responses,tokens,models,source_deleted,cost_usd');
    expect(r.out).not.toContain('Fix');
    const rows = table(r.out);
    expect(rows).toHaveLength(api.total);
    for (const a of api.rows) {
      const row = rows.find((x) => x['session_id'] === a.sessionId) as Record<string, string>;
      expect(row, a.sessionId).toBeDefined();
      expect(Number(row['prompts'])).toBe(a.prompts);
      expect(Number(row['responses'])).toBe(a.responses);
      expect(Number(row['tokens'])).toBe(a.tokens);
      expect(row['cost_usd']).toBe(a.costUsd.toFixed(6));
      expect(Number(row['active_minutes'])).toBeCloseTo(a.activeMs / 60000, 1);
      expect(row['models']).toBe(a.models.join('; '));
      expect(row['project']).toBe(a.displayName);
      expect(row['source_deleted']).toBe(a.sourceDeleted ? 'yes' : 'no');
    }
    const a = rows.find((x) => x['session_id'] === 'A') as Record<string, string>;
    expect(a['start_local']).toBe('2026-10-20 09:00:00');
    expect(a['end_local']).toBe('2026-10-22 00:30:00');
    expect(rows.map((x) => x['session_id'])).toEqual(['A', 'B']); // oldest first

    const withTitles = run(['--stdout', 'sessions', '--titles', '--from', '2026-10-19', '--to', '2026-10-23']);
    const t = table(withTitles.out).find((x) => x['session_id'] === 'A') as Record<string, string>;
    expect(t['title']).toBe('Fix, "quote"\nline');
  });

  it('applies the model and project filters like the API', () => {
    const s = build();
    const q = 'from=2026-10-19&to=2026-10-23';
    const opusDaily = body<Daily>(s, `/api/daily?metric=tokens&models=claude-opus-5-5&${q}`);
    const projB = body<Sessions>(s, `/api/sessions?projects=${encodeURIComponent('/work/b')}&${q}`);
    publish(s);

    const m = table(run(['--stdout', 'daily', '--models', 'claude-opus-5-5', '--from', '2026-10-19', '--to', '2026-10-23']).out);
    m.forEach((row, i) => expect(Number(row['total_tokens'])).toBe((opusDaily.days[i] as { total: number }).total));
    expect(Number(m.find((x) => x['day'] === '2026-10-20')?.['total_tokens'])).toBe(7 + 11 + 13 + 17);

    const p = table(run(['--stdout', 'sessions', '--projects', '/work/b', '--from', '2026-10-19', '--to', '2026-10-23']).out);
    expect(p.map((x) => x['session_id'])).toEqual(projB.rows.map((x) => x.sessionId));
    expect(p.map((x) => x['session_id'])).toEqual(['B']);
  });

  it('marks possibly incomplete days like the API', () => {
    const s = build();
    // The archive began on 2026-11-20, so with 30 days of retention the first complete day is 2026-10-21 and the
    // 20th (the first archived day) is possibly incomplete.
    setMeta(s.db, 'archive_started_at', String(local('2026-11-20', 12)));
    const api = body<Daily>(s, '/api/daily?metric=tokens&from=2026-10-19&to=2026-10-23');
    expect(api.days.some((d) => d.partial)).toBe(true);
    publish(s);
    const rows = table(run(['--stdout', 'daily', '--from', '2026-10-19', '--to', '2026-10-23']).out);
    expect(rows.map((x) => x['partial'] === 'yes')).toEqual(api.days.map((d) => d.partial));
  });

  it('writes daily.csv and sessions.csv into a stamped exports folder inside the data folder, equal to stdout', () => {
    const s = build();
    publish(s);
    const args = ['--from', '2026-10-19', '--to', '2026-10-23'];
    const r = run(['--csv', ...args]);
    expect(r.code, r.err).toBe(0);
    const base = join(env.dir, 'exports');
    const [stamp] = readdirSync(base);
    expect(stamp).toMatch(/^\d{8}-\d{6}$/);
    expect(readdirSync(join(base, stamp as string)).sort()).toEqual(['daily.csv', 'sessions.csv']);
    expect(r.out).toContain(join(base, stamp as string, 'daily.csv'));
    const daily = readFileSync(join(base, stamp as string, 'daily.csv'), 'utf8');
    const sess = readFileSync(join(base, stamp as string, 'sessions.csv'), 'utf8');
    expect(daily).toBe(run(['--stdout', 'daily', ...args]).out);
    expect(sess).toBe(run(['--stdout', 'sessions', ...args]).out);
    expect(statSync(join(base, stamp as string, 'daily.csv')).mode & 0o777).toBe(0o600);
    // nothing else was written beside the archive and the exports
    expect(readdirSync(env.dir).sort()).toEqual(expect.arrayContaining(['exports', 'ledger.db']));
    expect(readdirSync(work)).toEqual([]);
  });

  it('keeps an earlier export when a second one starts in the same second', () => {
    const s = build();
    publish(s);
    expect(run(['--csv', '--from', '2026-10-19', '--to', '2026-10-23']).code).toBe(0);
    expect(run(['--csv', '--from', '2026-10-19', '--to', '2026-10-23']).code).toBe(0);
    expect(readdirSync(join(env.dir, 'exports')).length).toBe(2);
  });

  it('answers bad input with a plain sentence and writes nothing', () => {
    const s = build();
    publish(s);
    const bad: Array<[string[], RegExp]> = [
      [[], /Choose an output format/],
      [['--csv', '--from', 'x'], /not a valid local date/],
      [['--csv', '--from', '2026-10-22', '--to', '2026-10-20'], /after the to date/],
      [['--csv', '--bogus'], /Unknown option/],
      [['--stdout', 'weekly'], /daily or sessions/],
      [['--csv', '--models'], /needs a value/],
    ];
    for (const [args, re] of bad) {
      const r = run(args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toMatch(re);
    }
    expect(existsSync(join(env.dir, 'exports'))).toBe(false);
  });

  it('says so when there is no archive', () => {
    const r = run(['--csv']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no archive yet');
  });
});
