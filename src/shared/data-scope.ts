// What leaves the computer with a lookup, and where it goes. The main process
// applies these rules to every request; the UI uses the same functions to show them.

import type { DataScope, HarnessConfig, ProviderConfig, TermContext } from './types';

export const SCOPE_LIMITS = { term: 200, sentence: 1200, paragraph: 2400, heading: 200, title: 300 };

const cut = (s: string | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Context trimmed to the scope. 'sentence' drops the paragraph and heading. */
export function applyScope(ctx: TermContext, scope: DataScope): TermContext {
  const base: TermContext = {
    term: cut(ctx.term, SCOPE_LIMITS.term),
    sentence: cut(ctx.sentence, SCOPE_LIMITS.sentence),
    paragraph: '',
    docTitle: cut(ctx.docTitle, SCOPE_LIMITS.title),
    docSource: ctx.docSource,
    docLang: ctx.docLang,
    termLang: ctx.termLang,
  };
  if (scope === 'sentence') return base;
  return { ...base, paragraph: cut(ctx.paragraph, SCOPE_LIMITS.paragraph), heading: ctx.heading ? cut(ctx.heading, SCOPE_LIMITS.heading) : undefined };
}

/** The full text may only accompany a request with the 'document' scope. */
export function documentAllowed(scope: DataScope): boolean {
  return scope === 'document';
}

/** Host that receives direct requests. Local endpoints are named, not promised to stay on this machine. */
export function providerEndpoint(p: ProviderConfig): string {
  if (p.kind === 'fake') return 'offline demo (nothing is sent)';
  const fallback = p.kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
  try {
    return new URL(p.baseUrl || fallback).host;
  } catch {
    return p.baseUrl || fallback;
  }
}

export function directRecipient(p: ProviderConfig, model: string, scope: DataScope): string {
  return `${providerEndpoint(p)} · ${model} · ${scope}`;
}

export function agentRecipient(h: HarnessConfig, model: string, scope: DataScope): string {
  // The agent sends whatever it reads in its workspace to its own model provider.
  return `${h.label} (its configured provider) · ${model || 'default model'} · ${scope === 'document' ? 'paragraph' : scope}`;
}
