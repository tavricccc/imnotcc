// One Runner per open session: a long-lived Claude Code process fed through a streaming input,
// kept while you talk and closed after the idle time. Its events go to every subscribed socket.
import crypto from 'node:crypto';
import os from 'node:os';
import { query, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import * as store from './state.js';
import * as wsl from './wsl.js';
import * as changes from './changes.js';

const runners = new Map();
const CHANGES_KEPT = 1; // only the latest turn's changes are remembered; the next turn replaces them
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
// Anything else said about a session goes out after the text streamed before it.
const emit = (id, event) => {
  if (id && event.kind !== 'delta') runners.get(id)?.flushDelta();
  for (const fn of listeners) fn(id, event);
};
// Streamed text is sent in batches rather than one socket message per token.
const DELTA_MS = 40;
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
    this.unsent = ''; // streamed text not yet sent to the pages
    // Background work Claude Code reports as live (shells, agents, monitors), as it last listed it.
    this.tasks = [];
    this.rawTasks = []; // the same, as Claude Code listed it
    this.taskInfo = new Map(); // task id -> { command, startedAt }
    this.toolInputs = new Map(); // recent tool_use id -> what it ran, to name a task's command
    this.deltaTimer = null;
    this.turn = null; // { uuid, before: snapshot | null } while a turn that started with that prompt runs
    // Prompts sent as "queue" while a turn ran: each goes out as its own turn once the one before
    // ends. Kept here rather than handed to Claude Code, so when they go is up to this server.
    this.held = []; // { uuid, text, images }
  }

  heldView() { return this.held.map(({ uuid, text, images }) => ({ uuid, text, images: images.length })); }
  emitHeld() { emit(this.id, { kind: 'queued', queued: this.heldView() }); }

  /** Hand every held prompt back to the pages, which put them in the composer again. */
  returnHeld() {
    if (!this.held.length) return;
    const items = this.held;
    this.held = [];
    emit(this.id, { kind: 'queue-returned', items });
    this.emitHeld();
  }

  unqueue(uuid) {
    const i = this.held.findIndex((h) => h.uuid === uuid);
    if (i < 0) return;
    const [item] = this.held.splice(i, 1);
    emit(this.id, { kind: 'queue-returned', items: [item] });
    this.emitHeld();
  }

  /** After a turn ends, start the next held prompt, if any. */
  sendHeld() {
    const next = this.held.shift();
    if (!next) return;
    this.emitHeld();
    emit(this.id, { kind: 'dequeued', uuid: next.uuid, text: next.text });
    this.send(next.text, next.images, next.uuid).catch((e) => emit(this.id, { kind: 'error', message: String(e?.message ?? e) }));
  }

  get meta() { return store.get().sessions[this.id]; }
  mode() { return this.meta?.permissionMode ?? store.get().settings.permissionMode; }

  flushDelta() {
    clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
    if (!this.unsent) return;
    const text = this.unsent;
    this.unsent = '';
    emit(this.id, { kind: 'delta', text });
  }

  snapshot() {
    // Pages already watching get the unsent text first; the joining one gets it in `draft` too,
    // and its snapshot replaces whatever it had.
    this.flushDelta();
    const s = store.get().settings;
    return {
      kind: 'snapshot', status: this.status, open: !!this.q, draft: this.draft, tasks: this.tasks, context: this.context, cost: this.cost, queued: this.heldView(),
      pending: [...this.pending.values()].map((p) => p.event), permissionMode: this.mode(),
      model: (this.meta?.model ?? s.model) || null, effort: (this.meta?.effort ?? s.effort) || null,
    };
  }

  async start() {
    this.effortStale = false;
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
    this.rawTasks = [];
    this.setTasks([]); // the list is per process, and a new one starts with none
    this.done = this.consume(q);
  }

  async consume(q) {
    try {
      for await (const m of q) this.handle(m);
    } catch (e) {
      emit(this.id, { kind: 'error', message: String(e?.message ?? e) });
    } finally {
      if (this.q === q) { this.q = null; this.rawTasks = []; this.setTasks([]); }
      this.denyAllPending('The session was closed.');
      this.turn = null;
      this.draft = '';
      this.setStatus('idle');
      this.returnHeld();
      emit(this.id, { kind: 'closed' });
    }
  }

  handle(m) {
    if (m.type === 'stream_event') {
      const ev = m.event;
      if (m.parent_tool_use_id === null && ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        this.draft += ev.delta.text;
        this.unsent += ev.delta.text;
        this.deltaTimer ??= setTimeout(() => this.flushDelta(), DELTA_MS);
      }
      return;
    }
    if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
      // Replaces the list; tasks Claude Code marks ambient are watchers, not work to show.
      this.rawTasks = (m.tasks ?? []).filter((t) => !t.ambient);
      this.showTasks();
      return;
    }
    if (m.type === 'system' && m.subtype === 'task_started') {
      // Often after the task joined the list: what it runs comes from the tool call that made it.
      const info = this.infoFor(m.task_id);
      info.command ??= this.toolInputs.get(m.tool_use_id) ?? m.prompt ?? null;
      this.showTasks();
    }
    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type !== 'tool_use') continue;
        const ran = c.input?.command ?? c.input?.prompt ?? null;
        if (typeof ran === 'string') this.toolInputs.set(c.id, ran);
      }
      while (this.toolInputs.size > 200) this.toolInputs.delete(this.toolInputs.keys().next().value);
    }
    if (m.type === 'system' && m.subtype === 'init') {
      this.controls().then((c) => { if (c) { cachedControls = c; emit(null, { kind: 'controls', controls: c }); } })
        .catch((e) => console.error('[imnotcc] controls:', e.message));
    }
    if (m.type === 'assistant' && m.parent_tool_use_id === null) this.draft = '';
    emit(this.id, { kind: 'sdk', msg: m });
    if (m.type === 'result') {
      this.endTurn();
      this.draft = '';
      this.setStatus('idle');
      this.armIdle();
      this.refreshUsage();
      // A stopped turn keeps its held prompts for the user instead of sending them on.
      if (this.interrupted) { this.interrupted = false; this.returnHeld(); } else this.sendHeld();
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
      if (!files.length || !after) delete meta.trees;
      // The two snapshots, so one file's diff can be shown later (until the next turn replaces them or git's gc clears them).
      if (files.length && after) meta.trees = keep(meta.trees, { top: before.top, before: before.tree, after: after.tree });
      store.save();
      emit(this.id, { kind: 'changes', uuid: turn.uuid, files });
    })().catch((e) => console.error('[imnotcc] changes:', e.message));
  }

  infoFor(id) {
    let info = this.taskInfo.get(id);
    if (!info) { info = { command: null, startedAt: Date.now() }; this.taskInfo.set(id, info); }
    return info;
  }

  showTasks() {
    const live = new Set(this.rawTasks.map((t) => t.task_id));
    // task_started can come before the task joins the list, so only old leftovers are dropped.
    for (const [id, info] of this.taskInfo) if (!live.has(id) && Date.now() - info.startedAt > 60_000) this.taskInfo.delete(id);
    this.setTasks(this.rawTasks.map((t) => {
      const info = this.infoFor(t.task_id);
      return { id: t.task_id, type: t.task_type, agent: t.subagent_type ?? null, description: t.description, command: info.command, startedAt: info.startedAt };
    }));
  }

  setTasks(tasks) {
    if (!tasks.length && !this.tasks.length) return;
    this.tasks = tasks;
    emit(this.id, { kind: 'tasks', tasks });
    // The idle close waited for these to end.
    if (!tasks.length && this.status === 'idle' && this.q) this.armIdle();
  }

  /** The end of a background shell's output (the last 8 KiB). */
  async taskOutput(taskId) {
    if (!this.q || typeof this.q.getTaskOutput !== 'function') return null;
    const r = await this.q.getTaskOutput(taskId);
    return { output: r?.output ?? '', truncated: !!r?.truncated, bytes: r?.total_bytes ?? 0 };
  }

  async stopTask(taskId) { if (this.q) await this.q.stopTask(taskId); }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    emit(this.id, { kind: 'status', status });
    emit(null, { kind: 'running', session: this.id, running: status === 'running' });
  }

  /** `queue` holds the prompt until the running turn ends; otherwise it joins that turn (steer). */
  async send(text, images = [], uuid, { queue = false, from } = {}) {
    if (queue && this.status === 'running' && uuid) {
      this.held.push({ uuid, text, images });
      this.emitHeld();
      return;
    }
    clearTimeout(this.idleTimer);
    // A prompt sent while a turn runs joins that turn; its changes are counted from the first.
    // The 'before' snapshot is taken while Claude Code starts, and the prompt only goes out once
    // it is done, so nothing Claude does can land in the 'before' side.
    const counts = this.status !== 'running' && !this.turn && uuid;
    const before = counts ? changes.snapshot(this.meta.cwd) : null;
    try {
      await this.restarting?.catch(() => {});
      await this.applyEffort();
      if (!this.q) {
        await this.start();
        if (uuid === this.id) await this.q.initializationResult();
      }
    } finally { await before; }
    const content = images.length ? [
      ...images.map(({ data, mediaType }) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })),
      ...(text ? [{ type: 'text', text }] : []),
    ] : text;
    if (counts && !this.turn) this.turn = { uuid, before: await before };
    this.queue.push({ type: 'user', ...(uuid ? { uuid } : {}), message: { role: 'user', content }, parent_tool_use_id: null });
    // Every device on this session shows the prompt now, not only the one that sent it.
    // The page that sent it (`from`) already shows its images, so they are not sent back to it.
    if (uuid) emit(this.id, { kind: 'prompt', uuid, text, from, images: images.map(({ data, mediaType }) => ({ data, mediaType })) });
    this.setStatus('running');
    this.wake?.();
  }

  async interrupt() {
    if (!this.q) return;
    if (this.status === 'running') this.interrupted = true;
    await this.q.interrupt();
  }

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

  // Effort is fixed when the process starts. It is saved at once; a process already running keeps
  // its old effort until the next message, which restarts it (resuming the same session) first.
  async setEffort(effort) {
    this.meta.effort = effort || null;
    store.save();
    if (this.q) this.effortStale = true;
    emit(this.id, { kind: 'effort', effort: effort || null });
  }

  /** Before a new turn: restart a process still on an old effort. */
  async applyEffort() {
    if (!this.effortStale || !this.q || this.status === 'running') return;
    this.effortStale = false;
    this.restarting = (async () => {
      this.close();
      await this.done;
      await this.start();
      await this.q.initializationResult();
    })().finally(() => { this.restarting = null; });
    await this.restarting;
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
    } catch (e) { console.error('[imnotcc] context usage:', e.message); }
    try {
      const u = await readUsage(q);
      const s = u?.session;
      this.cost = s ? { usd: s.total_cost_usd, added: s.total_lines_added, removed: s.total_lines_removed } : null;
      emit(this.id, { kind: 'cost', cost: this.cost });
    } catch (e) { console.error('[imnotcc] plan usage:', e.message); }
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    const minutes = store.get().settings.idleMinutes;
    if (!minutes) return;
    // Closing the process would kill its background work, so a session with some stays open.
    this.idleTimer = setTimeout(() => { if (this.status === 'idle' && !this.pending.size && !this.tasks.length) this.close(); }, minutes * 60_000);
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
