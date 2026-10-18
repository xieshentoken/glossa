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
import type { OutputKind, Settings } from '../shared/types';
import { copyTreeSafe, hashTree, readFileSafe, writeFileAtomic } from './fs-safe';
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
