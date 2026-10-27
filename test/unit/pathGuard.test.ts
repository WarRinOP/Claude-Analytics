import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertWritablePath, guardedMkdir, guardedWriteFile } from '../../src/config/pathGuard.ts';
import { dataDir, dbPath, logsDir, sourceRoot } from '../../src/config/paths.ts';

const saved = { data: process.env['LEDGER_DATA_DIR'], cfg: process.env['CLAUDE_CONFIG_DIR'] };
let base: string;
let data: string;
let outside: string;

function restore(key: 'LEDGER_DATA_DIR' | 'CLAUDE_CONFIG_DIR', v: string | undefined) {
  if (v === undefined) delete process.env[key];
  else process.env[key] = v;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-guard-')));
  data = join(base, 'data');
  outside = join(base, 'outside');
  mkdirSync(data);
  mkdirSync(outside);
  process.env['LEDGER_DATA_DIR'] = data;
  delete process.env['CLAUDE_CONFIG_DIR'];
});

afterEach(() => {
  restore('LEDGER_DATA_DIR', saved.data);
  restore('CLAUDE_CONFIG_DIR', saved.cfg);
  rmSync(base, { recursive: true, force: true });
});

describe('paths', () => {
  it('sourceRoot defaults to ~/.claude/projects and follows CLAUDE_CONFIG_DIR', () => {
    expect(sourceRoot()).toBe(join(homedir(), '.claude', 'projects'));
    process.env['CLAUDE_CONFIG_DIR'] = join(base, 'cfg');
    expect(sourceRoot()).toBe(join(base, 'cfg', 'projects'));
  });

  it('dataDir honours LEDGER_DATA_DIR inside the temp folder and derives db and logs paths', () => {
    expect(dataDir()).toBe(data);
    expect(dbPath()).toBe(join(data, 'ledger.db'));
    expect(logsDir()).toBe(join(data, 'logs'));
  });

  it('dataDir defaults to Application Support/UsageLedger', () => {
    delete process.env['LEDGER_DATA_DIR'];
    expect(dataDir()).toBe(join(homedir(), 'Library', 'Application Support', 'UsageLedger'));
  });

  it('LEDGER_DATA_DIR outside the temp folder throws', () => {
    process.env['LEDGER_DATA_DIR'] = join(homedir(), 'Documents', 'ledger-test');
    expect(() => dataDir()).toThrow();
    process.env['LEDGER_DATA_DIR'] = '/usr/local/ledger';
    expect(() => dataDir()).toThrow();
    process.env['LEDGER_DATA_DIR'] = join(tmpdir(), '..', 'escape');
    expect(() => dataDir()).toThrow();
  });

  it('LEDGER_DATA_DIR equal to the temp folder itself throws, and a symlink out of it throws', () => {
    process.env['LEDGER_DATA_DIR'] = tmpdir();
    expect(() => dataDir()).toThrow();
    const link = join(base, 'link-out');
    symlinkSync(homedir(), link);
    process.env['LEDGER_DATA_DIR'] = link;
    expect(() => dataDir()).toThrow();
  });
});

describe('pathGuard', () => {
  it('rejects ~/.claude and anything under it', () => {
    expect(() => assertWritablePath(join(homedir(), '.claude'))).toThrow();
    expect(() => assertWritablePath(join(homedir(), '.claude', 'x'))).toThrow();
    expect(() => assertWritablePath(join(homedir(), '.claude', 'projects', 'a', 'b.jsonl'))).toThrow();
  });

  it('rejects ~/Library/Application Support/Claude and children, but names that only share a prefix are just outside', () => {
    const support = join(homedir(), 'Library', 'Application Support');
    expect(() => assertWritablePath(join(support, 'Claude'))).toThrow(/Claude Code folder/);
    expect(() => assertWritablePath(join(support, 'Claude', 'x'))).toThrow(/Claude Code folder/);
    expect(() => assertWritablePath(join(support, 'ClaudeX'))).toThrow(/outside the app data folder/);
  });

  it('rejects a sibling that shares the data dir name prefix', () => {
    expect(() => assertWritablePath(data + 'Evil')).toThrow(/outside/);
    expect(() => assertWritablePath(join(base, 'dataEvil', 'x'))).toThrow(/outside/);
  });

  it('rejects paths outside the data dir and .. escapes', () => {
    expect(() => assertWritablePath(join(outside, 'x'))).toThrow();
    expect(() => assertWritablePath(join(homedir(), 'Desktop', 'x.txt'))).toThrow();
    expect(() => assertWritablePath(join(data, '..', 'outside', 'x'))).toThrow();
    expect(() => assertWritablePath(join(data, 'a', '..', '..', 'x'))).toThrow();
    expect(() => assertWritablePath('')).toThrow();
  });

  it('rejects a symlink inside the data dir that points outside it', () => {
    symlinkSync(outside, join(data, 'escape'));
    expect(() => assertWritablePath(join(data, 'escape'))).toThrow();
    expect(() => assertWritablePath(join(data, 'escape', 'new.txt'))).toThrow();
  });

  it('rejects a dangling symlink', () => {
    symlinkSync(join(base, 'does-not-exist'), join(data, 'dangling'));
    expect(() => assertWritablePath(join(data, 'dangling', 'x'))).toThrow();
  });

  it('rejects the source root even if the data dir overlaps it', () => {
    process.env['CLAUDE_CONFIG_DIR'] = data;
    expect(sourceRoot()).toBe(join(data, 'projects'));
    expect(() => assertWritablePath(join(data, 'projects', 'x.jsonl'))).toThrow(/Claude Code folder/);
    expect(assertWritablePath(join(data, 'ledger.db'))).toBe(join(data, 'ledger.db'));
  });

  it('accepts files and folders inside the data dir, existing or not', () => {
    expect(assertWritablePath(join(data, 'ledger.db'))).toBe(join(data, 'ledger.db'));
    expect(assertWritablePath(join(data, 'logs', 'a', 'b.log'))).toBe(join(data, 'logs', 'a', 'b.log'));
    expect(assertWritablePath(data)).toBe(data);
    writeFileSync(join(data, 'exists.txt'), 'x');
    expect(assertWritablePath(join(data, 'exists.txt'))).toBe(join(data, 'exists.txt'));
  });

  it('accepts a file inside a symlinked temp data dir and returns the real path', () => {
    const alias = join(base, 'alias');
    symlinkSync(data, alias);
    process.env['LEDGER_DATA_DIR'] = alias;
    expect(assertWritablePath(join(data, 'f.txt'))).toBe(join(data, 'f.txt'));
  });
});

describe('guarded wrappers', () => {
  it('create folders with mode 700 and files with mode 600', () => {
    const file = guardedWriteFile(join(data, 'logs', 'a.log'), 'hello');
    expect(readFileSync(file, 'utf8')).toBe('hello');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(data, 'logs')).mode & 0o777).toBe(0o700);
    const dir = guardedMkdir(join(data, 'x', 'y'));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuse and write nothing outside the data dir', () => {
    expect(() => guardedWriteFile(join(outside, 'x.txt'), 'no')).toThrow();
    expect(() => guardedMkdir(join(outside, 'sub'))).toThrow();
    expect(() => guardedMkdir(join(homedir(), '.claude', '__ledger_guard_test__'))).toThrow();
    expect(() => statSync(join(outside, 'x.txt'))).toThrow();
    expect(() => statSync(join(outside, 'sub'))).toThrow();
    expect(() => statSync(join(homedir(), '.claude', '__ledger_guard_test__'))).toThrow();
  });
});
