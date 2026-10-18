// Server-sent events from a fetch body: events end at a blank line, multi-line
// data is joined with "\n", comments (":") are skipped, UTF-8 split across
// chunks is decoded correctly.

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let data: string[] = [];
  let event: string | undefined;
  const take = function* (final: boolean): Generator<SseEvent> {
    for (;;) {
      const m = /\r\n|\r|\n/.exec(buf);
      if (!m) break;
      // A CR at the end of a chunk may be the first half of CRLF.
      if (!final && m[0] === '\r' && m.index === buf.length - 1) break;
      const line = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      if (line === '') {
        if (data.length) yield { event, data: data.join('\n') };
        data = [];
        event = undefined;
      } else if (line.startsWith(':')) {
        continue;
      } else {
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'data') data.push(value);
        else if (field === 'event') event = value;
      }
    }
    if (final) {
      if (buf) {
        // A last line without newline still counts as data.
        if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''));
        buf = '';
      }
      if (data.length) yield { event, data: data.join('\n') };
      data = [];
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      yield* take(false);
    }
    buf += decoder.decode();
    yield* take(true);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
