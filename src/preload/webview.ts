// Runs inside web pages shown in the reader (<webview>). Isolated from the
// page's own scripts. Picks terms and reports page text to the host.

import { ipcRenderer } from 'electron';
import { matchHotkey, parseHotkey } from '../shared/hotkey';
import { createTermCapture, type TermCapture } from '../shared/term-capture';
import { areaText } from '../shared/area-text';
import { findTerm, flashBoxes, flashRange, pageRegionRect, scrollToBox, scrollToRange, toPageRegion, type Box } from '../shared/term-locate';
import type { TermLocator } from '../shared/types';
import { cleanExtracted } from '../shared/text';
import { attachPinch } from '../shared/pinch';
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

// Pinch-to-zoom inside the page zooms this reading panel (the host applies it).
attachPinch(window, (factor, x, y) => ipcRenderer.sendToHost('glossa:zoom', { factor, x, y }));

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
