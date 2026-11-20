// WSL sessions: a folder given as a Linux path ("/home/...") runs Claude Code inside WSL, with
// WSL's own settings and login. This server stays on Windows and reaches WSL's files through
// //wsl.localhost/<distro>.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const DISTRO = process.env.IMNOTCC_WSL_DISTRO || 'Ubuntu';
const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
let home; // WSL's $HOME, read once; null when WSL is not there

// The CLI binary bundled inside @anthropic-ai/claude-agent-sdk for this OS, falling back to PATH.
let exe;
export function claudeExe() {
  if (exe !== undefined) return exe;
  const require = createRequire(import.meta.url);
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const suffix of ['', '-musl']) {
    try {
      const dir = path.dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/package.json`));
      if (fs.existsSync(path.join(dir, name))) return (exe = path.join(dir, name));
    } catch { /* not installed for this platform */ }
  }
  return (exe = 'claude');
}

export const isWsl = (cwd) => process.platform === 'win32' && typeof cwd === 'string' && cwd.startsWith('/');
export const available = () => wslHome() !== null;
export const homeDir = () => wslHome();
// A Linux path as Windows can open it.
export const hostPath = (p) => `//wsl.localhost/${DISTRO}${path.posix.resolve(p)}`;

function wslHome() {
  if (home !== undefined) return home;
  if (process.platform !== 'win32') return (home = null);
  try {
    home = execFileSync('wsl.exe', ['-d', DISTRO, '-e', 'sh', '-c', 'echo $HOME'], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim() || null;
  } catch { home = null; }
  return home;
}

const APP_DIR = path.resolve(import.meta.dirname, '..');
const versionOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return null; } };

// The Linux build of Claude Code that is installed next to the Windows one (`linux/` in the app
// folder), as WSL sees its path. Used only when it is the same version as the SDK, so both
// environments run the same Claude Code. Without it WSL falls back to its own `claude`.
let bundled;
function bundledClaude() {
  if (bundled !== undefined) return bundled;
  bundled = null;
  const dir = path.join(APP_DIR, 'linux', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64');
  const sdk = versionOf(path.join(APP_DIR, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'));
  const drive = /^([A-Za-z]):[\\/]/.exec(dir);
  if (process.platform === 'win32' && drive && sdk && versionOf(dir) === sdk && fs.existsSync(path.join(dir, 'claude'))) {
    bundled = `/mnt/${drive[1].toLowerCase()}/${dir.slice(3).replaceAll('\\', '/')}/claude`;
  }
  return bundled;
}

// Runs `claude` inside WSL through a login shell so its PATH applies.
const shellArgs = (args) => ['-d', DISTRO, '-e', 'bash', '-lc', 'exec "${CLAUDE_BIN:-claude}" "$@"', 'claude', ...args];
const shellEnv = () => {
  const bin = bundledClaude();
  return bin ? { ...process.env, CLAUDE_BIN: bin, WSLENV: [process.env.WSLENV, 'CLAUDE_BIN'].filter(Boolean).join(':') } : process.env;
};

// Query options that start Claude Code inside WSL.
// Windows sessions get the environment without a CLAUDE_CONFIG_DIR that a WSL read may have set
// at that moment.
export function spawnOptions(cwd) {
  if (!isWsl(cwd)) {
    const env = { ...process.env };
    if (ORIGINAL_CONFIG_DIR === undefined) delete env.CLAUDE_CONFIG_DIR; else env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
    return { env };
  }
  return {
    spawnClaudeCodeProcess: (o) => spawn('wsl.exe', ['-d', DISTRO, '--cd', cwd, ...shellArgs(o.args).slice(2)],
      { env: shellEnv(), stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, windowsHide: true }),
  };
}

// wsl.exe arguments that run the claude CLI inside WSL with `args`; pass `wslEnv` as the child's env.
export const cliArgs = (args) => shellArgs(args);
export const cliEnv = shellEnv;

// The SDK's transcript readers find Claude Code's files through CLAUDE_CONFIG_DIR, which is one
// value for the whole process. Reads of the same environment run concurrently, while Windows and
// WSL reads take turns so CLAUDE_CONFIG_DIR stays consistent for every active reader.
let activeMode = null; // 'win' | 'wsl' | null
let activeCount = 0;
const waiters = { win: [], wsl: [] };

function applyEnv(mode) {
  if (mode === 'wsl') {
    process.env.CLAUDE_CONFIG_DIR = hostPath(`${wslHome()}/.claude`);
  } else if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  }
}

export async function readFor(cwd, fn) {
  const mode = isWsl(cwd) ? 'wsl' : 'win';
  if (mode === 'wsl' && !wslHome()) throw new Error('找不到 WSL。');
  const other = mode === 'wsl' ? 'win' : 'wsl';
  if (activeMode === null || (activeMode === mode && waiters[other].length === 0)) {
    if (activeCount === 0) {
      activeMode = mode;
      applyEnv(mode);
    }
    activeCount++;
  } else {
    await new Promise((resolve) => waiters[mode].push(resolve));
  }
  try {
    return await fn();
  } finally {
    activeCount--;
    if (activeCount === 0) {
      const next = waiters[other].length > 0 ? other : waiters[mode].length > 0 ? mode : null;
      if (next) {
        activeMode = next;
        applyEnv(next);
        const batch = waiters[next].splice(0);
        activeCount = batch.length;
        for (const resolve of batch) resolve();
      } else {
        activeMode = null;
        applyEnv('win');
      }
    }
  }
}
