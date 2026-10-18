// The single gate every run passes, whatever started it (a card's skill button,
// re-run, a direct IPC call). Every skill runs with an agent. Three different things:
//   - agentsEnabled: the user accepted the notice that skills run with an agent
//     (asked once, on the first run, by a dialog of the main process);
//   - approval: built-in skills on the built-in Pi agent need none; other skills
//     are approved in a main-process dialog the renderer cannot answer, once per
//     skill version on Pi, per run or remembered on an external CLI;
//   - isolation: what the OS actually enforces (currently nothing, see isolation.ts).

import type { HarnessConfig, Settings, SkillInfo } from '../shared/types';
import { sha256 } from './cache';
import type { IsolationStatus } from './isolation';
import { JobRejected } from './job-plan';

export interface AgentApprovalRequest {
  skill: string;
  skillSource: SkillInfo['source'];
  skillHash: string;
  harness: string;
  /** Command line with secrets redacted. */
  command: string;
  model: string;
  workspace: string;
  recipient: string;
  isolation: IsolationStatus;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Skip the dialog for this exact skill version from now on. */
  remember: boolean;
}

export type AgentApprover = (r: AgentApprovalRequest) => Promise<ApprovalDecision>;

/** Tools the built-in Pi agent gets: all of them, unrestricted (as decided for Glossa). Keep in step with pi-worker.mts. */
export const PI_TOOLS = ['read', 'write', 'edit', 'bash', 'ls', 'grep', 'find'];

/** Default: nobody is there to approve, so nothing runs. */
export const denyAll: AgentApprover = async () => ({ approved: false, remember: false });

/** Flags that turn off the harness's own permission checks or sandbox. */
export const DANGEROUS_FLAGS = [
  /--dangerously-skip-permissions\b/,
  /--allow-dangerously-skip-permissions\b/,
  /--permission-mode[= ]+bypassPermissions\b/,
  /\bbypassPermissions\b/,
  /--dangerously-bypass-approvals-and-sandbox\b/,
  /--yolo\b/,
  /sandbox_mode\s*=\s*"?danger-full-access/,
  /--sandbox[= ]+danger-full-access\b/,
];

export function dangerousFlag(h: HarnessConfig): string | undefined {
  return DANGEROUS_FLAGS.find((re) => re.test(h.command))?.source;
}

/** What "remember" approves: this skill content run through this exact harness command. */
export function trustToken(skillHash: string, h: HarnessConfig): string {
  return sha256(`${skillHash}\n${h.id}\n${h.command}\n${(h.envAllow ?? []).join(',')}`);
}

export async function authorizeAgentRun(o: {
  origin: 'user' | 'auto';
  settings: Settings;
  skill: SkillInfo;
  skillHash: string;
  harness: HarnessConfig;
  request: Omit<AgentApprovalRequest, 'isolation' | 'skill' | 'skillSource' | 'skillHash' | 'harness'>;
  isolation: IsolationStatus;
  approve: AgentApprover;
  /** Shows the one-time notice; true when the user turned agents on. */
  enableAgents?: () => Promise<boolean>;
  remember: (skill: string, token: string) => void;
}): Promise<void> {
  if (o.origin !== 'user') throw new JobRejected('Agent skills only start from an explicit click, never automatically.');
  if (!o.settings.agentsEnabled && !(await o.enableAgents?.())) {
    throw new JobRejected('Skills run with an agent, and agents are turned off. Turn them on in Settings → Agent harnesses after reading the notice.');
  }
  const pi = o.harness.kind === 'pi';
  const bad = pi ? undefined : dangerousFlag(o.harness);
  if (bad) throw new JobRejected(`The harness command disables the agent's own safety checks (${bad}). Remove that flag.`);
  if (o.settings.requireIsolation && !o.isolation.isolated) {
    throw new JobRejected('Agent runs require OS isolation (Settings), and none is available on this computer.');
  }
  if (pi && o.skill.source === 'builtin') return;
  const token = trustToken(o.skillHash, o.harness);
  if (o.settings.agentTrust[o.skill.name] === token) return;
  const d = await o.approve({
    ...o.request,
    skill: o.skill.name,
    skillSource: o.skill.source,
    skillHash: o.skillHash,
    harness: o.harness.label,
    isolation: o.isolation,
  });
  if (!d.approved) throw new JobRejected('The agent run was not approved.');
  // On the built-in agent an approval covers this skill version.
  if (d.remember || pi) o.remember(o.skill.name, token);
}
