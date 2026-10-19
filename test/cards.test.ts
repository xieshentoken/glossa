import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidArgument, vTermCards } from '../src/main/validate';
import { Store } from '../src/main/store';
import { fitRect, GAP, maximized, placeCard, snapMove, snapResize, SNAP } from '../src/shared/card-geometry';
import * as cardsModule from '../src/shared/cards';
import { CARD_SIZE, cardJobIds, docCards, fromLegacy, runKey } from '../src/shared/cards';
import type { LegacyCard, TermCard } from '../src/shared/types';
import { box, req, tmpDir } from './helpers';

const legacy = (over: Partial<LegacyCard> = {}): LegacyCard => ({
  id: 'old1',
  jobId: 'mabc123-0011223344',
  term: 'Reynolds number',
  skill: 'eli5',
  rect: { x: 40, y: 60, w: 460, h: 340 },
  expanded: true,
  createdAt: 5,
  request: req('eli5'),
  ...over,
});

const card = (over: Partial<TermCard> = {}): TermCard => ({
  id: 'c1',
  term: 'Reynolds number',
  context: req('eli5').context,
  explainLang: 'fr',
  rect: { x: 10, y: 20, w: 460, h: 260 },
  window: 'normal',
  tasks: [{ id: 't1', jobId: 'mabc123-0011223344', skill: 'eli5', createdAt: 1, request: req('eli5') }],
  activeTask: 't1',
  createdAt: 1,
  ...over,
});

describe('legacy cards', () => {
  it('become one term card per saved result, keeping job, request and place', () => {
    const c = fromLegacy(legacy());
    expect(c).toMatchObject({ id: 'old1', term: 'Reynolds number', explainLang: 'fr', window: 'normal', activeTask: 'old1', rect: { x: 40, y: 60, w: 460, h: 340 } });
    expect(c.tasks).toEqual([{ id: 'old1', jobId: 'mabc123-0011223344', skill: 'eli5', createdAt: 5, request: req('eli5') }]);
    expect(c.context).toEqual(req('eli5').context);
    // A collapsed pill stays out of the way; a tiny saved size gets a usable one.
    expect(fromLegacy(legacy({ expanded: false, rect: { x: 1, y: 2, w: 0, h: 0 } }))).toMatchObject({ window: 'minimized', rect: { x: 1, y: 2, w: 480, h: 460 } });
  });

  it('are read when no new cards were saved; new cards win once saved', () => {
    expect(docCards({ cards: [legacy()] }).map((c) => c.id)).toEqual(['old1']);
    expect(docCards({ cards: [legacy()], termCards: [card()] }).map((c) => c.id)).toEqual(['c1']);
    expect(docCards(undefined)).toEqual([]);
  });

  it('keep their jobs from being cleaned up, in either format', () => {
    const two = card({ tasks: [...card().tasks, { id: 't2', jobId: 'mabc124-5566778899', skill: 'quick-gloss', createdAt: 2, request: req('quick-gloss') }] });
    expect(cardJobIds({ cards: [legacy({ jobId: 'mzzz-legacy0000' })], termCards: [two] }).sort()).toEqual(['mabc123-0011223344', 'mabc124-5566778899', 'mzzz-legacy0000']);
  });
});

describe('Store cards', () => {
  let dir: string;
  beforeEach(() => (dir = tmpDir()));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('saves term cards and drops the legacy copy on the first save', () => {
    const store = new Store(dir, box);
    const docId = 'a'.repeat(64);
    store.touchDoc({ docId, kind: 'markdown', title: 'T', source: '/t.md', openedAt: 1 });
    // A record as an older version wrote it.
    const file = `${store.docsDir}/${docId}.json`;
    const { termCards: _t, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...rest, cards: [legacy()] }));
    expect(docCards(store.getDoc(docId)).map((c) => c.id)).toEqual(['old1']);
    // Reopening keeps the old cards until they are saved in the new form.
    store.touchDoc({ docId, kind: 'markdown', title: 'T2', source: '/t.md', openedAt: 2 });
    expect(store.getDoc(docId)!.cards).toHaveLength(1);

    store.saveCards(docId, docCards(store.getDoc(docId)));
    const saved = store.getDoc(docId)!;
    expect(saved.cards).toBeUndefined();
    expect(saved.termCards!.map((c) => c.tasks[0].jobId)).toEqual(['mabc123-0011223344']);
    expect(saved.title).toBe('T2');
  });

  it('keeps cards of different documents apart', () => {
    const store = new Store(dir, box);
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    for (const docId of [a, b]) store.touchDoc({ docId, kind: 'pdf', title: docId[0], source: `/${docId[0]}.pdf`, openedAt: 1 });
    store.saveCards(a, [card({ id: 'ca' })]);
    store.saveCards(b, [card({ id: 'cb1' }), card({ id: 'cb2' })]);
    expect(docCards(store.getDoc(a)).map((c) => c.id)).toEqual(['ca']);
    expect(docCards(store.getDoc(b)).map((c) => c.id)).toEqual(['cb1', 'cb2']);
  });
});

describe('vTermCards', () => {
  it('accepts saved cards and rejects malformed ones', () => {
    const ok = card({ window: 'maximized' });
    expect(vTermCards([ok])).toEqual([ok]);
    expect(vTermCards([card({ tasks: [], activeTask: undefined })])[0].tasks).toEqual([]);
    expect(() => vTermCards([{ ...card(), window: 'fullscreen' }])).toThrow(InvalidArgument);
    expect(() => vTermCards([{ ...card(), extra: 1 }])).toThrow(/unexpected field extra/);
    expect(() => vTermCards([{ ...card(), restore: card().rect }])).toThrow(/unexpected field restore/);
    expect(() => vTermCards([{ ...card(), id: 'C/1' }])).toThrow(InvalidArgument);
    expect(() => vTermCards([card({ tasks: [{ ...card().tasks[0], jobId: '../x' }] })])).toThrow(InvalidArgument);
    expect(() => vTermCards([card({ context: { ...card().context, term: ' ' } })])).toThrow(InvalidArgument);
    expect(() => vTermCards([card({ tasks: Array.from({ length: 51 }, () => card().tasks[0]) })])).toThrow(InvalidArgument);
    expect(() => vTermCards({})).toThrow(InvalidArgument);
  });
});

describe('runs', () => {
  it('have the same key only for the same skill, term, language and engine choice', () => {
    const a = req('eli5');
    expect(runKey(a)).toBe(runKey({ ...a, force: true, origin: 'auto' }));
    expect(runKey(a)).not.toBe(runKey(req('quick-gloss')));
    expect(runKey(a)).not.toBe(runKey({ ...a, explainLang: 'de' }));
    expect(runKey(a)).not.toBe(runKey({ ...a, context: { ...a.context, term: 'Reynolds' } }));
    expect(runKey(a)).not.toBe(runKey({ ...a, direct: { model: 'other' } }));
    expect(runKey({ ...a, direct: {} })).toBe(runKey(a));
  });

  it('have one size whatever skill runs in them; nothing resizes a card by result type', () => {
    expect(CARD_SIZE).toEqual({ w: 480, h: 460 });
    expect('sizeForResult' in cardsModule || 'RESULT_SIZE' in cardsModule).toBe(false);
  });
});

describe('card placement', () => {
  const area = { w: 1000, h: 700 };

  it('fits a card inside the area', () => {
    expect(fitRect({ x: -50, y: 900, w: 300, h: 200 }, area)).toEqual({ x: 8, y: 492, w: 300, h: 200 });
    expect(fitRect({ x: 0, y: 0, w: 2000, h: 2000 }, area)).toEqual({ x: 8, y: 8, w: 984, h: 684 });
  });

  it('opens below the term, or above it near the bottom', () => {
    expect(placeCard({ x: 100, y: 100, height: 20 }, { w: 460, h: 260 }, area, [])).toEqual({ x: 100, y: 128, w: 460, h: 260 });
    expect(placeCard({ x: 100, y: 600, height: 20 }, { w: 460, h: 260 }, area, [])).toEqual({ x: 100, y: 332, w: 460, h: 260 });
    expect(placeCard({ x: 900, y: 100, height: 20 }, { w: 460, h: 260 }, area, []).x).toBe(532);
  });

  it('never puts a new card exactly over earlier ones', () => {
    const size = { w: 460, h: 260 };
    const placed: ReturnType<typeof placeCard>[] = [];
    for (let i = 0; i < 6; i++) placed.push(placeCard({ x: 100, y: 100, height: 20 }, size, area, placed));
    for (let i = 0; i < placed.length; i++) {
      for (let j = 0; j < i; j++) expect(Math.abs(placed[i].x - placed[j].x) >= 24 || Math.abs(placed[i].y - placed[j].y) >= 24).toBe(true);
      expect(fitRect(placed[i], area)).toEqual(placed[i]);
    }
  });

  it('starts a new column when the cascade reaches a corner', () => {
    const size = { w: 460, h: 260 };
    const corner = { x: 532, y: 432, w: 460, h: 260 };
    const r = placeCard({ x: 990, y: 690, height: 5 }, size, area, [corner]);
    expect(Math.abs(r.x - corner.x) >= 24 || Math.abs(r.y - corner.y) >= 24).toBe(true);
  });
});

describe('snapping', () => {
  const area = { w: 1200, h: 800 };
  const a = { x: 100, y: 100, w: 400, h: 300 };

  it('pulls a card next to another one, leaving a gap, and lines up the tops', () => {
    // Dragged to 10px right of a's right edge, 7px lower: snaps to the gap and aligns.
    expect(snapMove({ x: a.x + a.w + 10, y: 107, w: 300, h: 200 }, [a], area)).toEqual({ x: a.x + a.w + GAP, y: 100, w: 300, h: 200 });
    // To the left of a card.
    const c = { x: 700, y: 100, w: 300, h: 300 };
    expect(snapMove({ x: c.x - 300 - 3, y: 300, w: 300, h: 200 }, [c], area).x).toBe(c.x - 300 - GAP);
    // Below a, left edges lined up.
    expect(snapMove({ x: 110, y: a.y + a.h + 2, w: 300, h: 200 }, [a], area)).toEqual({ x: 100, y: a.y + a.h + GAP, w: 300, h: 200 });
  });

  it('snaps to the edges of the reading area', () => {
    expect(snapMove({ x: 14, y: 790 - 200, w: 300, h: 200 }, [], area)).toEqual({ x: 8, y: 592, w: 300, h: 200 });
  });

  it('lets go once the card is dragged further away', () => {
    const far = { x: a.x + a.w + GAP + SNAP + 1, y: 160, w: 300, h: 200 };
    expect(snapMove(far, [a], area)).toEqual(far);
    // Cards far apart vertically do not pull each other sideways.
    const below = { x: a.x + a.w + 10, y: 600, w: 300, h: 150 };
    expect(snapMove(below, [a], area).x).toBe(below.x);
  });

  it('snaps edges while resizing, never below the minimum size', () => {
    const b = { x: 600, y: 100, w: 300, h: 300 };
    expect(snapResize({ x: 100, y: 100, w: 600 - GAP - 100 - 5, h: 300 }, [b], area, { w: 220, h: 140 }).w).toBe(600 - GAP - 100);
    expect(snapResize({ x: 100, y: 100, w: 300, h: 795 - 100 }, [], area, { w: 220, h: 140 }).h).toBe(800 - 8 - 100);
    expect(snapResize({ x: 100, y: 100, w: 50, h: 50 }, [], area, { w: 220, h: 140 })).toMatchObject({ w: 220, h: 140 });
    expect(snapResize({ x: 100, y: 100, w: 5000, h: 5000 }, [], area, { w: 220, h: 140 })).toMatchObject({ w: 1092, h: 692 });
  });

  it('maximizes to the whole area; the shown rect follows the area, the saved one does not change', () => {
    expect(maximized(area)).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
    const saved = { x: 700, y: 450, w: 460, h: 300 };
    expect(fitRect(saved, { w: 800, h: 600 })).toEqual({ x: 332, y: 292, w: 460, h: 300 });
    expect(fitRect(saved, area)).toEqual(saved);
  });
});
