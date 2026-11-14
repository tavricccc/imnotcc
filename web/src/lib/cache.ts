// Shared for the lifetime of the signed-in tab. Reads retain the last successful value
// while revalidating, and a confirmed write supersedes any earlier request.
import * as React from "react";

const values = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
const MAX_ENTRIES = 150;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function cached<T>(key: string): T | null {
  return (values.get(key) as T | undefined) ?? null;
}

export function setCached<T>(key: string, value: T) {
  inflight.delete(key);
  values.delete(key);
  values.set(key, value);
  if (values.size > MAX_ENTRIES) values.delete(values.keys().next().value!);
  for (const listener of listeners) listener();
}

export function clearCache(prefix = "") {
  for (const key of inflight.keys()) if (key.startsWith(prefix)) inflight.delete(key);
  for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
  for (const listener of listeners) listener();
}

export function refreshCached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const request = Promise.resolve().then(load).then((value) => {
    if (inflight.get(key) === request) setCached(key, value);
    return cached<T>(key) ?? value;
  }).finally(() => {
    if (inflight.get(key) === request) inflight.delete(key);
  });
  inflight.set(key, request);
  return request;
}

export function useCached<T>(key: string, load: () => Promise<T>, enabled = true, delay = 0) {
  const data = React.useSyncExternalStore(subscribe, () => cached<T>(key));
  const [failure, setFailure] = React.useState<{ key: string; message: string }>();
  const loader = React.useMemo(() => ({ current: load }), [key]);
  loader.current = load;

  const setData = React.useCallback((value: T) => setCached(key, value), [key]);
  const reload = React.useCallback(async () => {
    const read = loader.current;
    setFailure(undefined);
    try { await refreshCached(key, read); }
    catch (e) { setFailure({ key, message: (e as Error).message }); }
  }, [key, loader]);

  React.useEffect(() => {
    if (!enabled) return;
    if (!delay) { void reload(); return; }
    const timer = setTimeout(reload, delay);
    return () => clearTimeout(timer);
  }, [delay, enabled, reload]);

  return { data, error: data === null && failure?.key === key ? failure.message : "", reload, setData };
}
