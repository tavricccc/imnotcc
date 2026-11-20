// What a turn changed, as git sees it: the working tree is snapshotted (tracked and untracked
// files, minus ignored ones) when a turn starts and again when it ends, and the two trees are
// diffed. It counts edits made any way, not only through the Edit tool. Folders outside a git
// repository have no snapshot, so their turns show no changes card.
//
// A snapshot is `git add -A` into a scratch index followed by `git write-tree`, the way
// `git stash create` works: it adds loose objects to the repository, which git's own gc clears
// once nothing points at them, and leaves the real index and the branch untouched.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as wsl from './wsl.js';

const DISTRO = process.env.IMNOTCC_WSL_DISTRO || 'Ubuntu';

function git(cwd, args, env = {}) {
  const base = ['-c', 'core.quotepath=false', ...args];
  const [file, argv, options] = wsl.isWsl(cwd)
    ? ['wsl.exe', ['-d', DISTRO, '--cd', cwd, '-e', 'env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), 'git', ...base], {}]
    : ['git', base, { cwd, env: { ...process.env, ...env } }];
  return new Promise((resolve, reject) => {
    execFile(file, argv, { ...options, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

// A path git printed, relative to `cwd` or absolute, as this server can open it.
function hostPath(cwd, p) {
  if (wsl.isWsl(cwd)) return wsl.hostPath(path.posix.resolve(cwd, p));
  return path.resolve(cwd, p);
}

/** The working tree as a tree id, or null when the folder is not in a git repository. */
export async function snapshot(cwd) {
  let scratch;
  const scratchName = `imnotcc-index-${crypto.randomUUID()}`;
  try {
    const [index, scratchPath, top] = (await git(cwd, ['rev-parse', '--git-path', 'index', '--git-path', scratchName, '--show-toplevel'])).trim().split(/\r?\n/);
    scratch = scratchPath;
    // Starting from the real index keeps git's stat cache, so unchanged files are not hashed again.
    try { fs.copyFileSync(hostPath(cwd, index), hostPath(cwd, scratch)); } catch { /* a repository with no index yet */ }
    const env = { GIT_INDEX_FILE: absolute(cwd, scratch) };
    await git(top, ['add', '-A'], env);
    return { top, tree: (await git(top, ['write-tree'], env)).trim() };
  } catch {
    return null;
  } finally {
    if (scratch) {
      const target = hostPath(cwd, scratch);
      fs.rm(target, { force: true }, () => {});
      fs.rm(`${target}.lock`, { force: true }, () => {});
    }
  }
}

const absolute = (cwd, p) => (wsl.isWsl(cwd) ? path.posix.resolve(cwd, p) : path.resolve(cwd, p));

/** Files that differ between two snapshots, with lines added and removed (null for binary files). */
export async function diff(before, after) {
  if (!before || !after || before.tree === after.tree) return [];
  const out = await git(before.top, ['diff', '--no-renames', '--numstat', before.tree, after.tree]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [added, removed, ...rest] = line.split('\t');
    const binary = added === '-';
    return { path: rest.join('\t'), added: binary ? null : Number(added), removed: binary ? null : Number(removed) };
  });
}

/** One file's change between two tree ids, as a unified diff ('' when git sees it as binary). */
export async function patch({ top, before, after }, file) {
  const out = await git(top, ['diff', '--no-renames', '--no-color', '--no-ext-diff', '-U3', before, after, '--', file]);
  return /^Binary files /m.test(out) ? '' : out;
}
