// Pinch-to-zoom for reading panels: two fingers on a touchscreen (pointer
// events), a trackpad pinch (Chromium reports it as wheel events with Ctrl),
// and Ctrl+wheel with a mouse. Used in the app and inside web pages (webview preload).

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 1000) / 1000));

/** Zoom factor of one Ctrl+wheel event. Mouse notches are capped so one notch is a modest step. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-25, Math.min(25, px)) / 100);
}

type Point = { x: number; y: number };
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Factor between two finger spreads (fingers apart → > 1). */
export function spreadFactor(before: [Point, Point], after: [Point, Point]): number {
  const d0 = dist(before[0], before[1]);
  return d0 > 0 ? dist(after[0], after[1]) / d0 : 1;
}

export interface PinchTarget {
  addEventListener: HTMLElement['addEventListener'];
  removeEventListener: HTMLElement['removeEventListener'];
}

/** Calls zoomBy(factor, x, y) for each step of a pinch; x, y is the pinch centre in client coordinates. */
export function attachPinch(target: PinchTarget, zoomBy: (factor: number, x: number, y: number) => void): () => void {
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomBy(wheelZoomFactor(e.deltaY, e.deltaMode), e.clientX, e.clientY);
  };
  const touches = new Map<number, Point>();
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    if (touches.size !== 2) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      return;
    }
    const [a, b] = [...touches.values()] as [Point, Point];
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a2, b2] = [...touches.values()] as [Point, Point];
    const f = spreadFactor([a, b], [a2, b2]);
    if (f !== 1) {
      e.preventDefault();
      zoomBy(f, (a2.x + b2.x) / 2, (a2.y + b2.y) / 2);
    }
  };
  const onUp = (e: PointerEvent) => {
    touches.delete(e.pointerId);
  };
  target.addEventListener('wheel', onWheel as EventListener, { passive: false });
  target.addEventListener('pointerdown', onDown as EventListener);
  target.addEventListener('pointermove', onMove as EventListener, { passive: false });
  target.addEventListener('pointerup', onUp as EventListener);
  target.addEventListener('pointercancel', onUp as EventListener);
  return () => {
    target.removeEventListener('wheel', onWheel as EventListener);
    target.removeEventListener('pointerdown', onDown as EventListener);
    target.removeEventListener('pointermove', onMove as EventListener);
    target.removeEventListener('pointerup', onUp as EventListener);
    target.removeEventListener('pointercancel', onUp as EventListener);
  };
}
