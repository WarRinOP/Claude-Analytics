// pnpm verify: lint, typecheck (server, web, e2e), unit and integration tests, web build, end to end tests, audit.
// Compact output (under 30 lines), nonzero exit on failure.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const root = process.cwd();

// The JavaScript entry of a tool, from its package's `bin` field. Tools are started as `node <entry>` so that no
// `.cmd` launcher (which Node refuses to spawn without a shell on Windows) and no `node_modules/.bin` shim is needed.
function entry(pkg: string, binName: string): string {
  const pkgJson = join(root, 'node_modules', pkg, 'package.json');
  const meta = JSON.parse(readFileSync(pkgJson, 'utf8')) as { bin?: string | Record<string, string> };
  const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[binName];
  if (rel === undefined) throw new Error(`${pkg} has no bin entry named ${binName}`);
  return join(dirname(pkgJson), rel);
}
const tool = {
  eslint: entry('eslint', 'eslint'),
  tsc: entry('typescript', 'tsc'),
  vitest: entry('vitest', 'vitest'),
  vite: entry('vite', 'vite'),
  playwright: entry('@playwright/test', 'playwright'),
};
const out: string[] = [];
let failed = false;

function run(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, text: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, spawnError: r.error };
}

function fail(line: string, details: string[]) {
  failed = true;
  out.push(line, ...details);
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const short = (s: string, n = 110) => (s.length > n ? s.slice(0, n - 3) + '...' : s);

// lint
{
  const r = run(tool.eslint, ['.', '--format', 'json']);
  let problems: string[] = [];
  let parsed = false;
  try {
    const files = JSON.parse(r.text.slice(r.text.indexOf('['), r.text.lastIndexOf(']') + 1)) as Array<{
      filePath: string;
      messages: Array<{ line: number; column: number; ruleId: string | null; message: string }>;
    }>;
    parsed = true;
    problems = files.flatMap((f) =>
      f.messages.map((m) => `${relative(root, f.filePath)}:${m.line}:${m.column} ${m.ruleId ?? ''} ${m.message}`),
    );
  } catch {
    // fall through
  }
  if (r.code === 0 && parsed && problems.length === 0) out.push('lint: ok');
  else
    fail(`lint: FAIL (${parsed ? problems.length : 'unparsed'} problems)`,
      parsed ? problems.slice(0, 5).map((p) => '  ' + short(p)) : ['  ' + short(r.text.trim().split('\n')[0] ?? '')]);
}

// typecheck: the server, the dashboard (web/) and the end to end tests each have their own tsconfig
{
  const errs: string[] = [];
  let bad = false;
  for (const args of [[], ['-p', 'web/tsconfig.json'], ['-p', 'test/e2e/tsconfig.json']]) {
    const r = run(tool.tsc, ['--noEmit', '--pretty', 'false', ...args]);
    const found = r.text.split('\n').filter((l) => /\(\d+,\d+\): error TS/.test(l));
    errs.push(...found);
    if (r.code !== 0) {
      bad = true;
      if (found.length === 0) errs.push(r.text.trim().split('\n')[0] ?? '');
    }
  }
  if (!bad) out.push('typecheck: ok (server, web, e2e)');
  else fail(`typecheck: FAIL (${errs.length} errors)`, errs.slice(0, 5).map((e) => '  ' + short(e)));
}

// tests
{
  const dir = mkdtempSync(join(tmpdir(), 'verify-'));
  const file = join(dir, 'vitest.json');
  const r = run(tool.vitest, ['run', '--reporter=json', `--outputFile=${file}`]);
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as {
      numPassedTests: number;
      numFailedTests: number;
      numPendingTests: number;
      numTodoTests: number;
      testResults: Array<{
        name: string;
        status: string;
        message?: string;
        assertionResults: Array<{ fullName: string; status: string; failureMessages?: string[] }>;
      }>;
    };
    const skipped = j.numPendingTests + j.numTodoTests;
    const totals = `${j.numPassedTests} passed, ${j.numFailedTests} failed, ${skipped} skipped`;
    const reasons: string[] = [];
    for (const f of j.testResults) {
      const failedAsserts = f.assertionResults.filter((a) => a.status === 'failed');
      for (const a of failedAsserts)
        reasons.push(`  ${short(a.fullName, 60)}: ${short((a.failureMessages?.[0] ?? '').split('\n')[0] ?? '', 60)}`);
      if (f.status === 'failed' && failedAsserts.length === 0)
        reasons.push(`  ${relative(root, f.name)}: ${short((f.message ?? 'suite failed').split('\n')[0] ?? '', 60)}`);
    }
    if (r.code === 0 && j.numFailedTests === 0 && reasons.length === 0) out.push(`test: ok (${totals})`);
    else fail(`test: FAIL (${totals})`, reasons.slice(0, 15));
  } catch {
    fail('test: FAIL (no report)', ['  ' + short(r.text.trim().split('\n').slice(-1)[0] ?? '')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// build the dashboard (web/dist)
let built = false;
{
  const r = run(tool.vite, ['build', '--config', 'web/vite.config.ts']);
  if (r.code === 0) {
    built = true;
    out.push('build:web: ok');
  } else fail('build:web: FAIL', r.text.trim().split('\n').filter((l) => l.trim() !== '').slice(-4).map((l) => '  ' + short(l)));
}

// end to end tests: headless Chromium against `serve` on synthetic data
if (!built) fail('e2e: FAIL (skipped, the web build failed)', []);
else {
  const dir = mkdtempSync(join(tmpdir(), 'verify-e2e-'));
  const file = join(dir, 'report.json');
  const r = spawnSync(process.execPath, [tool.playwright, 'test', '--reporter=json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: file },
  });
  try {
    interface Spec {
      title: string;
      ok: boolean;
      tests: Array<{ results: Array<{ error?: { message?: string } }> }>;
    }
    interface Suite {
      specs?: Spec[];
      suites?: Suite[];
    }
    const j = JSON.parse(readFileSync(file, 'utf8')) as { stats: { expected: number; unexpected: number; skipped: number; flaky: number }; suites: Suite[] };
    const reasons: string[] = [];
    const walk = (su: Suite): void => {
      for (const sp of su.specs ?? []) {
        if (sp.ok) continue;
        const msg = (sp.tests[0]?.results[0]?.error?.message ?? '').replace(ANSI, '').split('\n').find((l) => l.trim() !== '') ?? 'failed';
        reasons.push(`  ${short(sp.title, 60)}: ${short(msg.trim(), 60)}`);
      }
      (su.suites ?? []).forEach(walk);
    };
    j.suites.forEach(walk);
    const totals = `${j.stats.expected} passed, ${j.stats.unexpected} failed, ${j.stats.skipped} skipped`;
    if (r.status === 0 && j.stats.unexpected === 0 && j.stats.flaky === 0) out.push(`e2e: ok (${totals})`);
    else fail(`e2e: FAIL (${totals}, ${j.stats.flaky} flaky)`, reasons.slice(0, 8));
  } catch {
    fail('e2e: FAIL (no report)', [`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).map((l) => '  ' + short(l)).join('\n')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// audit
{
  // How to start pnpm. When pnpm runs this script it sets npm_execpath to itself: a JavaScript entry (start it with node),
  // or a native launcher (start it directly). Neither needs a shell. Only when that is missing is `pnpm` looked up by name:
  // on Windows that is a `.cmd` file, which Node refuses to start without a shell, so only there the constant command
  // `pnpm audit --prod` goes through the shell. Nothing from the environment is put into that command.
  const self = process.env['npm_execpath'] ?? '';
  const opts = { cwd: root, encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024 };
  let how: string;
  let x: SpawnSyncReturns<string>;
  if (/pnpm/i.test(self) && /\.[cm]?js$/.test(self)) {
    how = `node ${self}`;
    x = spawnSync(process.execPath, [self, 'audit', '--prod'], opts);
  } else if (/pnpm/i.test(self) && !/\.(cmd|bat)$/i.test(self)) {
    how = self;
    x = spawnSync(self, ['audit', '--prod'], opts);
  } else if (process.platform === 'win32') {
    how = 'shell: pnpm audit --prod';
    x = spawnSync('pnpm audit --prod', { ...opts, shell: true });
  } else {
    how = 'pnpm';
    x = spawnSync('pnpm', ['audit', '--prod'], opts);
  }
  const text = `${x.stdout ?? ''}\n${x.stderr ?? ''}`;
  const code = x.status ?? 1;
  const offline = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|offline|getaddrinfo/i.test(text);
  if (code === 0) out.push('audit: ok');
  else if (offline) out.push('audit: skipped (offline)');
  else {
    // Never an empty reason: the spawn error, the exit status or signal, then the last lines of output.
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    const why = [
      ...(x.error !== undefined ? [`spawn error: ${x.error.message}`] : []),
      `started as: ${how}; exit status ${x.status === null ? 'none' : x.status}${x.signal !== null ? `, signal ${x.signal}` : ''}`,
      ...lines.slice(-3),
    ];
    fail('audit: FAIL', why.map((l) => '  ' + short(l)));
  }
}

out.push(failed ? 'verify: FAIL' : 'verify: ok');
console.log(out.slice(0, 29).join('\n'));
process.exit(failed ? 1 : 0);
