import { isSkillContext, type Item, type Transcript } from "./transcript";

function openArchive(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("cc-remote-transcripts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sessions");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Reconcile the shared rows, retaining history that compact or pagination omitted. */
export function mergeTranscript(older: Item[], incoming: Item[], prepend = false): Item[] {
  const known = new Map(older.map((item, index) => [item.key, index]));
  const insertions = new Map<number, Item[]>();
  const rows = [...older];
  let pending: Item[] = [];
  let hasOverlap = false;
  for (const item of incoming) {
    const index = known.get(item.key);
    if (index === undefined) {
      pending.push(item);
      continue;
    }
    if (pending.length) {
      insertions.set(index, [...(insertions.get(index) ?? []), ...pending]);
      pending = [];
    }
    const previous = rows[index];
    rows[index] = previous.type === "tool" && previous.done && !item.done
      ? { ...previous, responseId: item.responseId ?? previous.responseId }
      : item;
    hasOverlap = true;
  }
  if (pending.length) {
    const index = prepend && !hasOverlap ? 0 : rows.length;
    insertions.set(index, [...(insertions.get(index) ?? []), ...pending]);
  }
  return [...rows.flatMap((item, index) => [...(insertions.get(index) ?? []), item]), ...(insertions.get(rows.length) ?? [])];
}

export function restoreTranscript(transcript: Transcript, items: Item[]) {
  transcript.items = items;
  transcript.tools.clear();
  for (const item of items) {
    if (item.type === "tool" && item.id) transcript.tools.set(item.id, item);
    const uuid = item.key.match(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?=$|-)/i)?.[0];
    if (uuid) transcript.seen.add(uuid);
  }
}

async function accessArchive(id: string, update?: (items: Item[], store: IDBObjectStore) => void): Promise<Item[]> {
  const db = await openArchive();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("sessions", update ? "readwrite" : "readonly");
      const store = transaction.objectStore("sessions");
      const read = store.get(id);
      let items: Item[] = [];
      read.onsuccess = () => {
        items = read.result ?? [];
        update?.(items, store);
      };
      transaction.oncomplete = () => resolve(items);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function readLocalTranscript(id: string) {
  const items = await accessArchive(id);
  // Older archives stored the rendered bubble without the SDK's synthetic flag.
  return items.filter((item, index) => {
    const previous = items[index - 1];
    return !(item.type === "user" && item.text && isSkillContext(item.text)
      && previous?.type === "tool" && previous.name === "Skill" && previous.done && !previous.error);
  });
}

export async function removeLocalTranscripts(ids: string[]) {
  if (!ids.length) return;
  const db = await openArchive();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("sessions", "readwrite");
      const store = transaction.objectStore("sessions");
      for (const id of ids) store.delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export const removeLocalTranscript = (id: string) => removeLocalTranscripts([id]);

export function saveLocalTranscript(id: string, items: Item[]) {
  if (!items.length) return Promise.resolve();
  const snapshot = structuredClone(items);
  return accessArchive(id, (previous, store) => { store.put(mergeTranscript(previous, snapshot), id); });
}
