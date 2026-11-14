// One Runner per open session: a long-lived Claude Code process fed through a streaming input,
// kept while you talk and closed after the idle time. Its events go to every subscribed socket.
import crypto from 'node:crypto';
import os from 'node:os';
import { query, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import * as store from './state.js';
import * as wsl from './wsl.js';
import * as changes from './changes.js';

const runners = new Map();
const CHANGES_KEPT = 200; // turns per session whose changes are remembered
const listeners = new Set(); // (sessionId | null, event) => void; null = for everyone
let planUsage = null;
let cachedControls = null; // slash commands and models, as last read from a running session

export const getPlanUsage = () => planUsage;
export const getControls = () => cachedControls;

// Reads the slash commands and models without a conversation: starts Claude Code with an input
// that never yields, asks over the control channel (no message reaches the API), then closes it.
let probing = null;
async function withIdleQuery(cwd, read) {
  let release;
  const idle = new Promise((resolve) => { release = resolve; });
  const q = query({ prompt: (async function* () { await idle; })(), options: { cwd, persistSession: false } });
  try { return await read(q); }
  finally { release(); q.close(); }
}

export function probeControls(cwd) {
  if (cachedControls) return Promise.resolve(cachedControls);
  probing ??= withIdleQuery(cwd, async (q) => {
    const [commands, models] = await Promise.all([q.supportedCommands(), q.supportedModels()]);
    cachedControls ??= { commands, models };
    emit(null, { kind: 'controls', controls: cachedControls });
    return cachedControls;
  }).finally(() => { probing = null; });
  return probing;
}
export function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = (id, event) => { for (const fn of listeners) fn(id, event); };
/** Sends `event` to every open page. */
export const broadcast = (event) => emit(null, event);

export function runnerFor(id) {
  let r = runners.get(id);
  if (!r) { r = new Runner(id); runners.set(id, r); }
  return r;
}
export function forget(id) {
  runners.get(id)?.close();
  runners.delete(id);
}
async function readUsage(q) {
  const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  const win = (w) => (w && typeof w.utilization === 'number' ? { pct: w.utilization, resetsAt: w.resets_at ?? null } : null);
  planUsage = usage?.rate_limits_available && usage.rate_limits
    ? { fiveHour: win(usage.rate_limits.five_hour), sevenDay: win(usage.rate_limits.seven_day), at: Date.now() }
    : null;
  emit(null, { kind: 'plan', plan: planUsage });
  return usage;
}

let refreshingPlan = null;
export function refreshPlan() {
  refreshingPlan ??= (async () => {
    const q = [...runners.values()].find((runner) => runner.q)?.q;
    if (q) await readUsage(q);
    else await withIdleQuery(os.homedir(), readUsage);
    return planUsage;
  })().finally(() => { refreshingPlan = null; });
  return refreshingPlan;
}
export const isRunning = (id) => runners.get(id)?.status === 'running';

class Runner {
  constructor(id) {
    this.id = id;
    this.q = null;
    this.queue = [];
    this.wake = null;
    this.closing = false;
    this.status = 'idle'; // idle | running
    this.pending = new Map(); // permission request id -> { resolve, event }
    this.alwaysAllow = new Set();
    this.idleTimer = null;
    this.context = null;
    this.cost = null;
    this.draft = ''; // the reply still streaming, for a socket that joins mid-turn
    this.turn = null; // { uuid, before: snapshot | null } while a turn that started with that prompt runs
  }

  get meta() { return store.get().sessions[this.id]; }
  mode() { return this.meta?.permissionMode ?? store.get().settings.permissionMode; }

  snapshot() {
    const s = store.get().settings;
    return {
      kind: 'snapshot', status: this.status, open: !!this.q, draft: this.draft, context: this.context, cost: this.cost,
      pending: [...this.pending.values()].map((p) => p.event), permissionMode: this.mode(),
      model: (this.meta?.model ?? s.model) || null, effort: (this.meta?.effort ?? s.effort) || null,
    };
  }

  async start() {
    const meta = this.meta;
    const settings = store.get().settings;
    const exists = !!(await wsl.readFor(meta.cwd, () => getSessionInfo(this.id, { dir: meta.cwd })).catch(() => null));
    this.closing = false;
    const self = this;
    async function* input() {
      while (!self.closing) {
        if (self.queue.length) { yield self.queue.shift(); continue; }
        await new Promise((r) => { self.wake = r; });
        self.wake = null;
      }
    }
    const model = meta.model ?? settings.model ?? undefined;
    const effort = meta.effort ?? settings.effort ?? undefined;
    const q = query({
      prompt: input(),
      options: {
        cwd: meta.cwd,
        ...wsl.spawnOptions(meta.cwd),
        ...(exists ? { resume: this.id } : { sessionId: this.id }),
        permissionMode: this.mode(),
        // Lets the mode be switched to bypass later in the same process.
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        // Thinking comes back as a readable summary instead of empty blocks.
        extraArgs: { 'thinking-display': 'summarized' },
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        canUseTool: (tool, toolInput, opts) => this.ask(tool, toolInput, opts),
        stderr: (line) => { if (/error/i.test(line)) console.error(`[claude ${this.id.slice(0, 8)}]`, line.trimEnd()); },
      },
    });
    this.q = q;
    this.done = this.consume(q);
  }

  async consume(q) {
    try {
      for await (const m of q) this.handle(m);
    } catch (e) {
      emit(this.id, { kind: 'error', message: String(e?.message ?? e) });
    } finally {
      if (this.q === q) this.q = null;
      this.denyAllPending('The session was closed.');
      this.turn = null;
      this.draft = '';
      this.setStatus('idle');
      emit(this.id, { kind: 'closed' });
    }
  }

  handle(m) {
    if (m.type === 'stream_event') {
      const ev = m.event;
      if (m.parent_tool_use_id === null && ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        this.draft += ev.delta.text;
        emit(this.id, { kind: 'delta', text: ev.delta.text });
      }
      return;
    }
    if (m.type === 'system' && m.subtype === 'init') {
      this.controls().then((c) => { if (c) { cachedControls = c; emit(null, { kind: 'controls', controls: c }); } })
        .catch((e) => console.error('[cc-remote] controls:', e.message));
    }
    if (m.type === 'assistant' && m.parent_tool_use_id === null) this.draft = '';
    emit(this.id, { kind: 'sdk', msg: m });
    if (m.type === 'result') {
      this.endTurn();
      this.draft = '';
      this.setStatus('idle');
      this.armIdle();
      this.refreshUsage();
    }
  }

  // What the turn changed, kept per prompt so the chat can show it under that turn's answer.
  endTurn() {
    const turn = this.turn;
    this.turn = null;
    if (!turn) return;
    const cwd = this.meta.cwd;
    (async () => {
      const { before } = turn;
      if (!before) return;
      const after = await changes.snapshot(cwd);
      const files = await changes.diff(before, after);
      const meta = this.meta;
      if (!meta) return;
      const keep = (map, value) => Object.fromEntries([...Object.entries(map ?? {}), [turn.uuid, value]].slice(-CHANGES_KEPT));
      meta.changes = keep(meta.changes, files);
      // The two snapshots, so one file's diff can be shown later (until git's gc clears them).
      if (files.length && after) meta.trees = keep(meta.trees, { top: before.top, before: before.tree, after: after.tree });
      store.save();
      emit(this.id, { kind: 'changes', uuid: turn.uuid, files });
    })().catch((e) => console.error('[cc-remote] changes:', e.message));
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    emit(this.id, { kind: 'status', status });
    emit(null, { kind: 'running', session: this.id, running: status === 'running' });
  }

  async send(text, images = [], uuid) {
    clearTimeout(this.idleTimer);
    await this.restarting?.catch(() => {});
    if (!this.q) {
      await this.start();
      if (uuid === this.id) await this.q.initializationResult();
    }
    const content = images.length ? [
      ...images.map(({ data, mediaType }) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })),
      ...(text ? [{ type: 'text', text }] : []),
    ] : text;
    // A prompt sent while a turn runs joins that turn; its changes are counted from the first.
    if (this.status !== 'running' && !this.turn && uuid) {
      // Taken before the prompt goes out, so nothing Claude does can land in the 'before' side.
      const turn = this.turn = { uuid, before: null };
      turn.before = await changes.snapshot(this.meta.cwd);
    }
    this.queue.push({ type: 'user', ...(uuid ? { uuid } : {}), message: { role: 'user', content }, parent_tool_use_id: null });
    this.setStatus('running');
    this.wake?.();
  }

  async interrupt() { if (this.q) await this.q.interrupt(); }

  async setMode(mode) {
    this.meta.permissionMode = mode;
    store.save();
    if (this.q) await this.q.setPermissionMode(mode);
    emit(this.id, { kind: 'mode', permissionMode: mode });
  }

  async setModel(model) {
    this.meta.model = model || null;
    store.save();
    if (this.q) await this.q.setModel(model || undefined);
    emit(this.id, { kind: 'model', model: model || null });
  }

  // Effort is fixed when the process starts. With no process it is simply saved for the next start;
  // with one, it may only change between turns, and the process is restarted (resuming the same
  // session) so the new effort applies to the next message.
  async setEffort(effort, { restart = false } = {}) {
    if (this.restarting) throw new Error('Claude Code 正在重新啟動。');
    if (this.q && this.status === 'running') throw new Error('這一輪結束後才能改 Effort。');
    if (this.q && !restart) throw new Error('改 Effort 需要重新啟動 Claude Code。');
    this.meta.effort = effort || null;
    store.save();
    if (this.q) {
      this.restarting = (async () => {
        this.close();
        await this.done;
        await this.start();
        await this.q.initializationResult();
        this.armIdle();
      })().finally(() => { this.restarting = null; });
      await this.restarting;
    }
    emit(this.id, { kind: 'effort', effort: effort || null });
  }

  ask(tool, input, { signal, decisionReason, blockedPath }) {
    if (tool !== 'AskUserQuestion' && this.alwaysAllow.has(tool)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const id = crypto.randomUUID();
    const event = { kind: 'permission', id, tool, input, reason: decisionReason ?? null, blockedPath: blockedPath ?? null };
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, event });
      signal?.addEventListener('abort', () => this.settle(id, { behavior: 'deny', message: 'Aborted.' }));
      emit(this.id, event);
    });
  }

  answer(id, { decision, answers, message }) {
    const p = this.pending.get(id);
    if (!p) return false;
    if (decision === 'deny') return this.settle(id, { behavior: 'deny', message: message || 'The user denied this.' });
    if (decision === 'always') this.alwaysAllow.add(p.event.tool);
    const input = p.event.input;
    return this.settle(id, { behavior: 'allow', updatedInput: answers ? { ...input, answers } : input });
  }

  settle(id, result) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.resolve(result);
    emit(this.id, { kind: 'permission-done', id });
    return true;
  }

  denyAllPending(message) { for (const id of [...this.pending.keys()]) this.settle(id, { behavior: 'deny', message }); }

  async refreshUsage() {
    const q = this.q;
    if (!q) return;
    try {
      const u = await q.getContextUsage({ detail: 'summary' });
      this.context = {
        used: u.totalTokens, max: u.maxTokens, threshold: u.autoCompactThreshold ?? null,
        autoCompact: u.isAutoCompactEnabled, model: u.model,
        categories: u.categories.filter((c) => c.kind === 'used' && c.tokens > 0).map((c) => ({ name: c.name, tokens: c.tokens })),
      };
      emit(this.id, { kind: 'context', context: this.context });
    } catch (e) { console.error('[cc-remote] context usage:', e.message); }
    try {
      const u = await readUsage(q);
      const s = u?.session;
      this.cost = s ? { usd: s.total_cost_usd, added: s.total_lines_added, removed: s.total_lines_removed } : null;
      emit(this.id, { kind: 'cost', cost: this.cost });
    } catch (e) { console.error('[cc-remote] plan usage:', e.message); }
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    const minutes = store.get().settings.idleMinutes;
    if (!minutes) return;
    this.idleTimer = setTimeout(() => { if (this.status === 'idle' && !this.pending.size) this.close(); }, minutes * 60_000);
  }

  close() {
    clearTimeout(this.idleTimer);
    this.closing = true;
    this.wake?.();
    this.q?.close();
  }

  async controls() {
    if (!this.q) return null;
    const [commands, models] = await Promise.all([this.q.supportedCommands(), this.q.supportedModels()]);
    return { commands, models };
  }
}

export function closeAll() { for (const r of runners.values()) r.close(); }
