// End to end checks of the time charts: every drawn value equals the API, the
// retention horizon is visible, the charts work from the keyboard, no horizontal scroll at 360 px, chart text and marks pass
// contrast in both themes, only loopback requests, no console errors, and every state (loading, error, empty) is designed.
import { expect, test, type Page } from '@playwright/test';
import type { ActivityMetric, Daily, DayDetail, Heatmap, Hours, Summary } from '../../src/api/types.ts';
import { base, collectProblems, getJson, money, n, ratio, summary } from './helpers.ts';

const METRICS: ActivityMetric[] = ['messages', 'tokens', 'sessions', 'cost'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const long = (d: string): string => `${Number(d.slice(8))} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const weekday = (d: string): string => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const hhmm = (ts: number): string => new Date(ts).toISOString().slice(11, 16);
const pad = (h: number): string => String(h).padStart(2, '0');
const levelOf = (v: number, t: number[]): number => (v <= 0 ? 0 : v <= (t[0] as number) ? 1 : v <= (t[1] as number) ? 2 : v <= (t[2] as number) ? 3 : 4);

async function go(page: Page, query = ''): Promise<void> {
  await page.goto(`${base()}/${query === '' ? '' : query.startsWith('?') ? query : `?${query}`}`);
  await expect(page.locator('[data-chart="heatmap"] g.hm__c').first()).toBeAttached();
  await expect(page.locator('[data-chart="daily"] .dc__svg')).toBeVisible();
  await expect(page.locator('[data-chart="hours"] .dc__svg')).toBeVisible();
}

const wide = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

test.describe('heatmap', () => {
  for (const metric of METRICS) {
    test(`every cell equals /api/heatmap for ${metric}; days before the archive are hatched with the label`, async ({ page }) => {
      await go(page, metric === 'messages' ? '' : `?metric=${metric}`);
      const api = await getJson<Heatmap>(`/api/heatmap?metric=${metric}`);
      const seen = await page.locator('[data-chart="heatmap"] g.hm__c').evaluateAll((els) =>
        els.map((e) => ({
          day: e.getAttribute('data-day') ?? '',
          value: e.getAttribute('data-value'),
          level: e.getAttribute('data-level'),
          state: e.getAttribute('data-state'),
          fill: e.querySelector('.hm__cell')?.getAttribute('fill') ?? '',
          paint: getComputedStyle(e.querySelector('.hm__cell') as Element).fill,
        })),
      );
      expect(seen).toHaveLength(api.cells.length);
      expect(api.cells.some((c) => c.beforeArchive)).toBe(true);
      const byDay = new Map(seen.map((s) => [s.day, s]));
      const problems: string[] = [];
      for (const c of api.cells) {
        const s = byDay.get(c.day);
        if (s === undefined) problems.push(`${c.day} missing`);
        else if (c.afterToday) {
          if (s.state !== 'future' || s.value !== null || s.paint !== 'none') problems.push(`${c.day} should be an empty outline`);
        } else if (c.beforeArchive) {
          // hatched, never drawn as a zero: no value, no colour step, a pattern fill
          if (s.state !== 'before' || s.value !== null || s.level !== null || !s.fill.startsWith('url(#')) problems.push(`${c.day} should be hatched`);
        } else if (s.state !== 'value' || s.value !== String(c.value) || s.level !== String(levelOf(c.value, api.thresholds))) {
          problems.push(`${c.day} drawn ${s.value}/${s.level}, API ${c.value}/${levelOf(c.value, api.thresholds)}`);
        }
      }
      expect(problems).toEqual([]);
      // the horizon: a hairline and the label, on the archive's first day
      const start = api.range.archiveStart as string;
      await expect(page.locator('[data-chart="heatmap"] .hm__flag')).toHaveText(`Archive starts ${long(start)}`);
      await expect(page.locator('[data-chart="heatmap"] .hm__horizon')).toHaveAttribute('data-horizon', start);
      // zero days inside the archive are a real step 0, not hatched
      expect(api.cells.some((c) => !c.beforeArchive && !c.afterToday && c.value === 0)).toBe(true);
      // the scale legend names the range of each step, ending at the maximum
      const items = await page.locator('[data-chart="heatmap"] .hm__scale li').allTextContents();
      expect(items[0]).toContain('0');
      expect(items[items.length - 1]).toContain('Before the archive');
    });
  }

  test('the scale legend states the values behind each colour step (messages)', async ({ page }) => {
    await go(page);
    const api = await getJson<Heatmap>('/api/heatmap?metric=messages');
    const t = api.thresholds;
    const last = page.locator('[data-chart="heatmap"] .hm__scale li').nth(4);
    await expect(last).toContainText(`${(t[2] as number) + 1} to ${t[3]}`);
  });

  test('the switch is shared, kept in the URL, and does not refetch the figures above', async ({ page }) => {
    const calls: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/')) calls.push(u.pathname + u.search);
    });
    await go(page);
    await page.waitForLoadState('networkidle');
    const before = calls.filter((c) => c.startsWith('/api/summary')).length;
    await page.locator('[data-metric="tokens"]').click();
    await expect(page).toHaveURL(/metric=tokens/);
    await expect(page.locator('[data-metric="tokens"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-chart="heatmap"] .chart__sub')).toContainText('Tokens per day');
    await expect(page.locator('[data-chart="daily"] .chart__sub')).toContainText('Tokens by model');
    await expect(page.locator('[data-chart="hours"] .chart__sub')).toContainText('Tokens by local hour');
    await page.waitForLoadState('networkidle');
    expect(calls.filter((c) => c.startsWith('/api/summary')).length).toBe(before);
    expect(calls.some((c) => c.startsWith('/api/heatmap') && c.includes('metric=tokens'))).toBe(true);
    await page.locator('[data-metric="sessions"]').click();
    await expect(page).toHaveURL(/metric=sessions/);
    await page.goBack();
    await expect(page).toHaveURL(/metric=tokens/);
    await page.reload();
    await expect(page.locator('[data-metric="tokens"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-metric="messages"]').click();
    await expect(page).toHaveURL(base() + '/');
  });

  test('keyboard: tab into the grid, arrow by day and week, Home and End, the tooltip follows focus, Escape closes it', async ({ page }) => {
    await go(page);
    const api = await getJson<Heatmap>('/api/heatmap?metric=messages');
    const index = new Map(api.cells.map((c, i) => [c.day, i]));
    const last = api.cells.map((c) => c.afterToday).lastIndexOf(false);
    const day = (i: number): string => (api.cells[i] as { day: string }).day;
    const active = (): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);

    await page.locator('[data-metric="sessions"]').focus();
    let landed = false;
    for (let i = 0; i < 4 && !landed; i++) {
      await page.keyboard.press('Tab');
      landed = await page.evaluate(() => document.activeElement?.matches('g.hm__c') ?? false);
    }
    expect(landed).toBe(true);
    // one roving tab stop: the newest day
    expect(await page.locator('[data-chart="heatmap"] g.hm__c[tabindex="0"]').count()).toBe(1);
    expect(await active()).toBe(day(last));
    const tip = page.locator('#hm-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(`${weekday(day(last))} ${long(day(last))}`);
    // a real focus ring
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement as Element);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBeGreaterThanOrEqual(2);

    let at = last;
    await page.keyboard.press('ArrowUp');
    at -= 1;
    expect(await active()).toBe(day(at));
    await expect(tip).toContainText(long(day(at)));
    await page.keyboard.press('ArrowLeft');
    at -= 7;
    expect(await active()).toBe(day(at));
    await page.keyboard.press('ArrowDown');
    at += 1;
    expect(await active()).toBe(day(at));
    await page.keyboard.press('ArrowRight');
    at += 7;
    expect(await active()).toBe(day(at));
    // the keys never go into the future
    await page.keyboard.press('End');
    expect(await active()).toBe(day(last));
    await page.keyboard.press('ArrowDown');
    expect(await active()).toBe(day(last));
    await page.keyboard.press('Home');
    expect(await active()).toBe(day(0));
    expect(index.get((await active()) as string)).toBe(0);
    // the tooltip of a hatched day says what it is
    await expect(tip).toContainText('Before the archive');
    // Escape closes it and keeps focus where it is
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    expect(await active()).toBe(day(0));
    // the roving stop moved with focus, and Tab leaves the grid
    await expect(page.locator(`[data-chart="heatmap"] g.hm__c[tabindex="0"]`)).toHaveAttribute('data-day', day(0));
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.matches('g.hm__c') ?? false)).toBe(false);
  });

  test('the day readout: sessions as tally marks grouped in fives, with project and time in text', async ({ page }) => {
    await go(page);
    const api = await getJson<Heatmap>('/api/heatmap?metric=messages');
    let busy: DayDetail | null = null;
    for (const c of api.cells.filter((x) => x.value > 0)) {
      const d = await getJson<DayDetail>(`/api/day?date=${c.day}`);
      if (d.sessions.length > 5) busy = d;
    }
    expect(busy).not.toBeNull();
    const b = busy as DayDetail;
    const count = b.sessions.length;
    await page.locator(`g.hm__c[data-day="${b.day}"]`).hover();
    const tip = page.locator('#hm-tip');
    await expect(tip.locator('.ctip__count')).toHaveText(`${count} sessions`);
    const groups = await tip.locator('.tally__group').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-ticks'))));
    expect(groups).toEqual([5, ...(count > 5 ? [count - 5] : [])]);
    expect(await tip.locator('.tally__tick').count()).toBe(count);
    expect(await tip.locator('.tally__slash').count()).toBe(1);
    await expect(tip.locator('.ctip__list li')).toHaveCount(5);
    await expect(tip.locator('.ctip__more')).toHaveText(`and ${count - 5} more`);
    const first = b.sessions[0] as DayDetail['sessions'][number];
    await expect(tip.locator('.ctip__list li').first()).toContainText(`${hhmm(first.firstTs)} to ${hhmm(first.lastTs)}`);
    await expect(tip.locator('.ctip__list li').first()).toContainText(first.displayName);
    // the same text is reachable without the tooltip: the cell's own name carries date and value
    const label = await page.locator(`g.hm__c[data-day="${b.day}"]`).getAttribute('aria-label');
    const cell = api.cells.find((c) => c.day === b.day);
    expect(label).toBe(`${weekday(b.day)} ${long(b.day)}, ${cell?.value} messages`);
    // the sessions metric: the value and the tally are the same count
    await page.goto(`${base()}/?metric=sessions`);
    await expect(page.locator('[data-chart="heatmap"] g.hm__c').first()).toBeAttached();
    await page.locator(`g.hm__c[data-day="${b.day}"]`).hover();
    await expect(page.locator('#hm-tip .ctip__n')).toHaveText(String(count));
    expect(await page.locator('#hm-tip .tally__tick').count()).toBe(count);
  });

  test('a day before the archive says it is unknown, not zero', async ({ page }) => {
    await go(page);
    await page.locator('g.hm__c[data-state="before"]').nth(40).hover();
    await expect(page.locator('#hm-tip')).toContainText('unknown, not zero');
  });

  test('table view: every day and value, then back to the grid', async ({ page }) => {
    for (const metric of METRICS) {
      await go(page, metric === 'messages' ? '' : `?metric=${metric}`);
      const api = await getJson<Heatmap>(`/api/heatmap?metric=${metric}`);
      const toggle = page.getByTestId('heatmap-table-toggle');
      await expect(toggle).toHaveText('Show as table');
      await toggle.click();
      await expect(toggle).toHaveText('Show as chart');
      const rows = await page.locator('table[data-table="heatmap"] td[data-day]').evaluateAll((els) =>
        els.map((e) => ({ day: e.getAttribute('data-day') ?? '', value: e.getAttribute('data-value'), state: e.getAttribute('data-state'), text: (e.textContent ?? '').trim() })),
      );
      expect(rows).toHaveLength(api.cells.length);
      const byDay = new Map(rows.map((r) => [r.day, r]));
      for (const c of api.cells) {
        const r = byDay.get(c.day);
        if (c.afterToday) expect(r?.state).toBe('future');
        else if (c.beforeArchive) expect([r?.state, r?.text]).toEqual(['before', 'unknown']);
        else expect([r?.value, (r?.text ?? '').replace(' (possibly incomplete)', '')]).toEqual([String(c.value), metric === 'cost' ? money(c.value) : n(c.value)]);
      }
      await expect(page.locator('table[data-table="heatmap"] caption')).toContainText('Each row is a week that starts on Monday');
      await toggle.click();
      await expect(page.locator('[data-chart="heatmap"] g.hm__c').first()).toBeAttached();
    }
  });
});

test.describe('daily chart', () => {
  type Seg = [string, string | null, number];
  const expectedSegs = (api: Daily, tokens: boolean): Seg[] => {
    const out: Seg[] = [];
    for (const d of api.days) {
      if (tokens) for (const m of api.models) if ((d.byModel[m] ?? 0) > 0) out.push([d.day, m, d.byModel[m] as number]);
      if (!tokens && d.total > 0) out.push([d.day, null, d.total]);
    }
    return out.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  };
  const drawnSegs = async (page: Page): Promise<Seg[]> => {
    const segs = await page.locator('[data-chart="daily"] path.dc__seg').evaluateAll((els) => els.map((e) => [e.getAttribute('data-day') ?? '', e.getAttribute('data-model'), Number(e.getAttribute('data-value'))] as [string, string | null, number]));
    return segs.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  };

  test('tokens by model equal /api/daily, with and without cache reads', async ({ page }) => {
    await go(page, '?metric=tokens');
    const withCache = await getJson<Daily>('/api/daily?metric=tokens');
    expect(withCache.models.length).toBeGreaterThanOrEqual(3);
    expect(await drawnSegs(page)).toEqual(expectedSegs(withCache, true));
    // the stack order is the API's model order, and a zero day is an empty slot, not a bar
    expect(withCache.days.some((d) => d.total === 0)).toBe(true);
    await expect(page.locator('[data-chart="daily"] .legend li[data-series]')).toHaveText(withCache.models);

    await page.getByRole('checkbox', { name: 'Hide cache reads' }).check();
    await expect(page).toHaveURL(/hideCacheRead=1/);
    const without = await getJson<Daily>('/api/daily?metric=tokens&hideCacheRead=1');
    await expect(page.locator('[data-chart="daily"] .chart__sub')).toContainText('cache reads hidden');
    await expect.poll(async () => JSON.stringify(await drawnSegs(page))).toBe(JSON.stringify(expectedSegs(without, true)));
    expect(without.days.reduce((s, d) => s + d.total, 0)).toBeLessThan(withCache.days.reduce((s, d) => s + d.total, 0));
    // the heatmap and the hour chart are not touched by the toggle
    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'Hide cache reads' })).toBeChecked();
  });

  for (const metric of ['messages', 'sessions'] as const) {
    test(`${metric}: one series in one hue, no legend box, values equal /api/daily`, async ({ page }) => {
      await go(page, metric === 'messages' ? '' : `?metric=${metric}`);
      const api = await getJson<Daily>(`/api/daily?metric=${metric}`);
      expect(await drawnSegs(page)).toEqual(expectedSegs(api, false));
      await expect(page.locator('[data-chart="daily"] .legend')).toHaveCount(0);
      await expect(page.getByRole('checkbox', { name: 'Hide cache reads' })).toHaveCount(0);
      const fills = await page.locator('[data-chart="daily"] path.dc__seg').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('fill')))]);
      expect(fills).toEqual(['var(--series-1)']);
    });
  }

  test('one y axis only, compact ticks, bars at most 24 px, rounded top only on the top segment', async ({ page }) => {
    await go(page, '?metric=tokens');
    const info = await page.evaluate(() => {
      const svg = document.querySelector('[data-chart="daily"] .dc__svg') as SVGSVGElement;
      const ticks = [...svg.querySelectorAll('.ax__t')].map((t) => (t.textContent ?? '').trim());
      const segs = [...svg.querySelectorAll<SVGPathElement>('path.dc__seg')];
      const widths = segs.map((s) => s.getBBox().width);
      // a stack with more than one segment: only the last one has curve commands in its path
      const byDay = new Map<string, SVGPathElement[]>();
      for (const s of segs) byDay.set(s.getAttribute('data-day') ?? '', [...(byDay.get(s.getAttribute('data-day') ?? '') ?? []), s]);
      const stack = [...byDay.values()].reduce((a, b) => (b.length > a.length ? b : a), [] as SVGPathElement[]);
      return { ticks, maxWidth: Math.max(...widths), curved: stack.map((s) => (s.getAttribute('d') ?? '').includes('A')), axisCount: svg.querySelectorAll('.ax__base').length };
    });
    expect(info.axisCount).toBe(1);
    expect(info.ticks.some((t) => /^\d+(\.\d)?[KMB]$/.test(t))).toBe(true);
    expect(info.maxWidth).toBeLessThanOrEqual(24.01);
    expect(info.curved.length).toBeGreaterThan(1);
    expect(info.curved.slice(0, -1).every((c) => !c)).toBe(true);
    expect(info.curved[info.curved.length - 1]).toBe(true);
  });

  test('colour follows the model: filtering to one model does not repaint it', async ({ page }) => {
    await go(page, '?metric=tokens');
    const fill = (model: string): Promise<string> => page.locator(`[data-chart="daily"] path.dc__seg[data-model="${model}"]`).first().evaluate((e) => getComputedStyle(e).fill);
    const opus = await fill('claude-opus-5-5');
    const haiku = await fill('claude-haiku-5-5');
    expect(opus).not.toBe(haiku);
    await go(page, '?metric=tokens&models=claude-haiku-5-5');
    await expect.poll(() => page.locator('[data-chart="daily"] path.dc__seg').count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator('[data-chart="daily"] path.dc__seg:not([data-model="claude-haiku-5-5"])').count()).toBe(0);
    expect(await fill('claude-haiku-5-5')).toBe(haiku);
  });

  test('hover and keyboard give a crosshair band and exact values per model', async ({ page }) => {
    await go(page, '?metric=tokens');
    const api = await getJson<Daily>('/api/daily?metric=tokens');
    const busiest = api.days.reduce((a, b) => (b.total > a.total ? b : a));
    const i = api.days.findIndex((d) => d.day === busiest.day);
    await page.locator('[data-chart="daily"] .dc__hit').scrollIntoViewIfNeeded();
    const box = await page.locator('[data-chart="daily"] .dc__hit').boundingBox();
    expect(box).not.toBeNull();
    const step = (box as { width: number }).width / api.days.length;
    await page.mouse.move((box as { x: number }).x + (i + 0.5) * step, (box as { y: number }).y + 40);
    const tip = page.locator('[data-chart="daily"] .ctip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(long(busiest.day));
    await expect(page.locator('[data-chart="daily"] .dc__band')).toHaveCount(1);
    for (const m of api.models) {
      const v = busiest.byModel[m] ?? 0;
      if (v > 0) await expect(tip).toContainText(`${n(v)}${m}`);
    }
    await expect(tip).toContainText(`${n(busiest.total)} total`);
    // keyboard: one tab stop, arrows move the band, Escape hides it
    await page.mouse.move(0, 0);
    await expect(tip).toHaveCount(0);
    await page.locator('[data-chart="daily"] g.dc__chart').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(long(api.days[api.days.length - 1]?.day as string));
    await page.keyboard.press('ArrowLeft');
    await expect(tip).toContainText(long(api.days[api.days.length - 2]?.day as string));
    await page.keyboard.press('Home');
    await expect(tip).toContainText(long(api.days[0]?.day as string));
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    await expect(page.locator('[data-chart="daily"] [aria-live="polite"]')).toContainText(long(api.days[0]?.day as string));
  });

  test('a range that starts before the archive draws those days hatched, with the horizon label', async ({ page }) => {
    await go(page);
    await page.getByRole('button', { name: '90d' }).click();
    await expect(page).toHaveURL(/from=/);
    const params = new URL(page.url()).searchParams.toString();
    const api = await getJson<Daily>(`/api/daily?${params}&metric=messages`);
    expect(api.range.coverageGap).toBe(true);
    const start = api.range.archiveStart as string;
    const before = api.days.filter((d) => d.day < start).length;
    expect(before).toBeGreaterThan(10);
    await expect(page.locator('[data-chart="daily"] .dc__before')).toHaveCount(before);
    await expect(page.locator('[data-chart="daily"] .hm__flag')).toHaveText(`Archive starts ${long(start)}`);
    // hatched days are not zero bars: no segment is drawn for them
    expect(await page.locator('[data-chart="daily"] path.dc__seg').evaluateAll((els, s) => els.filter((e) => (e.getAttribute('data-day') ?? '') < s).length, start)).toBe(0);
    // and the table view says unknown, not 0
    await page.getByTestId('daily-table-toggle').click();
    await expect(page.locator('table[data-table="daily"] tr[data-state="before"]')).toHaveCount(before);
    await expect(page.locator('table[data-table="daily"] tr[data-state="before"]').first()).toContainText('unknown');
  });

  test('table view lists every day with a column per model and the total', async ({ page }) => {
    await go(page, '?metric=tokens');
    const api = await getJson<Daily>('/api/daily?metric=tokens');
    await page.getByTestId('daily-table-toggle').click();
    const rows = await page.locator('table[data-table="daily"] tbody tr').evaluateAll((trs) =>
      trs.map((tr) => ({
        day: tr.getAttribute('data-day') ?? '',
        total: Number(tr.querySelector('td[data-total]')?.getAttribute('data-total')),
        models: Object.fromEntries([...tr.querySelectorAll('td[data-model]')].map((td) => [td.getAttribute('data-model') ?? '', Number(td.getAttribute('data-value'))])),
      })),
    );
    expect(rows).toHaveLength(api.days.length);
    api.days.forEach((d, i) => {
      expect(rows[i]?.day).toBe(d.day);
      expect(rows[i]?.total).toBe(d.total);
      expect(rows[i]?.models).toEqual(d.byModel);
    });
  });
});

test.describe('hour of day', () => {
  for (const metric of METRICS) {
    test(`24 bars equal /api/hours for ${metric}, the peak hour is labelled`, async ({ page }) => {
      await go(page, metric === 'messages' ? '' : `?metric=${metric}`);
      const api = await getJson<Hours>(`/api/hours?metric=${metric}`);
      const bars = await page.locator('[data-chart="hours"] .dc__seg').evaluateAll((els) => els.map((e) => [Number(e.getAttribute('data-hour')), Number(e.getAttribute('data-value'))]));
      expect(bars).toEqual(api.hours.map((h) => [h.hour, h.value]));
      expect(bars).toHaveLength(24);
      const peak = api.hours.reduce((a, h) => (h.value > a.value ? h : a));
      await expect(page.locator('[data-chart="hours"] .hr__peak')).toHaveText(`Peak ${pad(peak.hour)}:00`);
      const s = await summary();
      if (metric === 'messages' && s.peakHour !== null) expect(peak.hour).toBe(s.peakHour.hour);
    });
  }

  test('hover and keyboard show exact values; table view lists the 24 hours', async ({ page }) => {
    await go(page);
    const api = await getJson<Hours>('/api/hours?metric=messages');
    const peak = api.hours.reduce((a, h) => (h.value > a.value ? h : a));
    await page.locator('[data-chart="hours"] .dc__hit').scrollIntoViewIfNeeded();
    const box = await page.locator('[data-chart="hours"] .dc__hit').boundingBox();
    const step = (box as { width: number }).width / 24;
    await page.mouse.move((box as { x: number }).x + (peak.hour + 0.5) * step, (box as { y: number }).y + 60);
    const tip = page.locator('[data-chart="hours"] .ctip');
    await expect(tip).toContainText(`${pad(peak.hour)}:00 to ${pad((peak.hour + 1) % 24)}:00`);
    await expect(tip).toContainText(`${n(peak.value)} messages`);
    await page.mouse.move(0, 0);
    await page.getByTestId('hours-table-toggle').click();
    const rows = await page.locator('table[data-table="hours"] tbody tr').evaluateAll((trs) => trs.map((tr) => [Number(tr.getAttribute('data-hour')), Number(tr.querySelector('td')?.getAttribute('data-value'))]));
    expect(rows).toEqual(api.hours.map((h) => [h.hour, h.value]));
  });
});

test.describe('layout', () => {
  test('360 px: the page never scrolls sideways, the heatmap scrolls inside its own box starting at the newest weeks', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await go(page, '?metric=tokens');
    expect(await wide(page)).toBe(false);
    const scroller = await page.locator('.hm__scroll').evaluate((e) => ({ scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, left: e.scrollLeft }));
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    expect(scroller.left).toBeGreaterThan(0);
    expect(scroller.left + scroller.clientWidth).toBeGreaterThanOrEqual(scroller.scrollWidth - 2);
    // the newest day is on screen, and its readout stays inside the viewport
    const cell = page.locator('g.hm__c[tabindex="0"]');
    await cell.hover();
    const tip = await page.locator('#hm-tip').boundingBox();
    expect(tip).not.toBeNull();
    expect((tip?.x ?? -1) >= 0).toBe(true);
    expect((tip?.x ?? 0) + (tip?.width ?? 0)).toBeLessThanOrEqual(360);
    expect(await wide(page)).toBe(false);
    await page.mouse.move(0, 0);
    for (const id of ['heatmap', 'daily', 'hours']) {
      await page.getByTestId(`${id}-table-toggle`).click();
      expect(await wide(page)).toBe(false);
      await expect(page.locator(`[data-chart="${id}"] .tview`)).toBeVisible();
    }
    // the metric switch fits too
    await page.locator('[data-metric="sessions"]').click();
    expect(await wide(page)).toBe(false);
  });

  test('320 px: the page never scrolls sideways, every metric switch button sits inside its group', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await go(page, '?metric=tokens');
    expect(await wide(page)).toBe(false);
    const fit = await page.locator('.timebar .seg').evaluate((s) => {
      const g = s.getBoundingClientRect();
      return [...s.children].map((b) => b.getBoundingClientRect()).every((r) => r.left >= g.left - 0.5 && r.right <= g.right + 0.5);
    });
    expect(fit).toBe(true);
    await page.locator('[data-metric="cost"]').click();
    expect(await wide(page)).toBe(false);
  });

  test('768 px and 1440 px: no sideways scroll, charts fill their cards', async ({ page }) => {
    for (const w of [768, 1440]) {
      await page.setViewportSize({ width: w, height: 900 });
      await go(page, '?metric=tokens');
      expect(await wide(page)).toBe(false);
      const fit = await page.evaluate(() => [...document.querySelectorAll<SVGSVGElement>('.chart .dc__svg')].map((s) => s.getBoundingClientRect().right <= (s.closest('.chart') as Element).getBoundingClientRect().right));
      expect(fit.every(Boolean)).toBe(true);
    }
  });
});

test.describe('contrast and colour', () => {
  const rgb = (css: string): string => {
    const m = css.match(/[\d.]+/g) ?? ['0', '0', '0'];
    return `#${[0, 1, 2].map((i) => Math.round(Number(m[i])).toString(16).padStart(2, '0')).join('')}`;
  };
  for (const theme of ['dark', 'light'] as const) {
    test(`activity ramp, hatch, series marks and every chart text in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await go(page, '?metric=tokens');
      await page.getByRole('button', { name: theme === 'dark' ? 'Dark' : 'Light' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      const t = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const names = ['panel', 'raised', 'accent', 'heat-0', 'heat-1', 'heat-2', 'heat-3', 'heat-4'];
        const hatch = getComputedStyle(document.querySelector('.hatch__line') as Element).stroke;
        return { vars: Object.fromEntries(names.map((k) => [k, cs.getPropertyValue(`--${k}`).trim()])) as Record<string, string>, hatch };
      });
      const v = (k: string): string => t.vars[k] as string;
      const lum = (hex: string): number => {
        const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
      };
      const steps = ['heat-0', 'heat-1', 'heat-2', 'heat-3', 'heat-4'].map(v);
      expect(v('heat-4')).toBe(v('accent'));
      // monotone: lighter with each step on dark, darker with each step on light; every gap is visible
      for (let i = 1; i < steps.length; i++) {
        const a = lum(steps[i - 1] as string);
        const b = lum(steps[i] as string);
        expect(theme === 'dark' ? b > a : b < a).toBe(true);
        expect(ratio(steps[i - 1] as string, steps[i] as string)).toBeGreaterThanOrEqual(1.25);
      }
      // every non zero step reads against the panel; step 0 is meant to recede
      for (const k of ['heat-1', 'heat-2', 'heat-3', 'heat-4']) expect(ratio(v(k), v('panel')), `${k} on panel`).toBeGreaterThanOrEqual(2);
      expect(ratio(v('heat-4'), v('panel'))).toBeGreaterThanOrEqual(3);
      // the hatch line, composited over the panel
      const m = (t.hatch.match(/[\d.]+/g) ?? []).map(Number);
      const panel = [1, 3, 5].map((i) => parseInt(v('panel').slice(i, i + 2), 16));
      const a = m[3] ?? 1;
      const hatchHex = `#${[0, 1, 2].map((i) => Math.round((m[i] as number) * a + (panel[i] as number) * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
      expect(ratio(hatchHex, v('panel')), 'hatch on panel').toBeGreaterThanOrEqual(2);

      // series marks against the panel: 3:1, except the documented light relief slots, which always have text beside them
      const marks = await page.evaluate(() =>
        [...document.querySelectorAll<SVGPathElement>('[data-chart="daily"] path.dc__seg, [data-chart="hours"] .dc__seg')].map((e) => [e.getAttribute('data-model') ?? 'single', getComputedStyle(e).fill] as [string, string]),
      );
      expect(marks.length).toBeGreaterThan(20);
      const all = await getJson<{ models: string[] }>('/api/filters');
      const relief = new Set(theme === 'light' ? [1, 3, 4] : []);
      for (const [model, fill] of new Map(marks)) {
        const slot = all.models.indexOf(model);
        expect(ratio(rgb(fill), v('panel')), `${model} on panel`).toBeGreaterThanOrEqual(relief.has(slot) ? 2 : 3);
      }

      // every piece of chart text against what it sits on, with the tooltips open
      const check = async (): Promise<string[]> =>
        page.evaluate(() => {
          const parse = (s: string): number[] => {
            const m = s.match(/[\d.]+/g) ?? ['0', '0', '0', '0'];
            return [Number(m[0]), Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])];
          };
          const lum = ([r, g, b]: number[]): number => {
            const f = (x: number): number => (x / 255 <= 0.04045 ? x / 255 / 12.92 : ((x / 255 + 0.055) / 1.055) ** 2.4);
            return 0.2126 * f(r as number) + 0.7152 * f(g as number) + 0.0722 * f(b as number);
          };
          const over = (top: number[], under: number[]): number[] => [0, 1, 2].map((i) => (top[i] as number) * (top[3] as number) + (under[i] as number) * (1 - (top[3] as number))).concat([1]);
          const backdrop = (el: Element): number[] => {
            const layers: number[][] = [];
            for (let e: Element | null = el; e !== null; e = e.parentElement) {
              const bg = parse(getComputedStyle(e).backgroundColor);
              if ((bg[3] as number) > 0) layers.push(bg);
              if (bg[3] === 1) break;
            }
            let out = [0, 0, 0, 1];
            for (const l of layers.reverse()) out = over(l, out);
            return out;
          };
          const bad: string[] = [];
          let checked = 0;
          for (const el of document.querySelectorAll('.chart *')) {
            const own = [...el.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim() !== '');
            if (!own || el.closest('.sr-only')) continue;
            if (!(el as HTMLElement).checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
            const cs = getComputedStyle(el);
            const paint = el instanceof SVGElement ? cs.fill : cs.color;
            const bg = backdrop(el);
            const fg = over(parse(paint), bg);
            const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
            const r = (hi + 0.05) / (lo + 0.05);
            checked += 1;
            if (r < 4.5) bad.push(`${el.getAttribute('class') ?? el.tagName} "${(el.textContent ?? '').trim().slice(0, 20)}" ${r.toFixed(2)}`);
          }
          if (checked < 15) bad.push(`only ${checked} texts checked`);
          return bad;
        });
      expect(await check()).toEqual([]);
      await page.locator('g.hm__c[tabindex="0"]').hover();
      await expect(page.locator('#hm-tip .ctip__list li').first()).toBeVisible();
      expect(await check()).toEqual([]);
      await page.locator('[data-chart="daily"] .dc__hit').scrollIntoViewIfNeeded();
      const box = await page.locator('[data-chart="daily"] .dc__hit').boundingBox();
      await page.mouse.move((box as { x: number }).x + (box as { width: number }).width - 20, (box as { y: number }).y + 50);
      await expect(page.locator('[data-chart="daily"] .ctip')).toBeVisible();
      expect(await check()).toEqual([]);
      await page.getByTestId('heatmap-table-toggle').click();
      await page.getByTestId('daily-table-toggle').click();
      expect(await check()).toEqual([]);
    });
  }
});

test.describe('cleanliness and states', () => {
  test('using every chart: no console errors, no failed or foreign requests, no CSP violation, no layout shift', async ({ page }) => {
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
    await page.locator('g.hm__c[tabindex="0"]').hover();
    await page.locator('g.hm__c[tabindex="0"]').focus();
    await page.keyboard.press('ArrowLeft');
    await page.locator('[data-metric="tokens"]').click();
    await page.getByRole('checkbox', { name: 'Hide cache reads' }).check();
    await page.locator('[data-chart="daily"] g.dc__chart').focus();
    await page.keyboard.press('ArrowLeft');
    await page.locator('[data-metric="sessions"]').click();
    for (const id of ['heatmap', 'daily', 'hours']) await page.getByTestId(`${id}-table-toggle`).click();
    await page.getByRole('button', { name: '90d' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    expect(problems.errors).toEqual([]);
    expect(problems.failed).toEqual([]);
    expect([...problems.hosts]).toEqual([new URL(base()).host]);
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(0.02);
    // no inline style attribute in the HTML the server sends (the CSP would refuse it)
    const html = await (await fetch(`${base()}/`)).text();
    expect(html).not.toMatch(/\sstyle=/);
  });

  test('loading: each chart shows a skeleton of its own size, then draws without the page jumping', async ({ page }) => {
    await page.route('**/api/{heatmap,daily,hours}*', async (route) => {
      await new Promise((r) => setTimeout(r, 900));
      await route.continue();
    });
    await page.goto(`${base()}/`, { waitUntil: 'commit' });
    await expect(page.locator('[data-chart="heatmap"] .chart__skel')).toBeVisible();
    await expect(page.locator('[data-chart="daily"] .chart__skel')).toBeVisible();
    // The panels that are not delayed have answered (a race of a few milliseconds otherwise): the page height now differs
    // from the final one only by the three delayed charts.
    await expect(page.locator('table[data-table="sessions"]')).toBeVisible();
    const during = await page.evaluate(() => ({ doc: document.documentElement.scrollHeight, hm: document.querySelector('[data-chart="heatmap"]')?.getBoundingClientRect().height ?? 0, dc: document.querySelector('[data-chart="daily"]')?.getBoundingClientRect().height ?? 0 }));
    await expect(page.locator('[data-chart="hours"] .dc__svg')).toBeVisible();
    const after = await page.evaluate(() => ({ doc: document.documentElement.scrollHeight, hm: document.querySelector('[data-chart="heatmap"]')?.getBoundingClientRect().height ?? 0, dc: document.querySelector('[data-chart="daily"]')?.getBoundingClientRect().height ?? 0 }));
    expect(Math.abs(during.hm - after.hm)).toBeLessThanOrEqual(12);
    expect(Math.abs(during.dc - after.dc)).toBeLessThanOrEqual(12);
    expect(Math.abs(during.doc - after.doc)).toBeLessThanOrEqual(40);
  });

  test('error: one chart that cannot load says so in its own card, the others still draw, and Retry works', async ({ page }) => {
    await page.route('**/api/heatmap*', (route) => route.abort('connectionrefused'));
    await page.goto(`${base()}/`);
    const card = page.locator('[data-chart="heatmap"]');
    await expect(card.getByRole('alert')).toContainText('This chart did not load');
    await expect(card.getByRole('alert')).toContainText('not answering');
    await expect(page.locator('[data-chart="daily"] .dc__svg')).toBeVisible();
    await expect(page.locator('[data-chart="hours"] .dc__svg')).toBeVisible();
    await page.unroute('**/api/heatmap*');
    await card.getByRole('button', { name: 'Retry' }).click();
    await expect(card.locator('g.hm__c').first()).toBeAttached();
  });

  test('empty: a range before the archive says so once per chart, with no controls that do nothing', async ({ page }) => {
    await page.goto(`${base()}/?from=2020-01-01&to=2020-01-05`);
    await expect(page.getByText('No Claude Code activity in this range')).toBeVisible();
    const hm = page.locator('[data-chart="heatmap"] [data-state="empty"]');
    await expect(hm).toContainText('Nothing is recorded for these days. The archive starts');
    await expect(page.locator('[data-chart="daily"] [data-state="empty"]')).toContainText('Nothing is recorded for these days');
    await expect(page.locator('[data-chart="hours"] [data-state="empty"]')).toContainText('No activity in this range');
    await expect(page.getByTestId('heatmap-table-toggle')).toHaveCount(0);
    expect(await page.locator('.chart [tabindex="0"]').count()).toBe(0);
  });

  test('an hour chart with no activity says so instead of drawing 24 empty bars', async ({ page }) => {
    await page.route('**/api/hours*', (route) => route.fulfill({ json: { range: { from: '2026-01-01', to: '2026-01-02', days: 2, tz: 'UTC', archiveStart: null, coverageGap: false, completeFrom: null, partialGap: false }, metric: 'messages', hours: Array.from({ length: 24 }, (_, hour) => ({ hour, value: 0 })) } satisfies Hours }));
    await page.goto(`${base()}/`);
    await expect(page.locator('[data-chart="hours"] [data-state="empty"]')).toContainText('No activity in this range');
  });

  test('a rejected filter is explained once at the top, the charts stay quiet', async ({ page }) => {
    await page.goto(`${base()}/?from=2026-10-10&to=2026-10-01`);
    await expect(page.locator('.state--error')).toContainText('These filters cannot be used');
    await expect(page.locator('[data-chart="heatmap"] .chart__quiet')).toBeVisible();
    await expect(page.locator('.chart [role="alert"]')).toHaveCount(0);
  });

  test('a view bookmarked with metric and hideCacheRead opens as it was left', async ({ page }) => {
    await go(page, '?metric=tokens&hideCacheRead=1&models=claude-sonnet-5-5');
    await expect(page.locator('[data-metric="tokens"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('checkbox', { name: 'Hide cache reads' })).toBeChecked();
    const api = await getJson<Daily>('/api/daily?metric=tokens&hideCacheRead=1&models=claude-sonnet-5-5');
    expect(api.models).toEqual(['claude-sonnet-5-5']);
    await expect.poll(() => page.locator('[data-chart="daily"] path.dc__seg').count()).toBe(api.days.filter((d) => d.total > 0).length);
    // Reset filters clears the slice and keeps how the charts are read
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await expect(page).toHaveURL(/metric=tokens/);
    await expect(page).not.toHaveURL(/models=/);
  });
});

test.describe('KPI polish', () => {
  test('the Sessions card adds sessions per active day and messages per session, from /api/summary', async ({ page }) => {
    await page.goto(`${base()}/`);
    const s: Summary = await summary();
    await expect(page.locator('[data-kpi="sessionsPerDay"]')).toHaveText((s.sessions / s.activeDays).toFixed(1));
    await expect(page.locator('[data-kpi="messagesPerSession"]')).toHaveText((s.messages / s.sessions).toFixed(1));
  });

  test('grouping separators in large figures are narrower than a Commit Mono cell, the text stays the plain number', async ({ page }) => {
    await page.goto(`${base()}/`);
    const s = await summary();
    await expect(page.locator('[data-kpi="tokens"]')).toHaveText(n(s.tokens.total));
    const sep = await page.locator('[data-kpi="tokens"] .sep').first().evaluate((e) => {
      const cs = getComputedStyle(e);
      return { family: cs.fontFamily, ratio: e.getBoundingClientRect().width / parseFloat(cs.fontSize) };
    });
    expect(sep.family).not.toContain('Commit Mono');
    expect(sep.ratio).toBeLessThan(0.45);
  });
});
