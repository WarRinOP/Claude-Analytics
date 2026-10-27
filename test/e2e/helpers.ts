import { expect, type Page } from '@playwright/test';
import type { Summary } from '../../src/api/types.ts';

export const base = (): string => process.env['LEDGER_E2E_URL'] ?? '';
export const root = (): string => process.env['LEDGER_E2E_ROOT'] ?? '';

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base()}${path}`);
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}

export const summary = (query = ''): Promise<Summary> => getJson<Summary>(`/api/summary${query === '' ? '' : `?${query}`}`);

export const n = (v: number): string => v.toLocaleString('en-US');

// Dollars as the dashboard writes them: cents, and "<$0.01" under one cent.
const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = (v: number): string => (v > 0 && v < 0.01 ? '<$0.01' : usdFmt.format(v));

export function hours(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under 1 m';
  if (minutes < 60) return `${minutes} m`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h} h ${minutes % 60} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

// Visible text of one KPI value, as a user reads it.
export async function kpi(page: Page, name: string): Promise<string> {
  return ((await page.locator(`[data-kpi="${name}"]`).first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

// Waits for the figures, then checks every KPI on screen against the API answer for the same filters.
export async function expectKpisEqual(page: Page, s: Summary): Promise<void> {
  await expect(page.locator('[data-kpi="sessions"]')).toHaveText(n(s.sessions));
  await expect(page.locator('[data-kpi="messages"]')).toHaveText(n(s.messages));
  await expect(page.locator('[data-kpi="prompts"]')).toHaveText(n(s.prompts));
  await expect(page.locator('[data-kpi="responses"]')).toHaveText(n(s.responses));
  await expect(page.locator('[data-kpi="tokens"]')).toHaveText(n(s.tokens.total));
  await expect(page.locator('[data-kpi="tokens.input"]')).toHaveText(n(s.tokens.input));
  await expect(page.locator('[data-kpi="tokens.output"]')).toHaveText(n(s.tokens.output));
  await expect(page.locator('[data-kpi="tokens.cacheWrite"]')).toHaveText(n(s.tokens.cacheWrite));
  await expect(page.locator('[data-kpi="tokens.cacheRead"]')).toHaveText(n(s.tokens.cacheRead));
  await expect(page.locator('[data-kpi="activeDays"]')).toHaveText(n(s.activeDays));
  await expect(page.locator('[data-kpi="days"]')).toHaveText(n(s.range.days));
}

export function collectProblems(page: Page): { errors: string[]; failed: string[]; hosts: Set<string> } {
  const errors: string[] = [];
  const failed: string[] = [];
  const hosts = new Set<string>();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => hosts.add(new URL(r.url()).host));
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  return { errors, failed, hosts };
}

// Contrast ratio (WCAG 2) of two #rrggbb colours.
export function ratio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * (v[0] as number) + 0.7152 * (v[1] as number) + 0.0722 * (v[2] as number);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
