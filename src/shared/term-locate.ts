// Finding a picked term again in its document: "show in document" on a card.
// Runs in the app's readers and in web pages (via the webview preload).
//
// A locator keeps the term's exact text, some text on either side and its
// position. Text is compared without whitespace and case, so the same passage
// matches however a reader splits it into lines, blocks or PDF text runs.

import type { Region, TermContext, TermLocator } from './types';

const CONTEXT_CHARS = 48;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'SVG', 'MATH']);
const IGNORED = /[\s\u00ad\u200b-\u200d\u2060\ufeff]/;

/** Text as compared: whitespace and soft hyphens dropped, lower case where that keeps the length. */
export function normalize(s: string): string {
  let out = '';
  for (const ch of s) {
    if (IGNORED.test(ch)) continue;
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Where the locator's term is in `hay` (normalized text), or -1. The occurrence
 * whose surroundings match best wins; among equals, the one nearest the saved position.
 */
export function bestMatch(hay: string, loc: Pick<TermLocator, 'quote' | 'prefix' | 'suffix' | 'index'>): { at: number; length: number; score: number } | null {
  const q = normalize(loc.quote);
  if (!q) return null;
  const pre = normalize(loc.prefix);
  const suf = normalize(loc.suffix);
  let best = -1;
  let bestScore = -1;
  let bestDist = Infinity;
  for (let at = hay.indexOf(q); at >= 0; at = hay.indexOf(q, at + 1)) {
    const score = commonSuffix(hay.slice(Math.max(0, at - pre.length), at), pre) + commonPrefix(hay.slice(at + q.length, at + q.length + suf.length), suf);
    const dist = loc.index === undefined ? 0 : Math.abs(at - loc.index);
    if (score > bestScore || (score === bestScore && dist < bestDist)) {
      best = at;
      bestScore = score;
      bestDist = dist;
    }
  }
  return best < 0 ? null : { at: best, length: q.length, score: bestScore };
}

/** For cards saved before locators: the term inside its sentence. */
export function locatorFromContext(term: string, ctx: Pick<TermContext, 'term' | 'sentence'>): TermLocator {
  const quote = ctx.term || term;
  const i = ctx.sentence.indexOf(quote);
  return i < 0
    ? { quote, prefix: '', suffix: '' }
    : { quote, prefix: ctx.sentence.slice(Math.max(0, i - CONTEXT_CHARS), i), suffix: ctx.sentence.slice(i + quote.length, i + quote.length + CONTEXT_CHARS) };
}

interface Flat {
  text: string;
  /** Per text node: where its normalized text starts. */
  segs: { node: Text; start: number }[];
}

/** Visits the text nodes of `root` that are shown text (not scripts, styles, hidden parts or Glossa's own overlays); false stops. */
export function eachText(root: Node, visit: (t: Text) => boolean | void, skipElement?: (el: Element) => boolean): void {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      const el = n as Element;
      if (SKIP.has(el.tagName.toUpperCase()) || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('data-glossa-overlay') || el.hasAttribute('data-glossa-locate') || skipElement?.(el)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_SKIP;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (visit(n as Text) === false) return;
}

function flatten(root: Node): Flat {
  const segs: Flat['segs'] = [];
  let text = '';
  eachText(root, (node) => {
    const n = normalize(node.data);
    if (!n) return;
    segs.push({ node, start: text.length });
    text += n;
  });
  return { text, segs };
}

/** Position (normalized characters) of a point in `root`'s text. */
export function textIndex(root: Node, node: Node, offset: number): number | undefined {
  let count = 0;
  let found: number | undefined;
  eachText(root, (t) => {
    if (t === node) {
      found = count + normalize(t.data.slice(0, offset)).length;
      return false;
    }
    count += normalize(t.data).length;
  });
  return found;
}

/** A locator for the span [start, end) of `text`, a block of `root` starting at (node, offset). */
export function makeLocator(o: { text: string; start: number; end: number; root: Node; node: Node; offset: number; page?: number }): TermLocator {
  return {
    quote: o.text.slice(o.start, o.end).slice(0, 600),
    prefix: o.text.slice(Math.max(0, o.start - CONTEXT_CHARS), o.start),
    suffix: o.text.slice(o.end, o.end + CONTEXT_CHARS),
    index: textIndex(o.root, o.node, o.offset),
    ...(o.page ? { page: o.page } : {}),
  };
}

/** Raw offset in `node` of its `k`-th normalized character (k may equal the normalized length). */
function rawOffset(node: Text, k: number, end: boolean): number {
  let seen = 0;
  for (let i = 0; i < node.data.length; ) {
    const ch = String.fromCodePoint(node.data.codePointAt(i)!);
    if (!IGNORED.test(ch)) {
      if (seen === k && !end) return i;
      // normalize() keeps every kept character's length.
      seen += ch.length;
      if (seen === k && end) return i + ch.length;
    }
    i += ch.length;
  }
  return node.data.length;
}

function pointAt(flat: Flat, k: number, end: boolean): { node: Text; offset: number } | null {
  // The segment holding character k (for an end point, character k - 1).
  let lo = 0;
  let hi = flat.segs.length - 1;
  const want = end ? k - 1 : k;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (flat.segs[mid].start <= want) lo = mid;
    else hi = mid - 1;
  }
  const seg = flat.segs[lo];
  if (!seg) return null;
  return { node: seg.node, offset: rawOffset(seg.node, k - seg.start, end) };
}

/** The term of `loc` in `root`, or null when the document no longer contains it. */
export function findTerm(root: Node, loc: TermLocator): Range | null {
  const flat = flatten(root);
  const m = bestMatch(flat.text, loc);
  if (!m) return null;
  const a = pointAt(flat, m.at, false);
  const b = pointAt(flat, m.at + m.length, true);
  if (!a || !b) return null;
  const r = (root.ownerDocument ?? (root as Document)).createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}

/** The nearest ancestor that scrolls along `axis`; null = the window. */
function scrollParent(el: Element | null, axis: 'x' | 'y'): Element | null {
  for (let cur = el; cur && cur !== cur.ownerDocument.documentElement; cur = cur.parentElement) {
    const st = getComputedStyle(cur);
    const scrolls = axis === 'y' ? /(auto|scroll)/.test(st.overflowY) && cur.scrollHeight > cur.clientHeight : /(auto|scroll)/.test(st.overflowX) && cur.scrollWidth > cur.clientWidth;
    if (scrolls) return cur;
  }
  return null;
}

function visible(scroller: Element | null, view: Window) {
  return scroller ? scroller.getBoundingClientRect() : { top: 0, left: 0, bottom: view.innerHeight, right: view.innerWidth, height: view.innerHeight, width: view.innerWidth };
}

/**
 * Scrolls so the range sits in the middle of what is visible. `avoid` (client
 * coordinates, e.g. the card asking) is kept clear when there is room above or below it.
 */
export function scrollToRange(range: Range, avoid?: Box): void {
  scrollToBox(range.startContainer.parentElement!, () => range.getBoundingClientRect(), avoid);
}

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Scrolls the scrollers around `inside` so `box()` (client coordinates, read again after each step) is in view. */
export function scrollToBox(inside: Element, box: () => DOMRect, avoid?: Box): void {
  const view = inside.ownerDocument.defaultView!;
  const sy = scrollParent(inside, 'y');
  const by = visible(sy, view);
  const r = box();
  let y = by.top + by.height / 2 - r.height / 2;
  if (avoid && avoid.left < r.right && avoid.right > r.left && y + r.height > avoid.top && y < avoid.bottom) {
    const above = avoid.top - by.top;
    const below = by.bottom - avoid.bottom;
    const need = r.height + 24;
    if (above >= need && above >= below) y = by.top + above / 2 - r.height / 2;
    else if (below >= need) y = avoid.bottom + below / 2 - r.height / 2;
  }
  (sy ?? view).scrollBy({ top: r.top - y, behavior: 'instant' });
  const sx = scrollParent(inside, 'x');
  const bx = visible(sx, view);
  const r2 = box();
  if (r2.left < bx.left + 16 || r2.right > bx.right - 16) (sx ?? view).scrollBy({ left: r2.left - (bx.left + bx.width / 2 - r2.width / 2), behavior: 'instant' });
}

let current: (() => void) | null = null;

/**
 * Highlights the range for a few seconds, following scrolling. Drawn above the
 * page (nothing in it changes), clipped to `clip` when given. Returns the overlay.
 */
export function flashRange(range: Range, clip?: Element | null, ms = 2600): HTMLElement {
  return flashBoxes(range.startContainer.ownerDocument!, () => Array.from(range.getClientRects()), clip, ms);
}

/** Highlights the boxes `rects()` returns (client coordinates, read again while the page scrolls). */
export function flashBoxes(doc: Document, rects: () => DOMRect[], clip?: Element | null, ms = 2600): HTMLElement {
  current?.();
  const view = doc.defaultView!;
  const overlay = doc.createElement('div');
  overlay.setAttribute('data-glossa-locate', '');
  overlay.setAttribute('aria-hidden', 'true');
  const draw = () => {
    const c = clip?.getBoundingClientRect() ?? { left: 0, top: 0, width: view.innerWidth, height: view.innerHeight };
    overlay.style.cssText = `position:fixed;left:${c.left}px;top:${c.top}px;width:${c.width}px;height:${c.height}px;overflow:hidden;pointer-events:none;z-index:2147483645;`;
    overlay.replaceChildren();
    for (const rc of rects()) {
      if (rc.width <= 0 || rc.height <= 0) continue;
      const d = doc.createElement('div');
      d.style.cssText =
        `position:absolute;left:${rc.left - c.left - 3}px;top:${rc.top - c.top - 2}px;width:${rc.width + 6}px;height:${rc.height + 4}px;` +
        'background:rgba(255,196,0,.42);outline:2px solid rgba(255,150,0,.95);border-radius:4px;box-shadow:0 0 0 4px rgba(255,170,0,.25);';
      overlay.appendChild(d);
    }
  };
  draw();
  (doc.body ?? doc.documentElement).appendChild(overlay);
  // Web Animations are not blocked by a page's style CSP, unlike a <style> element.
  // Starts fully visible (a stalled animation still shows it): one pulse, then a fade at the end.
  overlay.animate([{ opacity: 1 }, { opacity: 0.45, offset: 0.12 }, { opacity: 1, offset: 0.25 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: ms, easing: 'ease-out' });
  const onMove = () => draw();
  view.addEventListener('scroll', onMove, true);
  view.addEventListener('resize', onMove);
  const timer = setTimeout(() => stop(), ms);
  const stop = () => {
    clearTimeout(timer);
    view.removeEventListener('scroll', onMove, true);
    view.removeEventListener('resize', onMove);
    overlay.remove();
    if (current === stop) current = null;
  };
  current = stop;
  return overlay;
}

/** A web page region (CSS pixels from the page's top left) in client coordinates now. */
export function pageRegionRect(doc: Document, r: Region): DOMRect {
  const v = doc.defaultView!;
  return new DOMRect(r.x - v.scrollX, r.y - v.scrollY, r.w, r.h);
}

/** The inverse of pageRegionRect. */
export function toPageRegion(doc: Document, rect: Box): Region {
  const v = doc.defaultView!;
  return { x: rect.left + v.scrollX, y: rect.top + v.scrollY, w: rect.right - rect.left, h: rect.bottom - rect.top, px: true };
}

/** A region saved as fractions of `frame` (a PDF page, or a scroller's whole content), in client coordinates now. */
export function regionRect(frame: Element, r: Region, content = false): DOMRect {
  const b = frame.getBoundingClientRect();
  const w = content ? frame.scrollWidth : b.width;
  const h = content ? frame.scrollHeight : b.height;
  const left = b.left - (content ? frame.scrollLeft : 0);
  const top = b.top - (content ? frame.scrollTop : 0);
  return new DOMRect(left + r.x * w, top + r.y * h, r.w * w, r.h * h);
}

/** The inverse of regionRect: `rect` (client coordinates) as fractions of `frame`. */
export function toRegion(frame: Element, rect: Box, content = false): Region {
  const b = frame.getBoundingClientRect();
  const w = (content ? frame.scrollWidth : b.width) || 1;
  const h = (content ? frame.scrollHeight : b.height) || 1;
  const left = b.left - (content ? frame.scrollLeft : 0);
  const top = b.top - (content ? frame.scrollTop : 0);
  return { x: (rect.left - left) / w, y: (rect.top - top) / h, w: (rect.right - rect.left) / w, h: (rect.bottom - rect.top) / h };
}
