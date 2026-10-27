// The usage breakdown ledger against the shared synthetic fixture. Every number on screen is
// compared with the API answer for the same filters; the table is driven by mouse and by keyboard only; 360 px, both
// themes, no console errors, and only 127.0.0.1 requests.
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Breakdown, BreakdownRow, BreakdownTotals } from '../../src/api/types.ts';
import { base, collectProblems, getJson, money, n, summary } from './helpers.ts';
import { textContrastProblems } from './panels.ts';

const out = join(process.cwd(), 'test-results', 'screens');
mkdirSync(out, { recursive: true });

const table = (page: Page): Locator => page.locator('table[data-table="breakdown"]');
const periodGroup = (page: Page, key: string): Locator => page.locator(`tbody[data-group="period"][data-key="${key}"]`);
const dayGroup = (page: Page, key: string): Locator => page.locator(`tbody[data-group="day"][data-key="${key}"]`);
const bd = (period: string, extra = ''): Promise<Breakdown> => getJson<Breakdown>(`/api/breakdown?period=${period}${extra === '' ? '' : `&${extra}`}`);

async function go(page: Page, query = ''): Promise<void> {
  await page.goto(`${base()}/${query}`);
  await expect(table(page)).toBeVisible();
}

// The seven figures of a row as the cells carry them (data-value) and as a person reads them.
const valuesOf = (t: BreakdownTotals): string[] => [t.responses, t.input, t.output, t.cacheWrite, t.cacheRead, t.total, t.costUsd].map(String);
const textsOf = (t: BreakdownTotals): string[] => [t.responses, t.input, t.output, t.cacheWrite, t.cacheRead, t.total].map(n).concat(money(t.costUsd));

async function figures(row: Locator): Promise<{ values: Array<string | null>; texts: string[] }> {
  const cells = row.locator('td[data-col]');
  const values = await cells.evaluateAll((tds) => tds.map((td) => td.getAttribute('data-value')));
  // the cost cell may carry a second line about unpriced events: the figure is what is left without it
  const texts = await cells.evaluateAll((tds) =>
    tds.map((td) => {
      const c = td.cloneNode(true) as HTMLElement;
      c.querySelectorAll('.lg__np').forEach((e) => e.remove());
      return (c.textContent ?? '').replace(/\s+/g, ' ').trim();
    }),
  );
  return { values, texts };
}

async function expectRow(row: Locator, t: BreakdownTotals, what: string): Promise<void> {
  const f = await figures(row);
  expect(f.values, `${what} values`).toEqual(valuesOf(t));
  expect(f.texts.slice(0, 6), `${what} text`).toEqual(textsOf(t).slice(0, 6));
  expect(f.texts[6], `${what} cost text`).toBe(money(t.costUsd));
}

async function setOpen(btn: Locator, wanted: boolean): Promise<void> {
  if ((await btn.getAttribute('aria-expanded')) !== String(wanted)) await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', String(wanted));
}

const daysBtn = (page: Page, key: string): Locator => periodGroup(page, key).locator('[data-toggle="days"]');
const modelsBtn = (group: Locator): Locator => group.locator('> tr [data-toggle="models"]');

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('the ledger on screen equals the API', () => {
  test('default: Monthly, the newest month open to its days, the others closed, every figure equal', async ({ page }) => {
    await go(page);
    const api = await bd('month');
    expect(api.rows.length).toBeGreaterThanOrEqual(2);
    await expect(table(page)).toHaveAttribute('data-period', 'month');
    await expect(page.locator('[data-bar="breakdown"] .seg__btn[data-period="month"]')).toHaveAttribute('aria-pressed', 'true');
    const keys = await page.locator('tbody[data-group="period"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
    expect(keys).toEqual(api.rows.map((r) => r.key));
    const open = await page.locator('tbody[data-group="period"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-days-open')));
    expect(open).toEqual(api.rows.map((_, i) => String(i === 0)));
    // only the newest month shows its days, and no model lines are open
    const newest = api.rows[0] as BreakdownRow;
    const dayKeys = await page.locator('tbody[data-group="day"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
    expect(dayKeys).toEqual(newest.days.map((d) => d.key));
    await expect(page.locator('tr[data-row="model"]')).toHaveCount(0);
    for (const r of api.rows) {
      await expectRow(periodGroup(page, r.key).locator('> tr').first(), r.totals, r.key);
      await expect(periodGroup(page, r.key).locator('> tr .lg__label').first()).toHaveText(r.label);
    }
    for (const d of newest.days) {
      await expectRow(dayGroup(page, d.key).locator('> tr').first(), d.totals, d.key);
      await expect(dayGroup(page, d.key).locator('> tr .lg__label').first()).toHaveText(d.label);
    }
    // the Models column: each model's swatch and short name
    const first = periodGroup(page, newest.key).locator('> tr').first().locator('.lg__models li');
    expect(await first.locator('.lg__mname').allTextContents()).toEqual(newest.models.map((m) => m.model.replace(/^claude-/, '')));
    expect(await first.evaluateAll((els) => els.map((e) => e.getAttribute('title')))).toEqual(newest.models.map((m) => m.model));
    expect(await first.locator('.swatch').evaluateAll((els) => els.map((e) => (e as HTMLElement).style.background.includes('var(--series-')))).toEqual(newest.models.map(() => true));
  });

  test('the totals row is the first row of the body and equals the API, the KPIs and the Models table', async ({ page }) => {
    await go(page);
    const api = await bd('month');
    const s = await summary();
    const body = table(page).locator('tbody').first();
    await expect(body).toHaveAttribute('data-group', 'totals');
    const row = body.locator('tr');
    await expectRow(row, api.totals, 'totals');
    expect(api.totals.total).toBe(s.tokens.total);
    expect(api.totals.costUsd).toBe(s.cost.usd);
    await expect(row.locator('td[data-col="total"]')).toHaveText(n(s.tokens.total));
    await expect(row.locator('td[data-col="cost"]')).toHaveText(money(s.cost.usd));
    await expect(row.locator('td[data-col="cost"]')).toHaveText(money(s.cost.usd));
    await expect(page.locator('tr[data-total="models"] td').nth(5)).toHaveText(n(api.totals.total));
    // the sum of the month rows is the total
    expect(api.rows.reduce((a, r) => a + r.totals.total, 0)).toBe(api.totals.total);
    // pinned: the totals row stays under the header while the rows scroll
    await expect(row.locator('th')).toHaveCSS('position', 'sticky');
  });

  test('the period switch: Weekly and Daily, in the URL, with the same grand total', async ({ page }) => {
    await go(page);
    const month = await bd('month');
    await page.locator('[data-bar="breakdown"] .seg__btn[data-period="week"]').click();
    await expect(page).toHaveURL(/breakdown=week/);
    await expect(table(page)).toHaveAttribute('data-period', 'week');
    const week = await bd('week');
    expect(await page.locator('tbody[data-group="period"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))).toEqual(week.rows.map((r) => r.key));
    await expect(periodGroup(page, (week.rows[0] as BreakdownRow).key).locator('> tr .lg__label').first()).toHaveText((week.rows[0] as BreakdownRow).label);
    expect((week.rows[0] as BreakdownRow).label).toMatch(/^Week of \d{1,2} [A-Z][a-z]{2} \d{4}$/);
    expect(week.totals).toEqual(month.totals);
    await expect(page.locator('tbody[data-group="period"][data-key] [data-toggle="days"][aria-expanded="true"]')).toHaveCount(1); // the newest week
    await page.locator('[data-bar="breakdown"] .seg__btn[data-period="day"]').click();
    await expect(page).toHaveURL(/breakdown=day/);
    await expect(table(page)).toHaveAttribute('data-period', 'day');
    const day = await bd('day');
    expect(await page.locator('tbody[data-group="day"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))).toEqual(day.rows.map((r) => r.key));
    await expect(page.locator('tbody[data-group="period"]')).toHaveCount(0);
    await expect(page.locator('[data-toggle="days"]')).toHaveCount(0); // a day has no days to open
    expect(day.totals).toEqual(month.totals);
    await expect(dayGroup(page, (day.rows[0] as BreakdownRow).key).locator('> tr .lg__label').first()).toHaveText((day.rows[0] as BreakdownRow).label);
    expect((day.rows[0] as BreakdownRow).label).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2} \d{4}$/);
    // Monthly again: the default needs no parameter, and Back walks through the views
    await page.locator('[data-bar="breakdown"] .seg__btn[data-period="month"]').click();
    expect(new URL(page.url()).searchParams.has('breakdown')).toBe(false);
    await page.goBack();
    await expect(table(page)).toHaveAttribute('data-period', 'day');
    await page.goBack();
    await expect(table(page)).toHaveAttribute('data-period', 'week');
  });

  test('a direct link to ?breakdown=week opens the weekly view; a bad value falls back to Monthly', async ({ page }) => {
    await go(page, '?breakdown=week');
    await expect(table(page)).toHaveAttribute('data-period', 'week');
    await go(page, '?breakdown=century');
    await expect(table(page)).toHaveAttribute('data-period', 'month');
  });

  test('open a month to its days and a week to its days; every day equals the API and days add up to the period', async ({ page }) => {
    await go(page);
    const months = await bd('month');
    const older = months.rows[1] as BreakdownRow;
    await setOpen(daysBtn(page, older.key), true);
    for (const d of older.days) await expectRow(dayGroup(page, d.key).locator('> tr').first(), d.totals, d.key);
    expect(older.days.reduce((a, d) => a + d.totals.total, 0)).toBe(older.totals.total);
    await expect(daysBtn(page, older.key)).toHaveAttribute('aria-controls', older.days.map((d) => `lg-d-${d.key}`).join(' '));
    await setOpen(daysBtn(page, older.key), false);
    await expect(page.locator(`tbody[data-group="day"]`)).toHaveCount((months.rows[0] as BreakdownRow).days.length);

    await page.locator('[data-bar="breakdown"] .seg__btn[data-period="week"]').click();
    const weeks = await bd('week');
    const w = weeks.rows[2] as BreakdownRow;
    await setOpen(daysBtn(page, w.key), true);
    for (const d of w.days) await expectRow(dayGroup(page, d.key).locator('> tr').first(), d.totals, d.key);
  });

  test('every row opens into its per model lines: month, week, day and a day inside a month; lines equal the API and add up', async ({ page }) => {
    await go(page);
    const months = await bd('month');
    const newest = months.rows[0] as BreakdownRow;
    // the month row
    const mg = periodGroup(page, newest.key);
    await setOpen(modelsBtn(mg), true);
    const lines = mg.locator('tr[data-row="model"]');
    await expect(lines).toHaveCount(newest.models.length);
    expect(await lines.evaluateAll((trs) => trs.map((t) => t.getAttribute('data-model')))).toEqual(newest.models.map((m) => m.model));
    for (const m of newest.models) await expectRow(mg.locator(`tr[data-model="${m.model}"]`), m, `month ${m.model}`);
    expect(newest.models.reduce((a, m) => a + m.total, 0)).toBe(newest.totals.total);
    await expect(mg.locator('tr[data-row="model"]').first().locator('th')).toContainText(newest.models[0]?.model ?? '');
    // a day inside that month
    const day = newest.days.find((d) => d.models.length > 1) ?? (newest.days[0] as BreakdownRow);
    const dg = dayGroup(page, day.key);
    await setOpen(modelsBtn(dg), true);
    for (const m of day.models) await expectRow(dg.locator(`tr[data-model="${m.model}"]`), m, `day ${m.model}`);
    await expect(dg.locator('tr[data-row="model"]').first()).toHaveAttribute('data-depth', '2');
    await expect(mg.locator('tr[data-row="model"]').first()).toHaveAttribute('data-depth', '1');
    // weekly and daily rows open the same way
    await page.locator('[data-bar="breakdown"] .seg__btn[data-period="week"]').click();
    const week = (await bd('week')).rows[0] as BreakdownRow;
    await setOpen(modelsBtn(periodGroup(page, week.key)), true);
    await expect(periodGroup(page, week.key).locator('tr[data-row="model"]')).toHaveCount(week.models.length);
    await page.locator('[data-bar="breakdown"] .seg__btn[data-period="day"]').click();
    const d0 = (await bd('day')).rows[0] as BreakdownRow;
    await setOpen(modelsBtn(dayGroup(page, d0.key)), true);
    for (const m of d0.models) await expectRow(dayGroup(page, d0.key).locator(`tr[data-model="${m.model}"]`), m, `daily ${m.model}`);
    // closing hides them again
    await setOpen(modelsBtn(dayGroup(page, d0.key)), false);
    await expect(dayGroup(page, d0.key).locator('tr[data-row="model"]')).toHaveCount(0);
  });

  test('Expand all opens every row to its days and models; Collapse all closes everything', async ({ page }) => {
    await go(page);
    const api = await bd('month');
    await page.getByTestId('breakdown-expand').click();
    const modelRows = api.rows.reduce((a, r) => a + r.models.length + r.days.reduce((b, d) => b + d.models.length, 0), 0);
    await expect(page.locator('tr[data-row="model"]')).toHaveCount(modelRows);
    await expect(page.locator('tbody[data-group="day"]')).toHaveCount(api.rows.reduce((a, r) => a + r.days.length, 0));
    expect(await page.locator('[data-toggle][aria-expanded="false"]').count()).toBe(0);
    await expect(page.getByTestId('breakdown-expand')).toHaveAttribute('aria-disabled', 'true');
    await page.getByTestId('breakdown-collapse').click();
    await expect(page.locator('tbody[data-group="day"]')).toHaveCount(0);
    await expect(page.locator('tr[data-row="model"]')).toHaveCount(0);
    expect(await page.locator('[data-toggle][aria-expanded="true"]').count()).toBe(0);
    await expect(page.getByTestId('breakdown-collapse')).toHaveAttribute('aria-disabled', 'true');
    // The choice belongs to the view: an untouched weekly view opens at its own default (the newest week), and monthly
    // stays collapsed when it comes back. Each check waits for that view's fresh answer, not the stale previous one.
    const week = await bd('week');
    await page.locator('[data-bar="breakdown"] .seg__btn[data-period="week"]').click();
    await expect(table(page)).toHaveAttribute('data-period', 'week');
    await expect(table(page)).not.toHaveAttribute('data-stale', 'true');
    await expect(page.locator('tbody[data-group="day"]')).toHaveCount((week.rows[0] as BreakdownRow).days.length);
    await page.locator('[data-bar="breakdown"] .seg__btn[data-period="month"]').click();
    await expect(table(page)).toHaveAttribute('data-period', 'month');
    await expect(table(page)).not.toHaveAttribute('data-stale', 'true');
    await expect(page.locator('tbody[data-group="day"]')).toHaveCount(0); // still collapsed
  });

  test('sorting: Newest first, Oldest first, Cost, Total tokens, for the periods and the days inside them', async ({ page }) => {
    await go(page);
    const api = await bd('month');
    const keys = async (sel: string): Promise<Array<string | null>> => page.locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute('data-key')));
    const sel = page.getByTestId('breakdown-sort');
    expect(await sel.locator('option').allTextContents()).toEqual(['Newest first', 'Oldest first', 'Cost', 'Total tokens']);
    await expect(sel).toHaveValue('newest');
    await sel.selectOption('oldest');
    expect(await keys('tbody[data-group="period"]')).toEqual([...api.rows].reverse().map((r) => r.key));
    await expect(daysBtn(page, (api.rows[0] as BreakdownRow).key)).toHaveAttribute('aria-expanded', 'true'); // the newest month stays the one that was open
    expect(await keys('tbody[data-group="day"]')).toEqual([...(api.rows[0] as BreakdownRow).days].reverse().map((d) => d.key));
    await sel.selectOption('cost');
    expect(await keys('tbody[data-group="period"]')).toEqual([...api.rows].sort((a, b) => b.totals.costUsd - a.totals.costUsd || (a.key < b.key ? 1 : -1)).map((r) => r.key));
    expect(await keys('tbody[data-group="day"]')).toEqual([...(api.rows[0] as BreakdownRow).days].sort((a, b) => b.totals.costUsd - a.totals.costUsd || (a.key < b.key ? 1 : -1)).map((d) => d.key));
    await sel.selectOption('tokens');
    expect(await keys('tbody[data-group="period"]')).toEqual([...api.rows].sort((a, b) => b.totals.total - a.totals.total || (a.key < b.key ? 1 : -1)).map((r) => r.key));
    await sel.selectOption('newest');
    expect(await keys('tbody[data-group="period"]')).toEqual(api.rows.map((r) => r.key));
    // the totals row stays first whatever the order
    await expect(table(page).locator('tbody').first()).toHaveAttribute('data-group', 'totals');
  });

  test('the global filters apply: a model filter, subagents out, a custom range', async ({ page }) => {
    for (const q of ['models=claude-haiku-5-5', 'includeSubagents=0', 'from=2026-10-01&to=2026-10-20', 'projects=%2Fwork%2Fatlas']) {
      await go(page, `?${q}`);
      for (const period of ['month', 'week', 'day']) {
        await page.locator(`[data-bar="breakdown"] .seg__btn[data-period="${period}"]`).click();
        await expect(table(page)).toHaveAttribute('data-period', period);
        const api = await bd(period, q);
        const top = period === 'day' ? 'day' : 'period';
        expect(await page.locator(`tbody[data-group="${top}"]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))).toEqual(api.rows.map((r) => r.key));
        await expectRow(table(page).locator('tbody').first().locator('tr'), api.totals, `${q} ${period} totals`);
        for (const r of api.rows.slice(0, 3)) await expectRow(page.locator(`tbody[data-group="${top}"][data-key="${r.key}"] > tr`).first(), r.totals, `${q} ${period} ${r.key}`);
      }
      const s = await summary(q);
      const total = table(page).locator('tbody[data-group="totals"] tr');
      await expect(total.locator('td[data-col="total"]')).toHaveText(n(s.tokens.total));
      await expect(total.locator('td[data-col="cost"]')).toHaveText(money(s.cost.usd));
    }
    // a model filter lists only that model, in every row
    await go(page, '?models=claude-haiku-5-5');
    expect(new Set(await page.locator('tbody[data-group="period"] .lg__models .lg__mname').allTextContents())).toEqual(new Set(['haiku-5-5']));
  });

  test('an empty range says so instead of drawing an empty table', async ({ page }) => {
    await page.goto(`${base()}/?from=2020-01-01&to=2020-01-05`);
    await expect(page.locator('[data-chart="breakdown"] [data-state="empty"]')).toHaveText('No usage in this range with these filters.');
    await expect(table(page)).toHaveCount(0);
  });

  test('possibly incomplete periods carry the dot mark and the words for assistive technology, and the key explains it', async ({ page }) => {
    await go(page);
    const api = await bd('month');
    const partial = api.rows.filter((r) => r.partial);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(api.rows.length);
    for (const r of api.rows) {
      const mark = periodGroup(page, r.key).locator('> tr').first().locator('[data-mark="partial"]');
      await expect(mark).toHaveCount(r.partial ? 1 : 0);
      if (r.partial) {
        await expect(mark.locator('.sr-only')).toHaveText('Possibly incomplete');
        await expect(mark.locator('.mark__dots')).toHaveAttribute('aria-hidden', 'true');
        await expect(mark.locator('.mark__dots')).toBeVisible();
      }
    }
    await expect(page.locator('[data-note="ledger-partial"]')).toContainText('Possibly incomplete');
    // the days of a partial month are marked one by one
    const p = partial[0] as BreakdownRow;
    await setOpen(daysBtn(page, p.key), true);
    for (const d of p.days) await expect(dayGroup(page, d.key).locator('> tr').first().locator('[data-mark="partial"]')).toHaveCount(d.partial ? 1 : 0);
    expect(p.days.some((d) => d.partial)).toBe(true);
  });

  test('the cost note says what the number is', async ({ page }) => {
    await go(page);
    await expect(page.locator('#breakdown [data-note="ledger-cost"]')).toContainText('API price equivalent');
    await expect(page.locator('#breakdown [data-note="ledger-cost"]')).toContainText('Not what you paid');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('columns, sorting memory and the download', () => {
  test('the column picker hides and shows columns, remembers the choice across a reload, and resets', async ({ page }) => {
    await go(page);
    const headers = async (): Promise<string[]> => (await table(page).locator('thead th').allTextContents()).map((t) => t.trim());
    expect(await headers()).toEqual(['Period', 'Models', 'Responses', 'Input', 'Output', 'Cache write', 'Cache read', 'Total tokens', 'Cost']);
    await page.getByTestId('breakdown-columns').click();
    const pop = page.getByRole('group', { name: 'Columns shown in the breakdown' });
    await expect(pop).toBeVisible();
    await expect(pop.getByRole('checkbox')).toHaveCount(7);
    await pop.getByRole('checkbox', { name: 'Cache write' }).uncheck();
    await pop.getByRole('checkbox', { name: 'Cache read' }).uncheck();
    await pop.getByRole('checkbox', { name: 'Input' }).uncheck();
    await expect(page.getByTestId('breakdown-columns')).toContainText('4 of 7');
    expect(await headers()).toEqual(['Period', 'Models', 'Responses', 'Output', 'Total tokens', 'Cost']);
    // every row loses the same cells, and the figures that stay are still right
    const api = await bd('month');
    const row = periodGroup(page, (api.rows[0] as BreakdownRow).key).locator('> tr').first();
    expect(await row.locator('td[data-col]').evaluateAll((tds) => tds.map((td) => td.getAttribute('data-col')))).toEqual(['responses', 'output', 'total', 'cost']);
    expect(await row.locator('td[data-col]').evaluateAll((tds) => tds.map((td) => td.getAttribute('data-value')))).toEqual([api.rows[0]?.totals.responses, api.rows[0]?.totals.output, api.rows[0]?.totals.total, api.rows[0]?.totals.costUsd].map(String));
    expect(await page.locator('tbody[data-group="totals"] td[data-col]').count()).toBe(4);
    // kept for this viewer
    expect(await page.evaluate(() => window.localStorage.getItem('ledger.breakdown.columns'))).toBe('["responses","output","total","cost"]');
    await page.reload();
    await expect(table(page)).toBeVisible();
    expect(await headers()).toEqual(['Period', 'Models', 'Responses', 'Output', 'Total tokens', 'Cost']);
    await expect(page.getByTestId('breakdown-columns')).toContainText('4 of 7');
    // switching the period does not bring them back
    await page.locator('[data-bar="breakdown"] .seg__btn[data-period="week"]').click();
    expect(await headers()).toEqual(['Period', 'Models', 'Responses', 'Output', 'Total tokens', 'Cost']);
    await page.getByTestId('breakdown-columns').click();
    await page.getByRole('button', { name: 'Show all columns' }).click();
    expect(await headers()).toEqual(['Period', 'Models', 'Responses', 'Input', 'Output', 'Cache write', 'Cache read', 'Total tokens', 'Cost']);
    await page.reload();
    await expect(table(page)).toBeVisible();
    expect((await headers()).length).toBe(9);
  });

  test('blocked storage: the ledger still works with every column and says nothing is wrong', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      const blocked = (): never => {
        throw new DOMException('blocked', 'SecurityError');
      };
      Object.defineProperty(window, 'localStorage', { get: blocked });
    });
    const page = await ctx.newPage();
    const problems = collectProblems(page);
    await go(page);
    expect(await table(page).locator('thead th').count()).toBe(9);
    await page.getByTestId('breakdown-columns').click();
    await page.getByRole('checkbox', { name: 'Input' }).uncheck();
    expect(await table(page).locator('thead th').count()).toBe(8); // applies for this visit
    expect(problems.errors).toEqual([]);
    await ctx.close();
  });

  test('Download CSV is a plain link with the current query, and the file equals the API', async ({ page }) => {
    await go(page, '?models=claude-sonnet-5-5,claude-opus-5-5');
    const link = page.getByTestId('breakdown-csv');
    await expect(link).toHaveAttribute('href', '/api/breakdown.csv?models=claude-sonnet-5-5%2Cclaude-opus-5-5&period=month');
    await page.locator('[data-bar="breakdown"] .seg__btn[data-period="week"]').click();
    await expect(link).toHaveAttribute('href', '/api/breakdown.csv?models=claude-sonnet-5-5%2Cclaude-opus-5-5&period=week');
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    const api = await bd('week', 'models=claude-sonnet-5-5,claude-opus-5-5');
    expect(download.suggestedFilename()).toBe(`usage-week-${api.range.from}-${api.range.to}.csv`);
    const path = await download.path();
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\r\n');
    expect(lines.pop()).toBe(''); // every row ends with CRLF
    expect(lines[0]).toBe('period,label,from,to,partial,models,model,responses,input,output,cache_write,cache_read,total,cost_usd,unpriced_events');
    // one row per period, each followed by its model rows, same numbers as the JSON
    const expected: string[] = [];
    const cells = (t: BreakdownTotals): string[] => [t.responses, t.input, t.output, t.cacheWrite, t.cacheRead, t.total].map(String).concat(t.costUsd.toFixed(6), String(t.unpriced));
    for (const r of api.rows) {
      const head = [r.key, r.label, r.from, r.to, r.partial ? 'yes' : 'no'];
      expected.push([...head, r.models.map((m) => m.model).join(';'), '', ...cells(r.totals)].join(','));
      for (const m of r.models) expected.push([...head, '', m.model, ...cells(m)].join(','));
    }
    expect(lines.slice(1)).toEqual(expected);
    // and it is the very file the API serves
    const served = await (await fetch(`${base()}/api/breakdown.csv?period=week&models=claude-sonnet-5-5,claude-opus-5-5`)).text();
    expect(served).toBe(text);
    expect(new Set(lines.slice(1).map((l) => l.split(',')[6]).filter((m) => m !== ''))).toEqual(new Set(['claude-sonnet-5-5', 'claude-opus-5-5']));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('keyboard only', () => {
  async function tabTo(page: Page, selector: string, max = 80): Promise<void> {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)) return;
    }
    throw new Error(`Tab never reached ${selector}`);
  }
  // Where the focus is, as one comparable record.
  const active = (page: Page): Promise<{ tag: string; toggle: string; key: string; id: string; period: string }> =>
    page.evaluate(() => {
      const e = document.activeElement;
      return {
        tag: e?.tagName ?? '',
        toggle: e?.getAttribute('data-toggle') ?? '',
        key: e?.closest('tbody')?.getAttribute('data-key') ?? '',
        id: e?.getAttribute('data-testid') ?? '',
        period: e?.getAttribute('data-period') ?? '',
      };
    });

  test('Tab reaches every disclosure; Enter and Space toggle it; focus stays on the toggled row', async ({ page }) => {
    await go(page);
    const api = await bd('month');
    const newest = api.rows[0] as BreakdownRow;
    const older = api.rows[1] as BreakdownRow;
    await page.getByTestId('breakdown-sort').focus();
    // the way in: past the download link and the scroll frame to the first disclosure
    await tabTo(page, `tbody[data-key="${newest.key}"] [data-toggle="days"]`);
    expect(await active(page)).toMatchObject({ tag: 'BUTTON', toggle: 'days', key: newest.key });
    await expect(daysBtn(page, newest.key)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await expect(daysBtn(page, newest.key)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('tbody[data-group="day"]')).toHaveCount(0);
    expect(await active(page)).toMatchObject({ toggle: 'days', key: newest.key }); // still on the same button
    await page.keyboard.press('Space');
    await expect(daysBtn(page, newest.key)).toHaveAttribute('aria-expanded', 'true');
    expect(await active(page)).toMatchObject({ toggle: 'days', key: newest.key });
    await expect(page.locator('tbody[data-group="day"]')).toHaveCount(newest.days.length);
    // the next stop is the models button of the same row
    await page.keyboard.press('Tab');
    expect(await active(page)).toMatchObject({ toggle: 'models', key: newest.key });
    await page.keyboard.press('Enter');
    await expect(periodGroup(page, newest.key).locator('tr[data-row="model"]')).toHaveCount(newest.models.length);
    expect(await active(page)).toMatchObject({ toggle: 'models', key: newest.key });
    await page.keyboard.press('Space');
    await expect(periodGroup(page, newest.key).locator('tr[data-row="model"]')).toHaveCount(0);
    expect(await active(page)).toMatchObject({ toggle: 'models', key: newest.key });
    // a day's models button
    const d = newest.days[0] as BreakdownRow;
    await tabTo(page, `tbody[data-group="day"][data-key="${d.key}"] [data-toggle="models"]`);
    await page.keyboard.press('Enter');
    await expect(dayGroup(page, d.key).locator('tr[data-row="model"]')).toHaveCount(d.models.length);
    expect(await active(page)).toMatchObject({ toggle: 'models', key: d.key });
    // the older month
    await tabTo(page, `tbody[data-group="period"][data-key="${older.key}"] [data-toggle="days"]`);
    await page.keyboard.press('Enter');
    await expect(dayGroup(page, older.days[0]?.key ?? '')).toBeVisible();
    expect(await active(page)).toMatchObject({ toggle: 'days', key: older.key });
    // Shift+Tab walks back to the previous disclosure
    await page.keyboard.press('Shift+Tab');
    expect(await active(page)).toMatchObject({ toggle: 'models' });
  });

  test('the switch, Expand all, Collapse all, the column picker and the sort work from the keyboard', async ({ page }) => {
    await go(page);
    await page.locator('[data-bar="breakdown"] .seg__btn[data-period="month"]').focus();
    await page.keyboard.press('Tab');
    expect(await active(page)).toMatchObject({ tag: 'BUTTON', period: 'week' });
    await page.keyboard.press('Enter');
    await expect(table(page)).toHaveAttribute('data-period', 'week');
    expect(await active(page)).toMatchObject({ period: 'week' }); // focus stays on the button that was pressed
    await page.keyboard.press('Tab'); // Daily
    await page.keyboard.press('Tab');
    expect(await active(page)).toMatchObject({ id: 'breakdown-expand' });
    await page.keyboard.press('Space');
    await expect(page.locator('[data-toggle][aria-expanded="false"]')).toHaveCount(0);
    expect(await active(page)).toMatchObject({ id: 'breakdown-expand' }); // not lost when the button has nothing more to do
    await page.keyboard.press('Tab');
    expect(await active(page)).toMatchObject({ id: 'breakdown-collapse' });
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-toggle][aria-expanded="true"]')).toHaveCount(0);
    expect(await active(page)).toMatchObject({ id: 'breakdown-collapse' });
    // the column picker: Enter opens it, Tab reaches the checkboxes, Space toggles one, Escape closes it and returns to the button
    await page.keyboard.press('Tab');
    expect(await active(page)).toMatchObject({ id: 'breakdown-columns' });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('breakdown-columns')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-col'))).toBe('responses');
    await page.keyboard.press('Space');
    await expect(table(page).locator('thead th[data-col="responses"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('breakdown-columns')).toHaveAttribute('aria-expanded', 'false');
    expect(await active(page)).toMatchObject({ id: 'breakdown-columns' });
    // the sort: Tab to it, typing the first letter of a choice picks it (arrow keys open the list on a Mac)
    await page.keyboard.press('Tab');
    expect(await active(page)).toMatchObject({ id: 'breakdown-sort' });
    await page.keyboard.type('O');
    await expect(page.getByTestId('breakdown-sort')).toHaveValue('oldest');
    // restore the stored choice for the tests that follow
    await page.evaluate(() => window.localStorage.removeItem('ledger.breakdown.columns'));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// A synthetic answer for the cases the small fixture cannot show: two years of days, and events without a price.
function synthetic(days: number): Breakdown {
  const models = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-future-9'];
  const mk = (i: number, model: string): Breakdown['rows'][number]['models'][number] => {
    const priced = model !== 'claude-future-9';
    const t = 1000 + i * 3 + (model.length % 7);
    return { model, responses: 2, input: 10, output: 20, cacheWrite: 30, cacheRead: t - 60, total: t, costUsd: priced ? Math.round((t * 1.5 + 1) * 1000) / 1e6 : 0, unpriced: priced ? 0 : 2 };
  };
  const rows: BreakdownRow[] = [];
  const start = Date.UTC(2026, 9, 27);
  let grand = { responses: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, costUsd: 0, unpriced: 0 };
  for (let i = 0; i < days; i++) {
    const day = new Date(start - i * 86_400_000).toISOString().slice(0, 10);
    const ms = models.map((m) => mk(i, m));
    const t = ms.reduce((a, m) => ({ responses: a.responses + m.responses, input: a.input + m.input, output: a.output + m.output, cacheWrite: a.cacheWrite + m.cacheWrite, cacheRead: a.cacheRead + m.cacheRead, total: a.total + m.total, costUsd: a.costUsd + m.costUsd, unpriced: a.unpriced + m.unpriced }), { responses: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, costUsd: 0, unpriced: 0 });
    grand = { responses: grand.responses + t.responses, input: grand.input + t.input, output: grand.output + t.output, cacheWrite: grand.cacheWrite + t.cacheWrite, cacheRead: grand.cacheRead + t.cacheRead, total: grand.total + t.total, costUsd: grand.costUsd + t.costUsd, unpriced: grand.unpriced + t.unpriced };
    rows.push({ key: day, label: `Day ${i}`, from: day, to: day, partial: i > days - 5, models: ms, totals: t, days: [] });
  }
  const last = rows[rows.length - 1] as BreakdownRow;
  return {
    range: { from: last.key, to: (rows[0] as BreakdownRow).key, days, tz: 'UTC', archiveStart: last.key, coverageGap: false, completeFrom: last.key, partialGap: false },
    period: 'day',
    rows,
    totals: grand,
    priceTableDate: '2026-10-27',
  };
}

test.describe('large ranges and unpriced models', () => {
  test('two years of days with everything open: a page of rows at a time with Show more, never a freeze', async ({ page }) => {
    const data = synthetic(730);
    await page.route('**/api/breakdown?*', (route) => route.fulfill({ json: data }));
    await go(page, '?breakdown=day');
    // 730 closed day rows are already more than 400: the first page only
    const count = (): Promise<number> => page.locator('tbody[data-group="day"]').count();
    expect(await count()).toBeGreaterThanOrEqual(100);
    expect(await count()).toBeLessThan(200);
    await expect(page.locator('.lg__morecount')).toContainText('of 730 days');
    const t0 = Date.now();
    await page.getByTestId('breakdown-expand').click();
    await expect(page.locator('tr[data-row="model"]').first()).toBeVisible();
    expect(Date.now() - t0).toBeLessThan(4000);
    const rowsNow = await page.locator('table[data-table="breakdown"] tbody tr').count();
    expect(rowsNow).toBeLessThan(450); // 25 days of 4 rows, nowhere near 2,920
    const before = await count();
    await page.getByTestId('breakdown-more').click();
    const after = await count();
    expect(after).toBeGreaterThan(before);
    expect(await page.getByTestId('breakdown-more').evaluate((e) => e === document.activeElement)).toBe(true); // focus stays on the button
    // keep going to the end
    for (let i = 0; i < 40 && (await page.getByTestId('breakdown-more').count()) > 0; i++) await page.getByTestId('breakdown-more').click();
    await expect(page.getByTestId('breakdown-more')).toHaveCount(0);
    expect(await count()).toBe(730);
    expect(Date.now() - t0).toBeLessThan(20_000);
    // the totals row is the whole range, not the page
    await expectRow(table(page).locator('tbody[data-group="totals"] tr'), data.totals, 'totals');
    // a change of range starts again at the first page
    await page.getByTestId('breakdown-collapse').click();
    await expect(page.locator('tr[data-row="model"]')).toHaveCount(0);
  });

  test('a model without a price says No price and is never shown as zero dollars; a row that mixes them says how many it leaves out', async ({ page }) => {
    const data = synthetic(3);
    await page.route('**/api/breakdown?*', (route) => route.fulfill({ json: data }));
    await go(page, '?breakdown=day');
    const day = data.rows[0] as BreakdownRow;
    const g = dayGroup(page, day.key);
    await expect(g.locator('> tr').first().locator('td[data-col="cost"] .lg__np')).toHaveAttribute('data-unpriced', '2');
    await expect(g.locator('> tr').first().locator('td[data-col="cost"] .lg__np')).toContainText('+2 no price');
    await expect(g.locator('> tr').first().locator('td[data-col="cost"] .lg__np .sr-only')).toContainText('2 events without a listed price');
    await setOpen(modelsBtn(g), true);
    const line = g.locator('tr[data-model="claude-future-9"] td[data-col="cost"]');
    await expect(line).toHaveAttribute('data-priced', 'false');
    await expect(line).toContainText('No price');
    await expect(line).not.toContainText('$0.00');
    await expect(g.locator('tr[data-model="claude-sonnet-5-5"] td[data-col="cost"]')).toHaveAttribute('data-value', String(day.models[0]?.costUsd));
    await expect(table(page).locator('tbody[data-group="totals"] td[data-col="cost"] .lg__np')).toHaveAttribute('data-unpriced', String(data.totals.unpriced));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('layout, themes, cleanliness', () => {
  const wide = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

  test('360 px: the page never scrolls sideways, the table scrolls inside its own frame, the period column stays', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const problems = collectProblems(page);
    await go(page);
    expect(await wide(page)).toBe(false);
    await page.getByTestId('breakdown-expand').click();
    await expect(page.locator('tr[data-row="model"]').first()).toBeVisible();
    expect(await wide(page)).toBe(false);
    const frame = page.locator('.tscroll--ledger');
    const sizes = await frame.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth, right: e.getBoundingClientRect().right }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client + 100); // it scrolls, inside itself
    expect(sizes.right).toBeLessThanOrEqual(360.5);
    // scroll the frame to the right: the first column stays at its left edge
    await frame.evaluate((e) => e.scrollTo({ left: 400 }));
    expect(await frame.evaluate((e) => e.scrollLeft)).toBeGreaterThan(100);
    const pos = await page.evaluate(() => {
      const f = document.querySelector('.tscroll--ledger')?.getBoundingClientRect();
      const heads = [...document.querySelectorAll('table[data-table="breakdown"] tbody th.lg__name')].map((e) => e.getBoundingClientRect().left);
      const h = document.querySelector('table[data-table="breakdown"] thead th')?.getBoundingClientRect().left;
      return { frame: f?.left ?? -1, rows: heads, head: h ?? -1 };
    });
    expect(pos.rows.every((l) => Math.abs(l - pos.frame) < 2)).toBe(true);
    expect(Math.abs(pos.head - pos.frame)).toBeLessThan(2);
    // the numbers that scrolled into view are the ones in the API
    const api = await bd('month');
    await expectRow(periodGroup(page, (api.rows[0] as BreakdownRow).key).locator('> tr').first(), (api.rows[0] as BreakdownRow).totals, 'phone');
    // the controls and every disclosure are at least 44 px high on a phone
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('#breakdown .lg__days, #breakdown .lg__mods, #breakdown .lg__btn, #breakdown .seg__btn, #breakdown .ms__btn, #breakdown .lg__sort')]
        .filter((e) => e.checkVisibility())
        .map((e) => ({ c: e.className, h: e.getBoundingClientRect().height }))
        .filter((x) => x.h < 43.5),
    );
    expect(small).toEqual([]);
    // the card and its controls fit
    const box = await page.locator('#breakdown').boundingBox();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 999) <= 360.5).toBe(true);
    const overflowing = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#breakdown .lg__bar *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).map((e) => e.className));
    expect(overflowing).toEqual([]);
    // the column picker fits the screen too
    await page.getByTestId('breakdown-columns').click();
    const pop = await page.locator('.lg__colpop').boundingBox();
    expect((pop?.x ?? -1) >= 0 && (pop?.x ?? 0) + (pop?.width ?? 999) <= 360.5).toBe(true);
    expect(await wide(page)).toBe(false);
    expect(problems.errors).toEqual([]);
    expect(problems.failed).toEqual([]);
    expect([...problems.hosts].every((h) => h.startsWith('127.0.0.1:'))).toBe(true);
  });

  test('the header and the totals stay in view while the rows scroll inside the frame', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    const data = synthetic(120);
    await page.route('**/api/breakdown?*', (route) => route.fulfill({ json: data }));
    await go(page, '?breakdown=day');
    const frame = page.locator('.tscroll--ledger');
    await frame.evaluate((e) => e.scrollTo({ top: 600 }));
    expect(await frame.evaluate((e) => e.scrollTop)).toBeGreaterThan(300);
    const r = await page.evaluate(() => {
      const f = document.querySelector('.tscroll--ledger')?.getBoundingClientRect();
      const head = document.querySelector('table[data-table="breakdown"] thead th')?.getBoundingClientRect();
      const tot = document.querySelector('table[data-table="breakdown"] tbody[data-group="totals"] th')?.getBoundingClientRect();
      return { fTop: f?.top ?? 0, head: head?.top ?? -1, hBottom: head?.bottom ?? 0, tot: tot?.top ?? -1 };
    });
    expect(Math.abs(r.head - r.fTop)).toBeLessThan(2);
    expect(Math.abs(r.tot - r.hBottom)).toBeLessThan(3);
  });

  test('the table fits at 1440 without sideways scrolling inside its frame', async ({ page }) => {
    await go(page);
    const s = await page.locator('.tscroll--ledger').evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
    expect(s.scroll).toBeLessThanOrEqual(s.client + 1);
  });

  test('no console errors, no failed requests, nothing leaves 127.0.0.1, with every control used', async ({ page }) => {
    const problems = collectProblems(page);
    await go(page);
    await page.getByTestId('breakdown-expand').click();
    for (const p of ['week', 'day', 'month']) await page.locator(`[data-bar="breakdown"] .seg__btn[data-period="${p}"]`).click();
    await page.getByTestId('breakdown-sort').selectOption('cost');
    await page.getByTestId('breakdown-columns').click();
    await page.getByRole('checkbox', { name: 'Cost' }).uncheck();
    await page.getByRole('checkbox', { name: 'Cost' }).check();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    expect(problems.errors).toEqual([]);
    expect(problems.failed).toEqual([]);
    expect([...problems.hosts].every((h) => h.startsWith('127.0.0.1:'))).toBe(true);
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`contrast of every visible text in the ledger with a month, its days and model lines open, ${theme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
      const page = await ctx.newPage();
      await go(page);
      await page.getByTestId('breakdown-expand').click();
      await expect(page.locator('tr[data-row="model"]').first()).toBeVisible();
      // the hover state is a state too
      await page.locator('tbody[data-group="day"]').first().locator('> tr').first().hover();
      const r = await textContrastProblems(page, '#breakdown');
      expect(r.checked).toBeGreaterThan(80);
      expect(r.problems).toEqual([]);
      await ctx.close();
    });
  }

  test('reduced motion: nothing animates and the rows still open', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await go(page);
    await setOpen(modelsBtn(periodGroup(page, ((await bd('month')).rows[0] as BreakdownRow).key)), true);
    expect(await page.locator('tr[data-row="model"]').first().evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
    await ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Screenshots for a human to look at: 390, 768 and 1440 px, dark and light, a month and its days open, one day open to its models.
for (const [name, width, height] of [
  ['390', 390, 844],
  ['768', 768, 1024],
  ['1440', 1440, 900],
] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`screenshot of the ledger at ${name} ${theme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
      const page = await ctx.newPage();
      await go(page);
      const newest = ((await bd('month')).rows[0] as BreakdownRow);
      await setOpen(modelsBtn(dayGroup(page, newest.days[0]?.key ?? '')), true);
      await page.mouse.move(0, 0);
      await page.locator('#breakdown').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.locator('#breakdown').screenshot({ path: join(out, `breakdown-${name}-${theme}.png`) });
      if (name === '390') {
        await page.locator('.tscroll--ledger').evaluate((e) => e.scrollTo({ left: 420 }));
        await page.waitForTimeout(150);
        await page.locator('#breakdown').screenshot({ path: join(out, `breakdown-${name}-${theme}-scrolled.png`) });
      }
      if (name === '1440') {
        await page.locator('[data-bar="breakdown"] .seg__btn[data-period="week"]').click();
        await page.getByTestId('breakdown-expand').click();
        await page.waitForTimeout(200);
        await page.locator('#breakdown').screenshot({ path: join(out, `breakdown-${name}-${theme}-weekly-expanded.png`) });
      }
      await ctx.close();
    });
  }
}
