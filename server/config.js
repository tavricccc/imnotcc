import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Settings come from IMNOTCC_* variables; the CC_REMOTE_* names from before the rename still work.
for (const [k, v] of Object.entries(process.env)) if (k.startsWith('CC_REMOTE_') && v !== undefined) process.env['IMNOTCC_' + k.slice(10)] ??= v;
export const DATA_DIR = path.resolve(process.env.IMNOTCC_DATA_DIR || path.join(ROOT, 'data'));
export const DIST_DIR = path.join(ROOT, 'dist');
export const PORT = Number(process.env.IMNOTCC_PORT || 4280);
export const DEV = process.env.IMNOTCC_DEV === '1';

// Origins allowed besides the request's own host: the public address (IMNOTCC_ORIGINS, comma
// separated) and, while developing, the Vite dev server.
export const ALLOWED_ORIGINS = new Set([
  ...(process.env.IMNOTCC_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
  ...(DEV ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []),
]);
