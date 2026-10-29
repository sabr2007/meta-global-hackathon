// Tiny element builders. Text goes in through text nodes only (never innerHTML), so run data that
// contains markup-like characters stays text.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined>;

function fill(el: Element, attrs: Attrs, children: Child[]): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'number' ? String(child) : child);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  fill(el, attrs, children);
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  fill(el, attrs, children);
  return el;
}

/** A number in Doto (numbers only), optionally with a unit in the body face. */
export function num(value: string | number, unit?: string, unitClass = 'figure__unit'): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(h('span', { class: 'num' }, value));
  if (unit) fragment.append(h('span', { class: unitClass }, unit));
  return fragment;
}

export function slot<T extends Element = HTMLElement>(name: string): T | null {
  return document.querySelector<T & Element>(`[data-slot="${name}"]`);
}

export function fillSlot(name: string, ...children: Child[]): void {
  const el = slot(name);
  if (!el) return;
  el.replaceChildren();
  fill(el, {}, children);
}
