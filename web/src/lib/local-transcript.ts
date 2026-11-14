import { isSkillContext, type Item, type Transcript } from "./transcript";

const openDb = (name: string, create: boolean): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => { if (create || !request.result.objectStoreNames.contains("sessions")) request.result.createObjectStore("sessions"); };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

/** Copy what the app kept under its old name (cc-remote) into the new database, then drop the old one. */
async function carryOver(db: IDBDatabase) {
  const names = await indexedDB.databases?.().catch(() => []) ?? [];
  if (!names.some((d) => d.name === "cc-remote-transcripts")) return;
  const old = await openDb("cc-remote-transcripts", false);
  const rows = await new Promise<{ key: IDBValidKey; value: unknown }[]>((resolve, reject) => {
    const out: { key: IDBValidKey; value: unknown }[] = [];
    const cursor = old.transaction("sessions").objectStore("sessions").openCursor();
    cursor.onsuccess = () => { const c = cursor.result; if (!c) return resolve(out); out.push({ key: c.key, value: c.value }); c.continue(); };
    cursor.onerror = () => reject(cursor.error);
  });
  old.close();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");
    for (const r of rows) store.put(r.value, r.key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  indexedDB.deleteDatabase("cc-remote-transcripts");
}

// Callers close what they open, so each call opens afresh; the carry-over runs once per page.
let carried: Promise<void> | undefined;
async function openArchive(): Promise<IDBDatabase> {
  const db = await openDb("imnotcc-transcripts", true);
  carried ??= carryOver(db).catch(() => {});
  await carried;
  return db;
}

const CLIP = 50;
const clip = (v: unknown) => (typeof v === "string" && v.length > CLIP ? v.slice(0, CLIP) : v);

/** What the archive keeps of a row: which tool ran and the first 50 characters of its string inputs. No tool output, no images. */
export function slimItem(item: Item): Item {
  if (item.type === "tool") {
    const input = Object.fromEntries(Object.entries(item.input ?? {}).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, clip(v)]));
    const { images: _images, image: _image, ...rest } = item;
    return { ...rest, input, result: item.done ? "" : null };
  }
  if (item.image || item.images) {
    const { images: _images, image: _image, ...rest } = item;
    return { ...rest, text: rest.text ?? "[圖片]" };
  }
  return item;
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

export interface ArchiveStats { bytes: number; sessions: { id: string; bytes: number; lastAt: number }[] }

/** Roughly how much the archive holds (JSON length), per session, with when each last had activity. */
export async function localArchiveStats(): Promise<ArchiveStats> {
  const db = await openArchive();
  try {
    return await new Promise((resolve, reject) => {
      const sessions: ArchiveStats["sessions"] = [];
      const cursor = db.transaction("sessions").objectStore("sessions").openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return resolve({ bytes: sessions.reduce((n, x) => n + x.bytes, 0), sessions });
        const items = c.value as Item[];
        const lastAt = items.reduce((m, i) => Math.max(m, i.endAt ?? i.at ?? 0), 0);
        sessions.push({ id: String(c.key), bytes: JSON.stringify(items).length, lastAt });
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
  } finally {
    db.close();
  }
}

export async function clearLocalTranscripts() {
  const db = await openArchive();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").clear();
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Rewrite every stored session in the slim form (older archives kept tool output and images). */
export async function slimLocalTranscripts() {
  const db = await openArchive();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      const store = tx.objectStore("sessions");
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        c.update((c.value as Item[]).map(slimItem));
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const ARCHIVE_WARN_BYTES = 30 * 1024 * 1024;

export const removeLocalTranscript = (id: string) => removeLocalTranscripts([id]);

export function saveLocalTranscript(id: string, items: Item[]) {
  if (!items.length) return Promise.resolve();
  const snapshot = structuredClone(items);
  return accessArchive(id, (previous, store) => { store.put(mergeTranscript(previous, snapshot).map(slimItem), id); });
}
