// Every screen, by its hash path. `tab` is its place in the dock and `depth` how far below the
// tab's own screen it sits: together they say which way a change of screen slides.
export type Screen =
  | { name: "sessions" }
  | { name: "new-session"; cwd?: string; environment?: "win" | "wsl" }
  | { name: "chat"; id: string }
  | { name: "plugins" }
  | { name: "plugin-browse" }
  | { name: "plugin-sources" }
  | { name: "settings" }
  | { name: "settings-defaults" }
  | { name: "settings-folders" }
  | { name: "settings-compact" };

export interface Route { screen: Screen; tab: string; tabIndex: number; depth: number }

const TABS = ["/", "/plugins", "/settings"];

export function parseRoute(path: string): Route {
  const at = (screen: Screen, tab: string, depth: number): Route => ({ depth, screen, tab, tabIndex: TABS.indexOf(tab) });
  const chat = path.match(/^\/s\/([\w-]+)/);
  if (chat) return at({ id: chat[1], name: "chat" }, "/", 1);
  const [pathname, query] = path.split("?");
  if (pathname === "/new") {
    const params = new URLSearchParams(query);
    const environment = params.get("env");
    return at({
      name: "new-session",
      cwd: params.get("cwd") || undefined,
      environment: environment === "win" || environment === "wsl" ? environment : undefined,
    }, "/", 1);
  }
  switch (path.replace(/\/+$/, "") || "/") {
    case "/plugins": return at({ name: "plugins" }, "/plugins", 0);
    case "/plugins/browse": return at({ name: "plugin-browse" }, "/plugins", 1);
    case "/plugins/sources": return at({ name: "plugin-sources" }, "/plugins", 1);
    case "/settings": return at({ name: "settings" }, "/settings", 0);
    case "/settings/defaults": return at({ name: "settings-defaults" }, "/settings", 1);
    case "/settings/folders": return at({ name: "settings-folders" }, "/settings", 1);
    case "/settings/compact": return at({ name: "settings-compact" }, "/settings", 1);
    default: return at({ name: "sessions" }, "/", 0);
  }
}
