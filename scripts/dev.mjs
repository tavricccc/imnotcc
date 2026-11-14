// Development.
//   npm run dev                      its own API server on 4290 (data in data/dev) + Vite on 5173
//   npm run dev -- --attach=4280     Vite only, on top of the server already running on 4280
import { spawn } from 'node:child_process';
import path from 'node:path';

const attach = process.argv.find((a) => a.startsWith('--attach='))?.split('=')[1] || process.env.IMNOTCC_ATTACH;
const port = attach || process.env.IMNOTCC_PORT || '4290';
const env = {
  ...process.env, IMNOTCC_PORT: port, IMNOTCC_DEV: '1',
  IMNOTCC_DATA_DIR: process.env.IMNOTCC_DATA_DIR || path.resolve('data', 'dev'),
};
const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
const procs = [run('npx vite', [])];
if (!attach) procs.push(spawn(process.execPath, ['--watch-path=server', 'server/index.js'], { stdio: 'inherit', env }));
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) console.error(`[dev] a process exited with ${code}`); });
