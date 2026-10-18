// Turns a request into everything a run needs: skill, engine, scoped context,
// recipient and the cache identity. Rejects requests that cannot run correctly.
//
// Every skill runs with an agent. runner 'direct' means a short answer: the
// built-in Pi agent gets the passage and the skill in one prompt and answers in
// its final message. runner 'agent' means a task in a job folder, run by the
// built-in Pi agent or an external CLI harness.

import { agentRecipient, applyScope, directRecipient, documentAllowed } from '../shared/data-scope';
import { buildAgentTask, languageName } from '../shared/prompts';
import type { AgentEngine, DirectEngine, HarnessConfig, JobRequest, ProviderConfig, Settings, SkillInfo, TermContext } from '../shared/types';
import { cacheKey, sha256 } from './cache';
import { OUTPUT_FILES, unsupportedCombination } from './output-contract';
import { selectedDirect } from '../shared/engine-selection';

export class JobRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobRejected';
  }
}

interface PlanBase {
  skill: SkillInfo;
  skillHash: string;
  explainLang: string;
  /** Context after the data scope was applied: this is what is sent. */
  context: TermContext;
  engineLabel: string;
  recipient: string;
  cacheKey: string;
}

export type JobPlan =
  | (PlanBase & { runner: 'direct'; engine: DirectEngine; provider: ProviderConfig; docText?: string })
  /** `provider` is set for the built-in Pi agent: the model connection it uses. */
  | (PlanBase & { runner: 'agent'; engine: AgentEngine; harness: HarnessConfig; provider?: ProviderConfig; task: string });

export function resolveExplainLang(settings: Settings, requested: string): string {
  const code = !requested || requested === 'ui' ? settings.uiLang : requested;
  return languageName(code);
}

function stripEmpty<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

export function resolveDirect(settings: Settings, skill: SkillInfo, req?: Partial<DirectEngine>): DirectEngine {
  return selectedDirect(settings, skill.name, req);
}

export function resolveAgent(settings: Settings, skill: SkillInfo, req?: Partial<AgentEngine>): AgentEngine {
  const e = { ...settings.defaults.agent, ...stripEmpty(settings.skillOverrides[skill.name]?.agent), ...stripEmpty(req) };
  if (skill.timeoutMinutes && !settings.skillOverrides[skill.name]?.agent?.timeoutMinutes && !req?.timeoutMinutes) {
    e.timeoutMinutes = Math.max(e.timeoutMinutes, skill.timeoutMinutes);
  }
  return e;
}

export function planJob(opts: {
  req: JobRequest;
  settings: Settings;
  skills: SkillInfo[];
  skillHash: (s: SkillInfo) => string;
  docText: (docId: string) => string | undefined;
}): JobPlan {
  const { req, settings } = opts;
  const skill = opts.skills.find((s) => s.name === req.skill);
  if (!skill) throw new JobRejected(`Unknown skill: ${req.skill}`);
  if (!skill.enabled) throw new JobRejected(`The skill "${skill.name}" is turned off.`);
  const combo = unsupportedCombination(skill.runner, skill.output);
  if (combo) throw new JobRejected(combo);

  const explainLang = resolveExplainLang(settings, req.explainLang);
  const skillHash = opts.skillHash(skill);
  const identityBase = {
    docId: req.docId,
    skill: { name: skill.name, contentHash: skillHash, runner: skill.runner, output: skill.output, task: skill.task ?? '' },
    explainLang,
    profile: settings.profile.trim(),
    theme: settings.theme,
  };
  const ctxId = (c: TermContext) => ({ term: c.term, sentence: c.sentence, paragraph: c.paragraph, heading: c.heading ?? '' });

  if (skill.runner === 'direct') {
    const engine = resolveDirect(settings, skill, req.direct);
    const provider = settings.providers.find((p) => p.id === engine.providerId);
    if (!provider) throw new JobRejected(`Provider "${engine.providerId}" is not configured`);
    const scope = settings.dataScope;
    const context = applyScope(req.context, scope);
    const docText = documentAllowed(scope) ? opts.docText(req.docId) : undefined;
    return {
      runner: 'direct',
      skill,
      skillHash,
      explainLang,
      context,
      engine,
      provider,
      docText,
      engineLabel: `Pi · ${provider.label} · ${engine.model} · ${engine.effort}`,
      recipient: directRecipient(provider, engine.model, docText ? 'document' : scope === 'document' ? 'paragraph' : scope),
      cacheKey: cacheKey({
        ...identityBase,
        docTextHash: docText ? sha256(docText) : null,
        context: ctxId(context),
        scope,
        engine: {
          via: 'pi',
          provider: provider.id,
          kind: provider.kind,
          presetId: provider.presetId ?? '',
          baseUrl: provider.baseUrl ?? '',
          maxTokensField: provider.maxTokensField ?? '',
          reasoning: !!provider.sendReasoningEffort,
          fallback: provider.serverFallback !== false,
          model: engine.model,
          effort: engine.effort,
          maxTokens: engine.maxTokens,
        },
      }),
    };
  }

  const engine = resolveAgent(settings, skill, req.agent);
  const harness = settings.harnesses.find((h) => h.id === engine.harnessId);
  if (!harness) throw new JobRejected(`Harness "${engine.harnessId}" is not configured`);
  // Agents never receive the whole document, whatever the scope.
  const scope = settings.dataScope === 'document' ? 'paragraph' : settings.dataScope;
  const context = applyScope(req.context, scope);
  const task = buildAgentTask({ skill, ctx: context, explainLang, theme: settings.theme, outputFile: OUTPUT_FILES[skill.output] });
  if (harness.kind === 'pi') {
    const provider = settings.providers.find((p) => p.id === (engine.providerId || settings.defaults.direct.providerId));
    if (!provider) throw new JobRejected(`Provider "${engine.providerId || settings.defaults.direct.providerId}" is not configured`);
    const model = engine.model || provider.selection?.model || settings.defaults.direct.model;
    return {
      runner: 'agent',
      skill,
      skillHash,
      explainLang,
      context,
      engine: { ...engine, providerId: provider.id, model },
      harness,
      provider,
      task,
      engineLabel: `Pi · ${provider.label} · ${model} · ${engine.effort}`,
      recipient: directRecipient(provider, model, scope),
      cacheKey: cacheKey({
        ...identityBase,
        docTextHash: null,
        context: ctxId(context),
        scope,
        engine: {
          harness: harness.id,
          via: 'pi',
          provider: provider.id,
          kind: provider.kind,
          baseUrl: provider.baseUrl ?? '',
          model,
          effort: engine.effort,
          budgetUsd: engine.budgetUsd,
          task: sha256(task),
        },
      }),
    };
  }
  return {
    runner: 'agent',
    skill,
    skillHash,
    explainLang,
    context,
    engine,
    harness,
    task,
    engineLabel: `${harness.label} · ${engine.model || 'default model'} · ${engine.effort}`,
    recipient: agentRecipient(harness, engine.model, scope),
    cacheKey: cacheKey({
      ...identityBase,
      docTextHash: null,
      context: ctxId(context),
      scope,
      engine: {
        harness: harness.id,
        command: sha256(harness.command),
        model: engine.model,
        effort: engine.effort,
        budgetUsd: engine.budgetUsd,
        task: sha256(task),
      },
    }),
  };
}
