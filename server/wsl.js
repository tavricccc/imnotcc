// WSL sessions: a folder given as a Linux path ("/home/...") runs Claude Code inside WSL, with
// WSL's own settings and login. This server stays on Windows and reaches WSL's files through
// //wsl.localhost/<distro>.
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

const DISTRO = process.env.IMNOTCC_WSL_DISTRO || 'Ubuntu';
const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
let home; // WSL's $HOME, read once; null when WSL is not there

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

// Query options that start Claude Code inside WSL, through a login shell so its PATH applies.
// Windows sessions get the environment without a CLAUDE_CONFIG_DIR that a WSL read may have set
// at that moment.
export function spawnOptions(cwd) {
  if (!isWsl(cwd)) {
    const env = { ...process.env };
    if (ORIGINAL_CONFIG_DIR === undefined) delete env.CLAUDE_CONFIG_DIR; else env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
    return { env };
  }
  return {
    spawnClaudeCodeProcess: (o) => spawn('wsl.exe', ['-d', DISTRO, '--cd', cwd, '-e', 'bash', '-lc', 'exec claude "$@"', 'claude', ...o.args],
      { stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, windowsHide: true }),
  };
}

// wsl.exe arguments that run the claude CLI inside WSL with `args`.
export const cliArgs = (args) => ['-d', DISTRO, '-e', 'bash', '-lc', 'exec claude "$@"', 'claude', ...args];

// The SDK's transcript readers find Claude Code's files through CLAUDE_CONFIG_DIR, which is one
// value for the whole process, so every read goes through this queue with the right value set.
let chain = Promise.resolve();
export function readFor(cwd, fn) {
  const run = chain.then(async () => {
    if (isWsl(cwd)) {
      if (!wslHome()) throw new Error('找不到 WSL。');
      process.env.CLAUDE_CONFIG_DIR = hostPath(`${wslHome()}/.claude`);
    }
    try { return await fn(); } finally {
      if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
    }
  });
  chain = run.catch(() => {});
  return run;
}
