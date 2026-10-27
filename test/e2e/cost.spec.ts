// The API price equivalent on screen. Every dollar figure is compared with the API answer for the same filters:
// the KPI card, the Models table, the Cost metric of the three time charts, the Projects and Sessions columns, the day tooltip
// and the Prices section of Data health. Also 360 px, both themes, and screenshots for a human to look at.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Daily, DayDetail, Health, Heatmap, Hours, Models, Projects, Sessions } from '../../src/api/types.ts';
import { base, collectProblems, getJson, money, summary } from './helpers.ts';
import { textContrastProblems } from './panels.ts';

const out = join(process.cwd(), 'test-results', 'screens');
mkdirSync(out, { recursive: true });

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const long = (d: string): string => `${Number(d.slice(8))} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

async function go(page: Page, query = ''): Promise<void> {
  await page.goto(`${base()}/${query === '' ? '' : query.startsWith('?') ? query : `?${query}`}`);
  await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
  await expect(page.locator('[data-kpi="cost"]')).toBeVisible();
}

const wide = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('the API price equivalent card', () => {
  test('shows the total in dollars with cents, the exact value for scripts, and the caveat with the table date', async ({ page }) => {
    await go(page);
    const s = await summary();
    expect(s.cost.usd).toBeGreaterThan(0);
    const fig = page.locator('[data-kpi="cost"]');
    await expect(fig).toHaveText(money(s.cost.usd));
    await expect(fig).toHaveAttribute('data-usd', s.cost.usd.toFixed(6));
    await expect(fig).toHaveAttribute('data-full', money(s.cost.usd));
    await expect(page.locator('article.card--cost .card__label')).toHaveText('API price equivalent');
    await expect(page.locator('[data-kpi="cost.caveat"]')).toHaveText(`At list API prices of ${long(s.cost.priceTableDate)}. Not what you paid.`);
    // the full value is the accessible name of the figure (the card is labelled by its heading)
    const name = await page.getByRole('img', { name: /^\$[\d,]+\.\d{2,6}$/ }).first().getAttribute('aria-label');
    expect(Number((name ?? '').replace(/[$,]/g, ''))).toBeCloseTo(s.cost.usd, 5);
    // the averages are plain ratios of API numbers
    await expect(page.locator('[data-kpi="costPerDay"]')).toHaveText(money(s.activeDays > 0 ? s.cost.usd / s.activeDays : 0));
    await expect(page.locator('[data-kpi="costPerSession"]')).toHaveText(money(s.sessions > 0 ? s.cost.usd / s.sessions : 0));
    // every model of the fixture has a price: no note about unpriced responses, no background note
    expect(s.cost.unpricedResponses).toBe(0);
    await expect(page.locator('[data-kpi="cost.unpriced"]')).toHaveCount(0);
    await expect(page.locator('[data-kpi="cost.background"]')).toHaveCount(0);
  });

  test('follows the filters: a model and a range', async ({ page }) => {
    await go(page, '?models=claude-opus-5-5');
    const opus = await summary('models=claude-opus-5-5');
    await expect(page.locator('[data-kpi="cost"]')).toHaveText(money(opus.cost.usd));
    const all = await summary();
    expect(opus.cost.usd).toBeLessThan(all.cost.usd);
    await page.getByRole('button', { name: '7d' }).click();
    const q = new URL(page.url()).searchParams.toString();
    const week = await summary(q);
    await expect(page.locator('[data-kpi="cost"]')).toHaveText(money(week.cost.usd));
    await expect(page.locator('[data-kpi="cost"]')).toHaveAttribute('data-usd', week.cost.usd.toFixed(6));
  });

  test('a value under one cent says so, and the exact value is its accessible name', async ({ page }) => {
    // one Haiku day: a few thousand tokens at $0.10 and $0.50 per million
    const days = (await getJson<Daily>('/api/daily?metric=cost&models=claude-haiku-5-5')).days.filter((d) => d.total > 0 && d.total < 0.01);
    expect(days.length).toBeGreaterThan(0);
    const day = (days[0] as { day: string }).day;
    const q = `models=claude-haiku-5-5&from=${day}&to=${day}`;
    await go(page, `?${q}`);
    const s = await summary(q);
    expect(s.cost.usd).toBeGreaterThan(0);
    expect(s.cost.usd).toBeLessThan(0.01);
    const fig = page.locator('[data-kpi="cost"]');
    await expect(fig).toHaveText('<$0.01');
    await expect(fig).toHaveAttribute('data-usd', s.cost.usd.toFixed(6));
    const name = await fig.locator('[role="img"]').getAttribute('aria-label');
    expect(name).toMatch(/^\$0\.0\d{2,6}$/);
    expect(Number((name ?? '').replace('$', ''))).toBeCloseTo(s.cost.usd, 6);
    await expect(page.locator('[data-kpi="costPerSession"]')).toHaveText('<$0.01');
  });

  test('background calls: the card says what they add, from Claude Code\'s own cost record', async ({ page }) => {
    await go(page, '?includeBackground=1');
    const s = await summary('includeBackground=1');
    expect(s.cost.backgroundUsd).toBeGreaterThan(0);
    await expect(page.locator('[data-kpi="cost"]')).toHaveText(money(s.cost.usd));
    await expect(page.locator('[data-kpi="cost.background"]')).toContainText(`Includes ${money(s.cost.backgroundUsd ?? 0)} from background calls`);
    const plain = await summary();
    expect(s.cost.usd).toBeCloseTo(plain.cost.usd + (s.cost.backgroundUsd ?? 0), 9);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('Models, Projects and Sessions', () => {
  test('the Models table cost and cost share equal /api/models, the total row equals the card, and the column sorts', async ({ page }) => {
    await go(page);
    const api = await getJson<Models>('/api/models');
    const rows = await page.locator('tbody[data-group="models"] tr[data-model]').evaluateAll((trs) =>
      trs.map((tr) => {
        const tds = [...tr.querySelectorAll('td')];
        return { model: tr.getAttribute('data-model'), cost: tds[7]?.getAttribute('data-value'), costText: (tds[7]?.textContent ?? '').trim(), share: tds[8]?.getAttribute('data-value'), shareText: (tds[8]?.textContent ?? '').trim(), title: tds[7]?.getAttribute('title') };
      }),
    );
    expect(rows.map((r) => r.model)).toEqual(api.rows.map((r) => r.model));
    expect(rows.map((r) => r.cost)).toEqual(api.rows.map((r) => String(r.costUsd)));
    expect(rows.map((r) => r.costText)).toEqual(api.rows.map((r) => money(r.costUsd ?? 0)));
    expect(rows.map((r) => r.share)).toEqual(api.rows.map((r) => String(r.costShare)));
    expect(rows.map((r) => r.shareText)).toEqual(api.rows.map((r) => `${(r.costShare * 100).toFixed(1)}%`));
    expect(api.rows.reduce((a, r) => a + r.costShare, 0)).toBeCloseTo(1, 9);
    const s = await summary();
    await expect(page.locator('tr[data-total="models"] td').nth(7)).toHaveText(money(s.cost.usd));
    // the cost share is a bar, the same shape as the token share
    expect(await page.locator('tr[data-model] td[data-share="cost"] .share__bar').count()).toBe(api.rows.length);
    await expect(page.locator('#models-cost-note')).toContainText(`at list API prices of ${long(s.cost.priceTableDate)}. Not what you paid.`);
    // sort by cost: largest first, then flipped
    await page.locator('#models').getByRole('button', { name: 'Sort by cost', exact: true }).click();
    const order = async (): Promise<string[]> => page.locator('tbody[data-group="models"] tr[data-model]').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-model') ?? ''));
    expect(await order()).toEqual([...api.rows].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1)).map((r) => r.model));
    await page.locator('#models').getByRole('button', { name: 'Sort by cost', exact: true }).click();
    expect(await order()).toEqual([...api.rows].sort((a, b) => (a.costUsd ?? -1) - (b.costUsd ?? -1)).map((r) => r.model));
  });

  test('background rows carry Claude Code\'s own cost and no share', async ({ page }) => {
    await go(page, '?includeBackground=1');
    const api = await getJson<Models>('/api/models?includeBackground=1');
    expect(api.background.length).toBeGreaterThan(0);
    const rows = await page.locator('tbody[data-group="background"] tr[data-background-model]').evaluateAll((trs) =>
      trs.map((tr) => ({ model: tr.getAttribute('data-background-model'), cost: [...tr.querySelectorAll('td')][7]?.getAttribute('data-value'), text: ([...tr.querySelectorAll('td')][7]?.textContent ?? '').trim() })),
    );
    expect(rows).toEqual(api.background.map((r) => ({ model: r.model, cost: String(r.costUsd), text: money(r.costUsd) })));
    // the total row still adds up the transcript models only
    const total = await page.locator('tr[data-total="models"] td').nth(7).getAttribute('data-value');
    expect(Number(total)).toBeCloseTo(
      api.rows.reduce((a, r) => a + (r.costUsd ?? 0), 0),
      9,
    );
  });

  test('Projects and Sessions have a cost column equal to the API', async ({ page }) => {
    await go(page);
    const projects = await getJson<Projects>('/api/projects');
    const pr = await page.locator('table[data-table="projects"] tbody tr[data-project]').evaluateAll((trs) => trs.map((tr) => [tr.getAttribute('data-project'), tr.querySelector('td.dt__cost')?.getAttribute('data-value'), (tr.querySelector('td.dt__cost')?.textContent ?? '').trim()]));
    expect(pr).toEqual(projects.rows.map((r) => [r.projectKey, String(r.costUsd), money(r.costUsd)]));
    await page.locator('#projects').getByRole('button', { name: 'Sort by cost', exact: true }).click();
    const order = await page.locator('table[data-table="projects"] tbody tr[data-project]').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-project')));
    expect(order).toEqual([...projects.rows].sort((a, b) => b.costUsd - a.costUsd).map((r) => r.projectKey));

    const sessions = await getJson<Sessions>('/api/sessions?page=1&pageSize=50&sort=start');
    const sr = await page.locator('table[data-table="sessions"] tbody tr[data-session]').evaluateAll((trs) => trs.map((tr) => [tr.getAttribute('data-session'), tr.querySelector('td.dt__cost')?.getAttribute('data-value'), (tr.querySelector('td.dt__cost')?.textContent ?? '').trim()]));
    expect(sr).toEqual(sessions.rows.map((r) => [r.sessionId, String(r.costUsd), money(r.costUsd)]));
    await expect(page.locator('table[data-table="sessions"] thead th', { hasText: 'Cost' })).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('the Cost metric of the time charts', () => {
  test('the switch has a Cost button kept in the address; the three charts say what they count', async ({ page }) => {
    await go(page);
    await page.locator('[data-metric="cost"]').click();
    await expect(page).toHaveURL(/metric=cost/);
    await expect(page.locator('[data-metric="cost"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-chart="heatmap"] .chart__sub')).toContainText('Cost (API price equivalent) per day');
    await expect(page.locator('[data-chart="daily"] .chart__sub')).toContainText('Cost by model');
    await expect(page.locator('[data-chart="hours"] .chart__sub')).toContainText('Cost by local hour');
    await page.reload();
    await expect(page.locator('[data-metric="cost"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('heatmap cells, daily segments and hour bars equal the API; the axes are in dollars', async ({ page }) => {
    await go(page, '?metric=cost');
    await expect(page.locator('[data-chart="daily"] path.dc__seg').first()).toBeAttached();
    const hm = await getJson<Heatmap>('/api/heatmap?metric=cost');
    const cells = await page.locator('[data-chart="heatmap"] g.hm__c[data-state="value"]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-day'), e.getAttribute('data-value')]));
    expect([...cells].sort()).toEqual(hm.cells.filter((c) => !c.beforeArchive && !c.afterToday).map((c) => [c.day, String(c.value)]).sort());
    expect(hm.cells.some((c) => c.value > 0 && c.value < 1)).toBe(true);

    const daily = await getJson<Daily>('/api/daily?metric=cost');
    const segs = await page.locator('[data-chart="daily"] path.dc__seg').evaluateAll((els) => els.map((e) => [e.getAttribute('data-day') ?? '', e.getAttribute('data-model') ?? '', e.getAttribute('data-value') ?? ''].join('|')));
    const want = daily.days.flatMap((d) => daily.models.filter((m) => (d.byModel[m] ?? 0) > 0).map((m) => [d.day, m, String(d.byModel[m])].join('|')));
    expect([...segs].sort()).toEqual([...want].sort());
    await expect(page.locator('[data-chart="daily"] .legend li[data-series]')).toHaveText(daily.models);
    await expect(page.getByRole('checkbox', { name: 'Hide cache reads' })).toHaveCount(0);
    const ticks = await page.locator('[data-chart="daily"] .ax__t').allTextContents();
    expect(ticks.filter((t) => t.startsWith('$')).length).toBeGreaterThan(1);
    expect(ticks.filter((t) => /^\$\d+(\.\d+)?[KM]?$/.test(t)).length).toBeGreaterThan(1);

    const hours = await getJson<Hours>('/api/hours?metric=cost');
    const bars = await page.locator('[data-chart="hours"] .dc__seg').evaluateAll((els) => els.map((e) => [Number(e.getAttribute('data-hour')), Number(e.getAttribute('data-value'))]));
    expect(bars).toEqual(hours.hours.map((h) => [h.hour, h.value]));
    const hticks = await page.locator('[data-chart="hours"] .ax__t').allTextContents();
    expect(hticks.some((t) => t.startsWith('$'))).toBe(true);
    // together they add up to the key figure
    const s = await summary();
    expect(daily.days.reduce((a, d) => a + d.total, 0)).toBeCloseTo(s.cost.usd, 9);
    expect(hours.hours.reduce((a, h) => a + h.value, 0)).toBeCloseTo(s.cost.usd, 9);
  });

  test('the colour scale names dollars, the table views show dollars, the day tooltip lists each session\'s cost', async ({ page }) => {
    await go(page, '?metric=cost');
    const hm = await getJson<Heatmap>('/api/heatmap?metric=cost');
    const items = await page.locator('[data-chart="heatmap"] .hm__scale li').allTextContents();
    expect(items[0]).toContain('$0');
    expect(items.some((t) => t.startsWith('Up to $'))).toBe(true);
    expect(items.filter((t) => /^(Up to|\$)/.test(t) || t === '$0').length).toBeGreaterThan(1);
    expect(items.slice(1).filter((t) => !/Possibly incomplete|Before the archive/.test(t)).every((t) => t.includes('$'))).toBe(true);
    expect(hm.thresholds.length).toBe(4);

    // the busiest day: its readout has the day's cost and a cost beside every listed session
    const busiest = hm.cells.reduce((a, c) => (c.value > a.value ? c : a));
    await page.locator(`g.hm__c[data-day="${busiest.day}"]`).scrollIntoViewIfNeeded();
    await page.locator(`g.hm__c[data-day="${busiest.day}"]`).hover();
    const tip = page.locator('#hm-tip');
    await expect(tip).toContainText(money(busiest.value));
    const detail = await getJson<DayDetail>(`/api/day?date=${busiest.day}`);
    await expect(tip.locator('li')).toHaveCount(Math.min(5, detail.sessions.length));
    const shown = await tip.locator('li .ctip__cost').allTextContents();
    expect(shown).toEqual(detail.sessions.slice(0, 5).map((x) => money(x.costUsd)));
    await page.mouse.move(0, 0);

    // table views
    await page.getByTestId('heatmap-table-toggle').click();
    await expect(page.locator(`table[data-table="heatmap"] td[data-day="${busiest.day}"]`)).toHaveText(money(busiest.value));
    await page.getByTestId('heatmap-table-toggle').click();
    await page.getByTestId('daily-table-toggle').click();
    const daily = await getJson<Daily>('/api/daily?metric=cost');
    const row = daily.days.find((d) => d.day === busiest.day) as Daily['days'][number];
    await expect(page.locator(`table[data-table="daily"] tr[data-day="${busiest.day}"] td[data-total]`)).toHaveText(money(row.total));
    await page.getByTestId('hours-table-toggle').click();
    const hours = await getJson<Hours>('/api/hours?metric=cost');
    const peak = hours.hours.reduce((a, h) => (h.value > a.value ? h : a));
    await expect(page.locator(`table[data-table="hours"] tr[data-hour="${peak.hour}"] td`)).toHaveText(money(peak.value));
  });

  test('the daily and hour tooltips give dollars per model and in total', async ({ page }) => {
    await go(page, '?metric=cost');
    const daily = await getJson<Daily>('/api/daily?metric=cost');
    const busiest = daily.days.reduce((a, b) => (b.total > a.total ? b : a));
    const i = daily.days.findIndex((d) => d.day === busiest.day);
    await page.locator('[data-chart="daily"] .dc__hit').scrollIntoViewIfNeeded();
    const box = await page.locator('[data-chart="daily"] .dc__hit').boundingBox();
    const step = (box as { width: number }).width / daily.days.length;
    await page.mouse.move((box as { x: number }).x + (i + 0.5) * step, (box as { y: number }).y + 40);
    const tip = page.locator('[data-chart="daily"] .ctip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(long(busiest.day));
    for (const m of daily.models) {
      const v = busiest.byModel[m] ?? 0;
      if (v > 0) await expect(tip).toContainText(`${money(v)}${m}`);
    }
    if (daily.models.filter((m) => (busiest.byModel[m] ?? 0) > 0).length > 1) await expect(tip).toContainText(`${money(busiest.total)} total`);
    await page.mouse.move(0, 0);

    const hours = await getJson<Hours>('/api/hours?metric=cost');
    const peak = hours.hours.reduce((a, h) => (h.value > a.value ? h : a));
    await page.locator('[data-chart="hours"] .dc__hit').scrollIntoViewIfNeeded();
    const hb = await page.locator('[data-chart="hours"] .dc__hit').boundingBox();
    await page.mouse.move((hb as { x: number }).x + (peak.hour + 0.5) * ((hb as { width: number }).width / 24), (hb as { y: number }).y + 60);
    await expect(page.locator('[data-chart="hours"] .ctip')).toContainText(money(peak.value));
  });

  test('filters reach the Cost charts', async ({ page }) => {
    await go(page, '?metric=cost&models=claude-opus-5-5');
    const daily = await getJson<Daily>('/api/daily?metric=cost&models=claude-opus-5-5');
    expect(daily.models).toEqual(['claude-opus-5-5']);
    const total = (await page.locator('[data-chart="daily"] path.dc__seg').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-value'))))).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(daily.days.reduce((a, d) => a + d.total, 0), 9);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('Data health prices', () => {
  test('the Prices section and its check line say what /api/health says', async ({ page }) => {
    await page.goto(`${base()}/#health`);
    await expect(page.getByTestId('health-body')).toBeVisible();
    const h = await getJson<Health>('/api/health');
    expect(h.prices.unpricedModels).toEqual([]);
    const check = page.locator('.checks__row[data-check="prices"]');
    await expect(check).toHaveAttribute('data-verdict', 'ok');
    await expect(check.locator('.checks__word')).toHaveText('OK');
    await expect(check.locator('svg.vs')).toHaveCount(1);
    await expect(check).toContainText(`price in the table of ${long(h.prices.tableDate)}`);
    const sec = page.locator('[data-hp="prices"]');
    await expect(sec.locator('h3')).toHaveText('Prices');
    await expect(sec.locator('[data-kv="table-date"] dd')).toHaveText(long(h.prices.tableDate));
    await expect(sec.locator('[data-kv="unpriced-models"] dd')).toHaveText('None');
    await expect(sec.locator('[data-kv="remainder"] dd')).toHaveText(`${h.prices.cacheWriteRemainderEvents} responses`);
    await expect(page.getByTestId('prices-summary')).toContainText('Every archived model has a price');
    await expect(sec.locator('table[data-table="health-unpriced"]')).toHaveCount(0);
  });

  test('the Cost definition is listed with the API wording', async ({ page }) => {
    await go(page);
    await page.getByRole('button', { name: 'Definitions' }).click();
    const item = page.locator('[data-definition="api-price-equivalent"]');
    await expect(item.locator('dt')).toHaveText('API price equivalent');
    await expect(item.locator('dd')).toContainText('It is not what you paid');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
test.describe('layout, themes, cleanliness', () => {
  test('360 px: the page never scrolls sideways with the Cost metric, the card fits, the new columns scroll inside their frames', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const problems = collectProblems(page);
    await go(page, '?metric=cost&includeBackground=1');
    await expect(page.locator('[data-chart="daily"] path.dc__seg').first()).toBeAttached();
    expect(await wide(page)).toBe(false);
    const card = await page.locator('article.card--cost').boundingBox();
    expect((card?.x ?? -1) >= 0 && (card?.x ?? 0) + (card?.width ?? 999) <= 360).toBe(true);
    // the figure is whole or compact with the exact value, never cut off
    const fig = await page.locator('[data-kpi="cost"]').evaluate((e) => ({ over: e.scrollWidth > e.clientWidth + 1, text: e.textContent }));
    expect(fig.over).toBe(false);
    for (const id of ['heatmap', 'daily', 'hours']) {
      await page.getByTestId(`${id}-table-toggle`).click();
      expect(await wide(page)).toBe(false);
    }
    const frames = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.tscroll')].map((f) => f.getBoundingClientRect().right <= window.innerWidth + 0.5));
    expect(frames.every(Boolean)).toBe(true);
    expect(problems.errors).toEqual([]);
    expect(problems.failed).toEqual([]);
    expect([...problems.hosts].every((h) => h.startsWith('127.0.0.1:'))).toBe(true);
  });

  test('the cost card is in the key figures at every width and stays out of the way of the token card', async ({ page }) => {
    for (const w of [390, 768, 1100, 1440]) {
      await page.setViewportSize({ width: w, height: 900 });
      await go(page);
      const boxes = await page.evaluate(() => Object.fromEntries(['sessions', 'messages', 'days', 'cost', 'tokens'].map((k) => [k, document.querySelector(`.card--${k}`)?.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number; right: number; bottom: number }])));
      const list = Object.entries(boxes);
      expect(list.every(([, b]) => b.width > 100 && b.x >= 0 && b.right <= w + 0.5)).toBe(true);
      // no two cards overlap
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const p = list[a]?.[1] as { x: number; y: number; right: number; bottom: number };
          const q = list[b]?.[1] as { x: number; y: number; right: number; bottom: number };
          const overlap = p.x < q.right - 0.5 && q.x < p.right - 0.5 && p.y < q.bottom - 0.5 && q.y < p.bottom - 0.5;
          expect(overlap, `${list[a]?.[0]} and ${list[b]?.[0]} at ${w}`).toBe(false);
        }
      }
      expect(await wide(page)).toBe(false);
      if (w >= 1100) expect(Math.abs((boxes['cost']?.y ?? 0) - (boxes['sessions']?.y ?? 99))).toBeLessThan(1); // one row of four
    }
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`contrast of every visible text with the Cost metric, the card and the new columns, ${theme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
      const page = await ctx.newPage();
      await go(page, '?metric=cost&includeBackground=1');
      await expect(page.locator('[data-chart="daily"] path.dc__seg').first()).toBeAttached();
      await page.getByRole('button', { name: 'Data health' }).click();
      await expect(page.getByTestId('health-body')).toBeVisible();
      await page.waitForTimeout(300);
      const r = await textContrastProblems(page);
      expect(r.checked).toBeGreaterThan(300);
      expect(r.problems).toEqual([]);
      // the hover readout too
      const cells = page.locator('g.hm__c[data-state="value"]');
      await cells.nth(Math.max(0, (await cells.count()) - 2)).hover();
      await page.waitForTimeout(300);
      expect((await textContrastProblems(page, '#hm-tip')).problems).toEqual([]);
      await ctx.close();
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// Screenshots for a human to look at: 390, 768 and 1440, dark and light.
for (const [name, width, height] of [
  ['390', 390, 844],
  ['768', 768, 1000],
  ['1440', 1440, 900],
] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`screenshots of the cost card, the Cost charts and the cost columns at ${name} ${theme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
      const page = await ctx.newPage();
      await go(page, '?metric=cost&includeBackground=1');
      await expect(page.locator('[data-chart="daily"] path.dc__seg').first()).toBeAttached();
      await expect(page.locator('table[data-table="models"]')).toBeVisible();
      await page.waitForTimeout(300);
      await page.locator('section[aria-labelledby="h-figures"]').screenshot({ path: join(out, `${name}-${theme}-cost-kpis.png`) });
      await page.locator('.slots').first().scrollIntoViewIfNeeded();
      for (const id of ['heatmap', 'daily', 'hours', 'models', 'projects', 'sessions']) {
        await page.locator(`[data-chart="${id}"]`).scrollIntoViewIfNeeded();
        await page.locator(`[data-chart="${id}"]`).screenshot({ path: join(out, `${name}-${theme}-cost-${id}.png`) });
      }
      const cell = page.locator('g.hm__c[data-state="value"]').nth(30);
      await cell.scrollIntoViewIfNeeded();
      await page.locator('[data-chart="heatmap"] g.hm__c[tabindex="0"]').hover();
      await page.waitForTimeout(400);
      await page.locator('[data-chart="heatmap"]').screenshot({ path: join(out, `${name}-${theme}-cost-heatmap-tip.png`) });
      await ctx.close();
    });
  }
}
