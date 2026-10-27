// Contract: where things live on each supported system. Pure: the system, the home folder
// and the environment come in as arguments, so the Windows rules are tested on macOS and the macOS rules on Windows.
// paths.ts and pathGuard.ts read their folders from here; nothing else decides a folder.
import { posix, win32, type PlatformPath } from 'node:path';

export type Os = 'darwin' | 'win32';

export interface PlatformInput {
  os: Os;
  home: string; // os.homedir()
  env: Record<string, string | undefined>; // process.env
}

export interface Folders {
  // The path rules of this system: win32 compares case insensitively and accepts both separators.
  path: PlatformPath;
  // Claude Code's config folder: CLAUDE_CONFIG_DIR when set and not empty, else <home>/.claude. Read only.
  claudeConfig: string;
  // Where Claude Code keeps transcripts: <claudeConfig>/projects. Read only.
  sourceRoot: string;
  // Claude Code's live session registry: <claudeConfig>/sessions. Read only.
  sessionsDir: string;
  // The app data folder when LEDGER_DATA_DIR is not set.
  //   darwin: <home>/Library/Application Support/UsageLedger
  //   win32:  %LOCALAPPDATA%\UsageLedger, else <home>\AppData\Local\UsageLedger (never the roaming profile)
  dataDir: string;
  // Folders the app never writes inside, whatever the data folder setting says. Always includes <home>/.claude,
  // claudeConfig and sourceRoot, plus the Claude desktop app's folders of this system.
  forbidden: string[];
  // A folder whose children starting with `prefix` are also never written (the Microsoft Store install of the desktop app
  // lives in %LOCALAPPDATA%\Packages\Claude_<publisher hash>). Null on macOS.
  forbiddenChildPrefix: { dir: string; prefix: string } | null;
}

// The system this process runs on. Any other system gets a plain sentence, not a half working app.
export function currentOs(platform: string = process.platform): Os {
  if (platform === 'darwin' || platform === 'win32') return platform;
  throw new Error(`Usage Ledger runs on macOS and Windows. This system (${platform}) is not supported.`);
}

const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v);

export function folders(i: PlatformInput): Folders {
  const p = i.os === 'win32' ? win32 : posix;
  const cfg = nonEmpty(i.env['CLAUDE_CONFIG_DIR']);
  const claudeConfig = cfg !== undefined ? p.resolve(cfg) : p.join(i.home, '.claude');
  const sourceRoot = p.join(claudeConfig, 'projects');
  const sessionsDir = p.join(claudeConfig, 'sessions');
  let dataDir: string;
  const desktop: string[] = [];
  let forbiddenChildPrefix: Folders['forbiddenChildPrefix'] = null;
  if (i.os === 'win32') {
    const local = nonEmpty(i.env['LOCALAPPDATA']) ?? p.join(i.home, 'AppData', 'Local');
    const roaming = nonEmpty(i.env['APPDATA']) ?? p.join(i.home, 'AppData', 'Roaming');
    dataDir = p.join(local, 'UsageLedger');
    // The desktop app: direct installer (Roaming\Claude), third party mode (Claude-3p, now Local, earlier Roaming), the
    // Squirrel install folder (AnthropicClaude), and the Store package (Packages\Claude_*).
    desktop.push(
      p.join(roaming, 'Claude'),
      p.join(roaming, 'Claude-3p'),
      p.join(local, 'Claude'),
      p.join(local, 'Claude-3p'),
      p.join(local, 'AnthropicClaude'),
    );
    forbiddenChildPrefix = { dir: p.join(local, 'Packages'), prefix: 'Claude_' };
  } else {
    dataDir = p.join(i.home, 'Library', 'Application Support', 'UsageLedger');
    desktop.push(p.join(i.home, 'Library', 'Application Support', 'Claude'), p.join(i.home, 'Library', 'Application Support', 'Claude-3p'));
  }
  const forbidden = [...new Set([p.join(i.home, '.claude'), claudeConfig, sourceRoot, ...desktop])];
  return { path: p, claudeConfig, sourceRoot, sessionsDir, dataDir, forbidden, forbiddenChildPrefix };
}
