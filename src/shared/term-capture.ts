// Picking a term with the keyboard, in any DOM document: the app's own readers
// (PDF text layer, converted Word/Markdown) and web pages (via the webview preload).
//
// Hotkey over a word → the word is highlighted. ←/→ shrink/grow the end,
// Shift+←/→ grow/shrink the start, Enter / hotkey again / click on it confirms,
// Esc cancels. With text already selected, the hotkey confirms at once.

import { matchHotkey, parseHotkey, type Hotkey } from './hotkey';
import { cleanTerm, growEnd, growStart, sentenceAt, shrinkEnd, shrinkStart, windowAround, wordAt, type Span } from './segment';
import { guessLang, truncate } from './text';
import type { PickedTerm } from './types';

export interface CaptureOptions {
  doc: Document;
  hotkey: string;
  docMeta: () => { title: string; source: string; lang?: string };
  onConfirm: (picked: PickedTerm) => void;
  hint?: string;
  /** Limit picking to this element (default: whole document). */
  root?: () => Element | null;
}

interface TextMap {
  text: string;
  segs: { node: Text; start: number; end: number }[];
  block: Element;
  layer: boolean;
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TD', 'TH', 'TABLE', 'BLOCKQUOTE', 'PRE',
  'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'DT', 'DD', 'DL', 'FIGURE', 'FIGCAPTION', 'BODY',
]);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON', 'SVG', 'MATH', 'TEMPLATE']);
const MAX_BLOCK_CHARS = 20_000;

function findBlock(node: Node): { block: Element; layer: boolean } | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  if (!el) return null;
  const layer = el.closest('.textLayer');
  if (layer) return { block: layer, layer: true };
  let cur: Element | null = el;
  while (cur && !BLOCK_TAGS.has(cur.tagName)) cur = cur.parentElement;
  return cur ? { block: cur, layer: false } : null;
}

function buildMap(block: Element, layer: boolean): TextMap {
  const segs: TextMap['segs'] = [];
  const lineBreaks: number[] = [];
  let text = '';
  const sep = (s: string) => {
    if (text && !text.endsWith(s) && !text.endsWith('\n')) text += s;
  };
  const walk = (n: Node) => {
    if (text.length > MAX_BLOCK_CHARS) return;
    if (n.nodeType === Node.TEXT_NODE) {
      const v = (n as Text).data;
      if (!v) return;
      segs.push({ node: n as Text, start: text.length, end: text.length + v.length });
      text += v;
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    if (SKIP_TAGS.has(el.tagName.toUpperCase()) || el.getAttribute('aria-hidden') === 'true') return;
    if (el.tagName === 'BR') {
      if (layer && text && !/\s$/.test(text)) lineBreaks.push(text.length);
      return sep(layer ? ' ' : '\n');
    }
    const isBlock = !layer && BLOCK_TAGS.has(el.tagName) && el !== block;
    if (isBlock) sep('\n');
    for (const c of Array.from(el.childNodes)) walk(c);
    if (isBlock) sep('\n');
  };
  walk(block);
  // PDF lines are joined with spaces. A short line without closing punctuation
  // followed by a capital letter is a heading or a paragraph end: make it a break
  // so it does not run into the next sentence.
  if (lineBreaks.length) {
    const chars = text.split('');
    let lineStart = 0;
    for (const at of lineBreaks) {
      const line = text.slice(lineStart, at).trim();
      if (line.length < 70 && !/[.,;:!?\-–]$/.test(line) && /^\p{Lu}/u.test(text.slice(at + 1, at + 2))) chars[at] = '\n';
      lineStart = at + 1;
    }
    text = chars.join('');
  }
  return { text, segs, block, layer };
}

function offsetOf(map: TextMap, node: Node, offset: number): number | null {
  for (const s of map.segs) if (s.node === node) return s.start + Math.min(offset, s.end - s.start);
  return null;
}

function rangeFor(map: TextMap, span: Span, doc: Document): Range | null {
  const point = (off: number, preferNext: boolean) => {
    for (const s of map.segs) {
      if (off < s.end || (off === s.end && !preferNext)) return off >= s.start ? { node: s.node, o: off - s.start } : { node: s.node, o: 0 };
    }
    const last = map.segs[map.segs.length - 1];
    return last ? { node: last.node, o: last.end - last.start } : null;
  };
  const a = point(span.start, true);
  const b = point(span.end, false);
  if (!a || !b) return null;
  const r = doc.createRange();
  r.setStart(a.node, a.o);
  r.setEnd(b.node, b.o);
  return r;
}

function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const d = doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
  }
  const r = doc.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function nearestHeading(doc: Document, block: Element): string | undefined {
  const hs = Array.from(doc.querySelectorAll('h1, h2, h3')).slice(0, 500);
  let found: Element | undefined;
  for (const h of hs) {
    if (h.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING || h.contains(block)) found = h;
    else break;
  }
  const t = found?.textContent?.replace(/\s+/g, ' ').trim();
  return t ? truncate(t, 160) : undefined;
}

export function createTermCapture(o: CaptureOptions) {
  const { doc } = o;
  const view = doc.defaultView!;
  let hk: Hotkey | null = parseHotkey(o.hotkey);
  let mouse = { x: -1, y: -1 };
  let active: { map: TextMap; span: Span; lang?: string } | null = null;
  let overlay: HTMLDivElement | null = null;

  const langFor = (block: Element, text: string) =>
    block.closest('[lang]')?.getAttribute('lang') || o.docMeta().lang || guessLang(text);

  const draw = () => {
    clearOverlay();
    if (!active) return;
    const r = rangeFor(active.map, active.span, doc);
    if (!r) return;
    overlay = doc.createElement('div');
    overlay.setAttribute('data-glossa-overlay', '');
    overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    const rects = Array.from(r.getClientRects()).filter((x) => x.width > 0 && x.height > 0);
    for (const rc of rects) {
      const d = doc.createElement('div');
      d.style.cssText = `position:fixed;left:${rc.left - 2}px;top:${rc.top - 1}px;width:${rc.width + 4}px;height:${rc.height + 2}px;` +
        'background:rgba(255,196,0,.35);outline:2px solid rgba(255,170,0,.9);border-radius:3px;';
      overlay.appendChild(d);
    }
    const last = rects[rects.length - 1];
    if (last && o.hint) {
      const tip = doc.createElement('div');
      tip.textContent = o.hint;
      tip.style.cssText = `position:fixed;left:${Math.max(4, last.left)}px;top:${last.bottom + 6}px;` +
        'font:12px/1.4 system-ui,sans-serif;background:#222;color:#fff;padding:3px 7px;border-radius:5px;white-space:nowrap;opacity:.92;';
      overlay.appendChild(tip);
    }
    (doc.body ?? doc.documentElement).appendChild(overlay);
  };

  const clearOverlay = () => {
    overlay?.remove();
    overlay = null;
  };

  const cancel = () => {
    active = null;
    clearOverlay();
  };

  const inRoot = (n: Node) => {
    const root = o.root?.();
    return !root || root.contains(n);
  };

  const begin = (map: TextMap, span: Span) => {
    active = { map, span, lang: langFor(map.block, map.text) };
    draw();
  };

  const confirm = () => {
    if (!active) return;
    const { map, span, lang } = active;
    const r = rangeFor(map, span, doc);
    const term = cleanTerm(map.text.slice(span.start, span.end));
    cancel();
    if (!term || !r) return;
    const s = sentenceAt(map.text, span.start, lang);
    const sentence = map.text.slice(s.start, s.end).replace(/\s+/g, ' ').trim();
    const paragraph =
      !map.layer && map.text.length <= 1600 ? map.text.replace(/\s+/g, ' ').trim() : windowAround(map.text.replace(/\n/g, ' '), span, 700);
    const box = r.getBoundingClientRect();
    const meta = o.docMeta();
    o.onConfirm({
      context: {
        term,
        sentence: truncate(sentence, 1200),
        paragraph: truncate(paragraph, 2400),
        heading: map.layer ? undefined : nearestHeading(doc, map.block),
        docTitle: meta.title,
        docSource: meta.source,
        docLang: meta.lang,
        termLang: lang,
      },
      rect: { x: box.left, y: box.top, width: box.width, height: box.height },
    });
  };

  const startFromSelection = (): boolean => {
    const sel = view.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    if (!inRoot(r.startContainer)) return false;
    const fb = findBlock(r.startContainer);
    if (!fb) return false;
    const map = buildMap(fb.block, fb.layer);
    const a = offsetOf(map, r.startContainer, r.startOffset);
    let b = offsetOf(map, r.endContainer, r.endOffset);
    if (a === null) return false;
    if (b === null || b <= a) b = Math.min(map.text.length, a + sel.toString().length);
    sel.removeAllRanges();
    begin(map, { start: a, end: b });
    confirm();
    return true;
  };

  const startAtPointer = () => {
    const c = caretAt(doc, mouse.x, mouse.y);
    if (!c || c.node.nodeType !== Node.TEXT_NODE || !inRoot(c.node)) return;
    const fb = findBlock(c.node);
    if (!fb) return;
    const map = buildMap(fb.block, fb.layer);
    const off = offsetOf(map, c.node, c.offset);
    if (off === null) return;
    const lang = langFor(fb.block, map.text);
    const span = wordAt(map.text, off, lang);
    if (span) begin(map, span);
  };

  const onKey = (e: KeyboardEvent) => {
    if (active) {
      const t = active.map.text;
      const l = active.lang;
      let handled = true;
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter' || matchHotkey(e, hk)) confirm();
      else if (e.key === 'ArrowRight') active.span = e.shiftKey ? shrinkStart(t, active.span, l) : growEnd(t, active.span, l);
      else if (e.key === 'ArrowLeft') active.span = e.shiftKey ? growStart(t, active.span, l) : shrinkEnd(t, active.span, l);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        if (active) draw();
      }
      return;
    }
    if (!matchHotkey(e, hk) || isEditable(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!startFromSelection()) startAtPointer();
  };

  const onMove = (e: MouseEvent) => {
    mouse = { x: e.clientX, y: e.clientY };
  };

  const onDown = (e: MouseEvent) => {
    if (!active || !overlay) return;
    const inside = Array.from(overlay.children).some((d) => {
      const r = d.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (inside) {
      e.preventDefault();
      confirm();
    } else cancel();
  };

  const onScroll = () => active && draw();

  view.addEventListener('keydown', onKey, true);
  view.addEventListener('mousemove', onMove, true);
  view.addEventListener('mousedown', onDown, true);
  view.addEventListener('scroll', onScroll, true);

  return {
    setHotkey(s: string) {
      hk = parseHotkey(s);
    },
    setHint(s: string) {
      o.hint = s;
    },
    isActive: () => !!active,
    cancel,
    /** For tests and automation: pick the word at a point as if the hotkey were pressed. */
    pickAt(x: number, y: number) {
      mouse = { x, y };
      startAtPointer();
      return !!active;
    },
    confirm,
    destroy() {
      cancel();
      view.removeEventListener('keydown', onKey, true);
      view.removeEventListener('mousemove', onMove, true);
      view.removeEventListener('mousedown', onDown, true);
      view.removeEventListener('scroll', onScroll, true);
    },
  };
}

export type TermCapture = ReturnType<typeof createTermCapture>;
