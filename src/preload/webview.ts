// Runs inside web pages shown in the reader (<webview>). Isolated from the
// page's own scripts. Picks terms and reports page text to the host.

import { ipcRenderer } from 'electron';
import { createTermCapture, type TermCapture } from '../shared/term-capture';
import { cleanExtracted } from '../shared/text';
import { createTextReporter } from '../shared/text-watch';

let capture: TermCapture | null = null;
let config = { hotkey: 'Alt+Q', hint: '' };

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

ipcRenderer.on('glossa:config', (_e, c: { hotkey: string; hint: string }) => {
  config = c;
  if (capture) {
    capture.setHotkey(c.hotkey);
    capture.setHint(c.hint);
  }
});

ipcRenderer.on('glossa:pickAt', (_e, p: { x: number; y: number }) => {
  if (capture?.pickAt(p.x, p.y)) capture.confirm();
});

window.addEventListener('DOMContentLoaded', () => {
  init();
  reporter.poke();
});
window.addEventListener('load', () => reporter.poke());
window.addEventListener('popstate', () => reporter.poke());
window.addEventListener('hashchange', () => reporter.poke());
window.addEventListener('pagehide', () => reporter.dispose());
