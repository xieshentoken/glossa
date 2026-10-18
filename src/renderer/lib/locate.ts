// What the app asks of an open document's reader: find a card's term again
// ("show in document"), read a captured area, and (web pages) pick where the
// mouse is when the app had the keyboard.

import { areaText } from '../../shared/area-text';
import { findTerm, flashBoxes, flashRange, regionRect, scrollToBox, scrollToRange, toRegion, type Box } from '../../shared/term-locate';
import type { TermLocator } from '../../shared/types';

/** Client rect to keep clear (the card asking), if there is room. */
export type Avoid = Box;

/** Finds the term, scrolls to it and highlights it; false when the document does not contain it. */
export type Locate = (loc: TermLocator, avoid?: Avoid) => Promise<boolean>;

/** What a captured area holds: its text (if the document has it as text), where it is, and whether pictures show in it. */
export interface AreaInfo {
  text: string;
  locator: TermLocator;
  pictures: boolean;
}

export interface ReaderHandle {
  locate: Locate;
  /** `rect` in the app window's client coordinates. */
  area: (rect: Box) => Promise<AreaInfo>;
  /** Web pages: the pick hotkey, forwarded. */
  pickHere?: () => void;
}

/** For readers whose whole text is in the DOM (converted documents, code): text first, else the saved region. */
export function locateIn(scroller: HTMLElement | null, loc: TermLocator, avoid?: Avoid): boolean {
  if (!scroller) return false;
  const range = loc.quote ? findTerm(scroller, loc) : null;
  if (range) {
    scrollToRange(range, avoid);
    flashRange(range, scroller);
    return true;
  }
  if (!loc.region || !scroller.firstElementChild) return false;
  const box = () => regionRect(scroller, loc.region!, true);
  scrollToBox(scroller.firstElementChild, box, avoid);
  flashBoxes(document, () => [box()], scroller);
  return true;
}

/** An area of a reader whose whole text is in the DOM; its place is kept relative to the scrolled content. */
export function areaIn(scroller: HTMLElement | null, rect: Box): AreaInfo {
  if (!scroller) return { text: '', locator: { quote: '', prefix: '', suffix: '' }, pictures: true };
  const a = areaText(scroller, rect);
  return { text: a.text, pictures: a.pictures, locator: { ...(a.locator ?? { quote: '', prefix: '', suffix: '' }), region: toRegion(scroller, rect, true) } };
}
