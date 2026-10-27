import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../../src/ingest/classify.ts';
import type { Fact, LineContext } from '../../src/ingest/facts.ts';

const here = dirname(fileURLToPath(import.meta.url));

// Windows has no Unix file modes (chmod only toggles the read only bit and modes read back as 0o666), so mode
// assertions (700, 600, 644) run only elsewhere. On Windows the app relies on the user profile ACL.
export const unixModes = process.platform !== 'win32';

// The one way a test removes a temp folder. Windows refuses to delete a file that is still open, so a leaked
// handle shows up as an error here (after a few retries for slow virus scanners and indexers) instead of being hidden.
export function removeTemp(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// Whether this account may create symlinks. On Windows creating one needs a privilege (Developer Mode or an administrator)
// and fails with EPERM without it. Tests that need a symlink skip with SYMLINK_SKIP_REASON when this is false.
export const SYMLINK_SKIP_REASON = 'skipped: this account cannot create symlinks (EPERM)';
export const symlinksWork: boolean = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-symlink-probe-'));
  try {
    writeFileSync(join(dir, 'target'), 'x');
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw err;
  } finally {
    removeTemp(dir);
  }
})();

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
