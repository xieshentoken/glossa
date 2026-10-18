// Reading panels for the multi-column layout. Every open document keeps one
// frame for its whole life; the layout only moves frames into a panel (left,
// middle, right) or hides them, so documents never reload or lose their place.

import { useEffect, useRef, type ReactNode } from 'react';
import type { T } from '../../shared/i18n';
import { REGIONS, type Region } from '../../shared/panels';
import { attachPinch } from '../../shared/pinch';
import type { DocInfo } from '../../shared/types';

const REGION_LABEL = { left: 'panelLeft', middle: 'panelMiddle', right: 'panelRight' } as const;

export interface PanelTab {
  tabId: string;
  doc: DocInfo;
}

/** One open document. `slot` is its panel, or -1 when it is not shown. */
export function ReaderFrame(props: {
  tab: PanelTab;
  slot: number;
  count: number;
  active: boolean;
  zoom: number;
  head: ReactNode;
  onActivate: () => void;
  onPointerInside: () => void;
  onZoomBy: (factor: number, x: number, y: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(props);
  cb.current = props;
  useEffect(() => attachPinch(ref.current!, (f, x, y) => cb.current.onZoomBy(f, x, y)), []);
  const shown = props.slot >= 0;
  return (
    <div
      ref={ref}
      className={`reader ${shown ? 'shown' : ''} ${props.active ? 'active' : ''} ${props.count > 1 ? 'multi' : ''} ${props.slot > 0 ? 'edge' : ''}`}
      style={shown ? { left: `${(100 * props.slot) / props.count}%`, width: `${100 / props.count}%` } : undefined}
      data-tab={props.tab.tabId}
      data-region={shown ? REGIONS[props.count as 1 | 2 | 3][props.slot] : undefined}
      data-zoom={props.zoom}
      onPointerDownCapture={() => shown && props.onActivate()}
      onPointerMove={props.onPointerInside}
      onFocusCapture={() => shown && props.onActivate()}
    >
      {props.count > 1 && shown ? props.head : null}
      <div className="reader-body">{props.children}</div>
    </div>
  );
}

/** Header of a panel: where it is, which document it shows, its zoom. */
export function PanelHead(props: {
  t: T;
  region: Region;
  tabs: PanelTab[];
  tabId: string | null;
  zoom: number;
  onChoose: (tabId: string) => void;
  onResetZoom: () => void;
}) {
  const { t } = props;
  return (
    <div className="panel-head">
      <span className="panel-region">{t(REGION_LABEL[props.region])}</span>
      <select value={props.tabId ?? ''} aria-label={t('panelChoose')} onChange={(e) => e.target.value && props.onChoose(e.target.value)} data-testid="panel-doc">
        {!props.tabId && <option value="">{t('panelChoose')}…</option>}
        {props.tabs.map((x) => (
          <option key={x.tabId} value={x.tabId}>
            {x.doc.title}
          </option>
        ))}
      </select>
      {props.tabId && (
        <button className="zoom-chip" title={t('zoomReset')} onClick={props.onResetZoom} data-testid="panel-zoom">
          {Math.round(props.zoom * 100)}%
        </button>
      )}
    </div>
  );
}

/** A panel with no document yet. */
export function EmptyPanel(props: { t: T; slot: number; count: number; active: boolean; tabs: PanelTab[]; onActivate: () => void; onChoose: (tabId: string) => void }) {
  const { t } = props;
  const region = REGIONS[props.count as 1 | 2 | 3][props.slot];
  return (
    <div
      className={`panel-empty ${props.active ? 'active' : ''} ${props.slot > 0 ? 'edge' : ''}`}
      style={{ left: `${(100 * props.slot) / props.count}%`, width: `${100 / props.count}%` }}
      data-region={region}
      data-testid="panel-empty"
      onPointerDown={props.onActivate}
    >
      <PanelHead t={t} region={region} tabs={props.tabs} tabId={null} zoom={1} onChoose={props.onChoose} onResetZoom={() => {}} />
      <div className="panel-empty-body">
        <p>{t('panelEmpty')}</p>
      </div>
    </div>
  );
}
