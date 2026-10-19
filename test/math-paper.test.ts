// LaTeX formulas in answers, and the paper theme of result pages.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markdownPage, MARKDOWN_OUTPUT_CSP } from '../src/main/output';
import { serveOutput } from '../src/main/output-protocol';
import { vSettingsPatch } from '../src/main/validate';
import { hasMath, protectMath, renderMath, splitMath } from '../src/shared/math';
import { BASE_INSTRUCTIONS } from '../src/shared/prompts';
import { ROOT, req, settle, setup, tmpDir } from './helpers';

let dir: string;
beforeEach(() => (dir = tmpDir()));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('finding formulas', () => {
  it('reads the usual delimiters', () => {
    expect(splitMath('Energy $E = mc^2$ and $$\\int_0^1 x\\,dx$$ or \\(a\\) and \\[b\\].')).toEqual([
      { text: 'Energy ' },
      { tex: 'E = mc^2', display: false },
      { text: ' and ' },
      { tex: '\\int_0^1 x\\,dx', display: true },
      { text: ' or ' },
      { tex: 'a', display: false },
      { text: ' and ' },
      { tex: 'b', display: true },
      { text: '.' },
    ]);
  });

  it('leaves prices, escaped dollars and code alone', () => {
    expect(hasMath('It costs $5 and $10 today.')).toBe(false);
    expect(hasMath('Between $ 3 $ spaces.')).toBe(false);
    expect(hasMath('Escaped \\$x\\$ dollars.')).toBe(false);
    expect(hasMath('Shell: `echo $HOME$` here.')).toBe(false);
    expect(hasMath('```\nlet a = $b$;\n```\nafter')).toBe(false);
    expect(hasMath('A $x$ in text')).toBe(true);
  });

  it('renders static HTML; a broken formula shows its source; nothing can run or load', () => {
    expect(renderMath('\\frac{a}{b}', false)).toContain('class="katex"');
    expect(renderMath('\\frac{a}{b}', true)).toContain('katex-display');
    expect(renderMath('\\frac{a', false)).toMatch(/katex-error|\\frac\{a/);
    const evil = renderMath('\\href{javascript:alert(1)}{x}\\url{https://e.example}', false);
    // No link is made (trust: false); the source appears only as escaped text for screen readers.
    expect(evil).not.toMatch(/<a\b|href=/);
    expect(evil).not.toMatch(/="javascript:/);
    expect(renderMath('<img src=x onerror=alert(1)>', false)).not.toContain('<img');
  });

  it('formulas survive Markdown; a formula alone is a block', async () => {
    const { md, restore } = protectMath('Ratio *Re* is $\\frac{\\rho v L}{\\mu}$.\n\n$$a^2+b^2=c^2$$\n\nEnd.');
    expect(md).not.toContain('\\frac');
    const { marked } = await import('marked');
    const html = restore(await marked.parse(md));
    expect(html).toMatch(/<em>Re<\/em> is <span class="katex">/);
    expect(html).toMatch(/<span class="katex-display">/);
    expect(html).not.toMatch(/<p><span class="katex-display">/);
    expect(html).not.toContain('GLOSSAMATH');
  });

  it('models are asked to write formulas in LaTeX', () => {
    expect(BASE_INSTRUCTIONS).toMatch(/formulas in LaTeX: \$…\$ inline, \$\$…\$\$/);
  });
});

describe('result pages', () => {
  it('link KaTeX only when there are formulas; the policy still allows no scripts or network', async () => {
    const page = await markdownPage('The **Reynolds number** $Re = \\frac{\\rho v L}{\\mu}$.', { theme: 'light', lang: 'en', title: 'Re' });
    expect(page).toContain('<link rel="stylesheet" href="_katex/katex.min.css">');
    expect(page).toContain('class="katex"');
    expect(await markdownPage('No formulas.', { theme: 'light', lang: 'en', title: 't' })).not.toContain('katex.min.css');
    expect(MARKDOWN_OUTPUT_CSP).toMatch(/default-src 'none'/);
    expect(MARKDOWN_OUTPUT_CSP).not.toMatch(/script-src|connect-src (?!'none')/);
  });

  it('serve KaTeX files from the app, and nothing else under that path', async () => {
    const h = setup(dir);
    const j = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    const katexDir = path.join(ROOT, 'node_modules', 'katex', 'dist');
    const s = h.store.getSettings();
    const css = await serveOutput(`glossa-out://${j.id}/_katex/katex.min.css`, h.jobs, s, 'light', katexDir);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toMatch(/text\/css/);
    const font = fs.readdirSync(path.join(katexDir, 'fonts')).find((f) => f.endsWith('.woff2'))!;
    expect((await serveOutput(`glossa-out://${j.id}/_katex/fonts/${font}`, h.jobs, s, 'light', katexDir)).headers.get('content-type')).toBe('font/woff2');
    for (const bad of ['_katex/katex.js', '_katex/../package.json', '_katex/%2e%2e/package.json', '_katex/fonts/x.svg']) {
      expect((await serveOutput(`glossa-out://${j.id}/${bad}`, h.jobs, s, 'light', katexDir)).status).toBe(404);
    }
  });

  it('take the paper look when the card asks for it', async () => {
    const page = await markdownPage('**Paper**', { theme: 'paper', lang: 'en', title: 't' });
    expect(page).toContain('background: #fbf8f1');
    expect(page).toMatch(/font: 15\.5px\/1\.72 'Iowan Old Style'/);
    expect(page).toContain('feTurbulence');
    expect(await markdownPage('**Light**', { theme: 'light', lang: 'en', title: 't' })).not.toContain('feTurbulence');
    const h = setup(dir);
    const j = await settle(h.jobs, (await h.jobs.start(req('eli5'))).id);
    expect(await (await serveOutput(`glossa-out://${j.id}/?theme=paper`, h.jobs, h.store.getSettings(), 'light')).text()).toContain('#fbf8f1');
  });

  it('paper is a theme choice', () => {
    expect(vSettingsPatch({ theme: 'paper' }).theme).toBe('paper');
    expect(() => vSettingsPatch({ theme: 'sepia' })).toThrow(/theme/);
  });
});
