export interface Item { key: string; type: string; text?: string; command?: boolean; error?: boolean; summary?: string; id?: string; name?: string; input?: Record<string, any>; result?: string | null; done?: boolean; image?: string; images?: string[]; calm?: boolean; output?: boolean; responseId?: string; beforeTool?: boolean; at?: number; endAt?: number; uuid?: string }
export interface Transcript { items: Item[]; tools: Map<string, Item>; seen: Set<string> }

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, any>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
}

interface RawMessage {
  uuid?: string;
  timestamp?: string;
  isSynthetic?: boolean;
  isMeta?: boolean;
  message?: { id?: string; role?: string; content?: string | ContentBlock[]; stop_reason?: string };
}

// Turns Claude Code messages (from history or live) into what the chat shows:
// user bubbles, assistant text, tool cards (with their results attached) and notes.

const COMMAND = /<command-name>\s*([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const STDOUT = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
const STDERR = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/;

export const isSkillContext = (text: string) => /^Base directory for this skill: [^\r\n]+\r?\n\r?\n/.test(text);

export function createTranscript(): Transcript {
  return { items: [], tools: new Map(), seen: new Set() };
}

const textOf = (content: unknown): string => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c): c is ContentBlock => !!c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text!).join('\n') : '');

// An image block as something an <img> can show, when it is one of the kinds browsers read.
const imageSrc = (c: ContentBlock | null | undefined): string | undefined => (c?.type === 'image' && c.source?.type === 'base64' && c.source.media_type && /^image\/(jpeg|png|gif|webp)$/.test(c.source.media_type) && c.source.data
  ? `data:${c.source.media_type};base64,${c.source.data}` : undefined);

function userText(t: Transcript, key: string, text: string, at?: number) {
  const push = (item: Item) => t.items.push(at ? { ...item, at } : item);
  const cmd = text.match(COMMAND);
  if (cmd) {
    const args = text.match(COMMAND_ARGS)?.[1]?.trim();
    return push({ key, type: 'note', text: `${cmd[1].trim()}${args ? ` ${args}` : ''}`, command: true });
  }
  const out = text.match(STDOUT) ?? text.match(STDERR);
  if (out) return out[1].trim() && push({ key, type: 'note', text: out[1].trim().replace(/\x1b\[[0-9;]*m/g, ''), output: true, error: !STDOUT.test(text) });
  if (text.startsWith('Caveat: The messages below')) return;
  if (text.startsWith('[Request interrupted')) return push({ key, type: 'note', text: '已中斷' });
  if (/^This session is being continued from a previous conversation/.test(text)) {
    return push({ key, type: 'note', text: '對話已壓縮，以下接續先前的摘要', summary: text });
  }
  if (text.trim()) push({ key, type: 'user', text });
}

// `m` is { uuid, message: { role, content } } as both history and live messages carry it.
export function addMessage(t: Transcript, msg: unknown, { subagent = false }: { subagent?: boolean } = {}) {
  const m = msg as RawMessage | null | undefined;
  if (!m?.message || (m.uuid && t.seen.has(m.uuid))) return;
  if (m.uuid) t.seen.add(m.uuid);
  if (subagent) return; // a subagent's own turns stay inside its Task card
  const { role, content } = m.message;
  const base = m.uuid ?? `local-${t.items.length}`;
  // When it happened, so a turn can say how long it took; live messages are stamped on arrival.
  const at = m.timestamp ? Date.parse(m.timestamp) || undefined : undefined;
  const push = (item: Item) => t.items.push(at ? { ...item, at } : item);
  if (role === 'user') {
    // A user item keeps its message's id: the server files a turn's changes under it.
    const from = t.items.length;
    try { userContent(); } finally { if (m.uuid) for (const it of t.items.slice(from)) if (it.type === 'user') it.uuid = m.uuid; }
    return;
  }
  function userContent() {
    const synthetic = m?.isSynthetic === true || m?.isMeta === true;
    const showText = (key: string, text: string) => {
      if (!synthetic || !isSkillContext(text)) userText(t, key, text, at);
    };
    if (typeof content === 'string') return showText(base, content);
    if (!Array.isArray(content)) return;
    content.forEach((c, i) => {
      if (c.type === 'tool_result') {
        const tool = c.tool_use_id ? t.tools.get(c.tool_use_id) : undefined;
        if (tool) {
          const images = Array.isArray(c.content) ? c.content.map(imageSrc).filter((x): x is string => !!x) : [];
          if (images.length) tool.images = images;
          tool.result = textOf(c.content) || (Array.isArray(c.content) && c.content.some((x) => x.type === 'image') && !images.length ? '[圖片]' : '');
          tool.error = !!c.is_error;
          tool.done = true;
          if (at) tool.endAt = at;
        }
      } else if (c.type === 'text' && typeof c.text === 'string') showText(`${base}-${i}`, c.text);
      else if (c.type === 'image') {
        const image = imageSrc(c);
        push({ key: `${base}-${i}`, type: 'user', image, text: image ? undefined : '[圖片]' });
      }
    });
  }
  if (role === 'assistant') {
    const responseId = m.message.id ?? base;
    (Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]).forEach((c, i) => {
      const key = `${base}-${i}`;
      if (c.type === 'text' && c.text?.trim()) push({ key, type: 'assistant', text: c.text, responseId, beforeTool: m.message?.stop_reason === 'tool_use' });
      else if (c.type === 'thinking' && c.thinking?.trim()) push({ key, type: 'thinking', text: c.thinking });
      else if (c.type === 'tool_use' && c.id) {
        const tool: Item = { key, type: 'tool', id: c.id, name: c.name, input: c.input, result: null, error: false, done: false, responseId, ...(at && { at }) };
        t.tools.set(c.id, tool);
        t.items.push(tool);
      }
    });
  }
}

export function addNote(t: Transcript, text: string, extra: Partial<Item> = {}) {
  t.items.push({ key: `note-${t.items.length}-${Date.now()}`, type: 'note', text, ...extra });
}

// One line that says what a tool call is doing.
export function toolSummary(name?: string, input: Record<string, any> = {}): string {
  const pick = (...keys: string[]) => keys.map((k) => input[k]).find((v): v is string => typeof v === 'string' && !!v);
  switch (name) {
    case 'Bash': case 'PowerShell': return pick('description', 'command') ?? '';
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return pick('file_path', 'notebook_path') ?? '';
    case 'Glob': case 'Grep': return [input.pattern, input.path].filter(Boolean).join('  ·  ');
    case 'WebFetch': return typeof input.url === 'string' ? input.url : '';
    case 'WebSearch': return typeof input.query === 'string' ? input.query : '';
    case 'Skill': return typeof input.skill === 'string' ? input.skill : '';
    case 'Task': case 'Agent': return pick('description', 'subagent_type') ?? '';
    case 'TodoWrite': return `${Array.isArray(input.todos) ? input.todos.length : 0} 項待辦`;
    case 'AskUserQuestion': return typeof input.questions?.[0]?.question === 'string' ? input.questions[0].question : '';
    default: return pick('description', 'command', 'file_path', 'path', 'url', 'query', 'pattern', 'prompt') ?? '';
  }
}
