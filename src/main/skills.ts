// Skill registry: built-in skills shipped with the app plus user skills
// (created in the app, imported from a folder, or installed from git).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_SKILLS, parseSkillMd, serializeSkillMd, skillFromParsed, SKILL_NAME_RE, type ParsedSkill } from '../shared/skills';
import type { Settings, SkillInfo } from '../shared/types';
import { sha256 } from './cache';
import { copyTreeSafe, hashTree, resolveInside, UnsafePathError, writeFileAtomic } from './fs-safe';

function readSkillDir(dir: string, source: SkillInfo['source'], order: number): SkillInfo | undefined {
  const file = path.join(dir, 'SKILL.md');
  try {
    if (fs.lstatSync(dir).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) return undefined;
    return skillFromParsed(parseSkillMd(fs.readFileSync(file, 'utf8')), dir, source, order);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Skipping skill in ${dir}: ${(err as Error).message}`);
    return undefined;
  }
}

export function assertSkillName(name: unknown, what = 'skill name'): string {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) throw new UnsafePathError(`Invalid ${what}`);
  return name;
}

/** Built-in skills appear as buttons in this order (the user can reorder them). */
const BUILTIN_ORDER = ['quick-gloss', 'eli5', 'anatomy'];
const builtinRank = (n: string) => (BUILTIN_ORDER.includes(n) ? BUILTIN_ORDER.indexOf(n) : BUILTIN_ORDER.length);

export class SkillRegistry {
  constructor(
    private builtinDir: string,
    private userDir: string,
  ) {}

  list(settings: Settings): SkillInfo[] {
    const byName = new Map<string, SkillInfo>();
    const scan = (root: string, source: SkillInfo['source']) => {
      if (!fs.existsSync(root)) return;
      const names = fs.readdirSync(root).sort();
      if (source === 'builtin') names.sort((a, b) => builtinRank(a) - builtinRank(b));
      for (const name of names) {
        if (!SKILL_NAME_RE.test(name)) continue; // staging folders and stray files
        const s = readSkillDir(path.join(root, name), source, byName.size);
        if (s && s.name === name) byName.set(s.name, s);
      }
    };
    scan(this.builtinDir, 'builtin');
    scan(this.userDir, 'user');
    const out = [...byName.values()].map((s) => {
      const o = settings.skillOverrides[s.name] ?? {};
      return {
        ...s,
        enabled: o.enabled ?? true,
        order: o.order ?? s.order,
        runner: o.runner ?? s.runner,
        output: o.output ?? s.output,
      };
    });
    return out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  /** Content identity: SKILL.md for direct skills (only it reaches the model); the whole folder for agent skills. */
  contentHash(s: SkillInfo): string {
    return s.runner === 'direct' ? sha256(fs.readFileSync(path.join(s.dir, 'SKILL.md'))) : hashTree(s.dir);
  }

  /** A user skill folder by validated name; refuses links. */
  private userSkillDir(name: string, mustExist: boolean): string {
    const dir = resolveInside(this.userDir, assertSkillName(name));
    if (mustExist) {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new UnsafePathError(`"${name}" is not a skill folder`);
    }
    return dir;
  }

  /** Create or update a user skill written in the app. */
  save(p: ParsedSkill, previousName?: string): void {
    assertSkillName(p.name);
    const dir = this.userSkillDir(p.name, false);
    if (previousName !== undefined && previousName !== p.name) {
      const old = this.userSkillDir(previousName, true);
      if (fs.existsSync(dir)) throw new Error(`A skill named "${p.name}" already exists`);
      fs.renameSync(old, dir);
    }
    fs.mkdirSync(dir, { recursive: true });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new UnsafePathError('Skill folder is a link');
    writeFileAtomic(path.join(dir, 'SKILL.md'), serializeSkillMd(p));
  }

  /** Raw SKILL.md of any skill, for the editor. */
  read(name: string, settings: Settings): { parsed: ParsedSkill; source: SkillInfo['source'] } {
    assertSkillName(name);
    const s = this.list(settings).find((x) => x.name === name);
    if (!s) throw new Error(`Unknown skill: ${name}`);
    return { parsed: parseSkillMd(fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8')), source: s.source };
  }

  remove(name: string): void {
    let dir: string;
    try {
      dir = this.userSkillDir(name, true);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Only user skills can be deleted');
      throw err;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Copy a skill folder into the user skills folder. The source is checked as a
   * whole first: links, hard links and special files make the import fail.
   */
  importFolder(src: string, overwrite = false): string {
    const file = path.join(src, 'SKILL.md');
    if (!fs.existsSync(file)) throw new Error('The folder has no SKILL.md');
    const parsed = parseSkillMd(fs.readFileSync(file, 'utf8'));
    const dest = this.userSkillDir(parsed.name, false);
    const staging = resolveInside(this.userDir, `.import-${parsed.name}-${Date.now()}`);
    try {
      copyTreeSafe(src, staging);
      if (fs.existsSync(dest)) {
        if (!overwrite) throw new Error(`A skill named "${parsed.name}" is already installed`);
        this.userSkillDir(parsed.name, true);
        fs.rmSync(dest, { recursive: true, force: true });
      }
      fs.renameSync(staging, dest);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return parsed.name;
  }

  /** Clone a known skill (e.g. Anatomy) from git into the user skills folder. */
  async installKnown(name: string, gitBin = 'git'): Promise<string> {
    const known = KNOWN_SKILLS.find((k) => k.name === name);
    if (!known) throw new Error(`Unknown preset: ${name}`);
    const staging = resolveInside(this.userDir, `.staging-${name}-${Date.now()}`);
    try {
      // core.symlinks=false: links in the repository arrive as plain files, never as links.
      await run(gitBin, ['-c', 'core.symlinks=false', 'clone', '--depth', '1', '--quiet', known.gitUrl, staging]);
      return this.importFolder(staging, true);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === 'ENOENT' ? `${cmd} is not installed. Download the skill as a folder and use "Import folder" instead.` : e.message)),
    );
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} exited with ${code}`))));
  });
}
