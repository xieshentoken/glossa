import type { Effort, ModelInfo, ProviderKind, ProviderPresetId, Settings } from './types';

export interface ConnectionDraft {
  id?: string;
  presetId: ProviderPresetId;
  label: string;
  baseUrl?: string;
  kind?: Exclude<ProviderKind, 'fake'>;
}
export interface ConnectionTest {
  requestId: string;
  draft: ConnectionDraft;
  /** Omitted when editing a connection whose key is already stored. */
  key?: string;
}
export interface ConnectionDiscovery {
  ticket: string;
  models: ModelInfo[];
  source: 'api' | 'documented' | 'manual';
}
export interface ConnectionSave {
  requestId: string;
  ticket: string;
  model: string;
  effort: Effort;
  mode: 'persist' | 'session';
  useFor: 'none' | 'quick' | 'direct' | 'both';
}
export interface ConnectionsApi {
  test(req: ConnectionTest): Promise<ConnectionDiscovery>;
  save(req: ConnectionSave): Promise<Settings>;
  cancel(requestId: string, ticket?: string): Promise<void>;
  remove(id: string): Promise<Settings>;
}
