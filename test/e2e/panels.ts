// Contrast of every piece of visible text against the background it sits on (WCAG 2): the same scan the dashboard spec runs on
// the closed page, here callable after panels are opened. Large text needs 3:1, the rest 4.5:1.
import type { Page } from '@playwright/test';

export async function textContrastProblems(page: Page, within = 'body'): Promise<{ problems: string[]; checked: number }> {
  return page.evaluate((scope) => {
    const parse = (v: string): [number, number, number, number] => {
      const m = v.match(/[\d.]+/g) ?? ['0', '0', '0', '0'];
      return [Number(m[0]), Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])];
    };
    const lum = ([r, g, b]: number[]): number => {
      const f = (x: number): number => (x / 255 <= 0.04045 ? x / 255 / 12.92 : ((x / 255 + 0.055) / 1.055) ** 2.4);
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
    for (const el of document.querySelectorAll<HTMLElement>(`${scope} *`)) {
      const own = [...el.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim() !== '');
      if (!own || !el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
      if (el.closest('.sr-only, .skip, [aria-hidden="true"], .tip__bubble')) continue;
      const cs = getComputedStyle(el);
      const bg = backdrop(el);
      const fg = over(parse(cs.color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
      const ratioNow = (hi + 0.05) / (lo + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      checked += 1;
      if (ratioNow < (large ? 3 : 4.5)) problems.push(`${el.className || el.tagName} "${(el.textContent ?? '').trim().slice(0, 24)}" ${ratioNow.toFixed(2)}`);
    }
    return { problems, checked };
  }, within);
}
