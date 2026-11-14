import * as React from "react";

/** A tiny observable value for state shared across screens. */
export function createStore<T extends object>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(patch: Partial<T> | ((v: T) => Partial<T>)) {
      value = { ...value, ...(typeof patch === "function" ? patch(value) : patch) };
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export type Store<T extends object> = ReturnType<typeof createStore<T>>;

export function useStore<T extends object>(store: Store<T>) {
  return React.useSyncExternalStore(store.subscribe, store.get, store.get);
}
