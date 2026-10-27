import { describe, expect, it } from 'vitest';
import { isWindowsPath, projectKeyOf, projectLabelOf } from '../../src/store/projectKey.ts';

describe('projectKeyOf', () => {
  it('gives every spelling of one Windows folder the same key: upper case drive, backslashes', () => {
    for (const spelling of ['c:/x/y', 'C:\\x\\y', 'C:/x/y', 'c:\\x\\y', 'c:\\x/y', 'C:/x\\y']) {
      expect(projectKeyOf(spelling), spelling).toBe('C:\\x\\y');
    }
    expect(projectKeyOf('d:/Work/App')).toBe('D:\\Work\\App');
  });

  it('keeps the folder name case and spaces, and non ASCII letters', () => {
    expect(projectKeyOf('c:/Users/me/My Project')).toBe('C:\\Users\\me\\My Project');
    expect(projectKeyOf('C:\\Users\\me\\Café Résumé 项目')).toBe('C:\\Users\\me\\Café Résumé 项目');
    expect(projectKeyOf('c:/Users/me/My Project ')).toBe('C:\\Users\\me\\My Project '); // a trailing space stays, as on macOS
  });

  it('is idempotent', () => {
    for (const p of ['c:/a/b', 'C:\\a\\b', '/work/demo', '']) expect(projectKeyOf(projectKeyOf(p))).toBe(projectKeyOf(p));
  });

  it('uses every other path exactly as written (macOS paths, odd names, UNC, relative)', () => {
    for (const p of [
      '/Users/me/work/demo',
      '/Users/me/work/demo ', // a trailing space is part of the name
      '/work/a\\b', // a backslash in a POSIX folder name
      '/work/a/B',
      '\\\\server\\share\\x',
      'c:x', // drive relative, not a Windows absolute path
      'C:',
      '1:/x',
      '~/proj',
      'relative/dir',
      '',
    ]) {
      expect(projectKeyOf(p), p).toBe(p);
      expect(isWindowsPath(p), p).toBe(false);
    }
  });

  it('recognises a Windows path only by drive letter, colon, then a slash or backslash', () => {
    expect(isWindowsPath('c:/x')).toBe(true);
    expect(isWindowsPath('Z:\\')).toBe(true);
    expect(isWindowsPath('cc:/x')).toBe(false);
  });
});

describe('projectLabelOf', () => {
  it('is the last part of a Windows style path, splitting on both separators', () => {
    expect(projectLabelOf('C:\\Users\\me\\My Project')).toBe('My Project');
    expect(projectLabelOf('c:/Users/me/My Project')).toBe('My Project');
    expect(projectLabelOf('c:/Users/me/Café')).toBe('Café');
    expect(projectLabelOf('C:\\x\\')).toBe('x');
    expect(projectLabelOf('C:/x//')).toBe('x');
  });

  it('is empty for a drive alone', () => {
    expect(projectLabelOf('C:\\')).toBe('');
    expect(projectLabelOf('c:/')).toBe('');
  });

  it('is the POSIX base name for every other path, the same on every system', () => {
    expect(projectLabelOf('/Users/me/work/demo')).toBe('demo');
    expect(projectLabelOf('/Users/me/work/demo ')).toBe('demo ');
    expect(projectLabelOf('/work/a/')).toBe('a');
    expect(projectLabelOf('/work/a\\b')).toBe('a\\b');
    expect(projectLabelOf('/')).toBe('');
    expect(projectLabelOf('')).toBe('');
  });
});
