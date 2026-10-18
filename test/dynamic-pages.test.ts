// P1-4: dynamic pages report changes debounced, and only real changes.
import { describe, expect, it } from 'vitest';
import { createTextReporter, textFingerprint, type PageText } from '../src/shared/text-watch';

function fakeClock() {
  let t = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      t += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > t) break;
        timers.shift();
        due.fn();
      }
    },
  };
}

describe('text reporter', () => {
  const page = (text: string, source = 'https://x/a'): PageText => ({ source, title: 'T', text });

  it('debounces bursts of mutations into one report', () => {
    const c = fakeClock();
    let current = page('loading');
    const sent: PageText[] = [];
    const r = createTextReporter({ read: () => current, send: (p) => sent.push(p), debounceMs: 1000, minIntervalMs: 0, ...c });
    r.poke();
    c.advance(1000);
    expect(sent.map((s) => s.text)).toEqual(['loading']);
    for (let i = 0; i < 50; i++) {
      current = page(`article body ${i}`);
      r.poke();
      c.advance(100);
    }
    expect(sent).toHaveLength(1);
    c.advance(1000);
    expect(sent.map((s) => s.text)).toEqual(['loading', 'article body 49']);
  });

  it('does not report unchanged text again, but does report a route change', () => {
    const c = fakeClock();
    let current = page('same');
    const sent: PageText[] = [];
    const r = createTextReporter({ read: () => current, send: (p) => sent.push(p), debounceMs: 10, minIntervalMs: 0, ...c });
    r.poke();
    c.advance(10);
    r.poke();
    c.advance(10);
    expect(sent).toHaveLength(1);
    current = page('same', 'https://x/b');
    r.poke();
    c.advance(10);
    expect(sent.map((s) => s.source)).toEqual(['https://x/a', 'https://x/b']);
  });

  it('rate-limits steady changes and stops after dispose', () => {
    const c = fakeClock();
    let n = 0;
    const sent: PageText[] = [];
    const r = createTextReporter({ read: () => page(`tick ${n++}`), send: (p) => sent.push(p), debounceMs: 100, minIntervalMs: 3000, ...c });
    for (let i = 0; i < 60; i++) {
      r.poke();
      c.advance(200);
    }
    // 12 s of constant changes → at most one report per 3 s.
    expect(sent.length).toBeLessThanOrEqual(5);
    r.dispose();
    r.poke();
    c.advance(10_000);
    const count = sent.length;
    c.advance(10_000);
    expect(sent.length).toBe(count);
  });

  it('fingerprints differ for different text', () => {
    expect(textFingerprint('a')).not.toBe(textFingerprint('b'));
    expect(textFingerprint('abc')).toBe(textFingerprint('abc'));
  });
});
