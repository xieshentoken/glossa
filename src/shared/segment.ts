// Word and sentence spans over plain text, using Intl.Segmenter so CJK text
// (no spaces) is split into words too.

export interface Span {
  start: number;
  end: number;
}

interface Seg {
  start: number;
  end: number;
  wordLike: boolean;
}

const segmenters = new Map<string, Intl.Segmenter>();

function segmenter(lang: string | undefined, granularity: 'word' | 'sentence'): Intl.Segmenter {
  const key = `${lang ?? ''}|${granularity}`;
  let s = segmenters.get(key);
  if (!s) {
    let locale: string | undefined = lang;
    try {
      if (locale) Intl.getCanonicalLocales(locale);
    } catch {
      locale = undefined;
    }
    s = new Intl.Segmenter(locale, { granularity });
    segmenters.set(key, s);
  }
  return s;
}

export function wordSegments(text: string, lang?: string): Seg[] {
  const out: Seg[] = [];
  for (const s of segmenter(lang, 'word').segment(text)) {
    out.push({ start: s.index, end: s.index + s.segment.length, wordLike: !!s.isWordLike });
  }
  return out;
}

/** The word at `offset`, or the nearest word on the same line. */
export function wordAt(text: string, offset: number, lang?: string): Span | null {
  const segs = wordSegments(text, lang).filter((s) => s.wordLike);
  if (!segs.length) return null;
  const hit = segs.find((s) => offset >= s.start && offset < s.end);
  if (hit) return { start: hit.start, end: hit.end };
  let best: Seg | null = null;
  let bestDist = Infinity;
  for (const s of segs) {
    const d = offset < s.start ? s.start - offset : offset - s.end;
    const between = text.slice(Math.min(offset, s.start), Math.max(offset, s.end));
    if (between.includes('\n')) continue;
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best && bestDist <= 3 ? { start: best.start, end: best.end } : null;
}

const MAX_TERM_CHARS = 120;

/** Extend the end of the span by one word (keeping the separator between). */
export function growEnd(text: string, span: Span, lang?: string): Span {
  const next = wordSegments(text, lang).find((s) => s.wordLike && s.start >= span.end);
  if (!next) return span;
  const gap = text.slice(span.end, next.start);
  if (gap.includes('\n\n') || next.end - span.start > MAX_TERM_CHARS) return span;
  return { start: span.start, end: next.end };
}

export function growStart(text: string, span: Span, lang?: string): Span {
  const prev = wordSegments(text, lang).filter((s) => s.wordLike && s.end <= span.start).pop();
  if (!prev) return span;
  const gap = text.slice(prev.end, span.start);
  if (gap.includes('\n\n') || span.end - prev.start > MAX_TERM_CHARS) return span;
  return { start: prev.start, end: span.end };
}

/** Remove the last word; a span never shrinks below one word. */
export function shrinkEnd(text: string, span: Span, lang?: string): Span {
  const inside = wordSegments(text.slice(span.start, span.end), lang).filter((s) => s.wordLike);
  if (inside.length <= 1) return span;
  return { start: span.start, end: span.start + inside[inside.length - 2].end };
}

export function shrinkStart(text: string, span: Span, lang?: string): Span {
  const inside = wordSegments(text.slice(span.start, span.end), lang).filter((s) => s.wordLike);
  if (inside.length <= 1) return span;
  return { start: span.start + inside[1].start, end: span.end };
}

export function sentenceAt(text: string, offset: number, lang?: string): Span {
  for (const s of segmenter(lang, 'sentence').segment(text)) {
    const end = s.index + s.segment.length;
    if (offset >= s.index && offset < end) return { start: s.index, end };
  }
  return { start: 0, end: text.length };
}

/** Text around `span`, cut at word boundaries, at most `radius` chars on each side. */
export function windowAround(text: string, span: Span, radius: number): string {
  let a = Math.max(0, span.start - radius);
  let b = Math.min(text.length, span.end + radius);
  if (a > 0) {
    const sp = text.indexOf(' ', a);
    if (sp !== -1 && sp < span.start) a = sp + 1;
  }
  if (b < text.length) {
    const sp = text.lastIndexOf(' ', b);
    if (sp > span.end) b = sp;
  }
  return (a > 0 ? '… ' : '') + text.slice(a, b) + (b < text.length ? ' …' : '');
}

const ELISION = /^(?:l|d|j|m|n|s|t|c|qu|lorsqu|puisqu|jusqu)['’](?=\p{L})/iu;

/** Strip quotes, brackets and trailing punctuation; drop French elisions (l'énergie → énergie). */
export function cleanTerm(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
  const opened = (t.match(/[(（]/g) ?? []).length - (t.match(/[)）]/g) ?? []).length;
  if (opened > 0 && raw.includes(t + ')')) t += ')';
  t = t.replace(ELISION, '');
  t = t.replace(/['’]s$/u, '');
  return t.trim();
}
