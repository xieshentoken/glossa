import { describe, expect, it } from 'vitest';
import { dropTab, panelBox, placeTab, resizePanels, showTab, REGIONS } from '../src/shared/panels';
import { attachPinch, clampZoom, spreadFactor, wheelZoomFactor, ZOOM_MAX, ZOOM_MIN } from '../src/shared/pinch';

describe('panel layout', () => {
  it('names the regions and splits the width evenly', () => {
    expect(REGIONS[1]).toEqual(['middle']);
    expect(REGIONS[2]).toEqual(['left', 'right']);
    expect(REGIONS[3]).toEqual(['left', 'middle', 'right']);
    expect([0, 1, 2].map((i) => panelBox(i, 3))).toEqual([
      { left: 0, width: 100 / 3 },
      { left: 100 / 3, width: 100 / 3 },
      { left: 200 / 3, width: 100 / 3 },
    ]);
  });

  it('growing fills new panels with open documents that are not shown; shrinking keeps the active one', () => {
    expect(resizePanels(['a'], 0, 3, ['a', 'b', 'c', 'd'])).toEqual({ panels: ['a', 'b', 'c'], active: 0 });
    expect(resizePanels(['a'], 0, 2, ['a'])).toEqual({ panels: ['a', null], active: 0 });
    expect(resizePanels(['a', 'b', 'c'], 2, 1, ['a', 'b', 'c'])).toEqual({ panels: ['c'], active: 0 });
    // From three to two with the middle one active: it stays where it can, the others keep their order.
    expect(resizePanels(['a', 'b', 'c'], 1, 2, ['a', 'b', 'c'])).toEqual({ panels: ['a', 'b'], active: 1 });
    expect(resizePanels([null, 'b', null], 0, 1, ['b'])).toEqual({ panels: ['b'], active: 0 });
  });

  it('showing a document focuses its panel, or puts it into the active one', () => {
    expect(showTab(['a', 'b'], 0, 'b')).toEqual({ panels: ['a', 'b'], active: 1 });
    expect(showTab(['a', 'b'], 1, 'c')).toEqual({ panels: ['a', 'c'], active: 1 });
    expect(placeTab(['a', 'b', 'c'], 0, 'c')).toEqual(['c', 'b', 'a']);
    expect(placeTab(['a', null], 1, 'd')).toEqual(['a', 'd']);
  });

  it('closing a document shows the nearest one that is not shown elsewhere', () => {
    expect(dropTab(['b'], 'b', ['a', 'b', 'c'])).toEqual(['a']);
    expect(dropTab(['a', 'b'], 'b', ['a', 'b', 'c'])).toEqual(['a', 'c']);
    expect(dropTab(['a', 'b'], 'b', ['a', 'b'])).toEqual(['a', null]);
    expect(dropTab(['a'], 'a', ['a'])).toEqual([null]);
  });
});

describe('pinch-to-zoom', () => {
  it('spreading fingers zooms in, pinching zooms out, within limits', () => {
    expect(spreadFactor([{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 0 }, { x: 150, y: 0 }])).toBe(1.5);
    expect(spreadFactor([{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 25, y: 0 }, { x: 75, y: 0 }])).toBe(0.5);
    expect(clampZoom(10)).toBe(ZOOM_MAX);
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
  });

  it('turns Ctrl+wheel into small steps; one mouse notch is capped', () => {
    expect(wheelZoomFactor(-4)).toBeGreaterThan(1);
    expect(wheelZoomFactor(4)).toBeLessThan(1);
    expect(wheelZoomFactor(100)).toBe(wheelZoomFactor(25));
    expect(wheelZoomFactor(3, 1)).toBe(wheelZoomFactor(25));
  });

  it('reports Ctrl+wheel and two-finger moves, and ignores plain scrolling', () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const target = { addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] = f), removeEventListener: () => {} } as never;
    const steps: number[] = [];
    attachPinch(target, (f) => steps.push(f));
    let prevented = 0;
    const wheel = (ctrlKey: boolean) => ({ ctrlKey, deltaY: -10, deltaMode: 0, clientX: 0, clientY: 0, preventDefault: () => prevented++ });
    listeners.wheel(wheel(false));
    listeners.wheel(wheel(true));
    const p = (id: number, x: number, type = 'touch') => ({ pointerId: id, pointerType: type, clientX: x, clientY: 0, preventDefault: () => {} });
    listeners.pointerdown(p(1, 100));
    listeners.pointerdown(p(2, 200));
    listeners.pointermove(p(2, 300)); // spread 100 → 200
    listeners.pointerup(p(2, 300));
    listeners.pointermove(p(1, 50)); // one finger: no zoom
    listeners.pointerdown(p(3, 0, 'mouse'));
    expect(prevented).toBe(1);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toBeGreaterThan(1);
    expect(steps[1]).toBe(2);
  });
});
