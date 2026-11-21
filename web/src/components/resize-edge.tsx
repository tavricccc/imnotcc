// The left edge of a right-hand panel: a divider line that drags to resize it.
import * as React from "react";

export function useEdgeResize(width: number, clamp: (w: number) => number, save: (w: number) => void) {
  const drag = React.useRef<{ id: number; x: number; start: number } | null>(null);
  const [dragging, setDragging] = React.useState<number | null>(null);
  const shown = clamp(dragging ?? width);
  const finish = () => {
    if (!drag.current) return;
    drag.current = null;
    if (dragging !== null) save(clamp(dragging));
    setDragging(null);
  };
  const handle = (
    <div aria-label="調整寬度" aria-orientation="vertical" aria-valuenow={shown}
      className="group absolute inset-y-0 -left-1.5 z-10 w-3 touch-none cursor-col-resize outline-none"
      onKeyDown={(e) => {
        const step = { ArrowLeft: 24, ArrowRight: -24 }[e.key];
        if (step) save(clamp(shown + step));
      }}
      onLostPointerCapture={finish}
      onPointerCancel={finish}
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0) return;
        drag.current = { id: e.pointerId, x: e.clientX, start: shown };
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(shown);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d?.id === e.pointerId) setDragging(clamp(d.start + d.x - e.clientX));
      }}
      onPointerUp={finish}
      role="separator" tabIndex={0}
    >
      <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-[width,background-color] duration-[var(--motion-control)] group-hover:w-[3px] group-hover:bg-accent-soft group-focus-visible:w-[3px] group-focus-visible:bg-accent-soft group-active:w-[3px] group-active:bg-accent-soft" />
    </div>
  );
  return { dragging: dragging !== null, handle, shown };
}
