import { useEffect, useRef, useState } from 'react';
import type { T } from '../../shared/i18n';
import type { Box } from '../../shared/term-locate';

const MIN_SIDE = 8;

/**
 * Drag over part of the reading area (documents, web pages, video) to explain
 * what is in it. Covers the area while open, so the pages under it do not get
 * the mouse. Esc or a click without dragging cancels.
 */
export function AreaCapture(props: { t: T; onDone: (rect: Box) => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cb.current.onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const box = drag && { left: Math.min(drag.x0, drag.x1), top: Math.min(drag.y0, drag.y1), right: Math.max(drag.x0, drag.x1), bottom: Math.max(drag.y0, drag.y1) };
  const origin = ref.current?.getBoundingClientRect();

  return (
    <div
      ref={ref}
      className="area-capture"
      tabIndex={-1}
      data-testid="area-capture"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      }}
      onPointerMove={(e) => drag && setDrag({ ...drag, x1: e.clientX, y1: e.clientY })}
      onPointerUp={(e) => {
        if (!drag) return;
        const b = { left: Math.min(drag.x0, e.clientX), top: Math.min(drag.y0, e.clientY), right: Math.max(drag.x0, e.clientX), bottom: Math.max(drag.y0, e.clientY) };
        setDrag(null);
        if (b.right - b.left < MIN_SIDE || b.bottom - b.top < MIN_SIDE) props.onCancel();
        else props.onDone(b);
      }}
    >
      <div className="area-capture-hint">{props.t('captureAreaHint')}</div>
      {box && origin && (
        <div
          className="area-capture-box"
          style={{ left: box.left - origin.left, top: box.top - origin.top, width: box.right - box.left, height: box.bottom - box.top }}
        />
      )}
    </div>
  );
}
