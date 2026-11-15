import * as React from "react";
import { SidebarSimple } from "@phosphor-icons/react/ssr";
import { isTauri } from "@/lib/tauri";
import { prefs } from "@/lib/prefs";
import { useStore } from "@/lib/store-core";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EdgeBlur } from "@/ui/edge-blur";

const MIN_SIDEBAR_WIDTH = 232;
const MAX_SIDEBAR_WIDTH = 420;
const sidebarLimit = () => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(window.innerWidth * 0.4)));

/**
 * The signed-in frame. Fixed page headers and chat controls share the same desktop inset.
 */
export function AppShell({ bare, children, sessions }: {
  bare: boolean;
  children: React.ReactNode;
  sessions?: { content: React.ReactNode; collapsed: boolean; toggle: () => void };
}) {
  const showSessions = !!sessions && !sessions.collapsed;
  const toggleLabel = showSessions ? "收起對話清單" : "展開對話清單";
  const { sessionSidebarWidth } = useStore(prefs);
  const [maxWidth, setMaxWidth] = React.useState(sidebarLimit);
  const [dragWidth, setDragWidth] = React.useState<number | null>(null);
  const drag = React.useRef<{ pointerId: number; x: number; startWidth: number; width: number } | null>(null);
  const clampWidth = (value: number) => Math.round(Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, value)));
  const width = clampWidth(dragWidth ?? sessionSidebarWidth);

  React.useEffect(() => {
    const resize = () => setMaxWidth(sidebarLimit());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  function finishResize(event: React.PointerEvent, save: boolean) {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (save) prefs.set({ sessionSidebarWidth: clampWidth(drag.current.width) });
    drag.current = null;
    setDragWidth(null);
  }

  return (
    <div className="min-h-svh md:pl-[var(--desktop-inset)] motion-safe:transition-[padding-left] motion-safe:duration-[var(--sidebar-motion)] motion-safe:ease-[var(--ease-nav)]"
      style={{
        "--session-sidebar-width": `${width}px`,
        "--sidebar-motion": dragWidth === null ? "var(--motion-nav)" : "0ms",
        "--desktop-inset": showSessions ? "var(--session-sidebar-width)" : "0px",
      } as React.CSSProperties}>
      {sessions && !showSessions && !isTauri() ? (
        <Button
          aria-label={toggleLabel}
          className="fixed left-3 top-3 z-40 hidden md:inline-flex"
          onClick={sessions.toggle}
          size="icon-sm"
          title={toggleLabel}
          variant="ghost"
        >
          <SidebarSimple size={16} />
        </Button>
      ) : null}
      {sessions ? (
        <aside aria-label="對話清單" className={cn(
          "fixed inset-y-0 left-0 z-30 hidden overflow-clip md:block",
          "motion-safe:transition-[width] motion-safe:duration-[var(--sidebar-motion)] motion-safe:ease-[var(--ease-nav)]",
          showSessions ? "w-[var(--session-sidebar-width)]" : "w-0",
        )} id="session-sidebar" inert={!showSessions}>
          <div className={cn(
            "h-full w-[var(--session-sidebar-width)]",
            "motion-safe:transition-transform motion-safe:duration-[var(--motion-nav)] motion-safe:ease-[var(--ease-nav)]",
            !showSessions && "-translate-x-4",
          )}>{sessions.content}</div>
          {showSessions ? (
            <div aria-controls="session-sidebar" aria-label="調整對話清單寬度" aria-orientation="vertical"
              aria-valuemax={maxWidth} aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuenow={width}
              className="absolute inset-y-0 right-0 z-10 w-2 touch-none cursor-col-resize outline-none hover:bg-accent-soft focus-visible:bg-accent-soft active:bg-accent-soft"
              role="separator" tabIndex={0}
              onPointerDown={(event) => {
                if (!event.isPrimary || event.button !== 0 || drag.current) return;
                drag.current = { pointerId: event.pointerId, x: event.clientX, startWidth: width, width };
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragWidth(width);
              }}
              onPointerMove={(event) => {
                const current = drag.current;
                if (current?.pointerId !== event.pointerId) return;
                current.width = clampWidth(current.startWidth + event.clientX - current.x);
                setDragWidth(current.width);
              }}
              onPointerUp={(event) => finishResize(event, true)}
              onPointerCancel={(event) => finishResize(event, false)}
              onLostPointerCapture={(event) => finishResize(event, false)}
              onKeyDown={(event) => {
                const widths: Record<string, number> = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: MIN_SIDEBAR_WIDTH, End: maxWidth };
                if (!Object.hasOwn(widths, event.key)) return;
                event.preventDefault();
                prefs.set({ sessionSidebarWidth: clampWidth(widths[event.key]) });
              }}
            />
          ) : null}
        </aside>
      ) : null}
      {bare ? children : (
        <div className={cn(
          "md:fixed md:inset-x-0 md:bottom-0 md:top-[var(--safe-top)] md:left-[var(--desktop-inset)] md:overflow-y-auto md:overscroll-contain md:bg-surface md:border-t md:border-line",
          "motion-safe:transition-[left,border-radius] motion-safe:duration-[var(--sidebar-motion)] motion-safe:ease-[var(--ease-nav)]",
          showSessions && "md:rounded-tl-2xl md:border-l",
        )}>
          <main
            className={cn(
              "mx-auto w-full max-w-3xl px-[var(--gutter)] pb-[max(2rem,var(--safe-bottom))] pt-[calc(var(--safe-top)+1.5rem)] md:px-8 md:pb-12 md:pt-8",
            )}
          >
            {children}
          </main>
        </div>
      )}
      {bare ? null : (
        <>
          <EdgeBlur className={cn("h-[calc(var(--safe-top)+5rem)] md:top-[var(--safe-top)] md:left-[var(--desktop-inset)] motion-safe:transition-[left] motion-safe:duration-[var(--sidebar-motion)] motion-safe:ease-[var(--ease-nav)] md:h-12", showSessions && "md:rounded-tl-2xl")} side="top" />
          <EdgeBlur
            className="h-[calc(var(--safe-bottom)+2rem)] md:left-[var(--desktop-inset)] motion-safe:transition-[left] motion-safe:duration-[var(--sidebar-motion)] motion-safe:ease-[var(--ease-nav)] md:h-12"
            side="bottom"
          />
        </>
      )}
    </div>
  );
}
