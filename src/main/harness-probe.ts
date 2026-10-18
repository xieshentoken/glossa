// Checks an agent harness without running a model: is the CLI installed, which
// version, and does its --help list every flag the command template uses.

import { spawn } from 'node:child_process';
import { buildCommand } from '../shared/template';
import type { HarnessConfig } from '../shared/types';
import { buildAgentEnv } from './agent-env';

export interface HarnessProbe {
  status: 'missing' | 'ok' | 'flags-missing' | 'error';
  binary: string;
  version?: string;
  missingFlags: string[];
  detail?: string;
}

function capture(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string; error?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(t);
      resolve({ code: null, out, error });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

export async function probeHarness(h: HarnessConfig, tmpDir: string, timeoutMs = 15_000): Promise<HarnessProbe> {
  let argv: string[];
  try {
    argv = buildCommand(h.command, { model: 'm', effort: 'low', budget: '1', workspace: tmpDir, skillDir: tmpDir, prompt: 'p' });
  } catch (err) {
    return { status: 'error', binary: '', missingFlags: [], detail: (err as Error).message };
  }
  const bin = argv[0];
  const env = buildAgentEnv({ extraAllow: h.envAllow, tmpDir });
  const v = await capture(bin, ['--version'], env, timeoutMs);
  if (v.error?.code === 'ENOENT') return { status: 'missing', binary: bin, missingFlags: [], detail: `${bin} is not installed or not on PATH.` };
  const version = v.out.trim().split('\n')[0]?.slice(0, 120) || undefined;
  // Flags are checked against the top-level help and, for "<cli> <subcommand>", that subcommand's help.
  const sub = argv[1] && !argv[1].startsWith('-') ? [argv[1]] : [];
  const help = (await capture(bin, ['--help'], env, timeoutMs)).out + (sub.length ? (await capture(bin, [...sub, '--help'], env, timeoutMs)).out : '');
  const flags = [...new Set(argv.filter((a) => /^--[a-z][\w-]*$/.test(a)))];
  const missingFlags = flags.filter((f) => !new RegExp(`(^|[\\s,])${f}(?![\\w-])`, 'm').test(help));
  return { status: missingFlags.length ? 'flags-missing' : 'ok', binary: bin, version, missingFlags };
}
