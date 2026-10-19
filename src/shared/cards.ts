// Term cards: one card per picked term, holding every skill run started from it.
// Documents saved before cards held several runs stored one card per run
// (LegacyCard); they are converted when read and written back in the new form
// on the next save.

import type { DocRecord, JobRequest, LegacyCard, TermCard } from './types';

/**
 * Every new card's size, whatever skill runs in it: switching between skills never resizes a
 * card. Only the reader changes it (resize handle, maximize / restore).
 */
export const CARD_SIZE = { w: 480, h: 460 };
export const MIN_CARD = { w: 220, h: 140 };

export function fromLegacy(c: LegacyCard): TermCard {
  const usable = c.rect.w >= MIN_CARD.w && c.rect.h >= MIN_CARD.h;
  return {
    id: c.id,
    term: c.term,
    context: c.request.context,
    explainLang: c.request.explainLang,
    rect: usable ? c.rect : { ...c.rect, ...CARD_SIZE },
    // A collapsed result pill stays out of the way.
    window: c.expanded ? 'normal' : 'minimized',
    tasks: [{ id: c.id, jobId: c.jobId, skill: c.skill, createdAt: c.createdAt, request: c.request }],
    activeTask: c.id,
    createdAt: c.createdAt,
  };
}

export function docCards(rec: Pick<DocRecord, 'cards' | 'termCards'> | undefined): TermCard[] {
  if (!rec) return [];
  return rec.termCards ?? (rec.cards ?? []).map(fromLegacy);
}

/** Every job a document's cards still show, in either format. */
export function cardJobIds(rec: Pick<DocRecord, 'cards' | 'termCards'> | undefined): string[] {
  if (!rec) return [];
  return [...(rec.termCards ?? []).flatMap((c) => c.tasks.map((t) => t.jobId)), ...(rec.cards ?? []).map((c) => c.jobId)];
}

/** Pictures of captured areas a document's cards still use. */
export function cardPictureIds(rec: Pick<DocRecord, 'termCards'> | undefined): string[] {
  return (rec?.termCards ?? []).flatMap((c) => [c.capture?.id, ...c.tasks.map((t) => t.request.image)]).filter((x): x is string => !!x);
}

/** Runs with the same key show the same answer: clicking again goes to the existing task. */
export function runKey(req: JobRequest): string {
  const engine = req.agent ?? req.direct;
  return JSON.stringify([req.skill, req.context.term, req.explainLang, engine?.model ?? '', engine?.effort ?? '', ...(req.image ? [req.image] : [])]);
}
