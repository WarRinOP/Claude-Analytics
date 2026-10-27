// The project key and label of a session, from its working folder (cwd). Pure.
//
// One project can arrive from Windows as `C:\x`, `c:\x` or `C:/x` (Claude Code names its project folders after the drive
// letter as it was typed, and other launchers write other forms). A cwd that looks like a Windows path is normalised to an
// upper case drive letter and backslashes, so all three spellings are one project. Anything else (macOS paths) is used
// exactly as it is, including a trailing space or a backslash that is part of a folder name.
import { posix } from 'node:path';

const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

export function isWindowsPath(cwd: string): boolean {
  return WINDOWS_PATH.test(cwd);
}

// The key a cwd is stored under in projects.project_key and sessions.project_key.
export function projectKeyOf(cwd: string): string {
  if (!isWindowsPath(cwd)) return cwd;
  return (cwd.slice(0, 1).toUpperCase() + cwd.slice(1)).replaceAll('/', '\\');
}

// The last part of the folder: what the projects list shows. A Windows style path splits on both separators; the drive
// alone (`C:\`) has no last part. Anything else uses the last part of a POSIX path, the same on every system.
export function projectLabelOf(cwd: string): string {
  if (!isWindowsPath(cwd)) return posix.basename(cwd);
  const parts = projectKeyOf(cwd).split('\\').filter((p) => p !== '');
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last ?? '';
}
