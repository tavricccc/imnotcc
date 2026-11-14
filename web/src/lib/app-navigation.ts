// Hash routes, so the server needs no fallback: #/ (sessions), #/s/<id> (chat), #/plugins…,
// #/settings…. A screen deeper in the tree slides in from the right.
import * as React from "react";

const read = () => location.hash.replace(/^#/, "") || "/";

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function usePath() {
  return React.useSyncExternalStore(subscribe, read, () => "/");
}

export function navigate(href: string, { replace = false }: { replace?: boolean } = {}) {
  if (!href.startsWith("/")) return false;
  if (replace) {
    visited[visited.length - 1] = href;
    location.replace(`#${href}`);
  } else location.hash = href;
  return true;
}

// The screens visited in this tab, so Back can step back instead of piling up history.
const visited: string[] = [read()];
window.addEventListener("hashchange", () => {
  const now = read();
  if (visited.at(-1) === now) return;
  if (visited.at(-2) === now) visited.pop();
  else visited.push(now);
});

/** Back to the parent screen: a step back in history when that is where the user came from. */
export function goBack(parent: string) {
  if (visited.at(-2) === parent) history.back();
  else navigate(parent, { replace: true });
}
