// P1-1: capability probing without model calls.
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeHarness } from '../src/main/harness-probe';
import type { HarnessConfig } from '../src/shared/types';
import { FIXTURES } from './helpers';

const h = (command: string): HarnessConfig => ({ id: 'x', label: 'x', command, parser: 'plain', skillDirs: [] });
const fake = `node ${JSON.stringify(path.join(FIXTURES, 'fake-cli.mjs'))}`;

describe('probeHarness (stand-in CLI)', () => {
  it('reports a missing binary', async () => {
    expect(await probeHarness(h('definitely-not-a-cli-xyz --model {model}'), os.tmpdir())).toMatchObject({ status: 'missing' });
  });
  it('reports flags the CLI does not list', async () => {
    // The flags are checked against the CLI's own help (`node fake-cli.mjs --help`).
    const r = await probeHarness(h(`${fake} --model {model} --effort {effort} --made-up-flag`), os.tmpdir());
    expect(r.status).toBe('flags-missing');
    expect(r.missingFlags).toContain('--made-up-flag');
  });
});
