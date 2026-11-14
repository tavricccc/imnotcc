import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.CC_REMOTE_DATA_DIR || path.join(ROOT, 'data'));
export const DIST_DIR = path.join(ROOT, 'dist');
export const PORT = Number(process.env.CC_REMOTE_PORT || 4280);
export const DEV = process.env.CC_REMOTE_DEV === '1';

// Origins allowed besides the request's own host: the public address (CC_REMOTE_ORIGINS, comma
// separated) and, while developing, the Vite dev server.
export const ALLOWED_ORIGINS = new Set([
  ...(process.env.CC_REMOTE_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
  ...(DEV ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []),
]);
