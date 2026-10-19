// Copies of finished results in a folder the user chose (Settings → General,
// or per skill). The app keeps its own copy in the job folder either way.
//
//   <folder>/<document title>/<term> - <skill>.md      Markdown result
//   <folder>/<document title>/<term> - <skill>.html    HTML result, a single file
//   <folder>/<document title>/<term> - <skill>/        HTML result with its files
//
// A copy with the same content is not written twice; a different result for the
// same term and skill gets " (2)", " (3)" … instead of replacing the earlier one.

import fs from 'node:fs';
import path from 'node:path';
import { hasMath } from '../shared/math';
import type { OutputKind, Settings, ViewTheme } from '../shared/types';
import { copyTreeSafe, hashTree, readFileSafe, tryReadFileSafe, writeFileAtomic } from './fs-safe';
import { markdownPage } from './output';
import { OUTPUT_SPECS } from './output-contract';

/** The folder a skill's results go to; '' = not saved. */
export function outputDirFor(settings: Pick<Settings, 'outputDir' | 'skillOverrides'>, skill: string): string {
  const own = settings.skillOverrides[skill]?.outputDir;
  return own === undefined ? settings.outputDir : own;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A file name that is valid on every system. */
export function safeName(s: string, max = 80): string {
  let n = s
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (n.length > max) n = n.slice(0, max).trim();
  if (!n) n = 'untitled';
  return RESERVED.test(n) ? `_${n}` : n;
}

export function exportResult(o: { dir: string; outputRoot: string; output: OutputKind; docTitle: string; term: string; skill: string }): string {
  if (!path.isAbsolute(o.dir)) throw new Error('The output folder is not an absolute path.');
  const spec = OUTPUT_SPECS[o.output];
  const resultDir = path.join(o.outputRoot, path.dirname(spec.file));
  const main = readFileSafe(o.outputRoot, spec.file, { maxBytes: spec.maxBytes });
  // An HTML result with pictures or scripts next to it is copied as a folder.
  const single = o.output === 'markdown' || fs.readdirSync(resultDir).every((f) => f === path.basename(spec.file));
  const ext = o.output === 'markdown' ? '.md' : '.html';
  const docDir = path.join(o.dir, safeName(o.docTitle));
  fs.mkdirSync(docDir, { recursive: true });
  const base = `${safeName(o.term, 60)} - ${safeName(o.skill, 40)}`;
  const tree = single ? '' : hashTree(resultDir);
  for (let i = 1; i <= 100; i++) {
    const target = path.join(docDir, i === 1 ? base : `${base} (${i})`) + (single ? ext : '');
    if (!fs.existsSync(target)) {
      if (single) writeFileAtomic(target, main);
      else copyTreeSafe(resultDir, target);
      return target;
    }
    const st = fs.lstatSync(target);
    if (single ? st.isFile() && fs.readFileSync(target).equals(main) : st.isDirectory() && hashTree(target) === tree) return target;
  }
  throw new Error('Too many copies of this result in the output folder.');
}

/** KaTeX's stylesheet with its fonts inlined, so an exported page shows formulas anywhere. */
export function inlineKatexCss(katexDir: string): string {
  const css = readFileSafe(katexDir, 'katex.min.css', { maxBytes: 2 * 1024 * 1024 }).toString('utf8');
  return css.replace(/url\(fonts\/([\w-]+)\.woff2\) format\("woff2"\)(?:,url\(fonts\/[\w-]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\))*/g, (all, name: string) => {
    const font = tryReadFileSafe(katexDir, `fonts/${name}.woff2`, { maxBytes: 2 * 1024 * 1024 });
    return font ? `url(data:font/woff2;base64,${font.toString('base64')}) format("woff2")` : all;
  });
}

/**
 * A result saved as a web page at a path the user chose (Export on the card).
 * Markdown results become the page shown on the card, standalone; an HTML result
 * is copied as it is, as a folder when it has files next to it. Returns the page written.
 */
export async function exportHtml(o: { outputRoot: string; output: OutputKind; target: string; theme: ViewTheme; lang: string; title: string; katexDir: string }): Promise<string> {
  if (!path.isAbsolute(o.target)) throw new Error('The export path is not an absolute path.');
  const target = /\.html?$/i.test(o.target) ? o.target : `${o.target}.html`;
  const spec = OUTPUT_SPECS[o.output];
  const main = readFileSafe(o.outputRoot, spec.file, { maxBytes: spec.maxBytes });
  if (o.output === 'markdown') {
    const md = main.toString('utf8');
    const page = await markdownPage(md, { theme: o.theme, lang: o.lang, title: o.title, standalone: true, katexCss: hasMath(md) ? inlineKatexCss(o.katexDir) : undefined });
    writeFileAtomic(target, page);
    return target;
  }
  const resultDir = path.join(o.outputRoot, path.dirname(spec.file));
  if (fs.readdirSync(resultDir).every((f) => f === path.basename(spec.file))) {
    writeFileAtomic(target, main);
    return target;
  }
  // Its pictures and scripts are found next to it: the whole folder, named like the chosen file.
  const base = target.replace(/\.html?$/i, '');
  for (let i = 1; i <= 100; i++) {
    const dir = i === 1 ? base : `${base} (${i})`;
    if (fs.existsSync(dir)) continue;
    copyTreeSafe(resultDir, dir);
    return path.join(dir, path.basename(spec.file));
  }
  throw new Error('Too many folders with this name.');
}
