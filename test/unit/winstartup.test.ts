import { describe, expect, it } from 'vitest';
import {
  TASK_NAME,
  buildLauncher,
  buildTaskXml,
  currentUserId,
  installPlan,
  jsString,
  launcherPath,
  localStartBoundary,
  parseTasklist,
  psQuote,
  startAction,
  taskXmlBytes,
  taskXmlPath,
  uninstallPlan,
  unsafePath,
  type StartupInput,
} from '../../src/cli/winstartup.ts';

const base: StartupInput = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  projectDir: 'C:\\Users\\Ana\\Claude Analytics',
  cliPath: 'C:\\Users\\Ana\\Claude Analytics\\src\\cli.ts',
  dataDir: 'C:\\Users\\Ana\\AppData\\Local\\UsageLedger',
  userId: 'ANA-PC\\Ana',
  wscriptExists: true,
  startBoundary: '2026-10-28T09:05:03',
};

// The nasty case: spaces, a double quote, backslashes, an ampersand, an apostrophe, non ASCII letters and a rare ideograph
// outside the basic plane (a surrogate pair). Windows forbids the double quote in a real path; the builders must still never break on it.
const nasty: StartupInput = {
  nodePath: 'D:\\Tools "x"\\nöde & co\\node.exe',
  projectDir: "D:\\Ünï\\日本語 O'Brien\\proj \\\\ 𠮷",
  cliPath: "D:\\Ünï\\日本語 O'Brien\\proj \\\\ 𠮷\\src\\cli.ts",
  dataDir: 'D:\\Data \\ with "quote"',
  userId: "DOM<AIN>\\O'Brien & \"Sons\"",
  tz: 'America/New_York',
  retentionDays: 45,
  wscriptExists: true,
  startBoundary: '2026-12-01T00:00:00',
};

// Reads back the value of `var <name> = "...";` in the launcher. A JScript literal made only of \", \\ and \uXXXX is also valid JSON.
function literalOf(launcher: string, name: string): string {
  const m = new RegExp(`^var ${name} = (".*");$`, 'm').exec(launcher);
  expect(m, `var ${name} in the launcher`).not.toBeNull();
  return JSON.parse((m as RegExpExecArray)[1] as string) as string;
}

describe('jsString and psQuote', () => {
  it('escapes quote, backslash, controls and every non ASCII unit, and stays ASCII', () => {
    expect(jsString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(jsString('line\nbreak\ttab')).toBe('"line\\u000Abreak\\u0009tab"');
    expect(jsString('é日𠮷')).toBe('"\\u00E9\\u65E5\\uD842\\uDFB7"');
    expect(jsString('plain path C:\\x')).toBe('"plain path C:\\\\x"');
    for (const s of ['é日𠮷', nasty.nodePath, '\u2028\u2029\0']) expect(jsString(s)).toMatch(/^[\x20-\x7e]*$/);
  });

  it('round trips every string through JSON.parse', () => {
    for (const s of ['', 'x', nasty.nodePath, nasty.projectDir, 'a\\"b\\\\', '\u2028 \0 \u007f \u0085', '𠮷 日本']) {
      expect(JSON.parse(jsString(s))).toBe(s);
    }
  });

  it('doubles single quotes (straight and curly) in a PowerShell string', () => {
    expect(psQuote("O'Brien")).toBe("'O''Brien'");
    expect(psQuote('a\u2019b\u2018c')).toBe("'a\u2019\u2019b\u2018\u2018c'");
    expect(psQuote('C:\\Program Files\\x $env:Y `z')).toBe("'C:\\Program Files\\x $env:Y `z'");
  });
});

describe('launcher', () => {
  it('runs node hidden, waits and returns its exit code', () => {
    const x = buildLauncher(base);
    expect(x).toContain('var shell = new ActiveXObject("WScript.Shell");');
    expect(x).toContain('var node = "C:\\\\Program Files\\\\nodejs\\\\node.exe";');
    expect(x).toContain('var cli = "C:\\\\Users\\\\Ana\\\\Claude Analytics\\\\src\\\\cli.ts";');
    expect(x).toContain('var command = "\\"" + node + "\\" \\"" + cli + "\\" serve";');
    expect(x).toContain('var code = shell.Run(command, 0, true);');
    expect(x.trimEnd().endsWith('WScript.Quit(code);')).toBe(true);
  });

  it('sets the environment lines only when they were set at install', () => {
    const none = buildLauncher(base);
    expect(none).not.toContain('Environment');
    expect(none).not.toContain('LEDGER_');
    const tz = buildLauncher({ ...base, tz: 'Asia/Dhaka' });
    expect(tz).toContain('var env = shell.Environment("PROCESS");');
    expect(tz).toContain('env("LEDGER_TZ") = "Asia/Dhaka";');
    expect(tz).not.toContain('LEDGER_RETENTION_DAYS');
    const days = buildLauncher({ ...base, retentionDays: 60 });
    expect(days).toContain('env("LEDGER_RETENTION_DAYS") = "60";');
    expect(days).not.toContain('LEDGER_TZ');
    const both = buildLauncher({ ...base, tz: 'Asia/Dhaka', retentionDays: 60 });
    expect(both.indexOf('LEDGER_TZ')).toBeLessThan(both.indexOf('LEDGER_RETENTION_DAYS'));
    expect(both.indexOf('LEDGER_RETENTION_DAYS')).toBeLessThan(both.indexOf('var node'));
  });

  it('carries nasty paths intact and stays plain ASCII ES3', () => {
    const x = buildLauncher(nasty);
    expect([...x].every((c) => c === '\n' || (c >= ' ' && c <= '~'))).toBe(true);
    expect(literalOf(x, 'node')).toBe(nasty.nodePath);
    expect(literalOf(x, 'cli')).toBe(nasty.cliPath);
    expect(x).toContain('env("LEDGER_TZ") = "America/New_York";');
    expect(x).toContain('env("LEDGER_RETENTION_DAYS") = "45";');
    // no ES5 or newer syntax: wscript may run the legacy engine
    expect(x).not.toMatch(/\b(let|const|class|async|await|import|export)\b|=>|`|\.\.\./);
    // every code line is a comment, a var, an env assignment or the two final calls
    for (const line of x.split('\n').filter((l) => l !== '' && !l.startsWith('//'))) {
      expect(line).toMatch(/^(var \w+ = .+;|env\(".+"\) = ".*";|WScript\.Quit\(code\);)$/);
    }
  });
});

describe('task XML', () => {
  it('holds the agreed task, trigger, principal, settings and action', () => {
    const x = buildTaskXml(base);
    expect(x.startsWith('<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">')).toBe(true);
    expect(x).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>ANA-PC\\Ana<\/UserId>\s*<\/LogonTrigger>/);
    expect(x.indexOf('<LogonTrigger>')).toBeLessThan(x.indexOf('<TimeTrigger>'));
    expect(x).toMatch(/<Principal id="Author">\s*<UserId>ANA-PC\\Ana<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/);
    for (const setting of [
      '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '<StartWhenAvailable>true</StartWhenAvailable>',
    ]) {
      expect(x).toContain(setting);
    }
    expect(x).toMatch(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>99<\/Count>\s*<\/RestartOnFailure>/);
    expect(x).toContain('<Command>%SystemRoot%\\System32\\wscript.exe</Command>');
    expect(x).toContain(`<Arguments>//B //Nologo &quot;C:\\Users\\Ana\\AppData\\Local\\UsageLedger\\launcher.js&quot;</Arguments>`);
    expect(x).toContain('<WorkingDirectory>C:\\Users\\Ana\\Claude Analytics</WorkingDirectory>');
    expect(x).not.toContain('powershell');
    expect(x).not.toContain('LEDGER_');
  });

  it('has a time trigger that repeats every minute with no end, starting at the install time', () => {
    const x = buildTaskXml(base);
    expect(x.match(/<TimeTrigger>/g)?.length).toBe(1);
    expect(x.match(/<LogonTrigger>/g)?.length).toBe(1);
    const block = /<TimeTrigger>([\s\S]*?)<\/TimeTrigger>/.exec(x)?.[1] ?? '';
    expect(block).toContain('<StartBoundary>2026-10-28T09:05:03</StartBoundary>');
    expect(block).toContain('<Enabled>true</Enabled>');
    expect(block).toMatch(/<Repetition>\s*<Interval>PT1M<\/Interval>\s*<StopAtDurationEnd>false<\/StopAtDurationEnd>\s*<\/Repetition>/);
    expect(block).not.toMatch(/<Duration>/); // no Duration means it repeats for ever
    expect(x).not.toMatch(/<Duration>/);
    // both triggers sit inside the one Triggers element, and the start boundary has no offset
    expect(x).toMatch(/<Triggers>\s*<LogonTrigger>[\s\S]*<\/LogonTrigger>\s*<TimeTrigger>[\s\S]*<\/TimeTrigger>\s*<\/Triggers>/);
    expect(block).toMatch(/<StartBoundary>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d<\/StartBoundary>/);
    // the start boundary follows the input, and the other settings are untouched
    expect(buildTaskXml({ ...base, startBoundary: '2027-01-02T03:04:05' })).toContain('<StartBoundary>2027-01-02T03:04:05</StartBoundary>');
    expect(x).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(x).toMatch(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>99<\/Count>\s*<\/RestartOnFailure>/);
  });

  it('writes the install time as local time without an offset', () => {
    expect(localStartBoundary(new Date(2026, 9, 28, 7, 5, 9))).toBe('2026-10-28T07:05:09');
    expect(localStartBoundary(new Date(2027, 0, 2, 23, 59, 59))).toBe('2027-01-02T23:59:59');
    expect(localStartBoundary(new Date(2026, 11, 31, 0, 0, 0))).toBe('2026-12-31T00:00:00');
  });

  it('escapes every value for XML', () => {
    const x = buildTaskXml(nasty);
    expect(x).toContain('<UserId>DOM&lt;AIN&gt;\\O&apos;Brien &amp; &quot;Sons&quot;</UserId>');
    expect(x).toContain('<WorkingDirectory>D:\\Ünï\\日本語 O&apos;Brien\\proj \\\\ 𠮷</WorkingDirectory>');
    expect(wellFormed(x)).toBe(true);
    expect(wellFormed(buildTaskXml(base))).toBe(true);
    expect(wellFormed(buildTaskXml({ ...nasty, wscriptExists: false }))).toBe(true);
  });

  it('uses hidden PowerShell with the same command when wscript.exe is missing', () => {
    const a = startAction({ ...base, wscriptExists: false });
    expect(a.command).toBe('%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(a.args).toBe(
      `-NoProfile -WindowStyle Hidden -Command "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\Ana\\Claude Analytics\\src\\cli.ts' serve; exit $LASTEXITCODE"`,
    );
    const withEnv = startAction({ ...base, wscriptExists: false, tz: 'Asia/Dhaka', retentionDays: 45 });
    expect(withEnv.args).toContain(`$env:LEDGER_TZ = 'Asia/Dhaka'; $env:LEDGER_RETENTION_DAYS = '45'; & 'C:`);
    const x = buildTaskXml({ ...base, wscriptExists: false });
    expect(x).toContain('powershell.exe</Command>');
    expect(x).not.toContain('wscript');
    const quoted = startAction({ ...nasty, wscriptExists: false }).args;
    expect(quoted).toContain("'D:\\Ünï\\日本語 O''Brien\\proj \\\\ 𠮷\\src\\cli.ts'");
  });

  it('writes UTF-16 little endian with a byte order mark', () => {
    const xml = buildTaskXml(nasty);
    const bytes = taskXmlBytes(xml);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xfe);
    expect(bytes.length).toBe(2 + xml.length * 2);
    expect(new TextDecoder('utf-16le', { ignoreBOM: true }).decode(bytes.subarray(2))).toBe(xml);
    expect(bytes[2]).toBe('<'.charCodeAt(0));
    expect(bytes[3]).toBe(0);
  });
});

describe('user id', () => {
  it('is DOMAIN\\user from the environment, else the plain user name', () => {
    expect(currentUserId({ USERDOMAIN: 'ANA-PC', USERNAME: 'Ana' }, 'fallback')).toBe('ANA-PC\\Ana');
    expect(currentUserId({ USERNAME: 'Ana' }, 'fallback')).toBe('fallback');
    expect(currentUserId({ USERDOMAIN: 'ANA-PC' }, 'fallback')).toBe('fallback');
    expect(currentUserId({ USERDOMAIN: ' ', USERNAME: 'Ana' }, 'fallback')).toBe('fallback');
    expect(currentUserId({}, 'fallback')).toBe('fallback');
  });
});

describe('files and unsafe paths', () => {
  it('keeps the two files in the data folder, with the separator of that folder', () => {
    expect(launcherPath(base)).toBe('C:\\Users\\Ana\\AppData\\Local\\UsageLedger\\launcher.js');
    expect(taskXmlPath({ dataDir: 'C:\\Users\\Ana\\AppData\\Local\\UsageLedger\\' })).toBe('C:\\Users\\Ana\\AppData\\Local\\UsageLedger\\task.xml');
    expect(launcherPath({ dataDir: 'C:\\' })).toBe('C:\\launcher.js');
    expect(taskXmlPath({ dataDir: '/tmp/ledger-x/data' })).toBe('/tmp/ledger-x/data/task.xml');
  });

  it('refuses a percent sign or a double quote in a path the task carries', () => {
    expect(unsafePath(base)).toBeNull();
    expect(unsafePath({ ...base, projectDir: 'C:\\100%done' })).toContain('percent sign');
    expect(unsafePath({ ...base, nodePath: 'C:\\Tools\\%PATH%\\node.exe' })).toContain('percent sign');
    expect(unsafePath({ ...base, dataDir: 'C:\\a"b' })).toContain('double quote');
  });
});

describe('plans', () => {
  it('installs in order: switch the task off, files, stop an earlier copy, check the port, register, start, wait', () => {
    const plan = installPlan(base);
    expect(plan.map((s) => s.kind)).toEqual(['run', 'write', 'write', 'run', 'stopServe', 'requirePortFree', 'run', 'run', 'waitForDashboard']);
    const w = plan.filter((s) => s.kind === 'write');
    expect(w.map((s) => s.path)).toEqual(['C:\\Users\\Ana\\AppData\\Local\\UsageLedger\\launcher.js', 'C:\\Users\\Ana\\AppData\\Local\\UsageLedger\\task.xml']);
    expect(w.map((s) => s.encoding)).toEqual(['ascii', 'utf16le']);
    expect(w[0]?.text).toBe(buildLauncher(base));
    expect(w[1]?.text).toBe(buildTaskXml(base));
    const runs = plan.filter((s) => s.kind === 'run').map((s) => [s.program, ...s.args]);
    expect(runs).toEqual([
      ['schtasks', '/Change', '/TN', TASK_NAME, '/DISABLE'],
      ['schtasks', '/End', '/TN', TASK_NAME],
      ['schtasks', '/Create', '/TN', TASK_NAME, '/XML', 'C:\\Users\\Ana\\AppData\\Local\\UsageLedger\\task.xml', '/F'],
      ['schtasks', '/Run', '/TN', TASK_NAME],
    ]);
    const flags = plan.filter((s) => s.kind === 'run').map((s) => s.ignoreFailure);
    expect(flags).toEqual([true, true, false, false]);
    const first = plan[0];
    expect(first?.kind === 'run' ? first.okText : '').toMatch(/switched off/);
    expect(first?.kind === 'run' ? first.failText : '').toMatch(/no task to switch off/);
  });

  it('uninstalls in order: switch the task off, end it, stop the process, delete the task, remove the two files', () => {
    const plan = uninstallPlan({ dataDir: base.dataDir, deleteData: false });
    expect(plan.map((s) => s.kind)).toEqual(['run', 'run', 'stopServe', 'run', 'remove', 'remove']);
    expect(plan.filter((s) => s.kind === 'run').map((s) => [s.program, ...s.args])).toEqual([
      ['schtasks', '/Change', '/TN', TASK_NAME, '/DISABLE'],
      ['schtasks', '/End', '/TN', TASK_NAME],
      ['schtasks', '/Delete', '/TN', TASK_NAME, '/F'],
    ]);
    expect(plan.filter((s) => s.kind === 'remove').map((s) => s.path)).toEqual([launcherPath(base), taskXmlPath(base)]);
    const withData = uninstallPlan({ dataDir: base.dataDir, deleteData: true });
    expect(withData.map((s) => s.kind)).toEqual(['run', 'run', 'stopServe', 'run', 'remove', 'remove', 'deleteData']);
    const off = plan[0];
    expect(off?.kind === 'run' ? off.ignoreFailure : false).toBe(true);
    expect(off?.kind === 'run' ? off.okText : '').toMatch(/switched off/);
    expect(off?.kind === 'run' ? off.failText : '').toMatch(/no task to switch off/);
    expect(withData.at(-1)).toEqual({ kind: 'deleteData', path: base.dataDir });
  });

  it('never puts a shell between the program and its arguments', () => {
    for (const s of [...installPlan(nasty), ...uninstallPlan({ dataDir: nasty.dataDir, deleteData: true })]) {
      if (s.kind !== 'run') continue;
      expect(s.program).toBe('schtasks');
      expect(s.program).not.toMatch(/cmd|powershell/i);
    }
  });
});

describe('tasklist output', () => {
  it('reads the image name by pid and ignores the sentence for no match', () => {
    expect(parseTasklist('"node.exe","1234","Console","1","54,300 K"\r\n', 1234)).toBe('node.exe');
    expect(parseTasklist('"chrome.exe","99","Console","1","1 K"', 1234)).toBeNull();
    expect(parseTasklist('INFO: No tasks are running which match the specified criteria.', 1234)).toBeNull();
    expect(parseTasklist('', 1234)).toBeNull();
  });
});

// A small well formedness check: balanced tags, quoted attribute values, text with no raw angle bracket or loose ampersand.
function wellFormed(xml: string): boolean {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w.]*)((?:\s+[\w:.]+="[^"<&]*")*)\s*(\/?)>|([^<]+)/g;
  let pos = 0;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    if (m.index !== pos) return false;
    pos = re.lastIndex;
    const text = m[5];
    if (text !== undefined) {
      if (text.includes('>') || /&(?!amp;|lt;|gt;|quot;|apos;)/.test(text)) return false;
      continue;
    }
    if (m[4] === '/') continue;
    if (m[1] === '/') {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2] as string);
  }
  return pos === body.length && stack.length === 0;
}
