// Card placement inside the reading area. Pure functions, coordinates relative
// to the area's top-left corner.

import type { Rect } from './types';

export interface Bounds {
  w: number;
  h: number;
}

export const MARGIN = 8;
const CASCADE = 24;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Shrink to the area if needed, then move fully inside it. */
export function fitRect(r: Rect, b: Bounds): Rect {
  const w = Math.max(1, Math.min(r.w, b.w - 2 * MARGIN));
  const h = Math.max(1, Math.min(r.h, b.h - 2 * MARGIN));
  return { w, h, x: clamp(r.x, MARGIN, Math.max(MARGIN, b.w - w - MARGIN)), y: clamp(r.y, MARGIN, Math.max(MARGIN, b.h - h - MARGIN)) };
}

/**
 * Where a new card for a term at `anchor` goes: below the term, or above it when
 * there is no room. A card that would sit on top of another one is stepped
 * down and right so the earlier card stays visible.
 */
export function placeCard(anchor: { x: number; y: number; height: number }, size: Bounds, b: Bounds, existing: Rect[]): Rect {
  const below = anchor.y + anchor.height + MARGIN;
  const y = below + size.h > b.h ? anchor.y - size.h - MARGIN : below;
  let r = fitRect({ x: anchor.x, y, ...size }, b);
  for (let i = 0; i < 12 && existing.some((e) => Math.abs(e.x - r.x) < CASCADE && Math.abs(e.y - r.y) < CASCADE); i++) {
    const next = fitRect({ ...r, x: r.x + CASCADE, y: r.y + CASCADE }, b);
    // Stuck in a corner: start a new column from the top.
    r = next.x === r.x && next.y === r.y ? fitRect({ ...r, x: r.x - CASCADE * 4, y: MARGIN }, b) : next;
  }
  return r;
}

export const SNAP = 12;
export const GAP = 8;

/** Ranges that overlap or come within SNAP of each other. */
const near = (a0: number, a1: number, b0: number, b1: number) => a0 <= b1 + SNAP && b0 <= a1 + SNAP;

function nearest(v: number, candidates: number[]): number {
  let best = v;
  let dist = SNAP + 1;
  for (const c of candidates) {
    const d = Math.abs(c - v);
    if (d <= SNAP && d < dist) {
      best = c;
      dist = d;
    }
  }
  return best;
}

/**
 * Snap a card being moved to the area's edges and to cards next to it, leaving
 * a GAP between cards; once next to another card, matching edges line up.
 * Computed from the pointer's position each time, so dragging further than
 * SNAP releases it.
 */
export function snapMove(r: Rect, others: Rect[], b: Bounds): Rect {
  const xs = [MARGIN, b.w - r.w - MARGIN];
  const ys = [MARGIN, b.h - r.h - MARGIN];
  for (const o of others) {
    const sideBySide = near(r.y, r.y + r.h, o.y, o.y + o.h);
    const stacked = near(r.x, r.x + r.w, o.x, o.x + o.w);
    if (sideBySide) xs.push(o.x + o.w + GAP, o.x - r.w - GAP);
    if (stacked) ys.push(o.y + o.h + GAP, o.y - r.h - GAP);
    if (stacked && Math.min(Math.abs(r.y - (o.y + o.h + GAP)), Math.abs(r.y + r.h + GAP - o.y)) <= SNAP) xs.push(o.x, o.x + o.w - r.w);
    if (sideBySide && Math.min(Math.abs(r.x - (o.x + o.w + GAP)), Math.abs(r.x + r.w + GAP - o.x)) <= SNAP) ys.push(o.y, o.y + o.h - r.h);
  }
  return fitRect({ ...r, x: nearest(r.x, xs), y: nearest(r.y, ys) }, b);
}

/** Snap the right and bottom edges of a card being resized. */
export function snapResize(r: Rect, others: Rect[], b: Bounds, min: Bounds): Rect {
  const rights = [b.w - MARGIN];
  const bottoms = [b.h - MARGIN];
  for (const o of others) {
    const sideBySide = near(r.y, r.y + r.h, o.y, o.y + o.h);
    const stacked = near(r.x, r.x + r.w, o.x, o.x + o.w);
    if (sideBySide && o.x > r.x) rights.push(o.x - GAP);
    if (stacked && o.y > r.y) bottoms.push(o.y - GAP);
    if (stacked) rights.push(o.x + o.w);
    if (sideBySide) bottoms.push(o.y + o.h);
  }
  const w = Math.max(min.w, nearest(r.x + r.w, rights) - r.x);
  const h = Math.max(min.h, nearest(r.y + r.h, bottoms) - r.y);
  return { ...r, w: Math.min(w, Math.max(min.w, b.w - r.x - MARGIN)), h: Math.min(h, Math.max(min.h, b.h - r.y - MARGIN)) };
}

/** The whole reading area. */
export function maximized(b: Bounds): Rect {
  return { x: 0, y: 0, w: b.w, h: b.h };
}
