// glossa-out://<jobId>/<path> — serves finished results to the sandboxed viewer.

import type { Settings, Theme, ViewTheme } from '../shared/types';
import { readFileSafe } from './fs-safe';
import type { JobManager } from './jobs';
import { HTML_OUTPUT_CSP, KATEX_PATH, MARKDOWN_OUTPUT_CSP, markdownPage, mimeFor } from './output';
import { OUTPUT_SPECS } from './output-contract';

const ASSET_MAX = 25 * 1024 * 1024;

function notFound(msg: string): Response {
  return new Response(msg, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** `theme` is the one shown when the viewer does not ask for one. */
export async function serveOutput(url: string, jobs: JobManager, settings: Settings, shown: Theme, katexDir?: string): Promise<Response> {
  let theme: ViewTheme = shown;
  const u = new URL(url);
  // KaTeX's stylesheet and fonts for formulas in Markdown results; read-only files of the app.
  if (katexDir && u.pathname.startsWith(`/${KATEX_PATH}`)) {
    const rel = u.pathname.slice(KATEX_PATH.length + 1);
    if (!/^(katex\.min\.css|fonts\/[\w-]+\.(woff2|woff|ttf))$/.test(rel)) return notFound('Not found');
    try {
      return new Response(new Uint8Array(readFileSafe(katexDir, rel, { maxBytes: 2 * 1024 * 1024 })), {
        headers: { 'content-type': mimeFor(rel), 'content-security-policy': MARKDOWN_OUTPUT_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'max-age=86400' },
      });
    } catch {
      return notFound('Not found');
    }
  }
  let root: string | undefined;
  try {
    root = jobs.outputDir(u.host);
  } catch {
    return notFound('Not found');
  }
  const job = root ? jobs.get(u.host) : undefined;
  if (!root || !job) return notFound('This result is missing. Close the card and run it again.');
  const q = u.searchParams.get('theme');
  if (q === 'light' || q === 'dark' || q === 'paper') theme = q;
  const csp = job.output === 'markdown' ? MARKDOWN_OUTPUT_CSP : HTML_OUTPUT_CSP;
  const headers = (type: string) => ({ 'content-type': type, 'content-security-policy': csp, 'x-content-type-options': 'nosniff' });
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const spec = OUTPUT_SPECS[job.output];
      const body = readFileSafe(root, spec.file, { maxBytes: spec.maxBytes });
      if (job.output === 'markdown') {
        const html = await markdownPage(body.toString('utf8'), { theme, lang: settings.uiLang, title: job.term });
        return new Response(html, { headers: headers('text/html; charset=utf-8') });
      }
      return new Response(new Uint8Array(body), { headers: headers('text/html; charset=utf-8') });
    }
    // Assets next to an HTML result (images, scripts the page references), inside output/ only.
    if (job.output !== 'html') return notFound('Not found');
    const body = readFileSafe(root, `output/${u.pathname}`, { maxBytes: ASSET_MAX });
    return new Response(new Uint8Array(body), { headers: headers(mimeFor(u.pathname)) });
  } catch {
    return notFound('Not found');
  }
}
