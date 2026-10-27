// Finds Claude Code transcript files under the projects root. Read only, synchronous.
//
// Rules:
// - A symlink is never followed, to a folder or to a file, at any depth. Symlinks directly under the root
//   are recorded as aliases (name and the link target as written). Every other symlink met while listing
//   a folder goes to `skipped`.
// - Layout read: <root>/<project>/<file> and <root>/<project>/<sid>/subagents/<file>. Nothing deeper.
// - A file is identified by (dev, ino). One file reached through two paths (hard link) appears once.
import { lstatSync, readdirSync, readlinkSync, type BigIntStats, type Dirent } from 'node:fs';
import { join } from 'node:path';

export interface DiscoveredFile {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  // Folder name directly under the root.
  projectDir: string;
  sessionId: string;
  agentId: string | null;
  isSubagent: boolean;
}

export interface Discovery {
  files: DiscoveredFile[];
  aliases: { aliasDir: string; targetDir: string }[];
  skipped: { path: string; reason: string }[];
}

export interface ParsedName {
  sessionId: string;
  agentId: string | null;
  isSubagent: boolean;
}

// Top level forms: <sid>.jsonl, <sid>.orphaned-<ts>-<suffix>.jsonl, <sid>.jsonl.superseded-<ts>.
// The session id never contains a dot, so the first dot ends it.
const SUPERSEDED = /^([^.]+)\.jsonl\.superseded-.+$/;
const ORPHANED = /^([^.]+)\.orphaned-.+\.jsonl$/;
const PLAIN = /^([^.]+)\.jsonl$/;
const SUBAGENT = /^agent-(.+)\.jsonl$/;

// Returns null for any name that is not a transcript.
export function parseTopLevelName(name: string): ParsedName | null {
  const m = SUPERSEDED.exec(name) ?? ORPHANED.exec(name) ?? PLAIN.exec(name);
  const sid = m?.[1];
  if (sid === undefined) return null;
  return { sessionId: sid, agentId: null, isSubagent: false };
}

// `sid` is the name of the folder that holds `subagents/`.
export function parseSubagentName(sid: string, name: string): ParsedName | null {
  const agentId = SUBAGENT.exec(name)?.[1];
  if (agentId === undefined) return null;
  return { sessionId: sid, agentId, isSubagent: true };
}

function code(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
}

// A folder or file that vanished (or changed kind) between listing and inspecting is not worth a record.
function isVanished(c: string): boolean {
  return c === 'ENOENT' || c === 'ENOTDIR';
}

function reasonFor(err: unknown): string {
  const c = code(err);
  if (c === 'EACCES' || c === 'EPERM') return 'permission denied';
  return `error ${c}`;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// A dev or ino that does not fit a JavaScript integer exactly cannot be stored, so it is refused.
export function toSafeNumber(n: bigint): number | null {
  return n >= 0n && n <= MAX_SAFE ? Number(n) : null;
}

type Skipped = Discovery['skipped'][number];

interface State {
  byIdentity: Map<string, DiscoveredFile>;
  aliases: Discovery['aliases'];
  skipped: Skipped[];
}

function readdirSafe(dir: string, st: State): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!isVanished(code(err))) st.skipped.push({ path: dir, reason: reasonFor(err) });
    return null;
  }
}

function lstatSafe(path: string, st: State): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (err) {
    if (!isVanished(code(err))) st.skipped.push({ path, reason: reasonFor(err) });
    return null;
  }
}

function addFile(path: string, parsed: ParsedName, projectDir: string, st: State): void {
  const s = lstatSafe(path, st);
  if (s === null) return;
  // The entry may have been swapped for something else since readdir. Only regular files count.
  if (s.isSymbolicLink()) {
    st.skipped.push({ path, reason: 'symlink not followed' });
    return;
  }
  if (!s.isFile()) return;
  const dev = toSafeNumber(s.dev);
  const ino = toSafeNumber(s.ino);
  const size = toSafeNumber(s.size);
  if (dev === null || ino === null || size === null) {
    st.skipped.push({ path, reason: 'inode too large' });
    return;
  }
  const file: DiscoveredFile = {
    path,
    dev,
    ino,
    size,
    mtimeMs: Number(s.mtimeMs),
    projectDir,
    sessionId: parsed.sessionId,
    agentId: parsed.agentId,
    isSubagent: parsed.isSubagent,
  };
  const key = `${dev}:${ino}`;
  const prior = st.byIdentity.get(key);
  // Same file through two paths: keep the path that sorts first.
  if (prior === undefined || file.path < prior.path) st.byIdentity.set(key, file);
}

function scanSubagents(projectPath: string, projectDir: string, sid: string, st: State): void {
  const dir = join(projectPath, sid, 'subagents');
  // lstat, not stat: a symlinked subagents folder must be reported, never entered.
  const s = lstatSafe(dir, st);
  if (s === null) return;
  if (s.isSymbolicLink()) {
    st.skipped.push({ path: dir, reason: 'symlink not followed' });
    return;
  }
  if (!s.isDirectory()) return;
  const entries = readdirSafe(dir, st);
  if (entries === null) return;
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isSymbolicLink()) {
      st.skipped.push({ path, reason: 'symlink not followed' });
      continue;
    }
    if (e.isDirectory()) continue;
    const parsed = parseSubagentName(sid, e.name);
    if (parsed !== null) addFile(path, parsed, projectDir, st);
  }
}

function scanProject(root: string, projectDir: string, st: State): void {
  const projectPath = join(root, projectDir);
  const entries = readdirSafe(projectPath, st);
  if (entries === null) return;
  for (const e of entries) {
    const path = join(projectPath, e.name);
    if (e.isSymbolicLink()) {
      st.skipped.push({ path, reason: 'symlink not followed' });
      continue;
    }
    if (e.isDirectory()) {
      scanSubagents(projectPath, projectDir, e.name, st);
      continue;
    }
    const parsed = parseTopLevelName(e.name);
    if (parsed !== null) addFile(path, parsed, projectDir, st);
  }
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function discover(root: string): Discovery {
  const st: State = { byIdentity: new Map(), aliases: [], skipped: [] };
  let top: Dirent[];
  try {
    top = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    // A missing root is a normal first run state. It is reported, never thrown.
    const reason = isVanished(code(err)) ? 'root not found' : reasonFor(err);
    return { files: [], aliases: [], skipped: [{ path: root, reason }] };
  }
  for (const e of top) {
    if (e.isSymbolicLink()) {
      try {
        st.aliases.push({ aliasDir: e.name, targetDir: readlinkSync(join(root, e.name)) });
      } catch (err) {
        if (!isVanished(code(err))) st.skipped.push({ path: join(root, e.name), reason: reasonFor(err) });
      }
      continue;
    }
    if (e.isDirectory()) scanProject(root, e.name, st);
  }
  return {
    files: [...st.byIdentity.values()].sort(byPath),
    aliases: st.aliases.sort((a, b) => (a.aliasDir < b.aliasDir ? -1 : a.aliasDir > b.aliasDir ? 1 : 0)),
    skipped: st.skipped.sort(byPath),
  };
}
