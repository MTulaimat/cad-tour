/** Tiny DOM helpers; the UI is plain TypeScript, no framework. */

type Attrs = Record<string, string | boolean | number | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) e.append(c);
  return e;
}

export const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
export const hasArabic = (s: string): boolean => ARABIC.test(s);

/** Sets text and direction for user-provided labels (room names from DXF files). */
export function setLabel(node: HTMLElement, text: string): void {
  node.textContent = text;
  node.dir = hasArabic(text) ? 'rtl' : 'auto';
  if (hasArabic(text)) document.documentElement.classList.add('has-arabic');
}

export function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
