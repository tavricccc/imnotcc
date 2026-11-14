// The only data this server keeps: which sessions imnotcc made, the folder list, app settings
// and the login secret. Everything else (history, titles) is read from Claude Code's own files.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'state.json');

const DEFAULTS = {
  sessions: {}, // id -> { cwd, createdAt, temporary?, permissionMode?, model?, effort? }
  folders: [],
  settings: { permissionMode: 'default', model: null, effort: null, folder: null, idleMinutes: 30 },
  auth: null, // { salt, hash, secret }
  push: null, // { vapid: { publicKey, privateKey }, subs: [PushSubscription JSON] }
};

let state;

export function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  state = { ...structuredClone(DEFAULTS), ...saved, settings: { ...DEFAULTS.settings, ...saved.settings } };
  return state;
}

export function get() { return state ?? load(); }

// Written to a temp file and renamed, so a crash mid-write never leaves half a file.
export function save() {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
