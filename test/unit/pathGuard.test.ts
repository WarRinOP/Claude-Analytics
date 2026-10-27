import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertWritablePath, forbiddenRules, guardedMkdir, guardedWriteFile, isForbidden } from '../../src/config/pathGuard.ts';
import { dataDir, dbPath, isInside, isInsideTemp, isStrictlyInside, logsDir, sourceRoot, tempRoots } from '../../src/config/paths.ts';
import { folders } from '../../src/config/platform.ts';
import { removeTemp, unixModes } from './helpers.ts';

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
  removeTemp(base);
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

  it('dataDir defaults to Application Support/UsageLedger on macOS and %LOCALAPPDATA%/UsageLedger on Windows', () => {
    delete process.env['LEDGER_DATA_DIR'];
    if (process.platform === 'win32') {
      const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
      expect(dataDir()).toBe(join(local, 'UsageLedger'));
    } else {
      expect(dataDir()).toBe(join(homedir(), 'Library', 'Application Support', 'UsageLedger'));
    }
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

  it('rejects the Claude desktop app folder and children, but names that only share a prefix are just outside', () => {
    // macOS: ~/Library/Application Support. Windows: %APPDATA% (the roaming profile).
    const support =
      process.platform === 'win32' ? (process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')) : join(homedir(), 'Library', 'Application Support');
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
    // The whole Claude config folder is never written (folders contract), so a data folder that is the config folder is refused too.
    expect(() => assertWritablePath(join(data, 'ledger.db'))).toThrow(/Claude Code folder/);
  });

  it('a config folder elsewhere does not touch the data folder', () => {
    process.env['CLAUDE_CONFIG_DIR'] = join(base, 'cfg');
    expect(() => assertWritablePath(join(base, 'cfg', 'anything'))).toThrow(/Claude Code folder/);
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
    if (unixModes) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(data, 'logs')).mode & 0o777).toBe(0o700);
    }
    const dir = guardedMkdir(join(data, 'x', 'y'));
    expect(statSync(dir).isDirectory()).toBe(true);
    if (unixModes) expect(statSync(dir).mode & 0o777).toBe(0o700);
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

describe('the folder rules of each system, run on any system', () => {
  const winHome = 'C:\\Users\\Me';
  const winEnv = { LOCALAPPDATA: 'C:\\Users\\Me\\AppData\\Local', APPDATA: 'C:\\Users\\Me\\AppData\\Roaming' };
  const win = folders({ os: 'win32', home: winHome, env: winEnv });
  const winRules = forbiddenRules(win);
  const bad = (p: string): boolean => isForbidden(win.path, winRules, p);

  it('win32 takes its folders from the contract and writes the data folder to the local profile', () => {
    expect(win.dataDir).toBe('C:\\Users\\Me\\AppData\\Local\\UsageLedger');
    expect(win.sourceRoot).toBe('C:\\Users\\Me\\.claude\\projects');
    expect(win.path).toBe(win32);
  });

  it('win32 compares case insensitively and accepts both separators', () => {
    expect(bad('C:\\Users\\Me\\.claude')).toBe(true);
    expect(bad('c:/users/me/.CLAUDE/projects/a/b.jsonl')).toBe(true);
    expect(bad('C:/Users/Me/.claude/sessions/x.json')).toBe(true);
    expect(bad('C:\\Users\\Me\\.claudeX\\a')).toBe(false);
    expect(bad('C:\\Users\\Me\\AppData\\Local\\UsageLedger\\ledger.db')).toBe(false);
    expect(bad('D:\\elsewhere\\x')).toBe(false);
    expect(isInside('C:\\A\\B', 'c:/a/b/c', win32)).toBe(true);
    expect(isInside('C:\\A\\B', 'C:\\A\\BC', win32)).toBe(false);
    expect(isInside('C:\\A\\B', 'C:\\A', win32)).toBe(false);
  });

  it('win32 refuses every desktop app folder of the platform contract', () => {
    for (const d of [
      'C:\\Users\\Me\\AppData\\Roaming\\Claude',
      'C:\\Users\\Me\\AppData\\Roaming\\Claude-3p',
      'C:\\Users\\Me\\AppData\\Local\\Claude',
      'C:\\Users\\Me\\AppData\\Local\\Claude-3p',
      'C:\\Users\\Me\\AppData\\Local\\AnthropicClaude',
    ]) {
      expect(bad(d), d).toBe(true);
      expect(bad(`${d}\\sub\\file.txt`), d).toBe(true);
      expect(bad(d.toLowerCase().replaceAll('\\', '/') + '/x'), d).toBe(true);
    }
    expect(bad('C:\\Users\\Me\\AppData\\Roaming\\ClaudeX\\a')).toBe(false);
  });

  it('win32 refuses every Store package folder that starts with Claude_, and only those', () => {
    const pk = 'C:\\Users\\Me\\AppData\\Local\\Packages';
    expect(bad(`${pk}\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\x`)).toBe(true);
    expect(bad(`${pk}\\Claude_pzs8sxrjxfjjc`)).toBe(true);
    expect(bad(`${pk.toLowerCase()}/claude_other/x`)).toBe(true);
    expect(bad(`${pk}\\ClaudeX\\x`)).toBe(false);
    expect(bad(`${pk}\\Other_1\\x`)).toBe(false);
    expect(bad(pk)).toBe(false);
  });

  it('win32 follows CLAUDE_CONFIG_DIR and refuses the whole folder', () => {
    const f = folders({ os: 'win32', home: winHome, env: { ...winEnv, CLAUDE_CONFIG_DIR: 'D:\\cfg' } });
    const rules = forbiddenRules(f);
    expect(isForbidden(f.path, rules, 'd:/CFG/projects/a.jsonl')).toBe(true);
    expect(isForbidden(f.path, rules, 'D:\\cfg\\anything')).toBe(true);
    expect(isForbidden(f.path, rules, 'D:\\cfg2\\anything')).toBe(false);
  });

  it('a real form of a folder is refused too', () => {
    const rules = forbiddenRules(win, (p) => (p === 'C:\\Users\\Me\\.claude' ? 'D:\\Real\\claude-home' : p));
    expect(isForbidden(win.path, rules, 'd:\\real\\CLAUDE-HOME\\projects\\x')).toBe(true);
  });

  it('darwin refuses ~/.claude and both desktop folders, and names that only share a prefix are outside', () => {
    const mac = folders({ os: 'darwin', home: '/Users/me', env: {} });
    const rules = forbiddenRules(mac);
    const badMac = (p: string): boolean => isForbidden(mac.path, rules, p);
    expect(mac.path).toBe(posix);
    expect(badMac('/Users/me/.claude/projects/a')).toBe(true);
    expect(badMac('/Users/me/Library/Application Support/Claude/x')).toBe(true);
    expect(badMac('/Users/me/Library/Application Support/Claude-3p/x')).toBe(true);
    expect(badMac('/Users/me/Library/Application Support/ClaudeX/x')).toBe(false);
    expect(badMac('/Users/me/Library/Application Support/UsageLedger/ledger.db')).toBe(false);
    expect(badMac('/Users/me/.CLAUDE/x')).toBe(false); // macOS paths are case sensitive here
    expect(mac.forbiddenChildPrefix).toBeNull();
  });

  it('LEDGER_DATA_DIR accepts the long and the 8.3 short form of the temp folder, and never the temp folder itself', () => {
    const roots = ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp', 'C:\\Users\\runneradmin\\AppData\\Local\\Temp'];
    const ok = (c: string): boolean => isInsideTemp(c, win32, roots);
    expect(ok('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ledger-x\\data')).toBe(true);
    expect(ok('c:/users/runneradmin/appdata/local/temp/ledger-x/data')).toBe(true);
    expect(ok(roots[0] as string)).toBe(false);
    expect(ok(roots[1] as string)).toBe(false);
    expect(ok('C:\\Users\\runneradmin\\Documents\\x')).toBe(false);
    expect(ok('C:\\Users\\runneradmin\\AppData\\Local\\Temp2\\x')).toBe(false);
    expect(isStrictlyInside('C:\\A', 'C:\\A', win32)).toBe(false);
  });

  it('on this system the temp roots hold the real path of tmpdir()', () => {
    expect(tempRoots()).toContain(realpathSync(tmpdir()));
    expect(isInsideTemp(join(realpathSync(tmpdir()), 'x'))).toBe(true);
    expect(isInsideTemp(realpathSync(tmpdir()))).toBe(false);
  });
});
