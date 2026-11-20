import * as React from "react";
import { auth, get } from "@/lib/api";
import { ARCHIVE_WARN_BYTES, localArchiveStats, slimLocalTranscripts } from "@/lib/local-transcript";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { navigate, usePath } from "@/lib/app-navigation";
import { prefs } from "@/lib/prefs";
import { start, stop } from "@/lib/socket";
import { startShared } from "@/lib/store";
import { startClaudeAuth } from "@/lib/claude-auth";
import { ClaudeLoginWatcher } from "@/components/claude-login";
import { useStore } from "@/lib/store-core";
import { Toaster } from "@/ui/feedback";
import { Lightbox } from "@/components/lightbox";
import { SettingsDialog, type SettingsSection } from "@/components/settings-dialog";
import { Titlebar } from "@/components/titlebar";
import { Pane, useStepDirection } from "@/ui/pane";
import { useCompactViewport } from "@/ui/use-compact-viewport";
import { AppSettingsPage } from "@/pages/app-settings";
import { ChatPage } from "@/pages/chat";
import { LoginPage } from "@/pages/login";
import { NewSessionPage } from "@/pages/new-session";
import type { FirstPrompt } from "@/lib/prompt";
import { PluginBrowsePage, PluginSourcesPage, PluginsPage } from "@/pages/plugins";
import { SessionsPage } from "@/pages/sessions";
import { ContextMenuHost } from "@/ui/context-menu";
import { CompactPage, GlobalPage, DefaultsPage, FoldersPage, SettingsPage } from "@/pages/settings";
import { parseRoute, type Screen } from "./routes";
import { AppShell } from "./shell";

function ScreenView({ onOpenSettings, screen }: { onOpenSettings: () => void; screen: Screen }) {
  switch (screen.name) {
    case "plugins": return <PluginsPage />;
    case "plugin-browse": return <PluginBrowsePage />;
    case "plugin-sources": return <PluginSourcesPage />;
    case "settings": return <SettingsPage />;
    case "settings-defaults": return <DefaultsPage />;
    case "settings-folders": return <FoldersPage />;
    case "settings-compact": return <CompactPage />;
    case "settings-global": return <GlobalPage />;
    case "app-settings": return <AppSettingsPage />;
    default: return <SessionsPage onOpenSettings={onOpenSettings} />;
  }
}

/** On launch: slim what older versions stored, then say so when the archive is still over the limit. */
function StorageWatcher() {
  const [mb, setMb] = React.useState<number | null>(null);
  React.useEffect(() => {
    void (async () => {
      try {
        await slimLocalTranscripts();
        const { bytes } = await localArchiveStats();
        if (bytes > ARCHIVE_WARN_BYTES) setMb(Math.round(bytes / 1048576));
      } catch { /* storage blocked */ }
    })();
  }, []);
  return (
    <ConfirmDialog
      cancelLabel="稍後再說"
      confirmLabel="前往清理"
      description={`這個裝置存了約 ${mb} MB 的對話快取，超過 30 MB。到 App 設定可以清掉舊的或全部。伺服器上的對話不受影響。`}
      onConfirm={() => navigate("/app")}
      onOpenChange={(o) => { if (!o) setMb(null); }}
      open={mb !== null}
      title="本機快取太大了"
    />
  );
}

export function App() {
  const { authed, checked } = useStore(auth);
  const path = usePath();
  const route = parseRoute(path);
  const direction = useStepDirection(path, [route.tabIndex, route.depth]);
  const compact = useCompactViewport();
  const { sessionSidebarCollapsed } = useStore(prefs);
  const [sessionRevision, setSessionRevision] = React.useState(0);
  const [firstPrompt, setFirstPrompt] = React.useState<FirstPrompt>();
  const [settingsSection, setSettingsSection] = React.useState<SettingsSection | null>(null);
  const newSession = route.screen.name === "new-session" ? route.screen : undefined;
  const sessionScreen = route.screen.name === "sessions" || route.screen.name === "chat" || !!newSession;
  const desktopSessions = !compact;
  const sessionId = route.screen.name === "chat" ? route.screen.id : undefined;
  const showDraft = !!newSession || (!compact && route.screen.name === "sessions");
  const toggleSessions = () => prefs.set({ sessionSidebarCollapsed: !sessionSidebarCollapsed });

  React.useEffect(() => {
    get("/api/me").then((r) => auth.set({ authed: r.authed, checked: true })).catch(() => auth.set({ authed: false, checked: true }));
  }, []);
  React.useEffect(() => {
    if (authed) { start(); startShared(); startClaudeAuth(); }
    else stop();
  }, [authed]);
  // A new screen starts at its top; a step back to a list does too, which is what a phone does.
  React.useLayoutEffect(() => { window.scrollTo(0, 0); }, [path]);

  if (!checked) return <Titlebar />;
  if (!authed) return <><Titlebar /><LoginPage /></>;
  const screen = sessionId ? (
    <ChatPage firstPrompt={firstPrompt?.id === sessionId ? firstPrompt : undefined} id={sessionId} key={sessionId} onRename={() => setSessionRevision((revision) => revision + 1)} slideIn={compact && direction > 0} />
  ) : showDraft ? (
    <NewSessionPage cwd={newSession?.cwd} environment={newSession?.environment} key={path} onStarted={(prompt) => {
      setFirstPrompt(prompt);
      navigate(`/s/${prompt.id}`, { replace: !!newSession });
    }} />
  ) : <ScreenView onOpenSettings={() => setSettingsSection("app")} screen={route.screen} />;
  return (
    <>
      <Titlebar sidebar={desktopSessions ? { collapsed: sessionSidebarCollapsed, toggle: toggleSessions } : undefined} />
      <ClaudeLoginWatcher />
      <ContextMenuHost />
      <StorageWatcher />
      <AppShell bare={!!sessionId || showDraft} sessions={desktopSessions ? {
        collapsed: sessionSidebarCollapsed,
        content: <SessionsPage activeId={sessionId} onOpenSettings={() => setSettingsSection("app")} onToggleSidebar={toggleSessions} revision={sessionRevision} sidebar />,
        toggle: toggleSessions,
      } : undefined}>
        {sessionId ? screen : (
          <Pane direction={sessionScreen && !compact ? 0 : direction} step={sessionScreen && !compact ? "session-workspace" : path}>{screen}</Pane>
        )}
      </AppShell>
      <SettingsDialog
        onOpenChange={(open) => { if (!open) setSettingsSection(null); }}
        onSectionChange={setSettingsSection}
        section={settingsSection}
      />
      <Toaster />
      <Lightbox />
    </>
  );
}
