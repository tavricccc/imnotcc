// Claude Code's own settings that the app shows: each model's auto-compact window. Changing one
// sends `/autocompact <size>` in a throwaway session of that model, exactly as typing it in the
// CLI would, so Claude Code writes settings.json itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const SETTINGS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const SIZE = /^\d{2,4}k$|^\d{5,7}$/i;
const MODEL = /^[\w.\-[\]]+$/;

function readModelSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).modelSettings ?? {}; } catch { return {}; }
}

async function runCommand(model, text) {
  let reply = '';
  const q = query({ prompt: text, options: { model, cwd: os.homedir(), persistSession: false, maxTurns: 1 } });
  for await (const m of q) if (m.type === 'result') reply = m.result ?? m.subtype;
  return reply;
}

export function claudeSettingsRoutes(app, wrap) {
  app.get('/api/compact-windows', (_req, res) => {
    const windows = Object.entries(readModelSettings())
      .map(([model, v]) => ({ model, window: v?.autoCompactWindow ?? null }));
    res.json({ windows });
  });

  app.post('/api/compact-windows', wrap(async (req, res) => {
    const model = String(req.body?.model ?? '');
    const size = String(req.body?.size ?? '').trim();
    if (!MODEL.test(model) || !SIZE.test(size)) return res.status(400).json({ error: '格式不對，例如 400k。' });
    const reply = await runCommand(model, `/autocompact ${size}`);
    const window = readModelSettings()[model]?.autoCompactWindow ?? null;
    res.json({ reply, window });
  }));
}
