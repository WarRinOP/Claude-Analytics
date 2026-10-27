// The Models, Projects and Recent sessions tables, the Definitions panel and the Data health panel against the shared
// synthetic fixture. Every number on screen is compared with the API answer for the same filters.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Definitions, Health, Models, Projects, Sessions } from '../../src/api/types.ts';
import { base, collectProblems, expectKpisEqual, getJson, money, n, summary } from './helpers.ts';
import { textContrastProblems } from './panels.ts';

const out = join(process.cwd(), 'test-results', 'screens');
mkdirSync(out, { recursive: true });

async function go(page: Page, query = ''): Promise<void> {
  await page.goto(`${base()}/${query}`);
  await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
  await expect(page.locator('table[data-table="models"]')).toBeVisible();
}

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('models table', () => {
  test('rows, totals and shares equal /api/models, and the total row equals the token KPI', async ({ page }) => {
    await go(page);
    const api = await getJson<Models>('/api/models');
    expect(api.rows.length).toBe(3);
    const rows = await page.locator('table[data-table="models"] tbody[data-group="models"] tr[data-model]').evaluateAll((trs) =>
      trs.map((tr) => ({ model: tr.getAttribute('data-model'), favorite: tr.getAttribute('data-favorite'), cells: [...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-value')), text: [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim()) })),
    );
    expect(rows.map((r) => r.model)).toEqual(api.rows.map((r) => r.model));
    expect(rows.map((r) => r.cells)).toEqual(api.rows.map((r) => [r.responses, r.input, r.output, r.cacheWrite, r.cacheRead, r.total, r.share, r.costUsd, r.costShare].map(String)));
    expect(rows.map((r) => r.text.slice(0, 6))).toEqual(api.rows.map((r) => [r.responses, r.input, r.output, r.cacheWrite, r.cacheRead, r.total].map(n)));
    expect(rows.map((r) => r.text[6])).toEqual(api.rows.map((r) => `${(r.share * 100).toFixed(1)}%`));
    expect(rows.map((r) => r.text[7])).toEqual(api.rows.map((r) => money(r.costUsd ?? 0)));
    expect(rows.map((r) => r.text[8])).toEqual(api.rows.map((r) => `${(r.costShare * 100).toFixed(1)}%`));
    expect(rows.filter((r) => r.favorite === 'true').map((r) => r.model)).toEqual(api.rows.filter((r) => r.favorite).map((r) => r.model));
    // the favorite marker says the word, it is not a colour or a bare shape
    await expect(page.locator('tr[data-favorite="true"] .fav')).toHaveText('Favorite');
    // the total row adds up the rows and equals the Tokens KPI
    const total = page.locator('tr[data-total="models"] td');
    expect(await total.evaluateAll((tds) => tds.map((td) => td.getAttribute('data-value')))).toEqual(
      [api.rows.reduce((a, r) => a + r.responses, 0), api.rows.reduce((a, r) => a + r.input, 0), api.rows.reduce((a, r) => a + r.output, 0), api.rows.reduce((a, r) => a + r.cacheWrite, 0), api.rows.reduce((a, r) => a + r.cacheRead, 0), api.rows.reduce((a, r) => a + r.total, 0), 1, api.rows.reduce((a, r) => a + (r.costUsd ?? 0), 0), 1].map(String),
    );
    const s = await summary();
    await expect(total.nth(5)).toHaveText(n(s.tokens.total));
    await expect(total.nth(7)).toHaveText(money(s.cost.usd));
    // each row has its swatch in the model colour of the charts
    const swatches = await page.locator('tr[data-model] .swatch').evaluateAll((els) => els.map((e) => (e as HTMLElement).style.background));
    expect(new Set(swatches).size).toBe(3);
    expect(swatches.every((c) => c.includes('var(--series-'))).toBe(true);
  });

  test('headers sort: aria-sort moves, text sorts ascending first, numbers descending first, a second click flips', async ({ page }) => {
    await go(page);
    const api = await getJson<Models>('/api/models');
    const order = async (): Promise<string[]> => page.locator('tbody[data-group="models"] tr[data-model]').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-model') ?? ''));
    const sortOf = (name: string): ReturnType<Page['locator']> => page.locator('th.th', { has: page.getByRole('button', { name: `Sort by ${name}` }) }).first();
    await expect(sortOf('total')).toHaveAttribute('aria-sort', 'descending');
    await page.getByRole('button', { name: 'Sort by model' }).click();
    await expect(sortOf('model')).toHaveAttribute('aria-sort', 'ascending');
    await expect(sortOf('total')).toHaveAttribute('aria-sort', 'none');
    expect(await order()).toEqual(api.rows.map((r) => r.model).sort());
    await page.getByRole('button', { name: 'Sort by model' }).click();
    await expect(sortOf('model')).toHaveAttribute('aria-sort', 'descending');
    expect(await order()).toEqual(api.rows.map((r) => r.model).sort().reverse());
    await page.getByRole('button', { name: 'Sort by responses' }).click();
    await expect(sortOf('responses')).toHaveAttribute('aria-sort', 'descending');
    expect(await order()).toEqual([...api.rows].sort((a, b) => b.responses - a.responses).map((r) => r.model));
    await page.getByRole('button', { name: 'Sort by share of total' }).click();
    await page.getByRole('button', { name: 'Sort by share of total' }).click();
    expect(await order()).toEqual([...api.rows].sort((a, b) => a.share - b.share).map((r) => r.model));
    // the favorite marker stays with its model, and the total row stays last
    await expect(page.locator('tr[data-favorite="true"]')).toHaveAttribute('data-model', api.rows.find((r) => r.favorite)?.model ?? '');
    expect(await page.locator('tbody[data-group="models"] tr').last().getAttribute('data-total')).toBe('models');
  });

  test('the background toggle sets includeBackground in the URL and lists the background group apart, labelled', async ({ page }) => {
    await go(page);
    await expect(page.locator('tbody[data-group="background"]')).toHaveCount(0);
    await page.getByTestId('models-background').check();
    await expect(page).toHaveURL(/includeBackground=1/);
    const group = page.locator('tbody[data-group="background"]');
    await expect(group).toBeVisible();
    await expect(group.locator('.dt__grouptitle')).toHaveText("Background calls (from Claude Code's session cost record)");
    const api = await getJson<Models>('/api/models?includeBackground=1');
    expect(api.background.length).toBeGreaterThan(0);
    const rows = await group.locator('tr[data-background-model]').evaluateAll((trs) => trs.map((tr) => ({ model: tr.getAttribute('data-background-model'), cells: [...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-value')) })));
    expect(rows.map((r) => r.model)).toEqual(api.background.map((r) => r.model));
    expect(rows.map((r) => r.cells.slice(1, 6))).toEqual(api.background.map((r) => [r.input, r.output, r.cacheWrite, r.cacheRead, r.total].map(String)));
    // the transcript rows and their total row do not include the background group
    expect(await page.locator('tr[data-total="models"] td').nth(5).getAttribute('data-value')).toBe(String(api.rows.reduce((a, r) => a + r.total, 0)));
    // the Model filter popover shows the same switch
    await page.getByRole('button', { name: /^Model/ }).first().click();
    await expect(page.getByRole('checkbox', { name: /Background calls/ })).toBeChecked();
    await page.keyboard.press('Escape');
    await page.getByTestId('models-background').uncheck();
    await expect(page.locator('tbody[data-group="background"]')).toHaveCount(0);
    await expect(page).not.toHaveURL(/includeBackground/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('projects table', () => {
  test('rows equal /api/projects; headers sort', async ({ page }) => {
    await go(page);
    const api = await getJson<Projects>('/api/projects');
    expect(api.rows.length).toBe(3);
    const read = async (): Promise<Array<{ key: string | null; cells: Array<string | null> }>> =>
      page.locator('table[data-table="projects"] tbody tr[data-project]').evaluateAll((trs) => trs.map((tr) => ({ key: tr.getAttribute('data-project'), cells: [...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-value')) })));
    expect(await read()).toEqual(api.rows.map((r) => ({ key: r.projectKey, cells: [r.sessions, r.messages, r.tokens, r.costUsd, r.lastActiveTs ?? 0].map(String) })));
    await expect(page.locator('table[data-table="projects"] tbody tr[data-project] td.dt__cost').first()).toHaveText(money(api.rows[0]?.costUsd ?? 0));
    await expect(page.locator('tr[data-project] th .rowbtn__name').first()).toHaveText(api.rows[0]?.displayName ?? '');
    await page.getByRole('button', { name: 'Sort by project' }).click();
    expect((await read()).map((r) => r.key)).toEqual([...api.rows].sort((a, b) => (a.displayName < b.displayName ? -1 : 1)).map((r) => r.projectKey));
    await page.getByRole('button', { name: 'Sort by last active' }).click();
    expect((await read()).map((r) => r.key)).toEqual([...api.rows].sort((a, b) => (b.lastActiveTs ?? 0) - (a.lastActiveTs ?? 0)).map((r) => r.projectKey));
  });

  test('a row click sets the project filter in the URL and filters every figure; a second click clears it', async ({ page }) => {
    await go(page);
    const api = await getJson<Projects>('/api/projects');
    const atlas = api.rows.find((r) => r.displayName === 'atlas');
    expect(atlas).toBeDefined();
    const key = atlas?.projectKey ?? '';
    await page.locator(`tr[data-project="${key}"] td`).first().click(); // any part of the row, not only its button
    await expect(page).toHaveURL(/projects=/);
    expect(new URL(page.url()).searchParams.get('projects')).toBe(key);
    await expectKpisEqual(page, await summary(`projects=${encodeURIComponent(key)}`));
    const rows = page.locator('table[data-table="projects"] tbody tr[data-project]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-selected', 'true');
    await expect(rows.first().getByRole('button', { name: /atlas/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.first().locator('.rowbtn__on')).toHaveText('Filtering');
    // the header filter says the same
    await expect(page.getByRole('button', { name: /^Project/ }).first()).toContainText('atlas');
    // a second click, from the keyboard this time, clears it
    await rows.first().getByRole('button').focus();
    await page.keyboard.press('Enter');
    await expect(page).not.toHaveURL(/projects=/);
    await expect(page.locator('table[data-table="projects"] tbody tr[data-project]')).toHaveCount(3);
    await expectKpisEqual(page, await summary());
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('recent sessions table', () => {
  test('the first page equals /api/sessions, with titles, marks and the partial day rule', async ({ page }) => {
    await go(page);
    await expect(page.locator('table[data-table="sessions"]')).toBeVisible();
    const api = await getJson<Sessions>('/api/sessions?page=1&pageSize=50&sort=start');
    expect(api.rows.length).toBe(api.total);
    const rows = await page.locator('table[data-table="sessions"] tbody tr[data-session]').evaluateAll((trs) =>
      trs.map((tr) => ({
        id: tr.getAttribute('data-session'),
        deleted: tr.getAttribute('data-source-deleted'),
        partial: tr.getAttribute('data-partial'),
        start: tr.querySelector('th')?.getAttribute('data-value'),
        nums: [...tr.querySelectorAll('td[data-value]')].map((td) => td.getAttribute('data-value')),
        project: tr.querySelector('.dt__project')?.textContent,
        title: tr.querySelector('.dt__title .dt__none, .dt__title .dt__titletext')?.textContent,
        models: [...tr.querySelectorAll('.mlist li span:last-child')].map((e) => e.textContent),
      })),
    );
    expect(rows.map((r) => r.id)).toEqual(api.rows.map((r) => r.sessionId));
    expect(rows.map((r) => r.start)).toEqual(api.rows.map((r) => String(r.firstTs)));
    expect(rows.map((r) => r.nums)).toEqual(api.rows.map((r) => [r.activeMs, r.wallMs, r.prompts, r.responses, r.tokens, r.costUsd].map(String)));
    expect(rows.map((r) => r.project)).toEqual(api.rows.map((r) => r.displayName));
    expect(rows.map((r) => r.models)).toEqual(api.rows.map((r) => r.models));
    expect(rows.map((r) => r.title)).toEqual(api.rows.map((r) => r.title ?? 'No title stored'));
    // a session that started before the complete from day says so (the fixture's tests run in UTC)
    const completeFrom = api.range.completeFrom as string;
    const expectPartial = api.rows.map((r) => (new Date(r.firstTs).toISOString().slice(0, 10) < completeFrom ? 'true' : null));
    expect(rows.map((r) => r.partial)).toEqual(expectPartial);
    expect(expectPartial).toContain('true');
    expect(expectPartial).toContain(null);
    await expect(page.locator('tr[data-partial="true"] .mark--partial').first()).toHaveText('Possibly incomplete');
    // the visible text of tokens, prompts and responses is the formatted API number
    const first = page.locator('tr[data-session]').first();
    await expect(first.locator('td[data-value]').nth(4)).toHaveText(n(api.rows[0]?.tokens ?? 0));
    await expect(first.locator('td[data-value]').nth(5)).toHaveText(money(api.rows[0]?.costUsd ?? 0));
    // one page: the range sentence, no page buttons
    await expect(page.getByTestId('sessions-range-bottom')).toHaveText(`Sessions 1 to ${api.total} of ${api.total}`);
    await expect(page.getByTestId('sessions-next-bottom')).toHaveCount(0);
  });

  test('sorting by tokens and by active time equals the server order', async ({ page }) => {
    await go(page);
    const ids = async (): Promise<string[]> => page.locator('table[data-table="sessions"] tbody tr[data-session]').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-session') ?? ''));
    await expect(page.locator('table[data-table="sessions"] th[aria-sort="descending"]')).toContainText('Start');
    await page.locator('#sessions').getByRole('button', { name: 'Sort by tokens' }).click();
    await expect(page.locator('table[data-table="sessions"] th[aria-sort="descending"]')).toContainText('Tokens');
    const byTokens = await getJson<Sessions>('/api/sessions?page=1&pageSize=50&sort=tokens');
    await expect.poll(ids).toEqual(byTokens.rows.map((r) => r.sessionId));
    await page.locator('#sessions').getByRole('button', { name: 'Sort by active time' }).click();
    const byActive = await getJson<Sessions>('/api/sessions?page=1&pageSize=50&sort=active');
    await expect.poll(ids).toEqual(byActive.rows.map((r) => r.sessionId));
    await expect(page.locator('#sessions .chart__sub')).toContainText('most active time first');
  });

  test('the filters reach the table: a model filter gives the filtered sessions', async ({ page }) => {
    await go(page, '?models=claude-opus-5-5');
    const api = await getJson<Sessions>('/api/sessions?models=claude-opus-5-5&page=1&pageSize=50&sort=start');
    await expect.poll(() => page.locator('table[data-table="sessions"] tbody tr[data-session]').count()).toBe(api.rows.length);
    expect(api.rows.length).toBeGreaterThan(0);
    expect(api.rows.length).toBeLessThan(17);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('definitions and data health', () => {
  test('both are closed until opened; Definitions lists every item of /api/definitions in the API wording', async ({ page }) => {
    await go(page);
    const button = page.getByRole('button', { name: 'Definitions' });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('definitions-list')).toHaveCount(0);
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const api = await getJson<Definitions>('/api/definitions');
    const list = page.getByTestId('definitions-list');
    await expect(list).toBeVisible();
    const items = await list.locator('.defs__item').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-definition'), term: e.querySelector('dt')?.textContent, text: e.querySelector('dd')?.textContent })));
    expect(items).toEqual(api.definitions.map((d) => ({ id: d.id, term: d.term, text: d.text.replaceAll('`', '') })));
    expect(await list.locator('dd code').count()).toBeGreaterThan(0);
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toBeHidden();
  });

  test('an address with #definitions or #health opens that section and brings it into view', async ({ page }) => {
    await page.goto(`${base()}/#definitions`);
    await expect(page.getByTestId('definitions-list')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Definitions' })).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => page.locator('#definitions').evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(400);
    await page.goto(`${base()}/#health`);
    await expect(page.getByTestId('health-body')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Data health' })).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => page.locator('#health').evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(400);
  });

  test('the sync pill opens Data health, also a second time after it was closed', async ({ page }) => {
    await go(page);
    const button = page.getByRole('button', { name: 'Data health' });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('link', { name: /^(Synced|Syncing|Stale|\d+ errors?)/ }).click();
    await expect(page).toHaveURL(/#health$/);
    await expect(page.getByTestId('health-body')).toBeVisible();
    await button.click();
    await expect(page.getByTestId('health-body')).toBeHidden();
    await page.getByRole('link', { name: /^(Synced|Syncing|Stale|\d+ errors?)/ }).click(); // same address, no hashchange
    await expect(page.getByTestId('health-body')).toBeVisible();
  });

  test('the panel says what /api/health says: checks, sync, archive, versions, entrypoints, the cost check and its explanation', async ({ page }) => {
    await page.goto(`${base()}/#health`);
    await expect(page.getByTestId('health-body')).toBeVisible();
    const h = await getJson<Health>('/api/health');
    // eight checks, each with a shape (an svg) and the verdict in words
    const checks = page.locator('.checks__row');
    await expect(checks).toHaveCount(8);
    const rows = await checks.evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-check'), verdict: e.getAttribute('data-verdict'), word: e.querySelector('.checks__word')?.textContent, shapes: e.querySelectorAll('svg.vs').length })));
    expect(rows.map((r) => r.id)).toEqual(['sync', 'source', 'errors', 'types', 'canary', 'versions', 'cost', 'prices']);
    expect(rows.every((r) => r.shapes === 1 && ['OK', 'Worth a look', 'Problem'].includes(r.word ?? ''))).toBe(true);
    const kv = async (sec: string, id: string): Promise<string> => ((await page.locator(`[data-hp="${sec}"] [data-kv="${id}"] dd`).textContent()) ?? '').replace(/\s+/g, ' ').trim();
    expect(await kv('archive', 'tz')).toBe(h.tz);
    expect(await kv('archive', 'files')).toBe(`${n(h.files.active)} active, ${n(h.files.deleted)} deleted at the source`);
    expect(await kv('archive', 'sessions')).toBe(`${n(h.sessions.total)} archived, ${n(h.sessions.sourceDeleted)} kept after their source was deleted`);
    expect(await kv('archive', 'retention')).toBe(`${h.retentionDays} days`);
    expect(await kv('archive', 'source')).toBe(h.sourceRoot);
    expect(await kv('sync', 'last-error')).toBe('None');
    expect(await kv('sync', 'trigger')).toBe(h.lastPass?.trigger);
    const versions = await page.locator('table[data-table="health-versions"] tbody tr').evaluateAll((trs) => trs.map((tr) => [tr.getAttribute('data-version'), tr.querySelector('td')?.getAttribute('data-value')]));
    expect(versions).toEqual(h.versions.map((v) => [v.version, String(v.responses)]));
    const entry = await page.locator('table[data-table="health-entrypoints"] tbody tr').evaluateAll((trs) => trs.map((tr) => [tr.getAttribute('data-entrypoint'), tr.querySelector('td')?.getAttribute('data-value')]));
    expect(entry).toEqual(h.entrypoints.map((e) => [e.entrypoint, String(e.responses)]));
    // no problems in the fixture: each empty list says so in words, with a shape
    await expect(page.locator('[data-hp="errors"] [data-empty="true"]')).toContainText('No ingest errors');
    await expect(page.locator('[data-hp="unknown-types"] [data-empty="true"]')).toContainText('None');
    await expect(page.locator('[data-hp="aliases"] [data-empty="true"]')).toContainText('None found');
    // the cost check: the summary sentence, its explanation, and the exceptions when there are some
    await expect(page.getByTestId('cost-why')).toContainText('Snapshots differ because Claude Code restarts its counters');
    await expect(page.getByTestId('cost-summary')).not.toBeEmpty();
    if (h.costCheck.exceptions.length > 0) await expect(page.locator('table[data-table="health-cost"] tbody tr')).toHaveCount(h.costCheck.exceptions.length);
    // the header of the section carries the overall verdict in words and a shape
    await expect(page.getByTestId('health-summary').locator('svg.vs')).toHaveCount(1);
    await expect(page.getByTestId('health-summary').locator('.hsum__word')).toHaveText(/^(Healthy|Worth a look|Needs attention)$/);
  });

  test('keyboard: Enter and Space toggle the sections, focus stays on the button, the ring is visible', async ({ page }) => {
    await go(page);
    const button = page.getByRole('button', { name: 'Data health' });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(await button.evaluate((el) => el === document.activeElement)).toBe(true);
    const ring = await button.evaluate((el) => {
      const cs = getComputedStyle(el);
      return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
    });
    expect(ring).toBe(true);
    // closed content is out of the tab order
    await expect(page.getByTestId('health-body')).toBeHidden();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('keyboard, layout, cleanliness', () => {
  test('sort headers and the table frames are reachable by keyboard with a visible ring; Enter sorts', async ({ page }) => {
    await go(page);
    const header = page.getByRole('button', { name: 'Sort by input' });
    await header.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('th[aria-sort="descending"]', { hasText: 'Input' })).toHaveCount(1);
    const rings = await page.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>('.th__btn, .tscroll, .rowbtn, .disc__btn, .pager__btn')];
      const bad: string[] = [];
      for (const el of els) {
        el.focus({ focusVisible: true } as FocusOptions);
        const cs = getComputedStyle(el);
        if (!(cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2)) bad.push(el.className);
      }
      return { checked: els.length, bad };
    });
    expect(rings.checked).toBeGreaterThan(15);
    expect(rings.bad).toEqual([]);
  });

  test('at 360 px the page never scrolls sideways: each table scrolls inside its own frame, with both panels open', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`${base()}/#health`);
    await expect(page.getByTestId('health-body')).toBeVisible();
    await page.getByRole('button', { name: 'Definitions' }).click();
    await expect(page.getByTestId('definitions-list')).toBeVisible();
    const wide = (): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(await wide()).toBe(false);
    const frames = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.tscroll')].map((f) => ({ label: f.getAttribute('aria-label'), over: f.scrollWidth > f.clientWidth, inside: f.getBoundingClientRect().right <= window.innerWidth + 0.5 })));
    expect(frames.every((f) => f.inside)).toBe(true);
    expect(frames.find((f) => f.label === 'Recent sessions table')?.over).toBe(true); // wider than the phone, scrolled inside
    expect(frames.find((f) => f.label === 'Models table')?.over).toBe(true);
    // touch targets of the new controls are at least 44 px high on a phone
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.th__btn, .disc__btn, .rowbtn, .chk--tool')].filter((e) => e.checkVisibility()).map((e) => ({ c: e.className, h: e.getBoundingClientRect().height })).filter((x) => x.h < 43.5),
    );
    expect(small).toEqual([]);
  });

  test('no console errors, no failed requests, nothing leaves 127.0.0.1, with every new panel opened', async ({ page }) => {
    const problems = collectProblems(page);
    await page.goto(`${base()}/#health`);
    await expect(page.getByTestId('health-body')).toBeVisible();
    await page.getByRole('button', { name: 'Definitions' }).click();
    await page.getByTestId('models-background').check();
    await page.locator('#sessions').getByRole('button', { name: 'Sort by tokens' }).click();
    await page.waitForTimeout(500);
    expect(problems.errors).toEqual([]);
    expect(problems.failed).toEqual([]);
    expect([...problems.hosts].every((h) => h.startsWith('127.0.0.1:'))).toBe(true);
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`contrast of every visible text with the tables and both panels open, ${theme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
      const page = await ctx.newPage();
      await page.goto(`${base()}/#health`);
      await expect(page.getByTestId('health-body')).toBeVisible();
      await page.getByRole('button', { name: 'Definitions' }).click();
      await expect(page.getByTestId('definitions-list')).toBeVisible();
      await page.getByTestId('models-background').check();
      await page.waitForTimeout(400);
      const r = await textContrastProblems(page);
      expect(r.checked).toBeGreaterThan(300);
      expect(r.problems).toEqual([]);
      // the three marks that carry meaning have text beside the shape: ok, look, problem
      const words = await page.locator('.checks__word').allTextContents();
      expect(words.every((w) => ['OK', 'Worth a look', 'Problem'].includes(w))).toBe(true);
      await ctx.close();
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// Screenshots of the new sections for a human to look at: 390 and 1440, dark and light.
for (const [name, width, height] of [
  ['390', 390, 844],
  ['1440', 1440, 900],
] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`screenshots of the tables and panels at ${name} ${theme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
      const page = await ctx.newPage();
      await go(page, '?includeBackground=1');
      await expect(page.locator('tbody[data-group="background"]')).toBeVisible();
      await expect(page.locator('table[data-table="sessions"] tbody tr').first()).toBeVisible();
      await page.waitForTimeout(300);
      for (const id of ['projects', 'models', 'sessions']) {
        await page.locator(`[data-chart="${id}"]`).scrollIntoViewIfNeeded();
        await page.locator(`[data-chart="${id}"]`).screenshot({ path: join(out, `${name}-${theme}-table-${id}.png`) });
      }
      await page.getByRole('button', { name: 'Definitions' }).click();
      await page.getByRole('button', { name: 'Data health' }).click();
      await expect(page.getByTestId('health-body')).toBeVisible();
      await page.waitForTimeout(400);
      await page.locator('#definitions').screenshot({ path: join(out, `${name}-${theme}-definitions.png`) });
      await page.locator('#health').screenshot({ path: join(out, `${name}-${theme}-health.png`) });
      await ctx.close();
    });
  }
}
