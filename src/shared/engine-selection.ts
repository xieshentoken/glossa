import type { DirectEngine, Settings } from './types';

export function selectedDirect(settings: Settings, skillName: string, requested?: Partial<DirectEngine>): DirectEngine {
  const clean = (o: Partial<DirectEngine> | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== '')) as Partial<DirectEngine>;
  const base = skillName === settings.quickSkill ? settings.defaults.quick : settings.defaults.direct;
  const override = clean(settings.skillOverrides[skillName]?.direct);
  const req = clean(requested);
  const engine = { ...base, ...override, ...req };
  const provider = settings.providers.find((p) => p.id === engine.providerId);
  if (provider?.selection) {
    engine.model = req.model ?? override.model ?? provider.selection.model;
    engine.effort = req.effort ?? override.effort ?? provider.selection.effort;
  }
  return engine;
}
