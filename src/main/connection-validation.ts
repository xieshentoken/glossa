import type { ConnectionSave, ConnectionTest } from '../shared/connections';
import { EFFORTS, type Effort, type ProviderPresetId } from '../shared/types';
import { presetFor } from '../shared/provider-presets';
import { str, vModel, vProviderId } from './validate';

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connection request.');
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some((k) => !allowed.includes(k))) throw new Error('Unexpected connection request field.');
  return o;
}
export const connectionRequestId = (v: unknown) => str(v, 'connection request ID', 64, /^[a-zA-Z0-9-]{8,64}$/);
export function connectionTest(v: unknown): ConnectionTest {
  const o = fields(v, ['requestId', 'draft', 'key']);
  const d = fields(o.draft, ['id', 'presetId', 'label', 'baseUrl', 'kind']);
  const presetId = str(d.presetId, 'provider preset', 30) as ProviderPresetId;
  presetFor(presetId);
  const kind = d.kind;
  if (kind !== undefined && !['openai', 'responses', 'anthropic', 'gemini'].includes(String(kind))) throw new Error('Invalid custom protocol.');
  return {
    requestId: connectionRequestId(o.requestId), key: o.key === undefined ? undefined : str(o.key, 'API key', 4096),
    draft: { id: d.id === undefined ? undefined : vProviderId(d.id), presetId, label: str(d.label, 'connection name', 80),
      baseUrl: d.baseUrl === undefined ? undefined : str(d.baseUrl, 'API base URL', 2000), kind: kind as ConnectionTest['draft']['kind'] },
  };
}
export function connectionSave(v: unknown): ConnectionSave {
  const o = fields(v, ['requestId', 'ticket', 'model', 'effort', 'mode', 'useFor']);
  const effort = str(o.effort, 'effort', 20) as Effort;
  if (!EFFORTS.includes(effort)) throw new Error('Invalid effort.');
  if (o.mode !== 'persist' && o.mode !== 'session') throw new Error('Invalid key storage mode.');
  if (!['none', 'quick', 'direct', 'both'].includes(String(o.useFor))) throw new Error('Invalid default assignment.');
  return { requestId: connectionRequestId(o.requestId), ticket: connectionRequestId(o.ticket), model: vModel(o.model), effort, mode: o.mode, useFor: o.useFor as ConnectionSave['useFor'] };
}
