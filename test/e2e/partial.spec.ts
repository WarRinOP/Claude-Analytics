// Possibly incomplete days: the fixture's archive starts 41 days before its first ingest, so the days from the archive start
// up to 30 days before the first ingest are partial. A partial day keeps its value and colour step and carries a lighter marking;
// days before the archive stay hatched as unknown. The two hairline labels must never overlap, also at 390 px.
import { expect, test, type Page } from '@playwright/test';
import type { ActivityMetric, Daily, Heatmap } from '../../src/api/types.ts';
import { base, getJson, n } from './helpers.ts';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const long = (d: string): string => `${Number(d.slice(8))} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const levelOf = (v: number, t: number[]): number => (v <= 0 ? 0 : v <= (t[0] as number) ? 1 : v <= (t[1] as number) ? 2 : v <= (t[2] as number) ? 3 : 4);

async function go(page: Page, query = ''): Promise<void> {
  await page.goto(`${base()}/${query === '' ? '' : query.startsWith('?') ? query : `?${query}`}`);
  await expect(page.locator('[data-chart="heatmap"] g.hm__c').first()).toBeAttached();
  await expect(page.locator('[data-chart="daily"] .dc__svg')).toBeVisible();
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  return page.locator(selector).first().evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
}

const intersect = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test.describe('the fixture', () => {
  test('has partial days and unknown days apart, in the API', async () => {
    const h = await getJson<Heatmap>('/api/heatmap');
    expect(h.range.partialGap).toBe(true);
    expect(h.range.completeFrom).not.toBe(h.range.archiveStart);
    const partial = h.cells.filter((c) => c.partial);
    expect(partial.length).toBeGreaterThan(5);
    expect(partial.some((c) => c.value > 0)).toBe(true); // the days that carry a value
    for (const c of partial) {
      expect(c.beforeArchive).toBe(false);
      expect(c.day >= (h.range.archiveStart as string) && c.day < (h.range.completeFrom as string)).toBe(true);
    }
    expect(h.cells.filter((c) => !c.partial && !c.beforeArchive && !c.afterToday).every((c) => c.day >= (h.range.completeFrom as string))).toBe(true);
  });
});

test.describe('heatmap', () => {
  for (const metric of ['messages', 'tokens', 'sessions'] as ActivityMetric[]) {
    test(`partial cells carry the marking and keep the value and step of /api/heatmap (${metric})`, async ({ page }) => {
      await go(page, metric === 'messages' ? '' : `?metric=${metric}`);
      const api = await getJson<Heatmap>(`/api/heatmap?metric=${metric}`);
      const seen = await page.locator('[data-chart="heatmap"] g.hm__c').evaluateAll((els) =>
        els.map((e) => ({
          day: e.getAttribute('data-day') ?? '',
          value: e.getAttribute('data-value'),
          level: e.getAttribute('data-level'),
          state: e.getAttribute('data-state'),
          partial: e.getAttribute('data-partial'),
          overlay: e.querySelectorAll('rect.hm__partial').length,
          cellPaint: getComputedStyle(e.querySelector('.hm__cell') as Element).fill,
          label: e.getAttribute('aria-label') ?? '',
        })),
      );
      const byDay = new Map(seen.map((s) => [s.day, s]));
      const problems: string[] = [];
      let marked = 0;
      for (const c of api.cells) {
        const s = byDay.get(c.day);
        if (s === undefined) {
          problems.push(`${c.day} missing`);
          continue;
        }
        if (c.partial && !c.beforeArchive && !c.afterToday) {
          marked += 1;
          if (s.partial !== 'true' || s.overlay !== 1) problems.push(`${c.day} should be marked`);
          // the value and the colour step are those of the API: the marking does not replace them
          if (s.state !== 'value' || s.value !== String(c.value) || s.level !== String(levelOf(c.value, api.thresholds))) problems.push(`${c.day} value ${s.value}/${s.level} vs ${c.value}`);
          if (!/possibly incomplete/i.test(s.label)) problems.push(`${c.day} label ${s.label}`);
          if (s.cellPaint.startsWith('url(')) problems.push(`${c.day} is drawn hatched like an unknown day`);
        } else {
          if (s.partial !== null || s.overlay !== 0) problems.push(`${c.day} should not be marked`);
          if (/possibly incomplete/i.test(s.label)) problems.push(`${c.day} label says incomplete`);
        }
      }
      expect(problems).toEqual([]);
      expect(marked).toBeGreaterThan(5);
      expect(await page.locator('[data-chart="heatmap"] rect.hm__partial').count()).toBe(marked);
      // the legend names the marking, between the colour steps and the unknown days
      const items = await page.locator('[data-chart="heatmap"] .hm__scale li').allTextContents();
      expect(items.slice(-2).map((t) => t.trim())).toEqual(['Possibly incomplete', 'Before the archive']);
    });
  }

  test('the marking is different from the hatch of unknown days: dots, not lines, and the value stays visible', async ({ page }) => {
    await go(page);
    const kinds = await page.evaluate(() => {
      const partial = document.querySelector('[data-chart="heatmap"] g.hm__c[data-partial="true"] rect.hm__partial') as SVGRectElement;
      const before = document.querySelector('[data-chart="heatmap"] g.hm__c[data-state="before"] rect.hm__cell') as SVGRectElement;
      const pat = (el: SVGRectElement): string => {
        const id = (el.getAttribute('fill') ?? '').replace(/^url\(#|\)$/g, '');
        const p = document.getElementById(id);
        return p === null ? '' : p.firstElementChild?.tagName ?? '';
      };
      return { partial: pat(partial), before: pat(before) };
    });
    expect(kinds).toEqual({ partial: 'circle', before: 'line' });
  });

  for (const [name, width] of [
    ['phone', 390],
    ['tablet', 768],
    ['desktop', 1440],
  ] as const) {
    test(`two hairlines with their labels, which never overlap, at ${name} width`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await go(page);
      const api = await getJson<Heatmap>('/api/heatmap');
      const archive = page.locator('[data-chart="heatmap"] .hm__horizon');
      const complete = page.locator('[data-chart="heatmap"] .hm__complete');
      await expect(archive).toHaveAttribute('data-horizon', api.range.archiveStart as string);
      await expect(complete).toHaveAttribute('data-complete-from', api.range.completeFrom as string);
      await expect(page.locator('[data-chart="heatmap"] .hm__flag')).toHaveText(`Archive starts ${long(api.range.archiveStart as string)}`);
      await expect(page.locator('[data-chart="heatmap"] .hm__mark')).toHaveText(`Complete from ${long(api.range.completeFrom as string)}`);
      const a = await box(page, '[data-chart="heatmap"] .hm__flag');
      const c = await box(page, '[data-chart="heatmap"] .hm__mark');
      expect(intersect(a, c)).toBe(false);
      // both stay inside the drawing, so neither is cut off by the card or by the scrolling box's edge
      const svg = await box(page, '[data-chart="heatmap"] svg.hm__svg');
      for (const b of [a, c]) {
        expect(b.left).toBeGreaterThanOrEqual(svg.left - 1);
        expect(b.right).toBeLessThanOrEqual(svg.right + 1);
        expect(b.bottom).toBeLessThanOrEqual(svg.bottom + 1);
      }
      // the lines of the two hairlines are two separate paths
      expect(await page.locator('[data-chart="heatmap"] .hm__horizon path, [data-chart="heatmap"] .hm__complete path').count()).toBe(2);
      // at phone width the newest weeks are on screen: both labels are visible without scrolling the page sideways
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      if (width === 390) {
        const scroller = await box(page, '[data-chart="heatmap"] .hm__scroll');
        for (const b of [a, c]) {
          expect(b.right).toBeGreaterThan(scroller.left);
          expect(b.left).toBeLessThan(scroller.right);
        }
        expect(c.left).toBeGreaterThanOrEqual(scroller.left - 1);
        expect(c.right).toBeLessThanOrEqual(scroller.right + 1);
      }
    });
  }

  test('the readout of a partial day says so, and the sessions of that day are still listed', async ({ page }) => {
    await go(page);
    const api = await getJson<Heatmap>('/api/heatmap');
    const withValue = api.cells.find((c) => c.partial && c.value > 0 && !c.beforeArchive) as Heatmap['cells'][number];
    await page.locator(`g.hm__c[data-day="${withValue.day}"]`).hover();
    const tip = page.locator('#hm-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Possibly incomplete');
    await expect(tip).toContainText(`${n(withValue.value)} message`);
    await expect(tip.locator('.ctip__list li').first()).toBeVisible();
    // a complete day does not say it
    const complete = api.cells.find((c) => !c.partial && !c.beforeArchive && !c.afterToday && c.value > 0) as Heatmap['cells'][number];
    await page.locator(`g.hm__c[data-day="${complete.day}"]`).hover();
    await expect(page.locator(`#hm-tip[data-day-tip="${complete.day}"]`)).toBeVisible();
    await expect(page.locator('#hm-tip')).not.toContainText('Possibly incomplete');
    // an unknown day says unknown, not possibly incomplete
    const before = api.cells.find((c) => c.beforeArchive) as Heatmap['cells'][number];
    await page.locator(`g.hm__c[data-day="${before.day}"]`).hover();
    await expect(page.locator(`#hm-tip[data-day-tip="${before.day}"]`)).toContainText('unknown, not zero');
    await expect(page.locator('#hm-tip')).not.toContainText('Possibly incomplete');
  });

  test('the table view marks the partial days and says what the marking means', async ({ page }) => {
    await go(page);
    const api = await getJson<Heatmap>('/api/heatmap');
    await page.getByTestId('heatmap-table-toggle').click();
    const rows = await page.locator('table[data-table="heatmap"] td[data-day]').evaluateAll((els) =>
      els.map((e) => ({ day: e.getAttribute('data-day') ?? '', partial: e.getAttribute('data-partial'), text: (e.textContent ?? '').trim() })),
    );
    const byDay = new Map(rows.map((r) => [r.day, r]));
    for (const c of api.cells) {
      const r = byDay.get(c.day);
      if (c.partial && !c.beforeArchive && !c.afterToday) {
        expect([r?.partial, /possibly incomplete/i.test(r?.text ?? '')]).toEqual(['true', true]);
        expect(r?.text.startsWith(n(c.value))).toBe(true);
      } else expect(r?.partial).toBeNull();
    }
    await expect(page.locator('[data-note="partial-table"]')).toContainText('Possibly incomplete');
    await expect(page.locator('table[data-table="heatmap"] caption')).toContainText('possibly incomplete');
  });
});

test.describe('daily chart', () => {
  test('a stippled band sits behind exactly the partial days, the bars keep their values, a second hairline ends it', async ({ page }) => {
    await go(page, '?metric=tokens');
    const api = await getJson<Daily>('/api/daily?metric=tokens');
    const partial = api.days.filter((d) => d.partial);
    expect(partial.length).toBeGreaterThan(5);
    expect(api.days.filter((d) => d.partial).every((d) => d.day >= (api.range.archiveStart as string) && d.day < (api.range.completeFrom as string))).toBe(true);
    const band = page.locator('[data-chart="daily"] rect.dc__partial');
    await expect(band).toHaveCount(1);
    await expect(band).toHaveAttribute('data-from', partial[0]?.day as string);
    await expect(band).toHaveAttribute('data-to', partial[partial.length - 1]?.day as string);
    // the band spans as many days as the API marks: its width is that share of the plot
    const plot = await box(page, '[data-chart="daily"] .dc__hit');
    const bandBox = await box(page, '[data-chart="daily"] rect.dc__partial');
    const step = (plot.right - plot.left) / api.days.length;
    expect(Math.abs(bandBox.right - bandBox.left - partial.length * step)).toBeLessThan(1.5);
    expect(Math.abs(bandBox.left - plot.left)).toBeLessThan(1.5); // all time starts on the first partial day
    // bars of partial days are drawn with their values
    const segs = await page.locator('[data-chart="daily"] path.dc__seg').evaluateAll((els) => els.map((e) => [e.getAttribute('data-day'), e.getAttribute('data-model'), Number(e.getAttribute('data-value'))] as const));
    for (const d of partial.filter((x) => x.total > 0)) {
      for (const m of api.models) {
        const v = d.byModel[m] ?? 0;
        if (v > 0) expect(segs.some(([day, model, value]) => day === d.day && model === m && value === v)).toBe(true);
      }
    }
    // the second hairline and its label
    await expect(page.locator('[data-chart="daily"] .hm__complete')).toHaveAttribute('data-complete-from', api.range.completeFrom as string);
    await expect(page.locator('[data-chart="daily"] .hm__mark')).toHaveText(`Complete from ${long(api.range.completeFrom as string)}`);
    const line = await box(page, '[data-chart="daily"] .hm__complete path');
    expect(Math.abs(line.left - bandBox.right)).toBeLessThan(1.5); // the hairline is where the band ends
    // the legend names it
    await expect(page.locator('[data-chart="daily"] .legend li[data-legend="partial"]')).toHaveText('Possibly incomplete');
  });

  for (const metric of ['messages', 'sessions'] as ActivityMetric[]) {
    test(`${metric}: one series, the key for the marking sits in the card head`, async ({ page }) => {
      await go(page, `?metric=${metric}`);
      await expect(page.locator('[data-chart="daily"] .legend')).toHaveCount(0);
      await expect(page.locator('[data-chart="daily"] .chart__tools li[data-legend="partial"]')).toHaveText('Possibly incomplete');
      await expect(page.locator('[data-chart="daily"] rect.dc__partial')).toHaveCount(1);
    });
  }

  for (const [name, width] of [
    ['phone', 390],
    ['tablet', 768],
    ['desktop', 1440],
  ] as const) {
    test(`both labels (a range that starts before the archive) are present and do not overlap at ${name} width`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await go(page);
      await page.getByRole('button', { name: '90d' }).click();
      await expect(page).toHaveURL(/from=/);
      const params = new URL(page.url()).searchParams.toString();
      const api = await getJson<Daily>(`/api/daily?${params}&metric=messages`);
      expect(api.range).toMatchObject({ coverageGap: true, partialGap: true });
      const flag = page.locator('[data-chart="daily"] .hm__flag');
      const mark = page.locator('[data-chart="daily"] .hm__mark');
      await expect(flag).toHaveText(`Archive starts ${long(api.range.archiveStart as string)}`);
      await expect(mark).toHaveText(`Complete from ${long(api.range.completeFrom as string)}`);
      const a = await box(page, '[data-chart="daily"] .hm__flag');
      const c = await box(page, '[data-chart="daily"] .hm__mark');
      expect(intersect(a, c)).toBe(false);
      const svg = await box(page, '[data-chart="daily"] svg.dc__svg');
      for (const b of [a, c]) {
        expect(b.left).toBeGreaterThanOrEqual(svg.left - 1);
        expect(b.right).toBeLessThanOrEqual(svg.right + 1);
        expect(b.top).toBeGreaterThanOrEqual(svg.top - 1);
      }
      // unknown days are hatched, partial days are stippled, and the two never share a bar
      const before = api.days.filter((d) => d.day < (api.range.archiveStart as string)).length;
      // one hatched bar per day, or per run of days on a narrow plot
      const hatched = await page.locator('[data-chart="daily"] .dc__before').count();
      expect(hatched).toBeGreaterThan(0);
      if (width >= 768) expect(hatched).toBe(before);
      await expect(page.locator('[data-chart="daily"] rect.dc__partial')).toHaveAttribute('data-from', api.range.archiveStart as string);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    });
  }

  test('the readout of a partial day says so; a complete day and an unknown day do not', async ({ page }) => {
    await go(page);
    const api = await getJson<Daily>('/api/daily?metric=messages');
    const tip = page.locator('[data-chart="daily"] .ctip');
    await page.locator('[data-chart="daily"] g.dc__chart').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Home'); // the first day is the archive start day, which is partial
    await expect(tip).toContainText(long(api.days[0]?.day as string));
    await expect(tip).toContainText('Possibly incomplete');
    await expect(page.locator('[data-chart="daily"] [aria-live="polite"]')).toContainText('possibly incomplete');
    await page.keyboard.press('End');
    await expect(tip).toContainText(long(api.days[api.days.length - 1]?.day as string));
    await expect(tip).not.toContainText('Possibly incomplete');
  });

  test('the table view marks each partial day with the words', async ({ page }) => {
    await go(page);
    const api = await getJson<Daily>('/api/daily?metric=messages');
    await page.getByTestId('daily-table-toggle').click();
    const rows = await page.locator('table[data-table="daily"] tbody tr').evaluateAll((trs) =>
      trs.map((tr) => ({ day: tr.getAttribute('data-day') ?? '', partial: tr.getAttribute('data-partial'), head: (tr.querySelector('th')?.textContent ?? '').trim(), total: Number(tr.querySelector('td[data-total]')?.getAttribute('data-total')) })),
    );
    expect(rows).toHaveLength(api.days.length);
    for (const d of api.days) {
      const r = rows.find((x) => x.day === d.day);
      if (d.partial) expect([r?.partial, r?.head.includes('Possibly incomplete'), r?.total]).toEqual(['true', true, d.total]);
      else expect([r?.partial, r?.head.includes('Possibly incomplete')]).toEqual([null, false]);
    }
    await expect(page.locator('table[data-table="daily"] caption')).toContainText('possibly incomplete');
  });
});

test.describe('light and dark', () => {
  for (const scheme of ['dark', 'light'] as const) {
    test(`the stipple dots are visible against a cell and against the panel in ${scheme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, timezoneId: 'UTC', locale: 'en-GB' });
      const page = await ctx.newPage();
      await go(page);
      const colours = await page.evaluate(() => {
        const dot = document.querySelector('.partial__dot:not(.partial__dot--band)') as SVGCircleElement;
        const band = document.querySelector('.partial__dot--band') as SVGCircleElement;
        const cs = getComputedStyle(document.documentElement);
        return { dot: getComputedStyle(dot).fill, band: getComputedStyle(band).fill, panel: cs.getPropertyValue('--panel').trim() };
      });
      // the dots carry some opacity (rgb with alpha), and the band's are lighter than the cells'
      const alpha = (c: string): number => Number(/\/\s*([\d.]+)\)|,\s*([\d.]+)\)$/.exec(c)?.[1] ?? /,\s*([\d.]+)\)$/.exec(c)?.[1] ?? 1);
      expect(alpha(colours.dot)).toBeGreaterThan(alpha(colours.band));
      expect(alpha(colours.band)).toBeGreaterThan(0.15);
      await ctx.close();
    });
  }
});
