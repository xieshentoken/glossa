// Clean-up for text extracted from PDFs and web pages, and a script-based language guess.

const LIGATURES: Record<string, string> = {
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st',
};

export function cleanExtracted(text: string): string {
  return text
    .replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c] ?? c)
    .replace(/\u00AD/g, '')
    .replace(/(\p{L})[-\u2010]\n\s*(\p{Ll})/gu, '$1$2')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'with', 'for', 'are'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'mit', 'den', 'ein', 'eine', 'zu', 'von'],
  fr: ['le', 'la', 'les', 'et', 'des', 'est', 'une', 'pour', 'dans', 'que', 'du', 'pas'],
  es: ['el', 'los', 'las', 'y', 'es', 'una', 'para', 'con', 'que', 'por', 'del'],
};

/** Best-effort language code from the text alone. */
export function guessLang(text: string): string | undefined {
  const sample = text.slice(0, 4000);
  const count = (re: RegExp) => (sample.match(re) ?? []).length;
  const kana = count(/[\u3040-\u30FF]/g);
  const han = count(/\p{Script=Han}/gu);
  const hangul = count(/\p{Script=Hangul}/gu);
  const cyr = count(/\p{Script=Cyrillic}/gu);
  const arab = count(/\p{Script=Arabic}/gu);
  const latin = count(/\p{Script=Latin}/gu);
  const max = Math.max(kana + han, hangul, cyr, arab, latin);
  if (max === 0) return undefined;
  if (max === kana + han) return kana > han / 10 ? 'ja' : 'zh';
  if (max === hangul) return 'ko';
  if (max === cyr) return 'ru';
  if (max === arab) return 'ar';
  const words = sample.toLowerCase().match(/\p{L}+/gu) ?? [];
  let best: string | undefined;
  let bestScore = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const score = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return best ?? 'en';
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
