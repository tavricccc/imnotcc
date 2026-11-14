// Plugins are managed by the Claude Code CLI itself: this only runs `claude plugin ...` and
// passes its output back. A running session picks changes up the next time it starts.
import { execFile } from 'node:child_process';

const NAME = /^[\w.@\-/:]+$/; // plugin ids, marketplace names, owner/repo, URLs, paths without spaces
const SOURCE = /^[^\s"'`;&|<>]+$/;

function claude(args, timeout = 180_000) {
  return new Promise((resolve) => {
    execFile('claude', args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

let availableCache = { at: 0, list: [] };

export function pluginRoutes(app, wrap) {
  app.get('/api/plugins', wrap(async (_req, res) => {
    const [plugins, markets] = await Promise.all([claude(['plugin', 'list', '--json']), claude(['plugin', 'marketplace', 'list', '--json'])]);
    if (!plugins.ok) return res.status(500).json({ error: plugins.stderr || plugins.stdout });
    res.json({
      installed: JSON.parse(plugins.stdout).map((p) => ({ id: p.id, version: p.version, scope: p.scope, enabled: p.enabled })),
      marketplaces: markets.ok ? JSON.parse(markets.stdout).map((m) => ({ name: m.name, source: m.repo || m.url || m.path || m.source })) : [],
    });
  }));

  // The marketplaces list thousands of plugins: search them here, a page at a time.
  app.get('/api/plugins/available', wrap(async (req, res) => {
    if (Date.now() - availableCache.at > 10 * 60_000 || req.query.refresh) {
      const r = await claude(['plugin', 'list', '--available', '--json']);
      if (!r.ok) return res.status(500).json({ error: r.stderr || r.stdout });
      const installed = new Set(JSON.parse(r.stdout).installed.map((p) => p.id));
      availableCache = {
        at: Date.now(),
        list: JSON.parse(r.stdout).available.map((p) => ({
          id: p.pluginId, name: p.name, description: p.description ?? '', installed: installed.has(p.pluginId),
        })),
      };
    }
    const q = String(req.query.q ?? '').toLowerCase().trim();
    const hits = q ? availableCache.list.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)) : availableCache.list;
    res.json({ total: hits.length, plugins: hits.slice(0, 50) });
  }));

  app.post('/api/plugins/:action', wrap(async (req, res) => {
    const { action } = req.params;
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
    const r = await claude(args);
    availableCache.at = 0;
    res.status(r.ok ? 200 : 500).json({ ok: r.ok, output: `${r.stdout}${r.stderr}`.trim() });
  }));
}
