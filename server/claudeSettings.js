// Claude Code's own settings that the app shows: each model's auto-compact window, for Windows
// and, when WSL is installed, for WSL separately (each has its own settings.json). Changing one
// sends `/autocompact <size>` in a throwaway session of that model in that environment, exactly
// as typing it in the CLI would, so Claude Code writes settings.json itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as wsl from './wsl.js';

const WIN_SETTINGS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const SIZE = /^\d{2,4}k$|^\d{5,7}$/i;
const MODEL = /^[\w.\-[\]]+$/;

const envs = () => (wsl.available() ? ['win', 'wsl'] : ['win']);
const mdFile = (env) => path.join(path.dirname(settingsFile(env)), 'CLAUDE.md');
const settingsFile = (env) => (env === 'wsl' ? wsl.hostPath(`${wsl.homeDir()}/.claude/settings.json`) : WIN_SETTINGS);

function readModelSettings(env) {
  try { return JSON.parse(fs.readFileSync(settingsFile(env), 'utf8')).modelSettings ?? {}; } catch { return {}; }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.imnotcc.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function runCommand(env, model, text) {
  const cwd = env === 'wsl' ? wsl.homeDir() : os.homedir();
  let reply = '';
  const q = query({ prompt: text, options: { model, cwd, persistSession: false, maxTurns: 1, ...wsl.spawnOptions(cwd) } });
  try {
    for await (const m of q) if (m.type === 'result') reply = m.result ?? m.subtype;
    return reply;
  } finally {
    q.close();
  }
}

export function claudeSettingsRoutes(app, wrap) {
  app.get('/api/compact-windows', (_req, res) => {
    const windows = envs().flatMap((env) => Object.entries(readModelSettings(env))
      .map(([model, v]) => ({ env, model, window: v?.autoCompactWindow ?? null })));
    res.json({ envs: envs(), windows });
  });

  app.post('/api/compact-windows', wrap(async (req, res) => {
    const env = String(req.body?.env ?? 'win');
    const model = String(req.body?.model ?? '');
    const size = String(req.body?.size ?? '').trim();
    if (!envs().includes(env)) return res.status(400).json({ error: env === 'wsl' ? '找不到 WSL。' : '環境不對。' });
    if (!MODEL.test(model) || !SIZE.test(size)) return res.status(400).json({ error: '格式不對，例如 400k。' });
    const reply = await runCommand(env, model, `/autocompact ${size}`);
    const window = readModelSettings(env)[model]?.autoCompactWindow ?? null;
    res.json({ reply, window });
  }));

  app.get('/api/claude-global', (_req, res) => {
    const read = (env) => { try { return fs.readFileSync(mdFile(env), 'utf8'); } catch { return ''; } };
    res.json({
      envs: envs(),
      claudeMd: Object.fromEntries(envs().map((env) => [env, read(env)])),
    });
  });

  app.put('/api/claude-md', wrap(async (req, res) => {
    const env = String(req.body?.env ?? 'win');
    if (!envs().includes(env)) return res.status(400).json({ error: '環境不對。' });
    if (typeof req.body?.text !== 'string' || req.body.text.length > 200_000) return res.status(400).json({ error: '內容不對或太長。' });
    writeAtomic(mdFile(env), req.body.text);
    res.json({ ok: true });
  }));

}
