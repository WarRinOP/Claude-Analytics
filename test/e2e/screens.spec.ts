// Screenshots for a human to look at: 390, 768 and 1440 px, dark and light, one with reduced motion, and the states that
// matter. Written to test-results/screens/ (git ignored), taken against the synthetic data.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { DayDetail, Heatmap } from '../../src/api/types.ts';
import { base, getJson } from './helpers.ts';

const out = join(process.cwd(), 'test-results', 'screens');
mkdirSync(out, { recursive: true });

async function ready(page: Page, query = ''): Promise<void> {
  await page.goto(`${base()}/${query}`);
  await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
  await page.waitForTimeout(300);
}

const sizes = [
  ['390', 390, 844],
  ['768', 768, 1024],
  ['1440', 1440, 900],
] as const;

for (const [name, width, height] of sizes) {
  for (const theme of ['dark', 'light'] as const) {
    test(`screenshot ${name} ${theme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
      const page = await ctx.newPage();
      await ready(page);
      await page.screenshot({ path: join(out, `${name}-${theme}.png`), fullPage: true });
      await ctx.close();
    });
  }
}

test('screenshot 1440 dark with reduced motion', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await ready(page);
  await page.screenshot({ path: join(out, '1440-dark-reduced-motion.png'), fullPage: true });
  await ctx.close();
});

test('screenshots of states: 90d with the coverage note, a filter popover, the empty range', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await ready(page);
  await page.getByRole('button', { name: '90d' }).click();
  await expect(page.locator('[data-note="coverage"]')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, '1440-dark-coverage-note.png') });
  await page.getByRole('button', { name: /^Model/ }).click();
  await page.getByRole('checkbox', { name: 'claude-sonnet-5-5' }).check();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, '1440-dark-model-filter-open.png') });
  await page.goto(`${base()}/?from=2020-01-01&to=2020-01-05`);
  await expect(page.getByText('No Claude Code activity in this range')).toBeVisible();
  await page.screenshot({ path: join(out, '1440-dark-empty.png') });
  await ctx.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  const p = await phone.newPage();
  await ready(p, '?from=2026-09-01');
  await p.getByRole('button', { name: /^Project/ }).click();
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(out, '390-light-project-filter-open.png') });
  await phone.close();
});

// The time charts: the heatmap with a busy day open (tally marks), the daily chart with its readout, the table views and the
// keyboard focus ring.
async function busyDay(): Promise<string> {
  const api = await getJson<Heatmap>('/api/heatmap?metric=messages');
  let best = { day: '', n: 0 };
  for (const c of api.cells.filter((x) => x.value > 0)) {
    const d = await getJson<DayDetail>(`/api/day?date=${c.day}`);
    if (d.sessions.length > best.n) best = { day: c.day, n: d.sessions.length };
  }
  return best.day;
}

for (const theme of ['dark', 'light'] as const) {
  test(`screenshots of the charts in ${theme}: tooltip, tokens, tables, keyboard focus`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
    const page = await ctx.newPage();
    const day = await busyDay();
    await ready(page);
    const card = page.locator('[data-chart="heatmap"]');
    await card.scrollIntoViewIfNeeded();
    await page.locator(`g.hm__c[data-day="${day}"]`).hover();
    await expect(page.locator('#hm-tip .tally__group').first()).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `1440-${theme}-heatmap-tooltip.png`) });

    await page.mouse.move(0, 0);
    await page.locator('g.hm__c[tabindex="0"]').focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `1440-${theme}-heatmap-keyboard.png`) });

    await page.goto(`${base()}/?metric=tokens`);
    await expect(page.locator('[data-chart="daily"] .dc__svg')).toBeVisible();
    await page.locator('[data-chart="daily"]').scrollIntoViewIfNeeded();
    const box = await page.locator('[data-chart="daily"] .dc__hit').boundingBox();
    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) * 0.62, (box?.y ?? 0) + 60);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `1440-${theme}-daily-tokens.png`) });

    await page.goto(`${base()}/`);
    for (const id of ['heatmap', 'daily', 'hours']) await page.getByTestId(`${id}-table-toggle`).click();
    await page.waitForTimeout(250);
    await page.locator('[data-chart="heatmap"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `1440-${theme}-tables.png`) });
    await ctx.close();
  });
}

test('screenshots of the charts on a phone: heatmap with the day open by a tap', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', hasTouch: true });
  const page = await ctx.newPage();
  const day = await busyDay();
  await ready(page);
  await page.locator('[data-chart="heatmap"]').scrollIntoViewIfNeeded();
  await page.locator(`g.hm__c[data-day="${day}"]`).tap();
  await expect(page.locator('#hm-tip .tally__group').first()).toBeVisible();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, '390-dark-heatmap-tooltip.png') });
  await ctx.close();
});
