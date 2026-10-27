import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discover, parseSubagentName, parseTopLevelName, toSafeNumber } from '../../src/ingest/discover.ts';
import { readLines } from '../../src/ingest/reader.ts';

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-discover-')));
  root = join(base, 'projects');
  mkdirSync(root);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function put(rel: string, text = '{"type":"x"}\n'): string {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  return p;
}

describe('session id parsing', () => {
  it('reads the three top level name forms', () => {
    const sid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
    for (const name of [`${sid}.jsonl`, `${sid}.orphaned-1761500000000-ab12cd.jsonl`, `${sid}.jsonl.superseded-1761500000000`]) {
      expect(parseTopLevelName(name)).toEqual({ sessionId: sid, agentId: null, isSubagent: false });
    }
  });

  it('ignores names that are not transcripts', () => {
    for (const name of ['custom-title.json', 'page-1.jpg', 'notes.txt', '.jsonl', 'memory', 'a.jsonl.bak']) {
      expect(parseTopLevelName(name)).toBeNull();
    }
  });

  it('reads the subagent form with the folder name as session id', () => {
    expect(parseSubagentName('sess-1', 'agent-a1b2c3.jsonl')).toEqual({
      sessionId: 'sess-1',
      agentId: 'a1b2c3',
      isSubagent: true,
    });
    expect(parseSubagentName('sess-1', 'agent-a1b2c3.meta.json')).toBeNull();
    expect(parseSubagentName('sess-1', 'other.jsonl')).toBeNull();
  });

  it('discover applies the forms and ignores everything else', () => {
    put('projA/s1.jsonl');
    put('projA/s2.orphaned-1700000000000-xyz.jsonl');
    put('projA/s3.jsonl.superseded-1700000000000');
    put('projA/s1/subagents/agent-ab12.jsonl');
    put('projA/s1/subagents/agent-ab12.meta.json');
    put('projA/s1/tool-results/big.txt');
    put('projA/memory/MEMORY.md');
    put('projA/custom-title.json');
    put('projA/page-1.jpg');
    put('stray.jsonl');
    const d = discover(root);
    const rel = d.files.map((f) => [f.path.slice(root.length + 1), f.sessionId, f.agentId, f.isSubagent, f.projectDir]);
    expect(rel).toEqual([
      ['projA/s1.jsonl', 's1', null, false, 'projA'],
      ['projA/s1/subagents/agent-ab12.jsonl', 's1', 'ab12', true, 'projA'],
      ['projA/s2.orphaned-1700000000000-xyz.jsonl', 's2', null, false, 'projA'],
      ['projA/s3.jsonl.superseded-1700000000000', 's3', null, false, 'projA'],
    ]);
    expect(d.skipped).toEqual([]);
    expect(d.aliases).toEqual([]);
  });

  it('does not look deeper than the subagents folder', () => {
    put('projA/s1/subagents/nested/agent-deep.jsonl');
    put('projA/s1/other/agent-x.jsonl');
    put('projA/s1/agent-y.jsonl');
    put('projA/s1/subagents/agent-ok.jsonl');
    expect(discover(root).files.map((f) => f.agentId)).toEqual(['ok']);
  });
});

describe('14 symlinks are never followed', () => {
  it('alias, loop, linked file and linked subagents folder: no loop, no error, each file once', () => {
    const real = put('proj/real-session.jsonl');
    put('proj/sid1/subagents/agent-one.jsonl');
    // alias of the whole project folder, relative and absolute targets as written
    symlinkSync('proj', join(root, 'alias-rel'));
    symlinkSync(join(root, 'proj'), join(root, 'alias-abs'));
    // loop inside the project folder, pointing at the folder itself
    symlinkSync(join(root, 'proj'), join(root, 'proj', 'proj-loop'));
    // symlinked transcript
    symlinkSync(real, join(root, 'proj', 'linked.jsonl'));
    // symlinked subagents folder holding a file that would be a duplicate
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'agent-two.jsonl'), '{}\n');
    mkdirSync(join(root, 'proj', 'sid2'));
    symlinkSync(elsewhere, join(root, 'proj', 'sid2', 'subagents'));
    // dangling link
    symlinkSync(join(base, 'nowhere'), join(root, 'proj', 'dangling.jsonl'));

    const d = discover(root);

    expect(d.files.map((f) => f.path.slice(root.length + 1))).toEqual([
      'proj/real-session.jsonl',
      'proj/sid1/subagents/agent-one.jsonl',
    ]);
    expect(d.aliases).toEqual([
      { aliasDir: 'alias-abs', targetDir: join(root, 'proj') },
      { aliasDir: 'alias-rel', targetDir: 'proj' },
    ]);
    expect(d.skipped.map((s) => [s.path.slice(root.length + 1), s.reason])).toEqual([
      ['proj/dangling.jsonl', 'symlink not followed'],
      ['proj/linked.jsonl', 'symlink not followed'],
      ['proj/proj-loop', 'symlink not followed'],
      ['proj/sid2/subagents', 'symlink not followed'],
    ]);
  });

  it('a symlink to a file in the subagents folder is skipped', () => {
    const real = put('proj/sid1/subagents/agent-one.jsonl');
    symlinkSync(real, join(root, 'proj', 'sid1', 'subagents', 'agent-link.jsonl'));
    const d = discover(root);
    expect(d.files).toHaveLength(1);
    expect(d.skipped).toHaveLength(1);
    expect(d.skipped[0]?.path.endsWith('agent-link.jsonl')).toBe(true);
  });
});

describe('19 same file at two paths', () => {
  it('a hard link appears once, under the path that sorts first', () => {
    const a = put('projB/s1.jsonl');
    mkdirSync(join(root, 'projA'));
    linkSync(a, join(root, 'projA', 'copy.jsonl'));
    const d = discover(root);
    expect(d.files).toHaveLength(1);
    expect(d.files[0]?.path).toBe(join(root, 'projA', 'copy.jsonl'));
    expect(d.files[0]?.sessionId).toBe('copy');
    expect(new Set(d.files.map((f) => `${f.dev}:${f.ino}`)).size).toBe(d.files.length);
  });
});

describe('discover results', () => {
  it('lists files sorted by path with identity, size and mtime from lstat', () => {
    const p2 = put('b/z.jsonl', 'abcd\n');
    const p1 = put('a/y.jsonl', 'xy\n');
    const d = discover(root);
    expect(d.files.map((f) => f.path)).toEqual([p1, p2]);
    const s = statSync(p2);
    const f = d.files[1];
    expect(f).toMatchObject({ dev: s.dev, ino: s.ino, size: 5 });
    expect(f?.mtimeMs).toBe(Math.floor(s.mtimeMs));
  });

  it('a missing root is reported, not thrown', () => {
    expect(discover(join(base, 'absent'))).toEqual({
      files: [],
      aliases: [],
      skipped: [{ path: join(base, 'absent'), reason: 'root not found' }],
    });
  });

  it('a folder that cannot be read goes to skipped', () => {
    if (process.getuid?.() === 0) return;
    put('locked/s1.jsonl');
    put('open/s2.jsonl');
    chmodSync(join(root, 'locked'), 0o000);
    try {
      const d = discover(root);
      expect(d.files.map((f) => f.sessionId)).toEqual(['s2']);
      expect(d.skipped).toEqual([{ path: join(root, 'locked'), reason: 'permission denied' }]);
    } finally {
      chmodSync(join(root, 'locked'), 0o755);
    }
  });

  it('numbers that do not fit a safe integer are refused', () => {
    expect(toSafeNumber(12345n)).toBe(12345);
    expect(toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBeNull();
    expect(toSafeNumber(2n ** 63n)).toBeNull();
    expect(toSafeNumber(-1n)).toBeNull();
  });
});

describe('41 (partial) the source tree is not modified', () => {
  function snapshot(dir: string, out: Map<string, string> = new Map()): Map<string, string> {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) out.set(p, 'link');
      else if (e.isDirectory()) {
        out.set(p, `dir ${statSync(p).mtimeMs}`);
        snapshot(p, out);
      } else {
        const st = statSync(p);
        out.set(p, `${createHash('sha256').update(readFileSync(p)).digest('hex')} ${st.mtimeMs} ${st.size}`);
      }
    }
    return out;
  }

  it('checksums and mtimes are identical after discover and a full read', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ type: 'x', n: i, pad: 'é'.repeat(i % 17) }));
    put('proj/s1.jsonl', lines.join('\n') + '\n');
    put('proj/s1/subagents/agent-a.jsonl', lines.slice(0, 50).join('\n') + '\npartial');
    put('proj/s1/tool-results/out.txt', 'x'.repeat(5000));
    symlinkSync('proj', join(root, 'alias'));
    symlinkSync(join(root, 'proj'), join(root, 'proj', 'loop'));

    const before = snapshot(root);
    const d = discover(root);
    expect(d.files).toHaveLength(2);
    let total = 0;
    for (const f of d.files) {
      for await (const b of readLines(f.path, 0, 0, { blockBytes: 512, batchBytes: 1024 })) total += b.lines.length;
    }
    expect(total).toBe(350);
    const after = snapshot(root);
    expect(after).toEqual(before);
  });
});
