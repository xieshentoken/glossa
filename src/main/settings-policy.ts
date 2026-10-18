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

/** Returns the patch to store; throws GrantDeclined when the user said no. */
export async function authorizeSettingsPatch(cur: Settings, patch: Partial<Settings>, confirm: GrantConfirm): Promise<Partial<Settings>> {
  const next = { ...patch };
  for (const g of grantsNeeded(cur, patch)) if (!(await confirm(g, { ...cur, ...patch }))) throw new GrantDeclined(g);
  // Turning agents off also forgets remembered approvals.
  if (patch.agentsEnabled === false) next.agentTrust = {};
  return next;
}
