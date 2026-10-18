// Multi-column reading: 1, 2 or 3 panels side by side, each showing one open
// document (by tab id) or nothing yet. Pure functions; the renderer keeps the state.

export type PanelCount = 1 | 2 | 3;
export type Region = 'left' | 'middle' | 'right';
export type Panels = (string | null)[];

export const REGIONS: Record<PanelCount, Region[]> = { 1: ['middle'], 2: ['left', 'right'], 3: ['left', 'middle', 'right'] };

/** Horizontal place of panel `i` of `n`, in percent of the reading area. */
export function panelBox(i: number, n: number): { left: number; width: number } {
  return { left: (100 * i) / n, width: 100 / n };
}

/**
 * A new panel count. The active panel's document stays shown, then the other
 * shown ones in order; new panels get open documents that are not shown yet.
 */
export function resizePanels(panels: Panels, active: number, n: PanelCount, tabs: string[]): { panels: Panels; active: number } {
  const first = panels[active] ?? null;
  const shown = [first, ...panels.filter((p, i) => i !== active)].filter((p): p is string => !!p && tabs.includes(p));
  const out: Panels = shown.slice(0, n);
  for (const t of tabs) if (out.length < n && !out.includes(t)) out.push(t);
  while (out.length < n) out.push(null);
  // Keep left-to-right order of documents that stay; the active one keeps its side where it can.
  const keep = Math.min(active, n - 1);
  if (first && out[0] === first && keep > 0) {
    out.splice(0, 1);
    out.splice(keep, 0, first);
  }
  return { panels: out, active: first ? out.indexOf(first) : 0 };
}

/** Show a document: in its own panel if it is shown already, otherwise in the active panel. */
export function showTab(panels: Panels, active: number, tab: string): { panels: Panels; active: number } {
  const at = panels.indexOf(tab);
  if (at >= 0) return { panels, active: at };
  const out = [...panels];
  out[active] = tab;
  return { panels: out, active };
}

/** Put a document into a given panel; if another panel showed it, the two swap. */
export function placeTab(panels: Panels, index: number, tab: string): Panels {
  const out = [...panels];
  const was = out.indexOf(tab);
  if (was >= 0) out[was] = out[index];
  out[index] = tab;
  return out;
}

/**
 * A document was closed. Its panel shows the nearest open document that is not
 * shown elsewhere; with one panel that is what a tab bar does anyway.
 */
export function dropTab(panels: Panels, tab: string, tabsBefore: string[]): Panels {
  const remaining = tabsBefore.filter((t) => t !== tab);
  const i = tabsBefore.indexOf(tab);
  const near = [...remaining.slice(Math.max(0, i - 1)), ...remaining.slice(0, Math.max(0, i - 1)).reverse()];
  return panels.map((p) => (p === tab ? (near.find((t) => !panels.includes(t)) ?? null) : p));
}
