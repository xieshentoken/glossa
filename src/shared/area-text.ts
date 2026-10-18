// The text inside a rectangle the reader dragged over ("capture an area"), in
// any DOM document: the app's readers (PDF text layer, converted documents,
// code) and web pages (via the webview preload). Whatever is drawn rather than
// written (scans, figures, video) is only in the picture taken of the area.

import { eachText, textIndex, type Box } from './term-locate';
import type { TermLocator } from './types';

const MAX_TEXT = 4000;
const PICTURES = 'img, canvas, video, svg, picture, iframe, object, embed';
const CONTAINERS = '.pdf-page, .code-block, p, li, tr, pre, blockquote, h1, h2, h3, h4, h5, h6';

export interface AreaText {
  text: string;
  /** Where the area's first text is, to find it again. */
  locator?: Omit<TermLocator, 'region' | 'page'>;
  /** Images, canvases or video show inside the area: its text alone may not be all of it. */
  pictures: boolean;
}

const meets = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const inside = (r: DOMRect, b: Box) => {
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
};

export function areaText(root: Element, area: Box): AreaText {
  const doc = root.ownerDocument;
  let text = '';
  let last: DOMRect | null = null;
  let first: { node: Text; start: number; end: number } | null = null;
  const range = doc.createRange();
  const add = (node: Text, start: number, end: number, box: DOMRect) => {
    if (last) {
      // A new line, or a gap on the same line, becomes white space.
      if (box.top >= last.bottom - Math.min(box.height, last.height) / 2) text = `${text.replace(/\s+$/, '')}\n`;
      else if (box.left - last.right > Math.min(box.height, last.height) * 0.2 && !/\s$/.test(text)) text += ' ';
    }
    text += node.data.slice(start, end);
    last = box;
    if (!first) first = { node, start, end };
    else if (first.node === node) first.end = end;
  };
  eachText(
    root,
    (node) => {
      if (text.length > MAX_TEXT) return false;
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      if (!rects.some((r) => meets(r, area))) return;
      // One line wholly inside: all of it.
      const [only] = rects;
      if (rects.length === 1 && only.left >= area.left && only.right <= area.right && only.top >= area.top && only.bottom <= area.bottom) {
        add(node, 0, node.data.length, only);
        return;
      }
      // Characters whose middle is inside the area, in runs; a run ends where the text wraps.
      let run: { start: number; end: number; box: DOMRect } | null = null;
      const flush = () => {
        if (run) add(node, run.start, run.end, run.box);
        run = null;
      };
      for (let i = 0; i < node.data.length; ) {
        const ch = String.fromCodePoint(node.data.codePointAt(i)!);
        range.setStart(node, i);
        range.setEnd(node, i + ch.length);
        const r = range.getBoundingClientRect();
        if (/\s/.test(ch) || r.width === 0) {
          if (run) run.end = i + ch.length;
        } else if (inside(r, area)) {
          const cur = run as { start: number; end: number; box: DOMRect } | null;
          if (cur && r.top >= cur.box.bottom - r.height / 2) flush();
          if (!run) run = { start: i, end: i + ch.length, box: r };
          else {
            const u = run.box;
            run.end = i + ch.length;
            run.box = new DOMRect(u.left, Math.min(u.top, r.top), r.right - u.left, Math.max(u.bottom, r.bottom) - Math.min(u.top, r.top));
          }
        } else flush();
        i += ch.length;
      }
      flush();
    },
    // Whole parts of the page outside the area are skipped (not elements without a box of their own).
    // Only boxes that hold their text (absolutely placed text may sit outside a parent's box).
    (el) => {
      if (!el.matches(CONTAINERS)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !meets(r, area);
    },
  );
  const pictures = Array.from(root.querySelectorAll(PICTURES)).some((el) => meets(el.getBoundingClientRect(), area));
  const clean = text.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
  const f = first as { node: Text; start: number; end: number } | null;
  const locator = f
    ? {
        quote: f.node.data.slice(f.start, Math.min(f.end, f.start + 120)),
        prefix: f.node.data.slice(Math.max(0, f.start - 48), f.start),
        suffix: f.node.data.slice(Math.min(f.end, f.start + 120), Math.min(f.end, f.start + 120) + 48),
        index: textIndex(root, f.node, f.start),
      }
    : undefined;
  return { text: clean, locator: locator && locator.quote.trim() ? locator : undefined, pictures };
}
