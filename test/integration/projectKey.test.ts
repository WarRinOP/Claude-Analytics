import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { upsertSession } from '../../src/store/repo.ts';
import { freshDb, message, useTempDataDir, type TempEnv } from '../unit/storeHelpers.ts';

let env: TempEnv;
beforeEach(() => {
  env = useTempDataDir();
});
afterEach(() => env.restore());

function projects(db: ReturnType<typeof freshDb>['db']): Array<{ project_key: string; display_name: string }> {
  return db.prepare('SELECT project_key, display_name FROM projects ORDER BY project_key').all() as Array<{ project_key: string; display_name: string }>;
}

describe('the project key of Windows style folders', () => {
  it('sessions that spell one folder three ways share one project, keyed with an upper case drive and backslashes', () => {
    const { db } = freshDb(env.dir);
    upsertSession(db, message({ sessionId: 'a', cwd: 'C:\\Users\\me\\My Project' }), 'C--Users-me-My-Project', 10);
    upsertSession(db, message({ sessionId: 'b', cwd: 'c:/Users/me/My Project' }), 'c--Users-me-My-Project', 10);
    upsertSession(db, message({ sessionId: 'c', cwd: 'C:/Users/me/My Project' }), 'C--Users-me-My-Project', 10);
    expect(projects(db)).toEqual([{ project_key: 'C:\\Users\\me\\My Project', display_name: 'My Project' }]);
    const keys = db.prepare('SELECT DISTINCT project_key AS k FROM sessions').all() as Array<{ k: string }>;
    expect(keys.map((k) => k.k)).toEqual(['C:\\Users\\me\\My Project']);
  });

  it('events of one session that spell the folder differently do not move the session to another project', () => {
    const { db } = freshDb(env.dir);
    const moved1 = upsertSession(db, message({ sessionId: 's', ts: 1_000, cwd: 'c:/Users/me/p' }), 'c--Users-me-p', 10);
    const moved2 = upsertSession(db, message({ sessionId: 's', ts: 2_000, cwd: 'C:\\Users\\me\\p' }), 'c--Users-me-p', 10);
    const moved3 = upsertSession(db, message({ sessionId: 's', ts: 500, cwd: 'C:/Users/me/p' }), 'c--Users-me-p', 10);
    expect([moved1, moved2, moved3]).toEqual([false, false, false]);
    expect(projects(db)).toEqual([{ project_key: 'C:\\Users\\me\\p', display_name: 'p' }]);
  });

  it('the result does not depend on the order of the spellings', () => {
    const spellings = ['c:/Users/me/p', 'C:\\Users\\me\\p', 'C:/Users/me/p'];
    const results = new Set<string>();
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0]]) {
      const { db } = freshDb(env.dir);
      for (const i of order) upsertSession(db, message({ sessionId: 's', ts: 1_000, cwd: spellings[i] as string }), 'c--Users-me-p', 10);
      results.add(JSON.stringify([projects(db), db.prepare('SELECT project_key FROM sessions').all()]));
    }
    expect(results.size).toBe(1);
  });

  it('a non ASCII folder name is kept and labelled', () => {
    const { db } = freshDb(env.dir);
    upsertSession(db, message({ sessionId: 'u', cwd: 'c:/Users/me/Café Résumé' }), 'C--Users-me-Caf--R-sum-', 10);
    expect(projects(db)).toEqual([{ project_key: 'C:\\Users\\me\\Café Résumé', display_name: 'Café Résumé' }]);
  });

  it('a drive alone is labelled with its key', () => {
    const { db } = freshDb(env.dir);
    upsertSession(db, message({ sessionId: 'r', cwd: 'c:/' }), 'c--', 10);
    expect(projects(db)).toEqual([{ project_key: 'C:\\', display_name: 'C:\\' }]);
  });

  it('macOS style paths are stored exactly as written: key, label and the trailing space case', () => {
    const { db } = freshDb(env.dir);
    upsertSession(db, message({ sessionId: 'm1', cwd: '/Users/me/work/demo' }), '-Users-me-work-demo', 10);
    upsertSession(db, message({ sessionId: 'm2', cwd: '/Users/me/work/demo ' }), '-Users-me-work-demo-', 10);
    upsertSession(db, message({ sessionId: 'm3', cwd: '/work/a\\b' }), '-work-a-b', 10);
    expect(projects(db)).toEqual([
      { project_key: '/Users/me/work/demo', display_name: 'demo' },
      { project_key: '/Users/me/work/demo ', display_name: 'demo ' },
      { project_key: '/work/a\\b', display_name: 'a\\b' },
    ]);
  });
});
