// Settings changes that widen what leaves the computer or what may run need a
// confirmation shown by the main process. Narrowing never does.

import type { Settings } from '../shared/types';

export type Grant = 'document' | 'agents';

/** Asks the user (native dialog in the app; a stub in tests). */
export type GrantConfirm = (grant: Grant, s: Settings) => Promise<boolean>;

export class GrantDeclined extends Error {
  constructor(grant: Grant) {
    super(`Not changed: ${grant === 'document' ? 'sending whole documents' : 'skills run by an agent'} was not confirmed.`);
    this.name = 'GrantDeclined';
  }
}

export function grantsNeeded(cur: Settings, patch: Partial<Settings>): Grant[] {
  const out: Grant[] = [];
  if (patch.dataScope === 'document' && cur.dataScope !== 'document') out.push('document');
  if (patch.agentsEnabled === true && !cur.agentsEnabled) out.push('agents');
  return out;
}

/**
 * Results are written to folders the user picked in a main-process dialog. The
 * renderer may clear a folder or send back one already stored, never a new path.
 */
export function assertOutputDirs(cur: Settings, patch: Partial<Settings>): void {
  const known = (dir: string | undefined, stored: string | undefined) => dir === undefined || dir === '' || dir === stored;
  if (!known(patch.outputDir, cur.outputDir)) throw new Error('Choose the output folder with the Choose… button.');
  for (const [name, o] of Object.entries(patch.skillOverrides ?? {})) {
    if (!known(o.outputDir, cur.skillOverrides[name]?.outputDir)) throw new Error('Choose the output folder with the Choose… button.');
  }
}

/** Returns the patch to store; throws GrantDeclined when the user said no. */
export async function authorizeSettingsPatch(cur: Settings, patch: Partial<Settings>, confirm: GrantConfirm): Promise<Partial<Settings>> {
  assertOutputDirs(cur, patch);
  // Picking a term would take the key first; the others would never fire.
  const norm = (h: string) => h.toLowerCase().split('+').map((x) => x.trim()).sort().join('+');
  const keys = [patch.hotkey ?? cur.hotkey, patch.locateHotkey ?? cur.locateHotkey, patch.captureHotkey ?? cur.captureHotkey].map(norm);
  if (new Set(keys).size < keys.length) throw new Error('The hotkeys for picking a term, showing it in the document and capturing an area must all differ.');
  const next = { ...patch };
  for (const g of grantsNeeded(cur, patch)) if (!(await confirm(g, { ...cur, ...patch }))) throw new GrantDeclined(g);
  // Turning agents off also forgets remembered approvals.
  if (patch.agentsEnabled === false) next.agentTrust = {};
  return next;
}
