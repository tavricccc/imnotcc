import * as React from "react";
import { auth, get } from "@/lib/api";
import { navigate, usePath } from "@/lib/app-navigation";
import { prefs } from "@/lib/prefs";
import { start } from "@/lib/socket";
import { startShared } from "@/lib/store";
import { startClaudeAuth } from "@/lib/claude-auth";
import { ClaudeLoginWatcher } from "@/components/claude-login";
import { useStore } from "@/lib/store-core";
import { Toaster } from "@/ui/feedback";
import { Lightbox } from "@/components/lightbox";
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
import { CompactPage, GlobalPage, DefaultsPage, FoldersPage, SettingsPage } from "@/pages/settings";
import { parseRoute, type Screen } from "./routes";
import { AppShell } from "./shell";

function ScreenView({ screen }: { screen: Screen }) {
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
    default: return <SessionsPage />;
  }
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
  const newSession = route.screen.name === "new-session" ? route.screen : undefined;
  const sessionScreen = route.screen.name === "sessions" || route.screen.name === "chat" || !!newSession;
  const desktopSessions = !compact && sessionScreen;
  const sessionId = route.screen.name === "chat" ? route.screen.id : undefined;
  const showDraft = !!newSession || (desktopSessions && !sessionId);
  const toggleSessions = () => prefs.set({ sessionSidebarCollapsed: !sessionSidebarCollapsed });

  React.useEffect(() => {
    get("/api/me").then((r) => auth.set({ authed: r.authed, checked: true })).catch(() => auth.set({ authed: false, checked: true }));
  }, []);
  React.useEffect(() => {
    if (authed) { start(); startShared(); startClaudeAuth(); }
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
  ) : <ScreenView screen={route.screen} />;
  return (
    <>
      <Titlebar />
      <ClaudeLoginWatcher />
      <AppShell active={route.tab} bare={!!sessionId || showDraft} dock={route.depth === 0} sessions={desktopSessions ? {
        collapsed: sessionSidebarCollapsed,
        content: <SessionsPage activeId={sessionId} revision={sessionRevision} sidebar />,
        toggle: toggleSessions,
      } : undefined}>
        {sessionId ? screen : (
          <Pane direction={desktopSessions ? 0 : direction} step={desktopSessions ? "session-workspace" : path}>{screen}</Pane>
        )}
      </AppShell>
      <Toaster />
      <Lightbox />
    </>
  );
}
