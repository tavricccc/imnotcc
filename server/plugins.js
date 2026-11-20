// Plugins are managed by the Claude Code CLI itself: this only runs `claude plugin ...` and
// passes its output back. A running session picks changes up the next time it starts.
import { execFile } from 'node:child_process';
import * as wsl from './wsl.js';

const NAME = /^[\w.@\-/:]+$/; // plugin ids, marketplace names, owner/repo, URLs, paths without spaces
const SOURCE = /^[^\s"'`;&|<>]+$/;

const envs = () => (wsl.available() ? ['win', 'wsl'] : ['win']);
const pickEnv = (raw) => (raw === 'wsl' && wsl.available() ? 'wsl' : 'win');

function claude(env, args, timeout = 180_000) {
  const [file, argv, extra] = env === 'wsl'
    ? ['wsl.exe', wsl.cliArgs(args), { env: wsl.cliEnv() }]
    : [wsl.claudeExe(), args, { env: wsl.spawnOptions(process.cwd()).env }];
  return new Promise((resolve) => {
    execFile(file, argv, { ...extra, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function parseJson(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

const availableCache = {
  win: { at: 0, list: [] },
  wsl: { at: 0, list: [] },
};

export function pluginRoutes(app, wrap) {
  app.get('/api/plugins', wrap(async (req, res) => {
    const env = pickEnv(req.query.env);
    const [plugins, markets] = await Promise.all([
      claude(env, ['plugin', 'list', '--json']),
      claude(env, ['plugin', 'marketplace', 'list', '--json']),
    ]);
    if (!plugins.ok) return res.status(500).json({ error: plugins.stderr || plugins.stdout });
    const parsedPlugins = parseJson(plugins.stdout);
    if (!Array.isArray(parsedPlugins)) return res.status(500).json({ error: '讀不到擴充元件清單（格式錯誤）。' });
    const parsedMarkets = markets.ok ? parseJson(markets.stdout, []) : [];
    res.json({
      envs: envs(),
      env,
      installed: parsedPlugins.map((p) => ({ id: p.id, version: p.version, scope: p.scope, enabled: p.enabled })),
      marketplaces: Array.isArray(parsedMarkets)
        ? parsedMarkets.map((m) => ({ name: m.name, source: m.repo || m.url || m.path || m.source }))
        : [],
    });
  }));

  // The marketplaces list thousands of plugins: search them here, a page at a time.
  app.get('/api/plugins/available', wrap(async (req, res) => {
    const env = pickEnv(req.query.env);
    const cache = availableCache[env];
    if (Date.now() - cache.at > 10 * 60_000 || req.query.refresh) {
      const r = await claude(env, ['plugin', 'list', '--available', '--json']);
      if (!r.ok) return res.status(500).json({ error: r.stderr || r.stdout });
      const parsed = parseJson(r.stdout);
      if (!parsed || !Array.isArray(parsed.installed) || !Array.isArray(parsed.available)) {
        return res.status(500).json({ error: '讀不到可安裝的擴充元件清單（格式錯誤）。' });
      }
      const installed = new Set(parsed.installed.map((p) => p.id));
      cache.at = Date.now();
      cache.list = parsed.available.map((p) => ({
        id: p.pluginId, name: p.name, description: p.description ?? '', installed: installed.has(p.pluginId),
      }));
    }
    const q = String(req.query.q ?? '').toLowerCase().trim();
    const hits = q ? cache.list.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)) : cache.list;
    res.json({ env, total: hits.length, plugins: hits.slice(0, 50) });
  }));

  app.post('/api/plugins/:action', wrap(async (req, res) => {
    const { action } = req.params;
    const env = pickEnv(req.body?.env);
    const name = String(req.body?.name ?? '');
    const scope = ['user', 'project', 'local'].includes(req.body?.scope) ? req.body.scope : null;
    let args;
    if (['install', 'uninstall', 'enable', 'disable', 'update'].includes(action)) {
      if (!NAME.test(name)) return res.status(400).json({ error: '名稱格式不對。' });
      args = ['plugin', action, name, ...(scope ? ['--scope', scope] : [])];
    } else if (action === 'marketplace-add') {
      if (!SOURCE.test(name)) return res.status(400).json({ error: '來源格式不對。' });
      args = ['plugin', 'marketplace', 'add', name];
    } else if (action === 'marketplace-remove' || action === 'marketplace-update') {
      if (!NAME.test(name)) return res.status(400).json({ error: '名稱格式不對。' });
      args = ['plugin', 'marketplace', action.split('-')[1], name];
    } else {
      return res.status(404).json({ error: 'action' });
    }
    const r = await claude(env, args);
    availableCache[env].at = 0;
    res.status(r.ok ? 200 : 500).json({ ok: r.ok, output: `${r.stdout}${r.stderr}`.trim() });
  }));
}
