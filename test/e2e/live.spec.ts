// The server's `synced` event refetches the panels on screen: append a turn to a synthetic transcript and watch the numbers move.
import { expect, test } from '@playwright/test';
import { appendTurn } from './fixture.ts';
import { base, expectKpisEqual, root, summary } from './helpers.ts';

test('a line appended to a transcript shows up on the open dashboard without a reload', async ({ page }) => {
  await page.goto(`${base()}/`);
  await expect(page.locator('[data-kpi="sessions"]')).toBeVisible();
  const before = await summary();
  await expectKpisEqual(page, before);
  appendTurn(root());
  await expect(page.locator('[data-kpi="responses"]')).toHaveText((before.responses + 1).toLocaleString('en-US'), { timeout: 20_000 });
  await expect(page.locator('[data-kpi="prompts"]')).toHaveText((before.prompts + 1).toLocaleString('en-US'));
  await expectKpisEqual(page, await summary());
  await expect(page.getByRole('link', { name: /^Synced \d\d:\d\d$/ })).toBeVisible();
});
