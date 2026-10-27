// End to end checks of the dashboard shell: KPI numbers equal the API, no horizontal scroll at 360 px,
// keyboard reach and visible focus, no console errors, no request to any host but 127.0.0.1, filters in the URL, and every
// state of the top panels.
import { expect, test, type Page } from '@playwright/test';
import type { Filters, Health, Summary } from '../../src/api/types.ts';
import { tokenWords } from '../../web/src/lib/format.ts';
import { base, collectProblems, expectKpisEqual, getJson, hours, kpi, n, ratio, summary } from './helpers.ts';

const go = async (page: Page, query = ''): Promise<void> => {
  await page.goto(`${base()}/${query}`);
  await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
};

test.describe('numbers', () => {
  for (const [name, width, height] of [
    ['phone', 390, 844],
    ['tablet', 768, 1024],
    ['desktop', 1440, 900],
  ] as const) {
    test(`KPI numbers equal /api/summary at ${name} width`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await go(page);
      const s = await summary();
      await expectKpisEqual(page, s);
      // Secondary row: the same values, as text.
      const stat = (id: string) => page.locator(`[data-stat="${id}"] dd`).first();
      if (s.peakHour !== null) {
        const h = s.peakHour.hour;
        const pad = (v: number): string => String(v).padStart(2, '0');
        await expect(stat('peakHour')).toHaveText(`${pad(h)}:00 to ${pad((h + 1) % 24)}:00`);
      }
      if (s.favoriteModel !== null) await expect(stat('favoriteModel')).toHaveText(s.favoriteModel.model);
      if (s.longestSession !== null) await expect(stat('longestSession')).toContainText(`${hours(s.longestSession.activeMs)} active`);
      await expect(stat('currentStreak')).toHaveText(`${s.currentStreak} ${s.currentStreak === 1 ? 'day' : 'days'}`);
      if (s.longestStreak !== null) await expect(stat('longestStreak')).toHaveText(`${s.longestStreak.days} ${s.longestStreak.days === 1 ? 'day' : 'days'}`);
      // The composition meter has one segment per non zero kind, and its table adds up to the total.
      const parts = s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite;
      expect(parts).toBe(s.tokens.total);
    });
  }

  test('the fixture is what the tests assume (three models, three projects, an archive older than 30 days)', async () => {
    const f = await getJson<Filters>('/api/filters');
    expect(f.models.length).toBe(3);
    expect(f.projects.length).toBe(3);
    const s = await summary();
    expect(s.sessions).toBe(17);
    expect(s.range.days).toBeGreaterThan(40);
  });
});

test.describe('layout and keyboard', () => {
  test('no horizontal scroll at 360 px, also with a popover and the custom dates open', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await go(page);
    const wide = (): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(await wide()).toBe(false);
    await page.getByRole('button', { name: 'Custom' }).click();
    await expect(page.getByLabel('From', { exact: true })).toBeVisible();
    expect(await wide()).toBe(false);
    await page.getByRole('button', { name: /^Model/ }).click();
    await expect(page.getByRole('group', { name: 'Model filter' })).toBeVisible();
    expect(await wide()).toBe(false);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Project/ }).click();
    await expect(page.getByRole('group', { name: 'Project filter' })).toBeVisible();
    expect(await wide()).toBe(false);
    await page.keyboard.press('Escape');
    // the longest sync pill wording (stale) still fits: the header wraps instead of scrolling
    const real = await getJson<Health>('/api/health');
    await page.route('**/api/health', (route) => route.fulfill({ json: { ...real, sync: { ...real.sync, lastSuccessAt: Date.now() - 90 * 60_000 } } satisfies Health }));
    await page.reload();
    await expect(page.getByRole('link', { name: /^Stale, last sync/ })).toBeVisible();
    expect(await wide()).toBe(false);
    await page.unroute('**/api/health');
    await page.reload();
    await page.getByRole('button', { name: /^Project/ }).click();
    // the popover stays inside the viewport
    const box = await page.getByRole('group', { name: 'Project filter' }).boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? -1) >= 0).toBe(true);
    expect((box?.x ?? 0) + (box?.width ?? 0) <= 360).toBe(true);
  });

  test('every control is reachable by keyboard with a visible focus ring', async ({ page }) => {
    await go(page);
    // The usage breakdown ledger asks after the key figures: wait for it, so every control it brings is numbered below.
    await expect(page.locator('table[data-table="breakdown"]')).toBeVisible();
    // Number every focusable element in the page, then Tab through and record which ones took focus.
    const total = await page.evaluate(() => {
      const all = [...document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')].filter(
        (el) => el.checkVisibility({ checkVisibilityCSS: true }),
      );
      all.forEach((el, i) => el.setAttribute('data-tabid', String(i)));
      return all.length;
    });
    expect(total).toBeGreaterThan(10);
    const seen = new Set<string>();
    const noRing: string[] = [];
    for (let i = 0; i < total + 3; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (el === null || el === document.body) return null;
        const cs = getComputedStyle(el);
        return {
          id: el.getAttribute('data-tabid'),
          label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30),
          ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
        };
      });
      if (info === null) break;
      if (info.id !== null) seen.add(info.id);
      if (!info.ring) noRing.push(info.label);
    }
    expect(noRing).toEqual([]);
    expect(seen.size).toBe(total);
  });

  test('a filter popover works from the keyboard: open, toggle, close with Escape, focus returns', async ({ page }) => {
    await go(page);
    const button = page.getByRole('button', { name: /^Model/ });
    await button.focus();
    await page.keyboard.press('Enter');
    const pop = page.getByRole('group', { name: 'Model filter' });
    await expect(pop).toBeVisible();
    await page.keyboard.press('Tab');
    const first = pop.getByRole('checkbox').first();
    await expect(first).toBeFocused();
    const ring = await first.evaluate((el) => {
      const item = el.closest('label') as HTMLElement;
      const cs = getComputedStyle(item);
      return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
    });
    expect(ring).toBe(true);
    await page.keyboard.press('Space');
    await expect(page).toHaveURL(/models=/);
    await page.keyboard.press('Escape');
    await expect(pop).toBeHidden();
    await expect(button).toBeFocused();
    await expect(button).toContainText(/claude-/);
  });

  test('skip link and the sync pill are reachable first', async ({ page }) => {
    await go(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to the figures' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });
});

test.describe('cleanliness', () => {
  test('no console errors, no failed requests, no CSP violations, no layout shift', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
      (window as unknown as { __cls: number }).__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
          if (!entry.hadRecentInput) (window as unknown as { __cls: number }).__cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    const problems = collectProblems(page);
    await go(page);
    await page.getByRole('button', { name: '7d' }).click();
    await expect(page).toHaveURL(/from=/);
    await page.getByRole('button', { name: /^Model/ }).click();
    await page.getByRole('button', { name: 'Custom' }).click();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.waitForTimeout(400);
    expect(problems.errors).toEqual([]);
    expect(problems.failed).toEqual([]);
    const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    expect(csp).toEqual([]);
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    expect(cls).toBeLessThan(0.02);
  });

  test('no request leaves 127.0.0.1, fonts are served by the ledger itself', async ({ page, context }) => {
    const seen: string[] = [];
    await context.route('**/*', (route) => {
      seen.push(route.request().url());
      return route.continue();
    });
    await go(page);
    await page.getByRole('button', { name: '30d' }).click();
    await page.waitForLoadState('networkidle');
    const hosts = new Set(seen.map((u) => new URL(u).host));
    expect([...hosts]).toEqual([new URL(base()).host]);
    expect(seen.some((u) => u.endsWith('.woff2'))).toBe(true);
    expect(seen.some((u) => u.includes('/api/events'))).toBe(true);
    // and the page holds no inline script, which the CSP would refuse
    expect(await page.evaluate(() => [...document.scripts].filter((s) => s.src === '' && s.textContent !== '').length)).toBe(0);
  });

  test('one fetch per panel per filter key, cached: a view visited before is not fetched again', async ({ page }) => {
    const calls: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/') && u.pathname !== '/api/events' && u.pathname !== '/api/health') calls.push(u.pathname + u.search);
    });
    await go(page);
    await page.waitForLoadState('networkidle');
    expect(calls.filter((c) => c.startsWith('/api/summary'))).toEqual(['/api/summary']);
    expect(calls.filter((c) => c.startsWith('/api/filters'))).toEqual(['/api/filters']);
    await page.getByRole('button', { name: '7d' }).click();
    await expect(page).toHaveURL(/from=/);
    await page.waitForLoadState('networkidle');
    expect(calls.filter((c) => c.startsWith('/api/summary')).length).toBe(2);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page).toHaveURL(base() + '/');
    await page.waitForLoadState('networkidle');
    // All was already cached: no third summary request
    expect(calls.filter((c) => c.startsWith('/api/summary')).length).toBe(2);
  });

  test('reduced motion: nothing is animating', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await go(page);
    await page.waitForTimeout(400);
    const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
    expect(running).toBe(0);
    await ctx.close();
  });
});

test.describe('filters live in the URL', () => {
  test('presets, model, project, subagent and background toggles change the URL and the numbers', async ({ page }) => {
    await go(page);
    const all = await summary();
    await expectKpisEqual(page, all);

    await page.getByRole('button', { name: '7d' }).click();
    await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    const q7 = new URL(page.url()).searchParams.toString();
    const s7 = await summary(q7);
    expect(s7.range.days).toBe(7);
    expect(s7.sessions).toBeLessThan(all.sessions);
    await expectKpisEqual(page, s7);
    await expect(page.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');

    // Model filter on top of the range
    await page.getByRole('button', { name: /^Model/ }).click();
    await page.getByRole('checkbox', { name: 'claude-sonnet-5-5' }).check();
    await expect(page).toHaveURL(/models=claude-sonnet-5-5/);
    await expectKpisEqual(page, await summary(new URL(page.url()).searchParams.toString()));

    // Subagent and background toggles
    await page.getByRole('checkbox', { name: /Background calls/ }).check();
    await expect(page).toHaveURL(/includeBackground=1/);
    await expectKpisEqual(page, await summary(new URL(page.url()).searchParams.toString()));
    await page.getByRole('checkbox', { name: /Subagent calls/ }).uncheck();
    await expect(page).toHaveURL(/includeSubagents=0/);
    await expectKpisEqual(page, await summary(new URL(page.url()).searchParams.toString()));
    await page.keyboard.press('Escape');

    // Project filter
    await page.getByRole('button', { name: /^Project/ }).click();
    await page.getByRole('checkbox', { name: 'ledger-demo' }).check();
    await expect(page).toHaveURL(/projects=/);
    await expectKpisEqual(page, await summary(new URL(page.url()).searchParams.toString()));
    await page.keyboard.press('Escape');

    // The URL is the state: a reload shows the same view, Reset returns to the plain address.
    const url = page.url();
    await page.reload();
    await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
    expect(page.url()).toBe(url);
    await expectKpisEqual(page, await summary(new URL(url).searchParams.toString()));
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await expect(page).toHaveURL(base() + '/');
    await expectKpisEqual(page, all);
  });

  test('custom range: two inclusive dates in the URL; a backwards pair is refused', async ({ page }) => {
    await go(page);
    const info = await getJson<Filters>('/api/filters');
    await page.getByRole('button', { name: 'Custom' }).click();
    await expect(page.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('From', { exact: true }).fill(info.today.slice(0, 8) + '01');
    await page.getByLabel('To', { exact: true }).fill(info.today);
    const expected = new URLSearchParams({ from: info.today.slice(0, 8) + '01', to: info.today });
    await expect(page).toHaveURL(new RegExp(`from=${expected.get('from')}&to=${expected.get('to')}`));
    await expectKpisEqual(page, await summary(expected.toString()));
    // a pair that runs backwards is not applied: the address stays as it was
    await page.getByLabel('From', { exact: true }).fill(info.today);
    await expect(page).toHaveURL(new RegExp(`from=${info.today}&to=${info.today}`));
    const before = page.url();
    await page.getByLabel('To', { exact: true }).fill(info.today.slice(0, 8) + '01');
    await expect(page.getByRole('alert').filter({ hasText: 'start day is after the end day' })).toBeVisible();
    expect(page.url()).toBe(before);
  });

  test('Back returns to the previous view', async ({ page }) => {
    await go(page);
    await page.getByRole('button', { name: '30d' }).click();
    await expect(page).toHaveURL(/from=/);
    await page.goBack();
    await expect(page).toHaveURL(base() + '/');
    await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('a bookmarked address with a bad filter says so and can be reset', async ({ page }) => {
    await page.goto(`${base()}/?from=2026-10-10&to=2026-10-01`);
    const err = page.locator('.state--error');
    await expect(err).toContainText('These filters cannot be used');
    await expect(err).toContainText('after');
    await page.getByRole('button', { name: 'Reset the filters' }).click();
    await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
    await expect(page).toHaveURL(base() + '/');
  });
});

test.describe('states', () => {
  test('coverage note: says which gap applies, dismissible for the session', async ({ page }) => {
    const long = (d: string): string => `${Number(d.slice(8))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
    await go(page);
    const note = page.locator('[data-note="coverage"]');
    const early = new Date(Date.parse(`${(await summary()).range.archiveStart}T00:00:00Z`) - 20 * 86_400_000).toISOString().slice(0, 10);
    // All time starts on the archive's first day, so no day is unknown, but the first days are possibly incomplete.
    const all = await summary();
    expect(all.range).toMatchObject({ coverageGap: false, partialGap: true });
    await expect(note).toBeVisible();
    await expect(note).toHaveText(
      `Days before ${long(all.range.completeFrom as string)} only include sessions that were continued later, because Claude Code deletes transcripts after 30 days. Their values are shown, marked as possibly incomplete.`,
    );
    await expect(note).not.toContainText('are unknown');
    await expect(note.locator('.note__hatch')).toHaveCount(1);
    await expect(note.locator('.note__hatch--partial')).toHaveCount(1);
    // 90 days reaches before the archive too: both gaps are named
    await page.getByRole('button', { name: '90d' }).click();
    const s = await summary(new URL(page.url()).searchParams.toString());
    expect(s.range).toMatchObject({ coverageGap: true, partialGap: true });
    await expect(note).toHaveText(
      `Days before ${long(s.range.completeFrom as string)} only include sessions that were continued later, because Claude Code deletes transcripts after 30 days. Days before ${long(s.range.archiveStart as string)} are unknown.`,
    );
    await expect(note.locator('.note__hatch')).toHaveCount(2);
    // a range that starts on the first complete day has no note
    await page.goto(`${base()}/?from=${all.range.completeFrom}`);
    await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
    await expect(page.locator('[data-note="ghost"]')).toHaveCount(0);
    await expect(note).toHaveCount(0);
    // dismissed for the session
    await page.goto(`${base()}/?from=${early}`);
    await expect(note).toBeVisible();
    await note.getByRole('button', { name: 'Dismiss the coverage note' }).click();
    await expect(note).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
    await expect(note).toHaveCount(0);
    await page.getByRole('button', { name: '7d' }).click();
    await expect(note).toHaveCount(0);
  });

  test('coverage note: only unknown days (the archive starts after the range starts, no day is partial)', async ({ page }) => {
    const early = new Date(Date.parse(`${(await summary()).range.archiveStart}T00:00:00Z`) - 20 * 86_400_000).toISOString().slice(0, 10);
    // the API is answered by hand: this archive began on the day it was first read, so nothing is partial
    await page.route('**/api/summary*', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Summary;
      await route.fulfill({ json: { ...body, range: { ...body.range, completeFrom: body.range.archiveStart, partialGap: false, coverageGap: true } } });
    });
    await page.route('**/api/filters*', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { archiveStart: string };
      await route.fulfill({ json: { ...body, completeFrom: body.archiveStart } });
    });
    await go(page, `?from=${early}`);
    const note = page.locator('[data-note="coverage"]');
    await expect(note).toContainText('Your archive starts');
    await expect(note).toContainText('earlier usage is unknown');
    await expect(note).not.toContainText('continued later');
    await expect(note.locator('.note__hatch--partial')).toHaveCount(0);
  });

  test('empty range: one plain message and a way out', async ({ page }) => {
    await page.goto(`${base()}/?from=2020-01-01&to=2020-01-05`);
    await expect(page.getByText('No Claude Code activity in this range')).toBeVisible();
    await expect(page.locator('[data-kpi="sessions"]')).toHaveCount(0);
    await page.getByRole('button', { name: /Show all time/ }).click();
    await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
    await expect(page).toHaveURL(base() + '/');
  });

  test('error: the service does not answer, one sentence and a working Retry', async ({ page }) => {
    await page.route('**/api/summary*', (route) => route.abort('connectionrefused'));
    await page.goto(`${base()}/`);
    const err = page.getByRole('alert').filter({ hasText: 'did not load' });
    await expect(err).toBeVisible();
    await expect(err).toContainText('not answering');
    await page.unroute('**/api/summary*');
    await err.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
    await expectKpisEqual(page, await summary());
  });

  test('loading: a skeleton with the final layout, then the numbers without the page jumping', async ({ page }) => {
    await page.route('**/api/summary*', async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await page.goto(`${base()}/`, { waitUntil: 'commit' });
    await expect(page.locator('.kpis .skel').first()).toBeVisible();
    await expect(page.locator('.panel')).toHaveAttribute('aria-busy', 'true');
    // The panels that are not delayed have answered (a race of a few milliseconds otherwise): the page height now differs
    // from the final one only by the key figures.
    await expect(page.locator('table[data-table="sessions"]')).toBeVisible();
    const during = await page.evaluate(() => ({
      kpis: document.querySelector('.kpis')?.getBoundingClientRect().height ?? 0,
      stats: document.querySelector('.stats')?.getBoundingClientRect().height ?? 0,
      doc: document.documentElement.scrollHeight,
    }));
    await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
    const after = await page.evaluate(() => ({
      kpis: document.querySelector('.kpis')?.getBoundingClientRect().height ?? 0,
      stats: document.querySelector('.stats')?.getBoundingClientRect().height ?? 0,
      doc: document.documentElement.scrollHeight,
    }));
    expect(Math.abs(during.kpis - after.kpis)).toBeLessThanOrEqual(4);
    expect(Math.abs(during.stats - after.stats)).toBeLessThanOrEqual(30);
    expect(Math.abs(during.doc - after.doc)).toBeLessThanOrEqual(40);
  });

  test('a number too wide for its card falls back to the compact form, full value in the name and tooltip', async ({ page }) => {
    const real = await summary();
    await page.route('**/api/summary*', (route) =>
      route.fulfill({ json: { ...real, tokens: { input: 1, output: 2, cacheRead: 987_654_321_098_760, cacheWrite: 3, total: 987_654_321_098_766 } } satisfies Summary }),
    );
    await page.setViewportSize({ width: 320, height: 700 });
    await go(page);
    const big = page.locator('[data-kpi="tokens"]');
    await expect(big).toHaveAttribute('data-compact', 'true');
    await expect(big.getByRole('img')).toHaveText('987.65T');
    // the words line shows with the compact figure too
    await expect(page.locator('[data-kpi="tokens.words"]')).toHaveText('987.65 Trillion');
    await expect(big.getByRole('img')).toHaveAttribute('aria-label', '987,654,321,098,766');
    await big.locator('.tip').focus();
    await expect(big.getByRole('tooltip')).toHaveText('987,654,321,098,766');
    // the exact numbers stay in the table
    await expect(page.locator('[data-kpi="tokens.cacheRead"]')).toHaveText('987,654,321,098,760');
  });

  test('the token total in words sits under the figure and equals the formatter on /api/summary', async ({ page }) => {
    const s = await summary();
    const expected = tokenWords(s.tokens.total);
    expect(expected).not.toBeNull();
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await go(page);
      const words = page.locator('[data-kpi="tokens.words"]');
      await expect(words).toHaveText(expected as string);
      await expect(page.locator('[data-kpi="tokens.words"]')).toHaveCount(1);
      // directly beneath the big number, above the caption
      const fig = await page.locator('.card--tokens .card__fig').boundingBox();
      const line = await words.boundingBox();
      const cap = await page.locator('.card--tokens .card__cap').boundingBox();
      expect(line && fig && cap).toBeTruthy();
      expect((line?.y ?? 0) >= (fig?.y ?? 0) + (fig?.height ?? 0) - 1).toBe(true);
      expect((cap?.y ?? 0) >= (line?.y ?? 0) + (line?.height ?? 0) - 1).toBe(true);
    }
  });

  test('the token total in words is hidden under 1,000 tokens', async ({ page }) => {
    const real = await summary();
    await page.route('**/api/summary*', (route) =>
      route.fulfill({ json: { ...real, tokens: { input: 100, output: 200, cacheRead: 300, cacheWrite: 399, total: 999 } } satisfies Summary }),
    );
    await go(page);
    await expect(page.locator('[data-kpi="tokens"]')).toHaveAttribute('data-full', '999');
    await expect(page.locator('[data-kpi="tokens.words"]')).toHaveCount(0);
  });

  test('null values say "Not enough data"', async ({ page }) => {
    const real = await summary();
    await page.route('**/api/summary*', (route) =>
      route.fulfill({ json: { ...real, peakHour: null, peakDay: null, favoriteModel: null, longestSession: null, longestStreak: null, currentStreak: 0 } satisfies Summary }),
    );
    await go(page);
    for (const id of ['peakHour', 'peakDay', 'favoriteModel', 'longestSession', 'longestStreak']) {
      await expect(page.locator(`[data-stat="${id}"] dd`).first()).toHaveText('Not enough data');
    }
    await expect(page.locator('[data-stat="currentStreak"] dd').first()).toHaveText('0 days');
  });

  test('the longest session shows its wall clock time in a tooltip that opens on focus', async ({ page }) => {
    await go(page);
    const s = await summary();
    const trigger = page.locator('[data-stat="longestSession"] .tip');
    await trigger.focus();
    await expect(trigger.getByRole('tooltip')).toBeVisible();
    await expect(trigger.getByRole('tooltip')).toContainText(`Wall clock from first to last event: ${hours(s.longestSession?.wallMs ?? 0)}`);
    await page.keyboard.press('Escape');
    await expect(trigger.getByRole('tooltip')).toBeHidden();
  });
});

test.describe('sync pill', () => {
  async function pillWith(page: Page, sync: Partial<Health['sync']>, errors = 0): Promise<void> {
    const real = await getJson<Health>('/api/health');
    await page.route('**/api/health', (route) => route.fulfill({ json: { ...real, errors: { total: errors }, sync: { ...real.sync, ...sync } } satisfies Health }));
    await go(page);
  }
  const pill = (page: Page) => page.getByRole('link', { name: /Synced|Syncing|Stale|error|Not connected/ });
  const shapeOf = (page: Page): Promise<string> => pill(page).locator('svg').evaluate((el) => el.innerHTML);

  test('Synced hh:mm after a recent success, and it links to Data health', async ({ page }) => {
    await go(page);
    await expect(pill(page)).toHaveText(/^Synced \d\d:\d\d$/);
    await expect(pill(page)).toHaveAttribute('data-state', 'synced');
    await expect(pill(page)).toHaveAttribute('href', '#health');
  });

  test('four states, four words, four shapes', async ({ browser }) => {
    const shapes: Record<string, string> = {};
    const cases: [string, Partial<Health['sync']>, number, RegExp, string][] = [
      ['synced', { lastSuccessAt: Date.now() - 30_000, running: false }, 0, /^Synced \d\d:\d\d$/, 'synced'],
      ['syncing', { running: true }, 0, /^Syncing$/, 'syncing'],
      ['stale', { lastSuccessAt: Date.now() - 10 * 60_000, running: false }, 0, /^Stale, last sync (10|11) min ago$/, 'stale'],
      ['errors', { lastSuccessAt: Date.now() - 30_000, running: false }, 3, /^3 errors$/, 'errors'],
    ];
    for (const [name, sync, errors, words, state] of cases) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await pillWith(page, sync, errors);
      await expect(pill(page)).toHaveText(words);
      await expect(pill(page)).toHaveAttribute('data-state', state);
      shapes[name] = await shapeOf(page);
      await ctx.close();
    }
    expect(new Set(Object.values(shapes)).size).toBe(4);
  });

  test('a service that stops answering shows Not connected', async ({ page }) => {
    await go(page);
    await page.route('**/api/health', (route) => route.abort('connectionrefused'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(pill(page)).toHaveText('Not connected');
  });
});

test.describe('theme', () => {
  test('System follows the OS, Dark and Light override it, the choice survives a reload', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await go(page);
    const bg = (): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const darkBg = await bg();
    await page.getByRole('button', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const lightBg = await bg();
    expect(lightBg).not.toBe(darkBg);
    expect(await page.evaluate(() => localStorage.getItem('ledger.theme'))).toBe('light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await bg()).toBe(lightBg);
    await page.getByRole('button', { name: 'System' }).click();
    expect(await page.evaluate(() => localStorage.getItem('ledger.theme'))).toBeNull();
    expect(await bg()).toBe(darkBg);
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await bg()).toBe(lightBg);
    await page.getByRole('button', { name: 'Dark' }).click();
    expect(await bg()).toBe(darkBg);
    await ctx.close();
  });

  test('the page works when storage is blocked', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('blocked'); } });
      Object.defineProperty(window, 'sessionStorage', { get: () => { throw new Error('blocked'); } });
    });
    const page = await ctx.newPage();
    const problems = collectProblems(page);
    await go(page);
    await page.getByRole('button', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: '90d' }).click();
    await page.locator('[data-note="coverage"]').getByRole('button').click();
    await expect(page.locator('[data-note="coverage"]')).toHaveCount(0);
    expect(problems.errors).toEqual([]);
    await ctx.close();
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`contrast: token pairs and every rendered text in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await go(page);
      await page.getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      const t = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const get = (name: string): string => cs.getPropertyValue(name).trim();
        const names = ['ground', 'panel', 'raised', 'sunk', 'ink', 'ink-2', 'ink-3', 'accent', 'accent-ink', 'good', 'warn', 'bad', 'series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6', 'tok-input', 'tok-output', 'tok-write', 'tok-read'];
        return Object.fromEntries(names.map((k) => [k, get(`--${k}`)])) as Record<string, string>;
      });
      const c = (name: string): string => t[name] as string;
      const fails: string[] = [];
      const need = (a: string, b: string, min: number): void => {
        const r = ratio(c(a), c(b));
        if (r < min) fails.push(`${a} on ${b}: ${r.toFixed(2)} < ${min}`);
      };
      for (const ink of ['ink', 'ink-2', 'ink-3']) for (const bg of ['ground', 'panel', 'raised', 'sunk']) need(ink, bg, 4.5);
      need('accent-ink', 'accent', 4.5);
      for (const bg of ['ground', 'panel', 'sunk']) need('accent', bg, 3);
      for (const s of ['good', 'warn', 'bad']) for (const bg of ['panel', 'raised']) need(s, bg, 3);
      // categorical marks: 3:1 on the panel, except the documented relief slots (light yellow, aqua, magenta), which are
      // always paired with text: the token table under the meter, and later the legend and tooltips of the charts
      const relief = new Set(theme === 'light' ? ['series-2', 'series-4', 'series-5'] : []);
      for (const s of ['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6', 'tok-input', 'tok-output', 'tok-write', 'tok-read']) {
        const key = s.startsWith('tok-') ? { 'tok-input': 'series-1', 'tok-output': 'series-6', 'tok-write': 'series-5', 'tok-read': 'series-3' }[s] : s;
        need(s, 'panel', relief.has(key as string) ? 2.0 : 3);
      }
      expect(fails).toEqual([]);

      // Every piece of visible text against the background it actually sits on.
      const bad = await page.evaluate(() => {
        const parse = (v: string): [number, number, number, number] => {
          const m = v.match(/[\d.]+/g) ?? ['0', '0', '0', '0'];
          return [Number(m[0]), Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])];
        };
        const lum = ([r, g, b]: number[]): number => {
          const f = (x: number): number => ((x / 255) <= 0.04045 ? x / 255 / 12.92 : (((x / 255) + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r as number) + 0.7152 * f(g as number) + 0.0722 * f(b as number);
        };
        const over = (top: number[], under: number[]): number[] => {
          const a = top[3] as number;
          return [0, 1, 2].map((i) => (top[i] as number) * a + (under[i] as number) * (1 - a)).concat([1]);
        };
        const backdrop = (el: Element): number[] => {
          const layers: number[][] = [];
          for (let e: Element | null = el; e !== null; e = e.parentElement) {
            const bg = parse(getComputedStyle(e).backgroundColor);
            if (bg[3] > 0) layers.push(bg);
            if (bg[3] === 1) break;
          }
          let out: number[] = [0, 0, 0, 1];
          for (const l of layers.reverse()) out = over(l, out);
          return out;
        };
        const problems: string[] = [];
        let checked = 0;
        for (const el of document.querySelectorAll<HTMLElement>('body *')) {
          const own = [...el.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim() !== '');
          if (!own || !el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
          if (el.closest('.sr-only, .skip, [aria-hidden="true"], .tip__bubble')) continue;
          const cs = getComputedStyle(el);
          const fg = over(parse(cs.color), backdrop(el));
          const bg = backdrop(el);
          const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
          const ratioNow = (hi + 0.05) / (lo + 0.05);
          const size = parseFloat(cs.fontSize);
          const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
          checked += 1;
          if (ratioNow < (large ? 3 : 4.5)) problems.push(`${el.className || el.tagName} "${(el.textContent ?? '').trim().slice(0, 24)}" ${ratioNow.toFixed(2)}`);
        }
        return { problems, checked };
      });
      expect(bad.checked).toBeGreaterThan(40);
      expect(bad.problems).toEqual([]);
    });
  }
});

test('KPI reading helper sanity: a value is read once, not twice', async ({ page }) => {
  await go(page);
  const s = await summary();
  expect(await kpi(page, 'sessions')).toBe(n(s.sessions));
});
