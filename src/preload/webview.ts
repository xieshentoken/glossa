// Runs inside web pages shown in the reader (<webview>). Isolated from the
// page's own scripts. Picks terms and reports page text to the host.

import { ipcRenderer, webFrame } from 'electron';
import { matchHotkey, parseHotkey } from '../shared/hotkey';
import { createTermCapture, type TermCapture } from '../shared/term-capture';
import { areaText } from '../shared/area-text';
import { findTerm, flashBoxes, flashRange, pageRegionRect, scrollToBox, scrollToRange, toPageRegion, type Box } from '../shared/term-locate';
import type { TermLocator } from '../shared/types';
import { cleanExtracted } from '../shared/text';
import { attachPinch } from '../shared/pinch';
import { anchorShift, takeAnchor, type ZoomAnchor } from '../shared/zoom-anchor';
import { createTextReporter } from '../shared/text-watch';

let capture: TermCapture | null = null;
let config = { hotkey: 'Alt+Q', hint: '', locateHotkey: 'Alt+L', captureHotkey: 'Alt+A' };

const meta = () => ({
  title: document.title || location.hostname,
  source: location.href,
  lang: document.documentElement.lang || undefined,
});

const mainElement = () => (document.querySelector('article, main, [role="main"]') ?? document.body) as HTMLElement | null;

const reporter = createTextReporter({
  read: () => ({ ...meta(), text: cleanExtracted(mainElement()?.innerText ?? '').slice(0, 600_000) }),
  send: (p) => ipcRenderer.sendToHost('glossa:doc', p),
});

function init() {
  capture?.destroy();
  capture = createTermCapture({
    doc: document,
    hotkey: config.hotkey,
    hint: config.hint,
    docMeta: meta,
    onConfirm: (picked) => ipcRenderer.sendToHost('glossa:pick', picked),
  });
  // Late-loading content and in-page route changes: report again once the page settles.
  new MutationObserver(() => reporter.poke()).observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

ipcRenderer.on('glossa:config', (_e, c: typeof config) => {
  config = c;
  if (capture) {
    capture.setHotkey(c.hotkey);
    capture.setHint(c.hint);
  }
});

ipcRenderer.on('glossa:pickAt', (_e, p: { x: number; y: number }) => {
  if (capture?.pickAt(p.x, p.y)) capture.confirm();
});

// "Show in document" on a card: find the term again, bring it into view, highlight it.
// A captured area is found by where it was (fractions of the page) when it has no text to look for.
ipcRenderer.on('glossa:locate', (_e, p: { id: number; loc: TermLocator; avoid?: Box }) => {
  let ok = false;
  try {
    const range = document.body && p.loc.quote ? findTerm(document.body, p.loc) : null;
    if (range) {
      scrollToRange(range, p.avoid);
      flashRange(range);
      ok = true;
    } else if (p.loc.region && document.body) {
      const box = () => pageRegionRect(document, p.loc.region!);
      scrollToBox(document.body, box, p.avoid);
      flashBoxes(document, () => [box()]);
      ok = true;
    }
  } catch {
    // reported as not found
  }
  ipcRenderer.sendToHost('glossa:located', { id: p.id, ok });
});

// The text of an area the reader dragged over (rectangle in this page's CSS pixels), and where it is.
ipcRenderer.on('glossa:areaText', (_e, p: { id: number; rect: Box }) => {
  try {
    const a = document.body ? areaText(document.body, p.rect) : { text: '', pictures: true };
    ipcRenderer.sendToHost('glossa:areaText', { id: p.id, ...a, region: toPageRegion(document, p.rect) });
  } catch {
    ipcRenderer.sendToHost('glossa:areaText', { id: p.id, text: '', pictures: true });
  }
});

// The pick hotkey pressed while the app had the keyboard, with the mouse over this page.
ipcRenderer.on('glossa:pickHere', () => capture?.trigger());

// Glossa's own hotkeys also work while the page has the keyboard.
window.addEventListener(
  'keydown',
  (e) => {
    const kind = matchHotkey(e, parseHotkey(config.locateHotkey)) ? 'locate' : matchHotkey(e, parseHotkey(config.captureHotkey)) ? 'capture' : null;
    if (!kind) return;
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.sendToHost('glossa:hotkey', kind);
  },
  true,
);

// Whether the mouse is over this page: the app then sends its hotkey here when it has the keyboard.
let pointerInside = false;
window.addEventListener(
  'mousemove',
  () => {
    if (pointerInside) return;
    pointerInside = true;
    ipcRenderer.sendToHost('glossa:pointer', true);
  },
  true,
);
window.addEventListener('mouseout', (e) => {
  // relatedTarget is null when the mouse leaves the page itself.
  if (e.relatedTarget || !pointerInside) return;
  pointerInside = false;
  ipcRenderer.sendToHost('glossa:pointer', false);
});

// Pinch-to-zoom inside the page zooms this reading panel (the host decides the zoom).
let lastPinch: { x: number; y: number; t: number } | null = null;
attachPinch(window, (factor, x, y) => {
  lastPinch = { x, y, t: performance.now() };
  ipcRenderer.sendToHost('glossa:zoom', { factor, x, y });
});

// The panel's zoom, applied here so that the spot under the pinch (or the middle of the page)
// stays where it is. A pinch sends many steps: its first anchor stays until the page has the
// new zoom; then the page (or the scrolling box holding that spot) scrolls it back, and keeps
// it there for a moment while the page finishes its layout, unless the reader scrolls.
/**
 * `dpr`: devicePixelRatio per unit of zoom (the screen's own scale); `since`: the last zoom step;
 * `settled`: when the page showed the new zoom. Checked on a timer: animation frames can pause.
 */
let zooming: { a: ZoomAnchor; from: number; to: number; dpr: number; since: number; settled?: number } | null = null;
const SETTLE_TICK = 16;
/** Zoom steps further apart than this are a new pinch, with its own anchor. */
const NEW_PINCH_MS = 250;
ipcRenderer.on('glossa:zoomTo', (_e, msg: unknown) => {
  const to = Number((msg as { zoom?: unknown } | null)?.zoom);
  if (!Number.isFinite(to) || to <= 0) return;
  const from = webFrame.getZoomFactor();
  if (zooming && performance.now() - zooming.since > NEW_PINCH_MS) zooming = null;
  if (zooming) {
    zooming.to = to;
    zooming.since = performance.now();
    zooming.settled = undefined;
  } else if (Math.abs(from - to) > 1e-3) {
    const p = lastPinch && performance.now() - lastPinch.t < 1000 ? lastPinch : { x: innerWidth / 2, y: innerHeight / 2 };
    const a = document.documentElement && takeAnchor(document.documentElement, p.x, p.y);
    if (a) {
      zooming = { a, from, to, dpr: window.devicePixelRatio / from, since: performance.now() };
      setTimeout(settleZoom, SETTLE_TICK);
    }
  }
  webFrame.setZoomFactor(to);
  ipcRenderer.sendToHost('glossa:zoomed', to);
});
function settleZoom(): void {
  const z = zooming;
  if (!z) return;
  const now = performance.now();
  // Wait until the page is laid out at the new zoom (devicePixelRatio follows it), at most 1.5 s.
  if (Math.abs(window.devicePixelRatio - z.dpr * z.to) > 0.005 && now - z.since < 1500) {
    setTimeout(settleZoom, SETTLE_TICK);
    return;
  }
  z.settled ??= now;
  // The same screen spot is at other CSS pixels now.
  const k = z.from / webFrame.getZoomFactor();
  const shift = anchorShift({ ...z.a, x: z.a.x * k, y: z.a.y * k });
  if (shift && (Math.abs(shift.dx) > 0.5 || Math.abs(shift.dy) > 0.5)) scrollerOf(z.a.el).scrollBy(shift.dx, shift.dy);
  if (shift && now - z.settled < 300) setTimeout(settleZoom, SETTLE_TICK);
  else zooming = null;
}
// The reader scrolling (or clicking, typing) takes over from the zoom's hold.
const stopHolding = (e: Event) => {
  if (!(e instanceof WheelEvent && e.ctrlKey)) zooming = null;
};
for (const type of ['wheel', 'pointerdown', 'keydown', 'touchmove']) window.addEventListener(type, stopHolding, { capture: true, passive: true });

/** The box that scrolls an element: its nearest scrolling ancestor, else the page. */
function scrollerOf(el: Element): Element | Window {
  for (let e = el.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    const st = getComputedStyle(e);
    if (/(auto|scroll|overlay)/.test(st.overflowY + st.overflowX) && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)) return e;
  }
  return window;
}

window.addEventListener('DOMContentLoaded', () => {
  // Two fingers zoom the panel; one finger still scrolls the page.
  document.documentElement.style.touchAction = 'pan-x pan-y';
  init();
  reporter.poke();
});
window.addEventListener('load', () => reporter.poke());
window.addEventListener('popstate', () => reporter.poke());
window.addEventListener('hashchange', () => reporter.poke());
window.addEventListener('pagehide', () => reporter.dispose());
