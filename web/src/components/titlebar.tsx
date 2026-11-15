import * as React from "react";
import { SidebarSimple } from "@phosphor-icons/react/ssr";
import { isTauri } from "@/lib/tauri";

interface TauriWindowHandle {
  startDragging: () => Promise<void>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  hide: () => Promise<void>;
}

function getCurrentTauriWindow(): TauriWindowHandle | null {
  const g = (window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => TauriWindowHandle } } }).__TAURI__;
  return g?.window?.getCurrentWindow ? g.window.getCurrentWindow() : null;
}

export function Titlebar({ sidebar }: { sidebar?: { collapsed: boolean; toggle: () => void } } = {}) {
  const active = isTauri();

  React.useLayoutEffect(() => {
    if (!active) return;
    // Not undone on unmount: the app swaps between login and main views, each with its own titlebar,
    // and the window stays frameless either way.
    document.documentElement.style.setProperty("--safe-top", "36px");
    document.documentElement.dataset.tauri = "1";
  }, [active]);

  if (!active) return null;

  const toggleLabel = sidebar ? (sidebar.collapsed ? "展開側邊欄" : "收起側邊欄") : undefined;

  return (
    <div
      className="fixed inset-x-0 top-0 z-[100] flex h-9 select-none items-stretch justify-between bg-transparent text-ink-muted"
      id="ccr-titlebar"
    >
      <div
        className="flex flex-1 items-center gap-2 pl-3 text-xs font-semibold tracking-wide"
        data-tauri-drag-region
        onDoubleClick={() => void getCurrentTauriWindow()?.toggleMaximize()}
        onMouseDown={(e) => {
          if (e.button === 0) void getCurrentTauriWindow()?.startDragging();
        }}
      >
        <img alt="" className="size-4 rounded-[22.37%]" src="/icon.svg" />
        <span>imnotcc</span>
        {sidebar ? (
          <button
            aria-expanded={!sidebar.collapsed}
            aria-label={toggleLabel}
            className="ml-1 hidden size-7 place-items-center rounded-md text-ink-muted transition-colors hover:bg-surface-pressed hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:grid"
            onClick={sidebar.toggle}
            onMouseDown={(e) => e.stopPropagation()}
            title={toggleLabel}
            type="button"
          >
            <SidebarSimple size={16} weight={sidebar.collapsed ? "regular" : "fill"} />
          </button>
        ) : null}
      </div>
      <div className="flex items-stretch">
        <button
          aria-label="最小化"
          className="grid w-11 place-items-center transition-colors hover:bg-surface-pressed hover:text-ink"
          onClick={() => void getCurrentTauriWindow()?.minimize()}
          type="button"
        >
          <svg className="size-2.5 stroke-current" fill="none" strokeWidth="1.4" viewBox="0 0 10 10">
            <line x1="1" x2="9" y1="5.5" y2="5.5" />
          </svg>
        </button>
        <button
          aria-label="最大化"
          className="grid w-11 place-items-center transition-colors hover:bg-surface-pressed hover:text-ink"
          onClick={() => void getCurrentTauriWindow()?.toggleMaximize()}
          type="button"
        >
          <svg className="size-2.5 stroke-current" fill="none" strokeWidth="1.4" viewBox="0 0 10 10">
            <rect height="7" width="7" x="1.5" y="1.5" />
          </svg>
        </button>
        <button
          aria-label="隱藏到系統匣"
          className="grid w-11 place-items-center transition-colors hover:bg-[#c42b1c] hover:text-white"
          onClick={() => void getCurrentTauriWindow()?.hide()}
          type="button"
        >
          <svg className="size-2.5 stroke-current" fill="none" strokeWidth="1.4" viewBox="0 0 10 10">
            <line x1="1.5" x2="8.5" y1="1.5" y2="8.5" />
            <line x1="8.5" x2="1.5" y1="1.5" y2="8.5" />
          </svg>
        </button>
      </div>
    </div>
  );
}
