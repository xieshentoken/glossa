// Reports a page's text to the host when it changes (late-loading content,
// single-page-app routes), debounced and rate-limited, and only when the text
// actually differs from the last report. Reporting is local (to the main
// process); whether anything is sent to a provider is decided there.

export interface PageText {
  source: string;
  title: string;
  text: string;
  lang?: string;
}

export interface TextReporterOptions {
  read: () => PageText;
  send: (p: PageText) => void;
  debounceMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** FNV-1a over the string; enough to tell "same text" from "changed". */
export function textFingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length}:${(h >>> 0).toString(16)}`;
}

export function createTextReporter(o: TextReporterOptions) {
  const debounce = o.debounceMs ?? 1200;
  const minInterval = o.minIntervalMs ?? 3000;
  const now = o.now ?? (() => Date.now());
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let last: string | undefined;
  let lastSent = -Infinity;
  let timer: unknown;
  let disposed = false;

  const flush = () => {
    timer = undefined;
    if (disposed) return;
    const p = o.read();
    const fp = textFingerprint(`${p.source}\n${p.title}\n${p.text}`);
    if (fp === last) return;
    last = fp;
    lastSent = now();
    o.send(p);
  };

  return {
    /** Something may have changed; report after things settle. */
    poke() {
      if (disposed) return;
      if (timer !== undefined) clearTimer(timer);
      const wait = Math.max(debounce, minInterval - (now() - lastSent));
      timer = setTimer(flush, wait);
    },
    flush,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
    },
  };
}
