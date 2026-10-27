import { createHash } from 'node:crypto';
import {
  appendFileSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { lstat, open as realOpen } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classify } from '../../src/ingest/classify.ts';
import { discover, type DiscoveredFile } from '../../src/ingest/discover.ts';
import {
  HEAD_BYTES,
  OPEN_RETRIES,
  OPEN_RETRY_MS,
  headHash,
  headLength,
  missingFiles,
  openNoFollow,
  planRead,
  readLines,
  type LineBatch,
  type OpenDeps,
  type ReadOptions,
} from '../../src/ingest/reader.ts';
import type { SourceFileRow } from '../../src/store/repo.ts';
import { mainCtx, removeTemp, SYMLINK_SKIP_REASON, symlinksWork } from './helpers.ts';

let base: string;
let root: string;
let file: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-reader-')));
  root = join(base, 'projects');
  mkdirSync(join(root, 'proj'), { recursive: true });
  file = join(root, 'proj', 'sess.jsonl');
});

afterEach(() => {
  removeTemp(base);
});

async function readAll(path: string, start = 0, lineNo = 0, opts: ReadOptions = {}): Promise<LineBatch[]> {
  const out: LineBatch[] = [];
  for await (const b of readLines(path, start, lineNo, opts)) out.push(b);
  return out;
}

function flat(batches: LineBatch[]) {
  return {
    lines: batches.flatMap((b) => b.lines),
    oversized: batches.flatMap((b) => b.oversized),
    endOffset: batches.at(-1)?.endOffset,
    endLineNo: batches.at(-1)?.endLineNo,
  };
}

function sha(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

function onlyFile(): DiscoveredFile {
  const f = discover(root).files[0];
  if (f === undefined) throw new Error('no file discovered');
  return f;
}

// What the ingest loop will store after a pass: offset, line count and the head hash for that offset.
async function stored(f: DiscoveredFile, endOffset: number, endLineNo: number): Promise<SourceFileRow> {
  return {
    id: 1,
    dev: f.dev,
    ino: f.ino,
    path: f.path,
    projectDir: f.projectDir,
    sessionId: f.sessionId,
    agentId: f.agentId,
    isSubagent: f.isSubagent,
    size: f.size,
    mtimeMs: f.mtimeMs,
    byteOffset: endOffset,
    linesRead: endLineNo,
    headHash: await headHash(f.path, headLength(endOffset)),
    status: 'active',
    firstSeenAt: 1,
    lastIngestedAt: 1,
    deletedDetectedAt: null,
  };
}

async function planNow(known: SourceFileRow | undefined) {
  const f = onlyFile();
  const head = known === undefined ? null : await headHash(f.path, headLength(known.byteOffset));
  return planRead(f, known, head);
}

describe('headHash', () => {
  it('hashes the first length bytes and is null for a missing file', async () => {
    writeFileSync(file, 'hello world\n');
    expect(await headHash(file, 5)).toBe(sha('hello'));
    expect(await headHash(file, 0)).toBe(sha(''));
    expect(await headHash(file, 1000)).toBe(sha('hello world\n'));
    expect(await headHash(join(root, 'proj', 'nope.jsonl'), 5)).toBeNull();
    expect(headLength(10)).toBe(10);
    expect(headLength(1_000_000)).toBe(HEAD_BYTES);
  });

  it.skipIf(!symlinksWork)(`does not follow a symlink${symlinksWork ? '' : ` (${SYMLINK_SKIP_REASON})`}`, async () => {
    writeFileSync(file, 'abc\n');
    const link = join(root, 'proj', 'link.jsonl');
    symlinkSync(file, link);
    expect(await headHash(link, 3)).toBeNull();
  });
});

describe('planRead (pure)', () => {
  const f: DiscoveredFile = {
    path: '/x/s.jsonl',
    dev: 1n,
    ino: 2n,
    size: 500,
    mtimeMs: 1,
    projectDir: 'p',
    sessionId: 's',
    agentId: null,
    isSubagent: false,
  };
  const known: SourceFileRow = {
    id: 1,
    dev: 1n,
    ino: 2n,
    path: '/x/s.jsonl',
    projectDir: 'p',
    sessionId: 's',
    agentId: null,
    isSubagent: false,
    size: 400,
    mtimeMs: 1,
    byteOffset: 400,
    linesRead: 8,
    headHash: 'h1',
    status: 'active',
    firstSeenAt: 1,
    lastIngestedAt: 1,
    deletedDetectedAt: null,
  };

  it('unknown file is new from 0', () => {
    expect(planRead(f, undefined, null)).toEqual({ action: 'new', start: 0 });
  });
  it('smaller than the stored offset is a truncation', () => {
    expect(planRead({ ...f, size: 399 }, known, 'h1')).toEqual({ action: 'reset', start: 0, reason: 'truncated' });
  });
  it('a different head is a replacement, at the same size or a larger one', () => {
    expect(planRead({ ...f, size: 400 }, known, 'h2')).toEqual({ action: 'reset', start: 0, reason: 'replaced' });
    expect(planRead(f, known, 'h2')).toEqual({ action: 'reset', start: 0, reason: 'replaced' });
  });
  it('an unreadable head (null) or a missing stored hash counts as replaced', () => {
    expect(planRead(f, known, null).reason).toBe('replaced');
    expect(planRead(f, { ...known, headHash: null }, 'h1').reason).toBe('replaced');
  });
  it('same size and head is unchanged', () => {
    expect(planRead({ ...f, size: 400 }, known, 'h1')).toEqual({ action: 'unchanged', start: 400 });
  });
  it('larger with the same head appends from the stored offset', () => {
    expect(planRead(f, known, 'h1')).toEqual({ action: 'append', start: 400 });
  });
  it('a known row with nothing consumed yet reads from 0 without a head check', () => {
    const fresh = { ...known, byteOffset: 0, linesRead: 0, headHash: null };
    expect(planRead(f, fresh, null)).toEqual({ action: 'append', start: 0 });
    expect(planRead({ ...f, size: 0 }, fresh, null)).toEqual({ action: 'unchanged', start: 0 });
  });
  it('a deleted row that reappears follows the same rules', () => {
    const gone = { ...known, status: 'deleted' as const, deletedDetectedAt: 5 };
    expect(planRead(f, gone, 'h1')).toEqual({ action: 'append', start: 400 });
    expect(planRead({ ...f, size: 10 }, gone, 'h1').reason).toBe('truncated');
  });
});

describe('missingFiles', () => {
  it('returns active known rows whose identity is not discovered', () => {
    const mk = (ino: bigint, status: 'active' | 'deleted'): SourceFileRow => ({
      id: Number(ino),
      dev: 9n,
      ino,
      path: `/p/${ino}`,
      projectDir: 'p',
      sessionId: 's',
      agentId: null,
      isSubagent: false,
      size: 0,
      mtimeMs: 0,
      byteOffset: 0,
      linesRead: 0,
      headHash: null,
      status,
      firstSeenAt: 1,
      lastIngestedAt: null,
      deletedDetectedAt: null,
    });
    const d = (ino: bigint, dev = 9n): DiscoveredFile => ({
      path: `/q/${ino}`,
      dev,
      ino,
      size: 0,
      mtimeMs: 0,
      projectDir: 'p',
      sessionId: 's',
      agentId: null,
      isSubagent: false,
    });
    const known = [mk(1n, 'active'), mk(2n, 'active'), mk(3n, 'deleted'), mk(4n, 'active')];
    // ino 1 moved path (still discovered by identity), ino 4 only exists on another device
    expect(missingFiles(known, [d(1n), d(4n, 8n)]).map((r) => r.ino)).toEqual([2n, 4n]);
    expect(missingFiles(known, [])).toHaveLength(3);
  });
});

describe('15 partial last line', () => {
  it('is not consumed, then consumed exactly once with continuing line numbers', async () => {
    writeFileSync(file, 'one\ntwo\nthr');
    const first = flat(await readAll(file));
    expect(first.lines.map((l) => l.text)).toEqual(['one', 'two']);
    expect(first.endOffset).toBe(8);
    expect(first.endLineNo).toBe(2);

    // still incomplete: nothing consumed, nothing yielded
    expect(await readAll(file, 8, 2)).toEqual([]);

    appendFileSync(file, 'ee\nfour\n');
    const second = flat(await readAll(file, 8, 2));
    expect(second.lines).toEqual([
      { text: 'three', lineNo: 3, byteOffset: 8 },
      { text: 'four', lineNo: 4, byteOffset: 14 },
    ]);
    expect(second.endOffset).toBe(19);
    expect(second.endLineNo).toBe(4);

    expect(await readAll(file, 19, 4)).toEqual([]);
  });
});

describe('16 truncation', () => {
  it('a file smaller than the stored offset resets and rereads from 0', async () => {
    const text = Array.from({ length: 50 }, (_, i) => `line number ${i}`).join('\n') + '\n';
    writeFileSync(file, text);
    const first = flat(await readAll(file));
    const known = await stored(onlyFile(), first.endOffset ?? 0, first.endLineNo ?? 0);
    expect(known.byteOffset).toBe(text.length);

    writeFileSync(file, 'line number 0\nline number 1\n'); // same inode, now shorter
    const plan = await planNow(known);
    expect(plan).toEqual({ action: 'reset', start: 0, reason: 'truncated' });

    const again = flat(await readAll(file, plan.start, 0));
    expect(again.lines.map((l) => l.text)).toEqual(['line number 0', 'line number 1']);
    expect(again.endLineNo).toBe(2);
  });
});

describe('17 replaced in place', () => {
  it('same size with different first bytes resets as replaced', async () => {
    const a = 'A'.repeat(60) + '\n' + 'tail\n';
    writeFileSync(file, a);
    const first = flat(await readAll(file));
    const known = await stored(onlyFile(), first.endOffset ?? 0, first.endLineNo ?? 0);

    writeFileSync(file, 'B' + a.slice(1)); // same size, same inode, first byte changed
    expect(statSync(file).size).toBe(a.length);
    expect(await planNow(known)).toEqual({ action: 'reset', start: 0, reason: 'replaced' });
  });

  it('a larger file with different first bytes resets as replaced', async () => {
    writeFileSync(file, 'old content here\nmore\n');
    const first = flat(await readAll(file));
    const known = await stored(onlyFile(), first.endOffset ?? 0, first.endLineNo ?? 0);
    writeFileSync(file, 'new content here\nmore\n' + 'x'.repeat(5000) + '\n');
    expect(await planNow(known)).toEqual({ action: 'reset', start: 0, reason: 'replaced' });
  });

  it('an append to a file larger than 4 KiB is an append', async () => {
    const line = 'x'.repeat(99) + '\n';
    writeFileSync(file, line.repeat(100)); // 10,000 bytes
    const first = flat(await readAll(file));
    const known = await stored(onlyFile(), first.endOffset ?? 0, first.endLineNo ?? 0);
    expect(known.byteOffset).toBe(10_000);
    appendFileSync(file, line);
    expect(await planNow(known)).toEqual({ action: 'append', start: 10_000 });
  });

  it('a 100 byte file that grows to 10,000 bytes by appending is an append, not a reset', async () => {
    const line = 'y'.repeat(49) + '\n'; // 50 bytes
    writeFileSync(file, line.repeat(2));
    const first = flat(await readAll(file));
    expect(first.endOffset).toBe(100);
    const known = await stored(onlyFile(), 100, first.endLineNo ?? 0);

    appendFileSync(file, line.repeat(198));
    expect(statSync(file).size).toBe(10_000);
    const plan = await planNow(known);
    expect(plan).toEqual({ action: 'append', start: 100 });

    const rest = flat(await readAll(file, plan.start, known.linesRead));
    expect(rest.lines).toHaveLength(198);
    expect(rest.lines[0]?.lineNo).toBe(3);
    expect(rest.endOffset).toBe(10_000);
    expect(rest.endLineNo).toBe(200);
  });

  it('unchanged file with the same bytes is unchanged', async () => {
    writeFileSync(file, 'abc\ndef\n');
    const first = flat(await readAll(file));
    const known = await stored(onlyFile(), first.endOffset ?? 0, first.endLineNo ?? 0);
    expect(await planNow(known)).toEqual({ action: 'unchanged', start: 8 });
  });
});

describe('reading rules', () => {
  it('splits on LF, strips one trailing CR, skips empty lines but counts them', async () => {
    writeFileSync(file, 'a\r\n\nb\r\r\n\r\nc\n');
    const r = flat(await readAll(file));
    expect(r.lines).toEqual([
      { text: 'a', lineNo: 1, byteOffset: 0 },
      { text: 'b\r', lineNo: 3, byteOffset: 4 },
      { text: 'c', lineNo: 5, byteOffset: 10 },
    ]);
    expect(r.endLineNo).toBe(5);
    expect(r.endOffset).toBe(12);
  });

  it('starts at a given offset and line number', async () => {
    writeFileSync(file, 'aa\nbb\ncc\n');
    const r = flat(await readAll(file, 3, 10));
    expect(r.lines).toEqual([
      { text: 'bb', lineNo: 11, byteOffset: 3 },
      { text: 'cc', lineNo: 12, byteOffset: 6 },
    ]);
    expect(r.endLineNo).toBe(12);
  });

  it('an empty file or a start at the end yields nothing', async () => {
    writeFileSync(file, '');
    expect(await readAll(file)).toEqual([]);
    writeFileSync(file, 'abc\n');
    expect(await readAll(file, 4, 1)).toEqual([]);
  });

  it('does not read bytes that were appended after the read began', async () => {
    writeFileSync(file, 'one\ntwo\n');
    const out: LineBatch[] = [];
    for await (const b of readLines(file, 0, 0, { batchBytes: 1, blockBytes: 4 })) {
      if (out.length === 0) appendFileSync(file, 'three\n');
      out.push(b);
    }
    expect(flat(out).lines.map((l) => l.text)).toEqual(['one', 'two']);
    const next = flat(await readAll(file, flat(out).endOffset, flat(out).endLineNo));
    expect(next.lines.map((l) => l.text)).toEqual(['three']);
  });

  it('rejects invalid options', async () => {
    writeFileSync(file, 'a\n');
    await expect(readAll(file, 0, 0, { blockBytes: 0 })).rejects.toThrow(RangeError);
    await expect(readAll(file, -1, 0)).rejects.toThrow(RangeError);
  });
});

describe('multibyte UTF 8 across block boundaries', () => {
  const text = 'héllo wörld 日本語 \u{1f600} end';

  it('decodes every line intact for any block size', async () => {
    const content = `${text}\nsecond ${text}\n${text}\n`;
    writeFileSync(file, content);
    for (let block = 1; block <= 12; block++) {
      const r = flat(await readAll(file, 0, 0, { blockBytes: block }));
      expect(r.lines.map((l) => l.text)).toEqual([text, `second ${text}`, text]);
      expect(r.endOffset).toBe(Buffer.byteLength(content));
    }
  });

  it('keeps a split character when the line completes in a later pass', async () => {
    const bytes = Buffer.from(`ok\n${text}\n`);
    const cut = bytes.indexOf(0xe6) + 1; // inside the first byte sequence of the Japanese text
    writeFileSync(file, bytes.subarray(0, cut));
    const a = flat(await readAll(file, 0, 0, { blockBytes: 5 }));
    expect(a.lines.map((l) => l.text)).toEqual(['ok']);
    appendFileSync(file, bytes.subarray(cut));
    const b = flat(await readAll(file, a.endOffset, a.endLineNo, { blockBytes: 5 }));
    expect(b.lines.map((l) => l.text)).toEqual([text]);
  });
});

describe('oversized lines', () => {
  it('a 5 KiB line in the middle is reported and the lines around it are read', async () => {
    const big = 'z'.repeat(5 * 1024);
    const content = `first\nsecond\n${big}\nfourth\nfifth\n`;
    writeFileSync(file, content);
    for (const block of [7, 1000, 1024 * 1024]) {
      const r = flat(await readAll(file, 0, 0, { maxLineBytes: 1024, blockBytes: block }));
      expect(r.lines.map((l) => [l.text, l.lineNo, l.byteOffset])).toEqual([
        ['first', 1, 0],
        ['second', 2, 6],
        ['fourth', 4, 13 + big.length + 1],
        ['fifth', 5, 13 + big.length + 1 + 7],
      ]);
      expect(r.oversized).toEqual([{ lineNo: 3, byteOffset: 13, length: big.length }]);
      expect(r.endOffset).toBe(Buffer.byteLength(content));
      expect(r.endLineNo).toBe(5);
    }
  });

  it('a line of exactly maxLineBytes is kept', async () => {
    writeFileSync(file, `${'q'.repeat(1024)}\n${'q'.repeat(1025)}\n`);
    const r = flat(await readAll(file, 0, 0, { maxLineBytes: 1024, blockBytes: 100 }));
    expect(r.lines).toHaveLength(1);
    expect(r.oversized).toEqual([{ lineNo: 2, byteOffset: 1025, length: 1025 }]);
  });

  it('an oversized line without its newline stops the batch before it', async () => {
    const big = 'z'.repeat(5 * 1024);
    writeFileSync(file, `ok\n${big}`);
    for (const block of [7, 1024 * 1024]) {
      const r = flat(await readAll(file, 0, 0, { maxLineBytes: 1024, blockBytes: block }));
      expect(r.lines.map((l) => l.text)).toEqual(['ok']);
      expect(r.oversized).toEqual([]);
      expect(r.endOffset).toBe(3);
      expect(r.endLineNo).toBe(1);
    }
    // once the line ends it is reported exactly once, with the right position
    appendFileSync(file, '\nnext\n');
    const r2 = flat(await readAll(file, 3, 1, { maxLineBytes: 1024 }));
    expect(r2.oversized).toEqual([{ lineNo: 2, byteOffset: 3, length: big.length }]);
    expect(r2.lines).toEqual([{ text: 'next', lineNo: 3, byteOffset: 3 + big.length + 1 }]);
  });

  it('an oversized line at the very start with no newline consumes nothing', async () => {
    writeFileSync(file, 'z'.repeat(3000));
    expect(await readAll(file, 0, 0, { maxLineBytes: 1024 })).toEqual([]);
  });
});

describe('batches', () => {
  it('concatenated batches hold every complete line once, in order, with exact offsets', async () => {
    const parts: string[] = [];
    for (let i = 0; i < 400; i++) {
      if (i % 37 === 5) parts.push(''); // empty line
      parts.push(JSON.stringify({ i, s: 'café 日本'.repeat(i % 9) }) + (i % 53 === 0 ? '\r' : ''));
    }
    const content = parts.join('\n') + '\n' + '{"partial":';
    writeFileSync(file, content);
    const buf = readFileSync(file);

    const batches = await readAll(file, 0, 0, { batchBytes: 700, blockBytes: 97 });
    expect(batches.length).toBeGreaterThan(10);

    const expected = parts.map((text, idx) => ({ text, lineNo: idx + 1 })).filter((l) => l.text !== '');
    const got = batches.flatMap((b) => b.lines);
    expect(got.map((l) => l.lineNo)).toEqual(expected.map((l) => l.lineNo));
    for (const l of got) {
      const raw = buf.subarray(l.byteOffset, l.byteOffset + Buffer.byteLength(l.text));
      expect(raw.toString('utf8')).toBe(l.text);
      expect(l.byteOffset === 0 || buf[l.byteOffset - 1] === 0x0a).toBe(true);
    }
    expect(got.map((l) => l.text)).toEqual(expected.map((l) => l.text.replace(/\r$/, '')));

    // every batch ends right after a newline, ends are increasing, every batch but the last holds at
    // least batchBytes, and counts agree
    let prevEnd = 0;
    let seen = 0;
    for (const [n, b] of batches.entries()) {
      expect(buf[b.endOffset - 1]).toBe(0x0a);
      expect(b.endOffset).toBeGreaterThan(prevEnd);
      if (n < batches.length - 1) expect(b.endOffset - prevEnd).toBeGreaterThanOrEqual(700);
      prevEnd = b.endOffset;
      seen += b.lines.length;
      expect(b.stopped).toBeUndefined();
    }
    expect(seen).toBe(got.length);
    const last = batches.at(-1);
    expect(last?.endLineNo).toBe(parts.length);
    expect(last?.endOffset).toBe(Buffer.byteLength(content) - '{"partial":'.length);
  });

  it('each batch can be committed on its own: restarting at a batch end gives the rest', async () => {
    const content = Array.from({ length: 60 }, (_, i) => `row ${i}`).join('\n') + '\n';
    writeFileSync(file, content);
    const batches = await readAll(file, 0, 0, { batchBytes: 40, blockBytes: 16 });
    const cut = batches[2];
    if (cut === undefined) throw new Error('expected at least 3 batches');
    const rest = flat(await readAll(file, cut.endOffset, cut.endLineNo, { batchBytes: 40, blockBytes: 16 }));
    const head = batches.slice(0, 3).flatMap((b) => b.lines);
    expect([...head, ...rest.lines].map((l) => l.text)).toEqual(content.trim().split('\n'));
  });
});

describe('a file that goes away or shrinks while reading', () => {
  it('a missing file yields one empty batch marked missing', async () => {
    const r = await readAll(join(root, 'proj', 'gone.jsonl'), 12, 3);
    expect(r).toEqual([{ lines: [], oversized: [], endOffset: 12, endLineNo: 3, stopped: 'missing' }]);
  });

  it.skipIf(!symlinksWork)(`a symlink at the path is treated as missing, never followed${symlinksWork ? '' : ` (${SYMLINK_SKIP_REASON})`}`, async () => {
    writeFileSync(file, 'a\nb\n');
    const link = join(root, 'proj', 'link.jsonl');
    symlinkSync(file, link);
    const r = await readAll(link);
    expect(r).toHaveLength(1);
    expect(r[0]?.stopped).toBe('missing');
    expect(r[0]?.lines).toEqual([]);
  });

  it('a file shorter than the start offset is marked shrunk', async () => {
    writeFileSync(file, 'a\n');
    const r = await readAll(file, 50, 7);
    expect(r).toEqual([{ lines: [], oversized: [], endOffset: 50, endLineNo: 7, stopped: 'shrunk' }]);
  });

  it('truncation between batches keeps the complete lines already read and marks shrunk', async () => {
    const content = Array.from({ length: 40 }, (_, i) => `row ${i}`).join('\n') + '\n';
    writeFileSync(file, content);
    const out: LineBatch[] = [];
    for await (const b of readLines(file, 0, 0, { batchBytes: 20, blockBytes: 16 })) {
      out.push(b);
      if (out.length === 1) truncateSync(file, b.endOffset); // file now ends where batch 1 ended
    }
    const last = out.at(-1);
    expect(last?.stopped).toBe('shrunk');
    expect(out.slice(0, -1).every((b) => b.stopped === undefined)).toBe(true);
    const all = flat(out);
    expect(all.lines.map((l) => l.text)).toEqual(content.split('\n').slice(0, all.lines.length));
    expect(all.lines.length).toBeGreaterThan(0);
    expect(all.endOffset).toBeLessThan(Buffer.byteLength(content));
  });

  it('breaking out of the loop early closes the file', async () => {
    writeFileSync(file, Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n') + '\n');
    for await (const b of readLines(file, 0, 0, { batchBytes: 10, blockBytes: 8 })) {
      expect(b.lines.length).toBeGreaterThan(0);
      break;
    }
    // the file can still be removed and read again without trouble
    expect(flat(await readAll(file)).lines).toHaveLength(100);
  });
});

describe('CRLF line endings', () => {
  const rows = ['{"a":1}', '{"b":"é"}', '{"c":3}'];

  it('JSON.parse already tolerates the carriage return, the reader still trims it so text and lengths are the same', () => {
    expect(JSON.parse('{"a":1}\r')).toEqual({ a: 1 });
  });

  it('a line ending in CRLF gives the same text and line numbers as one ending in LF, and the byte offsets count the CR', async () => {
    writeFileSync(file, rows.join('\n') + '\n');
    const lf = flat(await readAll(file));
    writeFileSync(file, rows.join('\r\n') + '\r\n');
    const crlf = flat(await readAll(file));
    expect(crlf.lines.map((l) => l.text)).toEqual(lf.lines.map((l) => l.text));
    expect(crlf.lines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
    expect(crlf.lines.map((l) => l.byteOffset)).toEqual([0, 9, 9 + Buffer.byteLength(rows[1] as string) + 2]);
    expect(crlf.endOffset).toBe(Buffer.byteLength(rows.join('\r\n')) + 2);
    expect(crlf.endLineNo).toBe(3);
  });

  it('is the same when the CR and the LF fall in different blocks', async () => {
    writeFileSync(file, rows.join('\r\n') + '\r\n');
    for (const blockBytes of [1, 2, 3, 5, 8]) {
      const r = flat(await readAll(file, 0, 0, { blockBytes, batchBytes: 4 }));
      expect(r.lines.map((l) => l.text), `block ${blockBytes}`).toEqual(rows);
    }
  });

  it('classifies a CRLF line exactly like the same line with LF', async () => {
    const line = '{"type":"user","uuid":"u1","sessionId":"s1","timestamp":"2026-10-01T09:00:00.000Z","cwd":"C:\\Users\\me\\My Project","message":{"role":"user","content":"x"}}';
    writeFileSync(file, line + '\r\n');
    const [read] = flat(await readAll(file)).lines;
    expect(read?.text).toBe(line);
    expect(classify(read?.text ?? '', mainCtx)).toEqual(classify(line, mainCtx));
  });

  it('a blank CRLF line counts as an empty line, and a last line without its LF waits even when its CR is there', async () => {
    writeFileSync(file, 'x\r\n\r\ny\r');
    const r = flat(await readAll(file));
    expect(r.lines).toEqual([{ text: 'x', lineNo: 1, byteOffset: 0 }]);
    expect(r.endLineNo).toBe(2);
    expect(r.endOffset).toBe(5);
    appendFileSync(file, '\n');
    const more = flat(await readAll(file, r.endOffset ?? 0, r.endLineNo ?? 0));
    expect(more.lines).toEqual([{ text: 'y', lineNo: 3, byteOffset: 5 }]);
  });
});

describe('a file Windows has locked', () => {
  const failWith = (code: string): Error => Object.assign(new Error(`${code}: simulated`), { code });

  // `codes` are the errors the first opens fail with; later opens work. Sleeps are recorded, not waited for.
  function lockedDeps(codes: string[]): { deps: OpenDeps; sleeps: number[]; opens: () => number } {
    const sleeps: number[] = [];
    let opens = 0;
    const deps: OpenDeps = {
      lstat: (p) => lstat(p, { bigint: true }),
      open: async (p, flags) => {
        opens += 1;
        const c = codes[opens - 1];
        if (c !== undefined) throw failWith(c);
        return realOpen(p, flags);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };
    return { deps, sleeps, opens: () => opens };
  }

  it('retries EBUSY, EPERM and EACCES, 50 ms apart, then reads normally', async () => {
    expect([OPEN_RETRIES, OPEN_RETRY_MS]).toEqual([3, 50]);
    writeFileSync(file, 'a\nb\n');
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const t = lockedDeps([code, code]);
      const r = flat(await readAll(file, 0, 0, { openDeps: t.deps }));
      expect(r.lines.map((l) => l.text), code).toEqual(['a', 'b']);
      expect(t.sleeps, code).toEqual([50, 50]);
      expect(t.opens(), code).toBe(3);
    }
  });

  it('headHash retries the same way', async () => {
    writeFileSync(file, 'hello\n');
    const t = lockedDeps(['EBUSY']);
    expect(await headHash(file, 5, t.deps)).toBe(sha('hello'));
    expect(t.sleeps).toEqual([50]);
  });

  it('gives up after three retries and throws the last error, so the caller records the read error as before', async () => {
    writeFileSync(file, 'a\n');
    const t = lockedDeps(['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY']);
    await expect(readAll(file, 0, 0, { openDeps: t.deps })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(t.opens()).toBe(1 + OPEN_RETRIES);
    expect(t.sleeps).toEqual([50, 50, 50]);
  });

  it('does not retry other errors, and a vanished file is missing, not an error', async () => {
    writeFileSync(file, 'a\n');
    const eio = lockedDeps(['EIO']);
    await expect(readAll(file, 0, 0, { openDeps: eio.deps })).rejects.toMatchObject({ code: 'EIO' });
    expect(eio.sleeps).toEqual([]);
    const gone = lockedDeps(['ENOENT']);
    const r = await readAll(file, 0, 0, { openDeps: gone.deps });
    expect(r[0]?.stopped).toBe('missing');
    expect(gone.sleeps).toEqual([]);
  });
});

describe('the open never follows a symlink, on any system', () => {
  const never = async (): Promise<void> => undefined;

  it('refuses a path that lstat reports as a symlink, without opening it', async () => {
    let opened = 0;
    const deps: OpenDeps = {
      lstat: async () => ({ dev: 1n, ino: 2n, isSymbolicLink: () => true }),
      open: async (p, flags) => {
        opened += 1;
        return realOpen(p, flags);
      },
      sleep: never,
    };
    writeFileSync(file, 'abc\n');
    expect(await openNoFollow(file, deps)).toBeNull();
    expect(await headHash(file, 3, deps)).toBeNull();
    expect((await readAll(file, 0, 0, { openDeps: deps }))[0]?.stopped).toBe('missing');
    expect(opened).toBe(0);
  });

  it('treats a handle that is not the file lstat saw as missing, and accepts the same file', async () => {
    writeFileSync(file, 'abc\n');
    const seen = await lstat(file, { bigint: true });
    const withIdentity = (dev: bigint, ino: bigint): OpenDeps => ({
      lstat: async () => ({ dev, ino, isSymbolicLink: () => false }),
      open: (p, flags) => realOpen(p, flags),
      sleep: never,
    });
    const otherIno = withIdentity(seen.dev, seen.ino + 1n);
    expect(await openNoFollow(file, otherIno)).toBeNull();
    expect(await headHash(file, 3, otherIno)).toBeNull();
    expect((await readAll(file, 0, 0, { openDeps: otherIno }))[0]?.stopped).toBe('missing');
    expect(await openNoFollow(file, withIdentity(seen.dev + 1n, seen.ino))).toBeNull();
    const same = await openNoFollow(file, withIdentity(seen.dev, seen.ino));
    expect(same).not.toBeNull();
    await same?.close();
  });

  it('compares ids above 2^53 exactly (they differ only in the low bits)', async () => {
    writeFileSync(file, 'abc\n');
    const seen = await lstat(file, { bigint: true });
    const high = (1n << 60n) + 1n;
    // The file's real id is small, so a lstat id that only differs in low bits of a huge number must not match it.
    const deps: OpenDeps = { lstat: async () => ({ dev: seen.dev, ino: high, isSymbolicLink: () => false }), open: (p, f) => realOpen(p, f), sleep: never };
    expect(await openNoFollow(file, deps)).toBeNull();
  });

  it.skipIf(!symlinksWork)(`on a system without O_NOFOLLOW the identity check alone refuses a link swapped in after the lstat${symlinksWork ? '' : ` (${SYMLINK_SKIP_REASON})`}`, async () => {
    writeFileSync(file, 'abc\n');
    const other = join(root, 'proj', 'other.jsonl');
    writeFileSync(other, 'zzz\n');
    const link = join(root, 'proj', 'swapped.jsonl');
    symlinkSync(file, link);
    // lstat saw a regular file (the other one) before the path was swapped for a link; open follows the link, as on Windows.
    const o = await lstat(other, { bigint: true });
    const deps: OpenDeps = {
      lstat: async () => ({ dev: o.dev, ino: o.ino, isSymbolicLink: () => false }),
      open: (p) => realOpen(p, constants.O_RDONLY),
      sleep: never,
    };
    expect(await openNoFollow(link, deps)).toBeNull();
    expect(await headHash(link, 3, deps)).toBeNull();
  });
});
