// Serving job outputs to the sandboxed viewer iframe.

import path from 'node:path';
import { marked } from 'marked';
import { escapeHtml } from './documents';
import { htmlAnswer, htmlAnswerParts } from '../shared/html-answer';
import { hasMath, protectMath } from '../shared/math';
import type { ViewTheme } from '../shared/types';

/** Scripts allowed (inline only) for HTML skills; no network of any kind. */
export const HTML_OUTPUT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; " +
  "img-src data: blob: glossa-out:; font-src data:; media-src data: blob:; worker-src blob:; " +
  "connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** Markdown results: no scripts at all. Formulas use KaTeX's stylesheet and fonts, served by the app (glossa-out://…/_katex/). */
export const MARKDOWN_OUTPUT_CSP =
  "default-src 'none'; style-src 'unsafe-inline' glossa-out:; img-src data:; font-src data: glossa-out:; form-action 'none'; base-uri 'none'";

/** Where a result page finds KaTeX's stylesheet (next to the page, see output-protocol.ts). */
export const KATEX_PATH = '_katex/';

const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif";

/** The result page's colours, the same tokens as the card around it in styles.css, so there is no seam. */
const PAGE_THEMES = {
  light: { bg: '#ffffff', fg: '#1c1d21', code: '#eef0f3', rule: '#c9cdd4', muted: '#5c616b', link: '#0b57d0', line: '#e2e4e9', sel: 'rgba(245, 180, 0, .18)' },
  dark: { bg: '#1c1e23', fg: '#e8e9ec', code: '#24272d', rule: '#3f444e', muted: '#a0a6b0', link: '#8ab4ff', line: '#2b2f37', sel: 'rgba(245, 180, 0, .16)' },
  paper: { bg: '#fbf8f1', fg: '#2b251d', code: '#f0e9db', rule: '#c9bba1', muted: '#6f6556', link: '#2c4a78', line: '#e0d6c3', sel: 'rgba(168, 116, 42, .16)' },
};

const SERIF =
  "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', 'Source Serif 4', 'Noto Serif', Georgia, 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Source Han Serif SC', serif";
/** The paper card's faint grain (an inline SVG; the page loads nothing else). */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .36 0 0 0 0 .27 0 0 0 0 .14 0 0 0 .055 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

export async function markdownPage(md: string, opts: { theme: ViewTheme; lang: string; title: string }): Promise<string> {
  // An answer written as HTML is shown rendered (its own styles kept, scripts dropped; the CSP allows none).
  const html = htmlAnswer(md);
  const parts = html ? htmlAnswerParts(html) : null;
  // Formulas are rendered first (KaTeX, static HTML) and put back after Markdown, which would mangle them.
  const math = parts ? null : protectMath(md);
  const body = parts ? parts.body : math!.restore(await marked.parse(math!.md));
  const katexCss = !parts && hasMath(md) ? `<link rel="stylesheet" href="${KATEX_PATH}katex.min.css">` : '';
  const c = PAGE_THEMES[opts.theme];
  const paper = opts.theme === 'paper';
  return `<!doctype html>
<html lang="${escapeHtml(opts.lang)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${MARKDOWN_OUTPUT_CSP}">
<title>${escapeHtml(opts.title)}</title>
${katexCss}<style>
:root { color-scheme: ${opts.theme === 'dark' ? 'dark' : 'light'}; }
body { margin: 0; padding: 6px 16px 20px; font: 14.5px/1.65 ${FONT_STACK}; background: ${c.bg}; color: ${c.fg}; }
${paper ? `body { font: 15.5px/1.72 ${SERIF}; background-image: ${GRAIN}; font-feature-settings: 'kern', 'liga', 'onum'; }
h1,h2,h3 { font-weight: 600; letter-spacing: .005em } strong { font-weight: 650 }
hr { border: 0; border-top: 1px solid ${c.line}; margin: 1.1em 0 }` : ''}
h1,h2,h3 { line-height: 1.3; margin: 1em 0 .4em; font-weight: 650 } h1 { font-size: 1.25em } h2 { font-size: 1.12em } h3 { font-size: 1.02em }
p { margin: .55em 0 } ul,ol { padding-inline-start: 1.4em } li { margin: .2em 0 }
strong { font-weight: 650 }
code { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: .92em; background: ${c.code}; padding: .1em .35em; border-radius: 4px }
pre code { display: block; padding: .7em .9em; overflow-x: auto; border-radius: 8px }
blockquote { margin: .7em 0; padding-inline-start: .9em; border-inline-start: 3px solid ${c.rule}; color: ${c.muted} }
a { color: ${c.link} }
table { border-collapse: collapse } td,th { border: 1px solid ${c.line}; padding: .3em .6em }
.katex { font-size: 1.08em } .katex-display { margin: .8em 0; overflow-x: auto; overflow-y: hidden; padding: .1em 0 }
::selection { background: ${c.sel} }
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
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
      '.ttf': 'font/ttf',
    } as Record<string, string>
  )[ext] ?? 'application/octet-stream';
}
