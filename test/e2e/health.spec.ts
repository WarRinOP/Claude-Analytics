// In a temp copy of synthetic transcripts, inject a malformed line and an unknown record type and delete a file; after
// the ingest each one appears in /api/health, in the Data health panel and in `doctor`. The same second server holds 120
// sessions, so the Recent sessions pagination (50 per page) is tested against real pages.
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Health, Sessions } from '../../src/api/types.ts';
import { put, usageLine, userLine } from '../unit/ingestHelpers.ts';
import { PROJECTS, writeTranscripts } from './fixture.ts';
import { runDoctor, startSecond, waitUntil, type Second } from './second.ts';

// 120 small sessions in one project, an hour apart, so the sessions table has three pages.
const MANY = 120;
function writeMany(projects: string): void {
  let n = 0;
  for (let i = 0; i < MANY; i++) {
    const sid = `many-${String(i).padStart(3, '0')}`;
    const lines = [userLine(sid, `u-${sid}`, i * 3600)];
    for (let t = 0; t <= i % 4; t++) lines.push(usageLine(sid, ++n, { ts: i * 3600 - 3600 + 60 * (t + 1), stop: true }));
    put(join(projects, '-work-many', `${sid}.jsonl`), lines);
  }
}

let second: Second;
let atlasFile = '';
let atlasLinesBefore = 0;
const deletedSession = 'sess-0010';

test.beforeAll(async () => {
  second = await startSecond((projects) => {
    writeTranscripts(projects);
    writeMany(projects);
  });
  atlasFile = join(second.projects, PROJECTS[1].folder, 'sess-0002.jsonl');
  atlasLinesBefore = readFileSync(atlasFile, 'utf8').split('\n').length - 1;
  // the injections: a malformed line and an unknown record type at the end of one file, and a deleted file
  appendFileSync(atlasFile, 'this is not json SECRET_TEXT_X\n');
  appendFileSync(atlasFile, JSON.stringify({ type: 'future-thing', version: '9.9.9', payload: 'SECRET_TEXT_X' }) + '\n');
  rmSync(join(second.projects, PROJECTS[2].folder, `${deletedSession}.jsonl`));
  await waitUntil(async () => {
    const h = await second.json<Health>('/api/health');
    return h.errors.total >= 1 && h.files.deleted >= 1 && h.unknownTypes.length >= 1;
  });
});
test.afterAll(async () => {
  await second.stop();
});

async function open(page: Page, hash = ''): Promise<void> {
  await page.goto(`${second.url}/${hash}`);
  await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
}

test.describe('an injected malformed line, unknown record type and deleted file', () => {
  test('each shows in /api/health', async () => {
    const h = await second.json<Health>('/api/health');
    expect(h.errors.total).toBe(1);
    expect(h.recentErrors).toHaveLength(1);
    expect(h.recentErrors[0]).toMatchObject({ file: `${PROJECTS[1].folder}/sess-0002.jsonl`, lineNo: atlasLinesBefore + 1, error: 'invalid json' });
    expect(h.recentErrors[0]?.byteOffset).toBeGreaterThan(0);
    expect(h.unknownTypes).toEqual([{ type: 'future-thing', version: '9.9.9', count: 1, lastSeenAt: expect.any(Number) }]);
    expect(h.files.deleted).toBe(1);
    expect(h.sessions.sourceDeleted).toBe(1);
    expect(h.status).toBe('ok'); // a bad line is not a failing sync
    expect(JSON.stringify(h)).not.toContain('SECRET_TEXT_X');
  });

  test('each shows in the Data health panel, in words, with the file and line', async ({ page }) => {
    const h = await second.json<Health>('/api/health');
    await open(page, '#health');
    await expect(page.getByTestId('health-body')).toBeVisible();
    // the error row: file relative to the source folder, line, byte offset, the reason in plain words and the stored code
    const row = page.locator('table[data-table="health-errors"] tbody tr');
    await expect(row).toHaveCount(1);
    await expect(row.locator('th')).toHaveText(`${PROJECTS[1].folder}/sess-0002.jsonl`);
    await expect(row.locator('td').nth(1)).toHaveText(String(atlasLinesBefore + 1));
    await expect(row.locator('td').nth(2)).toHaveText((h.recentErrors[0]?.byteOffset ?? 0).toLocaleString('en-US'));
    await expect(row.locator('.dt__what')).toContainText('The line is not valid JSON, so it was skipped.');
    await expect(row.locator('.dt__code')).toHaveText('invalid json');
    // the unknown record type with its version and count
    const unknown = page.locator('table[data-table="health-unknown-types"] tbody tr');
    await expect(unknown).toHaveCount(1);
    await expect(unknown.locator('th')).toHaveText('future-thing');
    await expect(unknown.locator('td').nth(0)).toHaveText('9.9.9');
    await expect(unknown.locator('td').nth(1)).toHaveText('1');
    // the deleted file and the session kept after it
    await expect(page.locator('[data-hp="archive"] [data-kv="files"] dd')).toHaveText(`${h.files.active} active, 1 deleted at the source`);
    await expect(page.locator('[data-hp="archive"] [data-kv="sessions"] dd')).toContainText('1 kept after their source was deleted');
    // the checks say so with the word and a shape; the section header too
    await expect(page.locator('[data-check="errors"]')).toHaveAttribute('data-verdict', 'note');
    await expect(page.locator('[data-check="errors"] .checks__text')).toContainText('1 problem reading transcripts');
    await expect(page.locator('[data-check="source"] .checks__text')).toContainText('1 file deleted at the source');
    await expect(page.locator('[data-check="types"] .checks__text')).toContainText('future-thing');
    await expect(page.getByTestId('health-summary')).toContainText('Worth a look');
    // the sync pill counts the error and opens this panel
    await expect(page.getByRole('link', { name: '1 error' })).toBeVisible();
    // the text of the bad line is nowhere on the page
    expect(await page.locator('body').innerText()).not.toContain('SECRET_TEXT_X');
  });

  test('each shows in `doctor`, which reads without writing and exits 0 while the sync is healthy', async () => {
    const d = runDoctor(second);
    expect(d.code).toBe(0);
    expect(d.out.split('\n').length).toBeLessThanOrEqual(60);
    expect(d.out).toContain(`${PROJECTS[1].folder}/sess-0002.jsonl, line ${atlasLinesBefore + 1}, byte `);
    expect(d.out).toContain('The line is not valid JSON, so it was skipped.');
    expect(d.out).toContain('future-thing (Claude Code 9.9.9): 1 line');
    expect(d.out).toContain('1 file deleted at the source');
    expect(d.out).toContain('Service: running (process ');
    expect(d.out).not.toContain('SECRET_TEXT_X');
  });

  test('the session whose source file was deleted stays in the table, marked', async ({ page }) => {
    const api = await second.json<Sessions>('/api/sessions?page=1&pageSize=200&sort=start');
    const gone = api.rows.filter((r) => r.sourceDeleted);
    expect(gone.map((r) => r.sessionId)).toEqual([deletedSession]);
    await open(page);
    // it is on a later page of 50: walk to it from the pager
    for (let i = 0; i < 3 && (await page.locator(`tr[data-session="${deletedSession}"]`).count()) === 0; i++) {
      await page.getByTestId('sessions-next-bottom').click();
      await expect(page.getByTestId('sessions-page-bottom')).toHaveText(`Page ${i + 2} of 3`);
    }
    const row = page.locator(`tr[data-session="${deletedSession}"]`);
    await expect(row).toHaveAttribute('data-source-deleted', 'true');
    await expect(row.locator('.mark--kept')).toHaveText('Source deleted, kept in the archive');
    await expect(page.locator('tr[data-source-deleted="true"]')).toHaveCount(1);
  });
});

test.describe('recent sessions pagination, 50 per page', () => {
  const pageIds = async (page: Page): Promise<string[]> => page.locator('table[data-table="sessions"] tbody tr[data-session]').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-session') ?? ''));

  test('three pages equal /api/sessions; the buttons, the range sentence and the end of the list', async ({ page }) => {
    await open(page);
    const total = (await second.json<Sessions>('/api/sessions?page=1&pageSize=1')).total;
    expect(total).toBe(17 + MANY);
    const last = Math.ceil(total / 50);
    await expect(page.getByTestId('sessions-range-bottom')).toHaveText(`Sessions 1 to 50 of ${total}`);
    await expect(page.getByTestId('sessions-page-bottom')).toHaveText(`Page 1 of ${last}`);
    await expect(page.getByTestId('sessions-prev-bottom')).toHaveAttribute('aria-disabled', 'true');
    // the top copy of the controls says the same
    await expect(page.getByTestId('sessions-range-top')).toHaveText(`Sessions 1 to 50 of ${total}`);
    for (let p = 1; p <= last; p++) {
      const api = await second.json<Sessions>(`/api/sessions?page=${p}&pageSize=50&sort=start`);
      await expect.poll(() => pageIds(page)).toEqual(api.rows.map((r) => r.sessionId));
      expect(api.rows.length).toBe(p < last ? 50 : total - 50 * (last - 1));
      await expect(page.getByTestId('sessions-page-bottom')).toHaveText(`Page ${p} of ${last}`);
      if (p < last) await page.getByTestId('sessions-next-bottom').click();
    }
    // at the end, Next is marked unavailable but keeps focus; it does nothing
    const next = page.getByTestId('sessions-next-bottom');
    await expect(next).toHaveAttribute('aria-disabled', 'true');
    expect(await next.evaluate((el) => el === document.activeElement)).toBe(true);
    await next.click({ force: true }); // marked unavailable: a click does nothing
    await expect(page.getByTestId('sessions-page-bottom')).toHaveText(`Page ${last} of ${last}`);
    await expect(page.getByTestId('sessions-range-bottom')).toHaveText(`Sessions ${50 * (last - 1) + 1} to ${total} of ${total}`);
    // back one page from the keyboard
    await page.getByTestId('sessions-prev-bottom').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('sessions-page-bottom')).toHaveText(`Page ${last - 1} of ${last}`);
  });

  test('a new sort or a new filter starts again at page 1', async ({ page }) => {
    await open(page);
    await page.getByTestId('sessions-next-top').click();
    await expect(page.getByTestId('sessions-page-top')).toHaveText(/^Page 2 of 3$/);
    await page.locator('#sessions').getByRole('button', { name: 'Sort by tokens' }).click();
    await expect(page.getByTestId('sessions-page-top')).toHaveText(/^Page 1 of 3$/);
    const api = await second.json<Sessions>('/api/sessions?page=1&pageSize=50&sort=tokens');
    await expect.poll(() => pageIds(page)).toEqual(api.rows.map((r) => r.sessionId));
    await page.getByTestId('sessions-next-top').click();
    await expect(page.getByTestId('sessions-page-top')).toHaveText(/^Page 2 of 3$/);
    // a project row click changes the filter slice: back to page 1 of the filtered list
    const key = (await second.json<{ rows: Array<{ projectKey: string; displayName: string }> }>('/api/projects')).rows.find((r) => r.displayName === 'ledger-demo')?.projectKey ?? '';
    await page.locator(`tr[data-project="${key}"]`).click();
    const filtered = await second.json<Sessions>(`/api/sessions?projects=${encodeURIComponent(key)}&page=1&pageSize=50&sort=tokens`);
    await expect.poll(() => pageIds(page)).toEqual(filtered.rows.map((r) => r.sessionId));
    await expect(page.getByTestId('sessions-range-bottom')).toHaveText(`Sessions 1 to ${filtered.rows.length} of ${filtered.total}`);
  });

  test('no page scrolls sideways at 390 px with pages and panels in play', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, '#health');
    await expect(page.getByTestId('health-body')).toBeVisible();
    await page.getByTestId('sessions-next-bottom').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });
});
