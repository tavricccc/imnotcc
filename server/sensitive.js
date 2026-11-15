// Paths the file browser, previews, downloads and search never touch: keys, credentials, browser
// profiles and this app's own data. Checked on the real path (symlinks resolved) as the host sees it.
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const home = os.homedir();
const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

// Whole folders, anywhere under them.
const DIRS = [
  path.join(home, '.ssh'), path.join(home, '.aws'), path.join(home, '.gnupg'), path.join(home, '.azure'),
  path.join(home, '.kube'), path.join(home, '.docker'), path.join(home, '.config', 'gcloud'),
  DATA_DIR,
  // Browser profiles: cookies, saved passwords.
  path.join(local, 'Google', 'Chrome', 'User Data'), path.join(local, 'Microsoft', 'Edge', 'User Data'),
  path.join(local, 'BraveSoftware'), path.join(roaming, 'Mozilla', 'Firefox'), path.join(roaming, 'Opera Software'),
  // Windows credential stores.
  path.join(local, 'Microsoft', 'Credentials'), path.join(roaming, 'Microsoft', 'Credentials'),
  path.join(roaming, 'Microsoft', 'Protect'), path.join(local, 'Microsoft', 'Vault'), path.join(roaming, 'Microsoft', 'Vault'),
].map(norm);

// Single files by their full path.
const FILES = [
  path.join(home, '.claude', '.credentials.json'), path.join(home, '.claude.json'),
  path.join(home, '.npmrc'), path.join(home, '.netrc'), path.join(home, '.git-credentials'), path.join(home, '.pypirc'),
].map(norm);

// Any file with one of these names, wherever it is.
const NAMES = [
  /^\.env(\..+)?$/i, /\.(pem|key|p12|pfx|keystore|jks|ppk|kdbx)$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.credentials\.json$/i, /^credentials(\.json)?$/i,
];
// .env.example and friends are templates, not secrets.
const TEMPLATE = /^\.env\.(example|sample|template|dist)$/i;

// A WSL path seen through \\wsl.localhost\<distro>: its Linux home folders count as home too.
const wslHomeRel = (n) => n.match(/^\/\/wsl(?:\.localhost|\$)\/[^/]+\/(?:home\/[^/]+|root)(\/.*)?$/)?.[1] ?? null;
const WSL_DIRS = ['/.ssh', '/.aws', '/.gnupg', '/.azure', '/.kube', '/.docker', '/.config/gcloud'];
const WSL_FILES = ['/.claude/.credentials.json', '/.claude.json', '/.npmrc', '/.netrc', '/.git-credentials', '/.pypirc'];

const under = (n, dir) => n === dir || n.startsWith(dir + '/');

/** Whether a host path (best resolved through realpath first) is off limits. */
export function isSensitive(p) {
  if (typeof p !== 'string' || !p) return false;
  const n = norm(p);
  if (DIRS.some((d) => under(n, d)) || FILES.includes(n)) return true;
  const rel = wslHomeRel(n);
  if (rel !== null && (WSL_DIRS.some((d) => under(rel, d)) || WSL_FILES.includes(rel))) return true;
  const name = n.slice(n.lastIndexOf('/') + 1);
  return !TEMPLATE.test(name) && NAMES.some((r) => r.test(name));
}

/**
 * rg glob arguments that keep the same names out of a search (only exclusions: a positive glob
 * would narrow rg to those files). Results are checked with isSensitive afterwards as well.
 */
export const RG_EXCLUDES = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks', '*.ppk', '*.kdbx', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '.credentials.json', 'credentials', 'credentials.json']
  .flatMap((g) => ['--glob', `!${g}`]);
