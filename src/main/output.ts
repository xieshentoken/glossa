// Serving job outputs to the sandboxed viewer iframe.

import path from 'node:path';
import { marked } from 'marked';
import { escapeHtml } from './documents';
import { htmlAnswer, htmlAnswerParts } from '../shared/html-answer';

/** Scripts allowed (inline only) for HTML skills; no network of any kind. */
export const HTML_OUTPUT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; " +
  "img-src data: blob: glossa-out:; font-src data:; media-src data: blob:; worker-src blob:; " +
  "connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** Markdown results: no scripts at all. */
export const MARKDOWN_OUTPUT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif";

export async function markdownPage(md: string, opts: { theme: 'dark' | 'light'; lang: string; title: string }): Promise<string> {
  // An answer written as HTML is shown rendered (its own styles kept, scripts dropped; the CSP allows none).
  const html = htmlAnswer(md);
  const parts = html ? htmlAnswerParts(html) : null;
  const body = parts ? parts.body : await marked.parse(md);
  const dark = opts.theme === 'dark';
  return `<!doctype html>
<html lang="${escapeHtml(opts.lang)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${MARKDOWN_OUTPUT_CSP}">
<title>${escapeHtml(opts.title)}</title>
<style>
:root { color-scheme: ${opts.theme}; }
/* Colours match the card surface and text tokens in styles.css, so the answer sits in the card without a seam. */
body { margin: 0; padding: 6px 16px 20px; font: 14.5px/1.65 ${FONT_STACK};
  background: ${dark ? '#1c1e23' : '#ffffff'}; color: ${dark ? '#e8e9ec' : '#1c1d21'}; }
h1,h2,h3 { line-height: 1.3; margin: 1em 0 .4em; font-weight: 650 } h1 { font-size: 1.25em } h2 { font-size: 1.12em } h3 { font-size: 1.02em }
p { margin: .55em 0 } ul,ol { padding-inline-start: 1.4em } li { margin: .2em 0 }
strong { font-weight: 650 }
code { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: .92em;
  background: ${dark ? '#24272d' : '#eef0f3'}; padding: .1em .35em; border-radius: 4px }
pre code { display: block; padding: .7em .9em; overflow-x: auto; border-radius: 8px }
blockquote { margin: .7em 0; padding-inline-start: .9em; border-inline-start: 3px solid ${dark ? '#3f444e' : '#c9cdd4'}; color: ${dark ? '#a0a6b0' : '#5c616b'} }
a { color: ${dark ? '#8ab4ff' : '#0b57d0'} }
table { border-collapse: collapse } td,th { border: 1px solid ${dark ? '#2b2f37' : '#e2e4e9'}; padding: .3em .6em }
::selection { background: rgba(245, 180, 0, ${dark ? '.16' : '.18'}) }
${parts?.styles.replace(/<\/style/gi, '') ?? ''}
</style></head><body>${body}</body></html>`;
}

export function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.json': 'application/json',
      '.md': 'text/plain; charset=utf-8',
    } as Record<string, string>
  )[ext] ?? 'application/octet-stream';
}
