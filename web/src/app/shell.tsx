import * as React from "react";
import { CaretLeft, CaretRight, ChatsCircle, GearSix, PuzzlePiece } from "@phosphor-icons/react/ssr";
import { prefs } from "@/lib/prefs";
import { useStore } from "@/lib/store-core";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { EdgeBlur } from "@/ui/edge-blur";
import { PrimaryNav, type NavItem } from "@/ui/nav";

const ITEMS: NavItem[] = [
  { href: "/", icon: ChatsCircle, label: "Session" },
  { href: "/plugins", icon: PuzzlePiece, label: "Plugin" },
  { href: "/settings", icon: GearSix, label: "設定" },
];
const MIN_SIDEBAR_WIDTH = 232;
const MAX_SIDEBAR_WIDTH = 420;
const sidebarLimit = () => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(window.innerWidth * 0.4)));

/**
 * The signed-in frame. Fixed page headers and chat controls share the same desktop inset.
 */
export function AppShell({ active, bare, children, dock, sessions }: {
  active: string;
  bare: boolean;
  children: React.ReactNode;
  dock: boolean;
  sessions?: { content: React.ReactNode; collapsed: boolean; toggle: () => void };
}) {
  const showSessions = !!sessions && !sessions.collapsed;
  const toggleLabel = showSessions ? "收起 session 清單" : "展開 session 清單";
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
    <div className="min-h-svh [--rail-width:3.5rem] md:pl-[var(--desktop-inset)] motion-safe:transition-[padding-left] motion-safe:duration-[var(--sidebar-motion)] motion-safe:ease-[var(--ease-nav)]"
      style={{
        "--session-sidebar-width": `${width}px`,
        "--sidebar-motion": dragWidth === null ? "var(--motion-nav)" : "0ms",
        "--desktop-inset": showSessions ? "calc(var(--rail-width) + var(--session-sidebar-width))" : "var(--rail-width)",
      } as React.CSSProperties}>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[var(--rail-width)] flex-col items-center gap-4 border-r border-line py-4 md:flex">
        <img alt="cc-remote" className="size-8 rounded-icon" src="/icon.svg" />
        <PrimaryNav activeHref={active} items={ITEMS} label="主選單" variant="rail" />
        {sessions ? (
          <Button aria-controls="session-sidebar" aria-expanded={showSessions} aria-label={toggleLabel} className="mt-auto" onClick={sessions.toggle} size="icon-sm" title={toggleLabel} variant="ghost">
            {showSessions ? <CaretLeft weight="bold" /> : <CaretRight weight="bold" />}
          </Button>
        ) : null}
      </aside>
      {sessions ? (
        <aside aria-label="Session 清單" className={cn(
          "fixed inset-y-0 left-[var(--rail-width)] z-30 hidden overflow-clip bg-surface/60 md:block",
          "motion-safe:transition-[width] motion-safe:duration-[var(--sidebar-motion)] motion-safe:ease-[var(--ease-nav)]",
          showSessions ? "w-[var(--session-sidebar-width)]" : "w-0",
        )} id="session-sidebar" inert={!showSessions}>
          <div className={cn(
            "h-full w-[var(--session-sidebar-width)] border-r border-line",
            "motion-safe:transition-transform motion-safe:duration-[var(--motion-nav)] motion-safe:ease-[var(--ease-nav)]",
            !showSessions && "-translate-x-4",
          )}>{sessions.content}</div>
          {showSessions ? (
            <div aria-controls="session-sidebar" aria-label="調整 session 清單寬度" aria-orientation="vertical"
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
        <main
          className={cn(
            "mx-auto w-full max-w-3xl px-[var(--gutter)] pt-[calc(var(--safe-top)+1.5rem)] md:px-8 md:pb-12 md:pt-10",
            dock ? "pb-[calc(var(--bottom-nav-height)+var(--bottom-nav-gap)+1.5rem)]" : "pb-[max(2rem,var(--safe-bottom))]",
          )}
        >
          {children}
        </main>
      )}
      {bare ? null : (
        <>
          <EdgeBlur className="h-[calc(var(--safe-top)+5rem)] md:left-[var(--desktop-inset)] motion-safe:transition-[left] motion-safe:duration-[var(--sidebar-motion)] motion-safe:ease-[var(--ease-nav)] md:h-20" side="top" />
          <EdgeBlur
            className={cn("md:left-[var(--desktop-inset)] motion-safe:transition-[left] motion-safe:duration-[var(--sidebar-motion)] motion-safe:ease-[var(--ease-nav)] md:h-16", dock ? "h-[calc(var(--bottom-nav-height)+var(--bottom-nav-gap)+1.5rem)]" : "h-[calc(var(--safe-bottom)+2rem)]")}
            side="bottom"
          />
        </>
      )}
      <div
        aria-hidden={!dock}
        className={cn(
          "fixed inset-x-[var(--gutter)] bottom-[var(--bottom-nav-gap)] z-30 mx-auto max-w-xs transition-[opacity,translate] duration-[var(--motion-nav)] ease-[var(--ease-nav)] md:hidden",
          dock ? "translate-y-0 opacity-100" : bare ? "hidden" : "pointer-events-none translate-y-6 opacity-0",
        )}
        inert={!dock}
      >
        <PrimaryNav activeHref={active} items={ITEMS} label="主選單" variant="dock" />
      </div>
    </div>
  );
}
