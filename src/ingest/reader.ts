// Incremental reader: decides what to read from a known file and reads only new complete lines.
// Source files are opened read only and without following a final symlink. Nothing here writes.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { SourceFileRow } from '../store/repo.ts';
import type { DiscoveredFile } from './discover.ts';

const KiB = 1024;
const MiB = 1024 * KiB;

// Head hash covers the first min(HEAD_BYTES, byte_offset) bytes, so appending to a small file
// does not change the hash that was stored for it.
export const HEAD_BYTES = 4 * KiB;

export function headLength(byteOffset: number): number {
  return Math.min(HEAD_BYTES, Math.max(0, byteOffset));
}

// SHA 256 hex of the first `length` bytes of the file. Fewer bytes are hashed if the file is shorter
// (the result then differs from a stored hash, which is the right outcome). Returns null when the
// file cannot be opened because it is gone or is now a symlink; other errors are thrown.
export async function headHash(path: string, length: number): Promise<string | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (isGone(err)) return null;
    throw err;
  }
  try {
    const buf = Buffer.alloc(Math.max(0, length));
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return createHash('sha256').update(buf.subarray(0, got)).digest('hex');
  } finally {
    await fh.close();
  }
}

function isGone(err: unknown): boolean {
  const c = (err as NodeJS.ErrnoException).code;
  // ELOOP: the path is now a symlink. It is never followed, so the file counts as gone.
  return c === 'ENOENT' || c === 'ENOTDIR' || c === 'ELOOP';
}

// ---------------------------------------------------------------- plan

export interface ReadPlan {
  action: 'new' | 'unchanged' | 'append' | 'reset';
  start: number;
  reason?: 'truncated' | 'replaced';
}

// Pure. `currentHead` is headHash(path, headLength(known.byteOffset)) of the file as it is now.
// It is only consulted when known.byteOffset > 0. A null there (file unreadable) counts as a mismatch,
// so the plan is a reset and the following read reports the file as missing.
// The status of the known row (active or deleted) does not matter: a deleted file seen again follows the same rules.
export function planRead(file: DiscoveredFile, known: SourceFileRow | undefined, currentHead: string | null): ReadPlan {
  if (known === undefined) return { action: 'new', start: 0 };
  if (file.size < known.byteOffset) return { action: 'reset', start: 0, reason: 'truncated' };
  if (known.byteOffset > 0 && (known.headHash === null || currentHead !== known.headHash)) {
    return { action: 'reset', start: 0, reason: 'replaced' };
  }
  if (file.size === known.byteOffset) return { action: 'unchanged', start: known.byteOffset };
  return { action: 'append', start: known.byteOffset };
}

// Active known rows whose (dev, ino) was not discovered.
export function missingFiles(known: SourceFileRow[], discovered: DiscoveredFile[]): SourceFileRow[] {
  const seen = new Set(discovered.map((f) => `${f.dev}:${f.ino}`));
  return known.filter((r) => r.status === 'active' && !seen.has(`${r.dev}:${r.ino}`));
}

// ---------------------------------------------------------------- reading

export interface ReadOptions {
  // A line longer than this many bytes (without its newline) is skipped, not buffered. Default 64 MiB.
  maxLineBytes?: number;
  // A batch ends on the first line boundary at or after this many consumed bytes. Default 8 MiB.
  batchBytes?: number;
  // Size of one read from disk. Default 1 MiB. Tests use small values.
  blockBytes?: number;
}

export interface LineBatch {
  // Non empty lines. lineNo is 1 based and counts empty lines. byteOffset is where the line starts in the file.
  lines: { text: string; lineNo: number; byteOffset: number }[];
  // Lines over maxLineBytes. length counts the line's bytes without the newline.
  oversized: { lineNo: number; byteOffset: number; length: number }[];
  // Offset of the byte after the last newline consumed so far. Store this as byte_offset.
  endOffset: number;
  // Number of lines consumed so far, empty and oversized ones included. Store this as lines_read.
  endLineNo: number;
  // Set only on the last batch when the file went away or got shorter while it was being read.
  // The batch still holds every complete line read before that point. Absent on a normal finish.
  stopped?: 'missing' | 'shrunk';
}

/**
 * Reads the complete lines of `path` from byte `start` up to the size the file had when the read began.
 *
 * `startLineNo` is the number of lines already consumed before `start` (the stored lines_read, 0 after a
 * reset), so the first line returned has lineNo startLineNo + 1.
 *
 * Completion: the generator ends after the last batch. If the file is gone (ENOENT) or shrinks while
 * reading, the final batch carries `stopped` ('missing' or 'shrunk'); an empty batch is yielded if nothing
 * else was pending. Other I/O errors (for example EACCES) are thrown.
 */
export async function* readLines(
  path: string,
  start: number,
  startLineNo: number,
  opts: ReadOptions = {},
): AsyncGenerator<LineBatch, void, undefined> {
  const maxLineBytes = opts.maxLineBytes ?? 64 * MiB;
  const batchBytes = opts.batchBytes ?? 8 * MiB;
  const blockBytes = opts.blockBytes ?? 1 * MiB;
  for (const [name, v] of [['maxLineBytes', maxLineBytes], ['batchBytes', batchBytes], ['blockBytes', blockBytes]] as const) {
    if (!Number.isSafeInteger(v) || v < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  if (!Number.isSafeInteger(start) || start < 0) throw new RangeError('start must be a non negative integer');

  let batch: Pick<LineBatch, 'lines' | 'oversized'> = { lines: [], oversized: [] };
  let batchStart = start; // offset where the current batch began
  let consumed = start; // offset after the last newline consumed
  let lineNo = startLineNo; // lines consumed so far
  const makeBatch = (stopped?: 'missing' | 'shrunk'): LineBatch => {
    const b: LineBatch = { ...batch, endOffset: consumed, endLineNo: lineNo };
    if (stopped !== undefined) b.stopped = stopped;
    batch = { lines: [], oversized: [] };
    batchStart = consumed;
    return b;
  };

  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (!isGone(err)) throw err;
    yield makeBatch('missing');
    return;
  }

  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      yield makeBatch('missing');
      return;
    }
    const limit = st.size;
    if (start > limit) {
      yield makeBatch('shrunk');
      return;
    }

    const buf = Buffer.allocUnsafe(Math.min(blockBytes, Math.max(1, limit - start)));
    let pos = start; // next file offset to read
    let lineStart = start; // file offset of the first byte of the line being assembled
    let pending: Buffer[] = []; // bytes of the unfinished line seen in earlier blocks (copies)
    let pendingLen = 0;
    let skipping = false; // the unfinished line is over maxLineBytes: count it, do not keep it
    let skipLen = 0;
    let stopped: 'shrunk' | undefined;

    while (pos < limit) {
      const want = Math.min(buf.length, limit - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead === 0) {
        stopped = 'shrunk';
        break;
      }
      const blockOffset = pos;
      pos += bytesRead;
      const view = buf.subarray(0, bytesRead);
      let i = 0;
      while (i < bytesRead) {
        const nl = view.indexOf(0x0a, i);
        if (nl === -1) {
          // No newline in the rest of this block: keep the bytes, or just count them once the line is too long.
          const segLen = bytesRead - i;
          if (skipping) {
            skipLen += segLen;
          } else if (pendingLen + segLen > maxLineBytes) {
            skipping = true;
            skipLen = pendingLen + segLen;
            pending = [];
            pendingLen = 0;
          } else {
            pending.push(Buffer.from(view.subarray(i)));
            pendingLen += segLen;
          }
          break;
        }

        const lineLen = (skipping ? skipLen : pendingLen) + (nl - i);
        lineNo++;
        if (lineLen > maxLineBytes) {
          batch.oversized.push({ lineNo, byteOffset: lineStart, length: lineLen });
        } else if (lineLen > 0) {
          let bytes = pending.length === 0 ? view.subarray(i, nl) : Buffer.concat([...pending, view.subarray(i, nl)], lineLen);
          if (bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, bytes.length - 1);
          if (bytes.length > 0) {
            // Decoded per line from whole bytes, so a character split across blocks is intact.
            batch.lines.push({ text: bytes.toString('utf8'), lineNo, byteOffset: lineStart });
          }
        }
        pending = [];
        pendingLen = 0;
        skipping = false;
        skipLen = 0;
        consumed = blockOffset + nl + 1;
        lineStart = consumed;
        i = nl + 1;

        if (consumed - batchStart >= batchBytes) yield makeBatch();
      }
    }

    // A trailing partial line (or an oversized line still without its newline) is not consumed.
    if (consumed > batchStart || stopped !== undefined) yield makeBatch(stopped);
  } finally {
    await fh.close();
  }
}
