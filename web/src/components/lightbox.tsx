import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ArrowSquareOut, X } from "@phosphor-icons/react/ssr";
import { createStore, useStore } from "@/lib/store-core";
import { cn } from "@/lib/utils";

const shown = createStore<{ src: string | null }>({ src: null });

/** Shows an image over everything, as large as the screen allows; pinch, drag and double-tap zoom it. */
export const openImage = (src: string) => shown.set({ src });

interface View { scale: number; x: number; y: number }
const FIT: View = { scale: 1, x: 0, y: 0 };
const MAX_SCALE = 6;

/**
 * Pinch and pan for one element, by pointer events, so it works while the page itself
 * forbids pinch-zoom. Positions are in CSS pixels from the element's centre.
 */
function useZoom(src: string | null, onTapOutside: () => void) {
  const [view, setView] = React.useState<View>(FIT);
  const box = React.useRef<HTMLDivElement>(null);
  const pointers = React.useRef(new Map<number, { x: number; y: number }>());
  const gesture = React.useRef<{ view: View; dist: number; mid: { x: number; y: number }; moved: boolean } | null>(null);
  const lastTap = React.useRef(0);
  React.useEffect(() => setView(FIT), [src]);

  const centre = () => {
    const r = box.current!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const clamp = (v: View): View => (v.scale <= 1 ? FIT : { ...v, scale: Math.min(MAX_SCALE, v.scale) });
  // Zoom to `scale` keeping the screen point `at` where it is.
  const zoomAt = (from: View, scale: number, at: { x: number; y: number }): View => {
    const c = centre();
    const k = scale / from.scale;
    return { scale, x: (at.x - c.x) - k * (at.x - c.x - from.x), y: (at.y - c.y) - k * (at.y - c.y - from.y) };
  };
  const start = () => {
    const pts = [...pointers.current.values()];
    const mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { view, dist, mid, moved: gesture.current?.moved ?? false };
  };

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* a pointer already gone */ }
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 1) gesture.current = null;
      start();
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!pointers.current.has(e.pointerId) || !gesture.current) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture.current;
      const pts = [...pointers.current.values()];
      if (pts.length > 1) {
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const scaled = zoomAt(g.view, Math.max(0.6, Math.min(MAX_SCALE, g.view.scale * (dist / g.dist))), g.mid);
        g.moved = true;
        setView({ ...scaled, x: scaled.x + mid.x - g.mid.x, y: scaled.y + mid.y - g.mid.y });
      } else if (g.view.scale > 1) {
        const dx = pts[0].x - g.mid.x, dy = pts[0].y - g.mid.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
        setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
      } else if (Math.abs(pts[0].x - g.mid.x) + Math.abs(pts[0].y - g.mid.y) > 8) g.moved = true;
    },
    onPointerUp: (e: React.PointerEvent) => {
      const g = gesture.current;
      pointers.current.delete(e.pointerId);
      if (pointers.current.size) { start(); return; }
      setView((v) => clamp(v));
      if (!g || g.moved) return;
      // A tap: double-tap toggles zoom at that point; a single tap outside the image closes.
      const now = Date.now();
      if (now - lastTap.current < 300) {
        lastTap.current = 0;
        setView((v) => (v.scale > 1 ? FIT : zoomAt(v, 2.5, { x: e.clientX, y: e.clientY })));
        return;
      }
      lastTap.current = now;
      const onImage = (e.target as HTMLElement).tagName === "IMG";
      if (!onImage && view.scale <= 1) window.setTimeout(() => { if (lastTap.current === now) onTapOutside(); }, 300);
    },
    onPointerCancel: (e: React.PointerEvent) => { pointers.current.delete(e.pointerId); setView((v) => clamp(v)); },
    onWheel: (e: React.WheelEvent) => {
      // Ctrl+wheel and trackpad pinch on a computer.
      const next = Math.max(1, Math.min(MAX_SCALE, view.scale * Math.exp(-e.deltaY / 300)));
      setView(clamp(zoomAt(view, next, { x: e.clientX, y: e.clientY })));
    },
  };
  return { box, handlers, view, zoomed: view.scale > 1 };
}

export function Lightbox() {
  const { src } = useStore(shown);
  const close = () => shown.set({ src: null });
  const { box, handlers, view, zoomed } = useZoom(src, close);
  return (
    <DialogPrimitive.Root onOpenChange={(open) => { if (!open) close(); }} open={!!src}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="scrim fixed inset-0 z-[60] bg-black/90" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-[60] touch-none select-none overflow-hidden overscroll-contain outline-none"
          ref={box}
          {...handlers}
        >
          <DialogPrimitive.Title className="sr-only">圖片</DialogPrimitive.Title>
          {src ? (
            <img
              alt=""
              className={cn("pointer-events-auto absolute inset-3 m-auto size-[calc(100%-1.5rem)] object-contain sm:inset-8 sm:size-[calc(100%-4rem)] will-change-transform", !zoomed && "transition-transform duration-200 ease-out")}
              draggable={false}
              src={src}
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            />
          ) : null}
          <div className="fixed right-[max(0.75rem,var(--safe-right,0px))] top-[max(0.75rem,var(--safe-top))] flex gap-2" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
            {src && !src.startsWith("data:") ? (
              <a aria-label="在新分頁開啟" className="grid size-10 place-items-center rounded-full bg-black/60 text-white" href={src} rel="noopener noreferrer" target="_blank">
                <ArrowSquareOut className="size-5" weight="bold" />
              </a>
            ) : null}
            <DialogPrimitive.Close aria-label="關閉" className="grid size-10 place-items-center rounded-full bg-black/60 text-white">
              <X className="size-5" weight="bold" />
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * A small preview that opens in the lightbox. Given several sources it shows the first that
 * loads, and it disappears if none does.
 */
export function Thumb({ className, src }: { className?: string; src: string | string[] }) {
  const sources = Array.isArray(src) ? src : [src];
  const [tried, setTried] = React.useState(0);
  const current = sources[tried];
  if (!current) return null;
  return (
    <button className={cn("shrink-0 overflow-hidden rounded-tile shadow-panel outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]", className)} onClick={() => openImage(current)} type="button">
      <img alt="" className="block size-20 object-cover" loading="lazy" onError={() => setTried(tried + 1)} src={current} />
    </button>
  );
}
