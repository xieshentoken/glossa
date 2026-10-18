// Deterministic offline provider for tests and demos. No network.

import type { Provider, StreamRequest, StreamResult } from './index';

export class FakeProvider implements Provider {
  constructor(private delayMs = Number(process.env.GLOSSA_FAKE_DELAY_MS ?? 15)) {}

  async stream(req: StreamRequest): Promise<StreamResult> {
    const term = /^Term: (.*)$/m.exec(req.user)?.[1] ?? '?';
    const lang = /^Answer language: (.*)$/m.exec(req.user)?.[1] ?? '?';
    const style = /\("([\w-]+)" skill\)/.exec(req.system.map((s) => s.text).join('\n'))?.[1] ?? 'skill';
    const full = `**${term}** — offline sample explanation (${style}, ${lang}, ${req.model}, effort ${req.effort}).`;
    let text = '';
    for (const chunk of full.match(/.{1,12}/gsu) ?? []) {
      if (req.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      await new Promise((r) => setTimeout(r, this.delayMs));
      text += chunk;
      req.onText(chunk);
    }
    return { text, finish: 'complete' };
  }
}
