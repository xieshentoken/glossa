// Answers that are HTML rather than Markdown (some models write an ELI5 as a
// small HTML page, often inside an ```html fence). They are shown rendered, in
// the same script-free viewer as Markdown answers.

const FENCE = /^```(?:html?|xhtml)?\s*\n([\s\S]*?)\n```\s*$/i;
const LOOKS_HTML = /^\s*(<!doctype html|<html[\s>]|<(?:body|div|section|article|main|header|p|h[1-6]|ul|ol|table|figure|style|svg|details)\b)/i;

/** The HTML of an answer that is HTML, or null for ordinary Markdown. */
export function htmlAnswer(text: string): string | null {
  const t = text.trim();
  const inner = FENCE.exec(t)?.[1] ?? t;
  if (!LOOKS_HTML.test(inner) || !/<\/[a-z][\w-]*>/i.test(inner)) return null;
  return inner;
}

/** Body and inline styles of an HTML answer, without scripts (the viewer would block them anyway). */
export function htmlAnswerParts(html: string): { styles: string; body: string } {
  const clean = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  const styles = [...clean.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]).join('\n');
  const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(clean)?.[1] ?? clean.replace(/<style\b[\s\S]*?<\/style\s*>/gi, '').replace(/<\/?(?:!doctype|html|head|meta|title)\b[^>]*>/gi, '');
  return { styles, body: body.trim() };
}
