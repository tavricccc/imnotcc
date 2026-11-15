import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { motion } from "motion/react";
import {
  CaretLeft,
  Compass,
  FolderSimple,
  Gauge,
  GearSix,
  GitBranch,
  Globe,
  PuzzlePiece,
  SlidersHorizontal,
  Sparkle,
  X,
} from "@phosphor-icons/react/ssr";
import { cssEasing, timing, timingMs } from "@/lib/motion-timing";
import { AppSettingsPage } from "@/pages/app-settings";
import { PluginBrowsePage, PluginSourcesPage, PluginsPage } from "@/pages/plugins";
import { CompactPage, DefaultsPage, FoldersPage, GlobalPage, SettingsPage } from "@/pages/settings";
import { cn } from "@/lib/utils";
import { EmbeddedNavContext } from "@/ui/app-link";
import { Button } from "@/ui/button";
import { ListGroup, ListRow } from "@/ui/list";
import { SettingsEmbeddedContext } from "@/ui/page";
import { Pane } from "@/ui/pane";
import { Sheet } from "@/ui/sheet";
import { useCompactViewport } from "@/ui/use-compact-viewport";

export type SettingsSection =
  | "app"
  | "claude"
  | "claude-defaults"
  | "claude-folders"
  | "claude-compact"
  | "claude-global"
  | "plugins"
  | "plugins-browse"
  | "plugins-sources";

interface SectionItem {
  id: SettingsSection;
  label: string;
  icon: React.ComponentType<{ className?: string; weight?: "regular" | "fill" }>;
}

const GROUPS: { title: string; items: SectionItem[] }[] = [
  {
    title: "App",
    items: [
      { id: "app", label: "App 設定", icon: GearSix },
    ],
  },
  {
    title: "Claude",
    items: [
      { id: "claude", label: "帳戶與總覽", icon: SlidersHorizontal },
      { id: "claude-defaults", label: "新對話預設值", icon: Sparkle },
      { id: "claude-folders", label: "專案資料夾", icon: FolderSimple },
      { id: "claude-compact", label: "自動壓縮門檻", icon: Gauge },
      { id: "claude-global", label: "全域 CLAUDE.md", icon: Globe },
    ],
  },
  {
    title: "擴充元件",
    items: [
      { id: "plugins", label: "已安裝", icon: PuzzlePiece },
      { id: "plugins-browse", label: "瀏覽並安裝", icon: Compass },
      { id: "plugins-sources", label: "市集來源", icon: GitBranch },
    ],
  },
];

const HREF_TO_SECTION: Record<string, SettingsSection> = {
  "/app": "app",
  "/settings": "claude",
  "/settings/defaults": "claude-defaults",
  "/settings/folders": "claude-folders",
  "/settings/compact": "claude-compact",
  "/settings/global": "claude-global",
  "/plugins": "plugins",
  "/plugins/browse": "plugins-browse",
  "/plugins/sources": "plugins-sources",
};

export function sectionFromHref(href: string): SettingsSection | null {
  const clean = href.split("?")[0].replace(/\/+$/, "") || "/";
  return HREF_TO_SECTION[clean] ?? null;
}

function SectionBody({ section }: { section: SettingsSection }) {
  switch (section) {
    case "app": return <AppSettingsPage />;
    case "claude": return <SettingsPage />;
    case "claude-defaults": return <DefaultsPage />;
    case "claude-folders": return <FoldersPage />;
    case "claude-compact": return <CompactPage />;
    case "claude-global": return <GlobalPage />;
    case "plugins": return <PluginsPage />;
    case "plugins-browse": return <PluginBrowsePage />;
    case "plugins-sources": return <PluginSourcesPage />;
  }
}

function sectionTitle(section: SettingsSection): string {
  for (const g of GROUPS) {
    const found = g.items.find((it) => it.id === section);
    if (found) return found.label;
  }
  return "設定";
}

const SECTION_ORDER: SettingsSection[] = GROUPS.flatMap((g) => g.items.map((it) => it.id));

function DesktopSectionPane({ section, children }: { section: SettingsSection; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const prevIndex = React.useRef<number | null>(null);

  React.useLayoutEffect(() => {
    const nextIndex = SECTION_ORDER.indexOf(section);
    const prev = prevIndex.current;
    prevIndex.current = nextIndex;
    const el = ref.current;
    if (!el || prev === null || prev === nextIndex) return;
    for (const anim of el.getAnimations({ subtree: true })) {
      if (anim instanceof CSSAnimation && anim.animationName === "content-in") anim.finish();
    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dir = Math.sign(nextIndex - prev);
    const rise = reduced ? 0 : dir * (Number.parseFloat(getComputedStyle(el).getPropertyValue("--motion-rise")) || 10);
    el.animate(
      [{ opacity: 0, translate: `0 ${rise}px` }, { opacity: 1, translate: "0 0" }],
      { duration: timingMs("control"), easing: cssEasing("arrive") },
    );
  }, [section]);

  return <div ref={ref}>{children}</div>;
}

export function SettingsDialog({
  onOpenChange,
  onSectionChange,
  section,
}: {
  onOpenChange: (open: boolean) => void;
  onSectionChange: (section: SettingsSection) => void;
  section: SettingsSection | null;
}) {
  const compact = useCompactViewport();
  const [mobilePicked, setMobilePicked] = React.useState(false);
  const [mobileDirection, setMobileDirection] = React.useState(0);

  React.useEffect(() => {
    if (!section) {
      setMobilePicked(false);
      setMobileDirection(0);
    }
  }, [section]);

  const interceptNav = React.useCallback((href: string) => {
    const target = sectionFromHref(href);
    if (target) {
      setMobileDirection(1);
      onSectionChange(target);
      setMobilePicked(true);
      return true;
    }
    onOpenChange(false);
    return false;
  }, [onOpenChange, onSectionChange]);

  const active = section ?? "app";

  if (compact) {
    return (
      <Sheet
        layout="record"
        onOpenChange={onOpenChange}
        open={section !== null}
        size="screen"
        title={mobilePicked ? (
          <span className="inline-flex items-center gap-1.5">
            <Button
              aria-label="返回設定分類"
              onClick={() => {
                setMobileDirection(-1);
                setMobilePicked(false);
              }}
              size="icon-sm"
              variant="ghost"
            >
              <CaretLeft weight="bold" />
            </Button>
            <span>{sectionTitle(active)}</span>
          </span>
        ) : "設定"}
      >
        <SettingsEmbeddedContext.Provider value>
          <EmbeddedNavContext.Provider value={interceptNav}>
            <Pane direction={mobileDirection} step={mobilePicked ? `detail:${active}` : "index"}>
              {mobilePicked ? (
                <div className="pb-6">
                  <SectionBody section={active} />
                </div>
              ) : (
                <div className="grid gap-5 pb-6">
                  {GROUPS.map((group) => (
                    <ListGroup key={group.title} title={group.title}>
                      {group.items.map(({ icon: Icon, id, label }) => (
                        <ListRow
                          icon={<Icon />}
                          key={id}
                          label={label}
                          onClick={() => {
                            setMobileDirection(1);
                            onSectionChange(id);
                            setMobilePicked(true);
                          }}
                        />
                      ))}
                    </ListGroup>
                  ))}
                </div>
              )}
            </Pane>
          </EmbeddedNavContext.Provider>
        </SettingsEmbeddedContext.Provider>
      </Sheet>
    );
  }

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={section !== null}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="scrim fixed inset-0 z-50 bg-[var(--scrim)]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="dialog-surface fixed left-1/2 top-1/2 z-50 flex h-[min(42rem,calc(100svh-4rem))] w-[min(56rem,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-panel border border-line bg-surface-solid text-ink shadow-float outline-none"
        >
          <DialogPrimitive.Title className="sr-only">設定</DialogPrimitive.Title>
          <nav aria-label="設定分類" className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain border-r border-line bg-surface-raised/60 p-3">
            <div className="px-2.5 pt-1 text-xs font-semibold tracking-wide text-ink-muted">設定</div>
            {GROUPS.map((group) => (
              <div className="grid gap-0.5" key={group.title}>
                <div className="px-2.5 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-ink-faint">{group.title}</div>
                {group.items.map(({ icon: Icon, id, label }) => {
                  const current = active === id;
                  return (
                    <button
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "relative flex h-8.5 items-center gap-2.5 rounded-tile px-2.5 text-left text-sm font-medium outline-none transition-colors duration-[var(--motion-control)] ease-[var(--ease-move)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]",
                        current ? "text-ink" : "text-ink-muted hover:bg-surface-raised hover:text-ink",
                      )}
                      key={id}
                      onClick={() => onSectionChange(id)}
                      type="button"
                    >
                      {current ? (
                        <motion.span
                          aria-hidden
                          className="absolute inset-0 rounded-tile bg-surface-pressed"
                          layoutId="settings-sidebar-pill"
                          transition={timing("control", "move")}
                        />
                      ) : null}
                      <Icon className="relative z-10 size-4 shrink-0" weight={current ? "fill" : "regular"} />
                      <span className="relative z-10 truncate">{label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="relative min-w-0 flex-1 overflow-y-auto overscroll-contain px-7 py-6">
            <Button
              aria-label="關閉設定"
              className="sticky top-0 z-10 float-right -mr-2 -mt-1 rounded-full"
              onClick={() => onOpenChange(false)}
              size="icon-sm"
              variant="ghost"
            >
              <X weight="bold" />
            </Button>
            <SettingsEmbeddedContext.Provider value>
              <EmbeddedNavContext.Provider value={interceptNav}>
                <div className="mx-auto max-w-2xl pb-4">
                  <DesktopSectionPane section={active}>
                    <SectionBody section={active} />
                  </DesktopSectionPane>
                </div>
              </EmbeddedNavContext.Provider>
            </SettingsEmbeddedContext.Provider>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
