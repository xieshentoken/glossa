// Term cards per document: creation, skill runs, persistence. Cards of every
// open document stay in memory; only the active document's cards are shown.

import { useCallback, useRef, useState } from 'react';
import { fitRect, placeCard, type Bounds } from '../../shared/card-geometry';
import { CARD_SIZE, docCards, RESULT_SIZE, runKey, sizeForResult } from '../../shared/cards';
import type { CardTask, Effort, JobRequest, JobState, PickedTerm, SkillInfo, TermCard } from '../../shared/types';
import { api } from '../api';
import { uid } from './uid';

export interface RunOptions {
  model?: string;
  effort?: Effort;
}

export function useTermCards(opts: {
  start: (req: JobRequest) => Promise<JobState | null>;
  bounds: () => Bounds;
  /** Runs fn and shows its error, if any. */
  guard: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [byDoc, setByDoc] = useState<Record<string, TermCard[]>>({});
  const [focused, setFocused] = useState<string | null>(null);
  const ref = useRef({ byDoc, opts });
  ref.current = { byDoc, opts };
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Runs being started (approval dialogs can take a while); a second click waits for the first.
  const starting = useRef(new Set<string>());

  const persist = (docId: string, list: TermCard[]) => {
    clearTimeout(saveTimers.current[docId]);
    saveTimers.current[docId] = setTimeout(() => void api.docs.saveCards(docId, list), 300);
  };

  const setDoc = useCallback((docId: string, fn: (list: TermCard[]) => TermCard[], save = true) => {
    setByDoc((m) => {
      const next = fn(m[docId] ?? []);
      if (save) persist(docId, next);
      return { ...m, [docId]: next };
    });
  }, []);

  const update = useCallback(
    (docId: string, id: string, fn: (c: TermCard) => TermCard, save = true) => setDoc(docId, (l) => l.map((c) => (c.id === id ? fn(c) : c)), save),
    [setDoc],
  );

  /** Reads the saved cards of a document (converting older ones) and returns them. */
  const load = useCallback(async (docId: string) => {
    const list = docCards(await api.docs.record(docId));
    setByDoc((m) => ({ ...m, [docId]: list }));
    return list;
  }, []);

  /** A new card for a picked term; earlier cards stay. `anchor` is relative to the reading area. */
  const create = useCallback(
    (docId: string, picked: PickedTerm, anchor: { x: number; y: number; height: number }, explainLang: string) => {
      // Minimized cards count too: their bar sits at the card's corner.
      const existing = (ref.current.byDoc[docId] ?? []).map((c) => c.rect);
      const card: TermCard = {
        id: uid(),
        term: picked.context.term,
        context: picked.context,
        explainLang,
        rect: placeCard(anchor, CARD_SIZE, ref.current.opts.bounds(), existing),
        window: 'normal',
        tasks: [],
        createdAt: Date.now(),
      };
      setDoc(docId, (l) => [...l, card]);
      setFocused(card.id);
    },
    [setDoc],
  );

  const run = useCallback(
    async (docId: string, id: string, skill: SkillInfo, o: RunOptions) => {
      const card = ref.current.byDoc[docId]?.find((c) => c.id === id);
      if (!card) return;
      const engine = { model: o.model, effort: o.effort };
      const request: JobRequest = {
        docId,
        skill: skill.name,
        context: { ...card.context, term: card.term.trim() || card.context.term },
        explainLang: card.explainLang,
        origin: 'user',
        ...(skill.runner === 'direct' ? { direct: engine } : { agent: engine }),
      };
      const key = runKey(request);
      const shown = (c: TermCard): TermCard => (c.window === 'minimized' ? { ...c, window: 'normal' } : c);
      const same = card.tasks.find((t) => runKey(t.request) === key);
      if (same) return update(docId, id, (c) => shown({ ...c, activeTask: same.id }));
      const pendingKey = `${id}\n${key}`;
      if (starting.current.has(pendingKey)) return;
      starting.current.add(pendingKey);
      try {
        await ref.current.opts.guard(async () => {
          const job = await ref.current.opts.start(request);
          if (!job) return;
          const task: CardTask = { id: uid(), jobId: job.id, skill: skill.name, createdAt: Date.now(), request };
          update(docId, id, (c) =>
            shown({
              ...c,
              tasks: [...c.tasks, task],
              activeTask: task.id,
              rect: c.window === 'maximized' ? c.rect : fitRect(sizeForResult(c.rect, skill.output), ref.current.opts.bounds()),
            }),
          );
        });
      } finally {
        starting.current.delete(pendingKey);
      }
    },
    [update],
  );

  const rerun = useCallback(
    (docId: string, id: string, task: CardTask) =>
      ref.current.opts.guard(async () => {
        const job = await ref.current.opts.start({ ...task.request, origin: 'user', force: true });
        if (job) update(docId, id, (c) => ({ ...c, activeTask: task.id, tasks: c.tasks.map((t) => (t.id === task.id ? { ...t, jobId: job.id } : t)) }));
      }),
    [update],
  );

  /** Closing a card leaves its runs going; the task panel finds them again. */
  const close = useCallback((docId: string, id: string) => setDoc(docId, (l) => l.filter((c) => c.id !== id)), [setDoc]);

  /**
   * Shows the card holding a run: restores it from the dock, or, when it was
   * closed, brings it back with the run (its context was fixed when it started).
   */
  const reveal = useCallback(
    (docId: string, jobId: string, request: JobRequest | undefined, output: keyof typeof RESULT_SIZE = 'markdown') => {
      const card = (ref.current.byDoc[docId] ?? []).find((c) => c.tasks.some((t) => t.jobId === jobId));
      if (card) {
        const task = card.tasks.find((t) => t.jobId === jobId)!;
        update(docId, card.id, (c) => ({ ...c, window: c.window === 'minimized' ? 'normal' : c.window, activeTask: task.id }));
        setFocused(card.id);
        return;
      }
      if (!request) return;
      const existing = (ref.current.byDoc[docId] ?? []).map((c) => c.rect);
      const task: CardTask = { id: uid(), jobId, skill: request.skill, createdAt: Date.now(), request };
      const back: TermCard = {
        id: uid(),
        term: request.context.term,
        context: request.context,
        explainLang: request.explainLang,
        rect: placeCard({ x: 40, y: 40, height: 0 }, RESULT_SIZE[output], ref.current.opts.bounds(), existing),
        window: 'normal',
        tasks: [task],
        activeTask: task.id,
        createdAt: Date.now(),
      };
      setDoc(docId, (l) => [...l, back]);
      setFocused(back.id);
    },
    [setDoc, update],
  );

  return { byDoc, focused, setFocused, load, create, update, run, rerun, close, reveal };
}
