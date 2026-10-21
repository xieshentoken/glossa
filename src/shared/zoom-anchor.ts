// Keeping what is under the pointer in place while a reading panel zooms.
//
// The anchor is the character under the point (or, off text, the element there),
// remembered by its own box. After the new layout, whatever happened to it (scaled,
// moved by text reflowing in a wider or narrower column, pages rendered again), the
// scroller moves so that the same spot of that box is under the point again. Used in
// the app's readers and inside web pages (webview preload).

export interface ZoomAnchor {
  /** One character at the point, or null when the point is not on a line of text. */
  range: Range | null;
  el: Element;
  /** Where the point is in that box, as fractions of its size (they scale with the zoom). */
  fx: number;
  fy: number;
  /** The point, in viewport coordinates of this document. */
  x: number;
  y: number;
}

export function takeAnchor(root: Element, x: number, y: number): ZoomAnchor | null {
  const doc = root.ownerDocument;
  const el = doc.elementsFromPoint(x, y).find((e) => e !== root && root.contains(e)) ?? root;
  let range: Range | null = null;
  const c = doc.caretRangeFromPoint?.(x, y);
  if (c && c.startContainer.nodeType === Node.TEXT_NODE && root.contains(c.startContainer)) {
    const text = c.startContainer as Text;
    const i = Math.min(c.startOffset, Math.max(0, text.length - 1));
    const r = doc.createRange();
    r.setStart(text, i);
    r.setEnd(text, Math.min(text.length, i + 1));
    const b = r.getBoundingClientRect();
    // Only a character on the pointer's line; elsewhere the caret is merely the nearest text.
    if (b.height > 0 && y >= b.top - 1 && y <= b.bottom + 1) range = r;
  }
  const box = (range ?? el).getBoundingClientRect();
  if (!box.width && !box.height) return null;
  return { range, el, fx: box.width ? (x - box.left) / box.width : 0, fy: box.height ? (y - box.top) / box.height : 0, x, y };
}

/** How far the anchored spot is from the point now: scroll by this to put it back. Undefined once it is gone. */
export function anchorShift(a: ZoomAnchor): { dx: number; dy: number } | undefined {
  if (!(a.range?.startContainer ?? a.el).isConnected) return undefined;
  const b = (a.range ?? a.el).getBoundingClientRect();
  if (!b.width && !b.height) return undefined;
  return { dx: b.left + a.fx * b.width - a.x, dy: b.top + a.fy * b.height - a.y };
}
