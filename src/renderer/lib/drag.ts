import { useCallback, useRef } from 'react';
import type { Rect } from '../../shared/types';

/**
 * Pointer handler for moving or resizing a rect. Calls onClick instead when the
 * pointer barely moved, so a pill can be both dragged and clicked.
 */
export function useDragRect(opts: {
  rect: Rect;
  bounds: () => { w: number; h: number };
  onChange: (r: Rect) => void;
  onEnd?: (r: Rect) => void;
  onClick?: () => void;
  mode?: 'move' | 'resize';
  min?: { w: number; h: number };
  /** Adjusts the rect while dragging (snapping); gets the rect the pointer asks for. */
  snap?: (r: Rect) => Rect;
}) {
  const ref = useRef(opts);
  ref.current = opts;
  return useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a')) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, rect: { ...ref.current.rect } };
    let moved = false;
    let last = start.rect;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      const { w: bw, h: bh } = ref.current.bounds();
      const min = ref.current.min ?? { w: 220, h: 140 };
      if ((ref.current.mode ?? 'move') === 'move') {
        last = {
          ...start.rect,
          x: clamp(start.rect.x + dx, -start.rect.w + 60, bw - 60),
          y: clamp(start.rect.y + dy, 0, bh - 30),
        };
      } else {
        last = {
          ...start.rect,
          w: clamp(start.rect.w + dx, min.w, Math.max(min.w, bw - start.rect.x)),
          h: clamp(start.rect.h + dy, min.h, Math.max(min.h, bh - start.rect.y)),
        };
      }
      if (ref.current.snap) last = ref.current.snap(last);
      ref.current.onChange(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (moved) ref.current.onEnd?.(last);
      else ref.current.onClick?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }, []);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
