/**
 * DOM helpers for the vanilla-TS UI layer.
 * Replaces Svelte's template/bind syntax with direct DOM construction.
 */

export type Children = (Node | string)[];

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Children
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== "" && v != null) e.setAttribute(k, v);
  }
  for (const c of children) {
    e.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}
