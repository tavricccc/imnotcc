// One file's change in one turn, like an editor's diff: side by side when there is room, one
// column on a phone. The turn's other files are a step away.
import * as React from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react/ssr";
import { get } from "@/lib/api";
import { openPreview, type PreviewTarget } from "@/lib/preview";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { ErrorState, LoadingList } from "@/ui/page";
import { useCompactViewport } from "@/ui/use-compact-viewport";
import { baseName } from "@/lib/format";
import type { ThemedToken } from "shiki/core";
import { Tokens, useTokens } from "./preview-views";

type DiffTarget = Extract<PreviewTarget, { kind: "diff" }>;
type Row = { kind: "hunk"; text: string } | { kind: "line"; type: " " | "+" | "-"; text: string; old?: number; new?: number };

/** A unified diff, as rows with each side's line numbers. */
export function parsePatch(patch: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    const type = line[0];
    if (type === "+") rows.push({ kind: "line", type, text: line.slice(1), new: newNo++ });
    else if (type === "-") rows.push({ kind: "line", type, text: line.slice(1), old: oldNo++ });
    else if (type === " ") rows.push({ kind: "line", type, text: line.slice(1), old: oldNo++, new: newNo++ });
  }
  return rows;
}

type Line = Extract<Row, { kind: "line" }>;
type Pair = { kind: "hunk"; text: string } | { kind: "pair"; left?: Line; right?: Line };

/** Rows side by side: removed lines beside the added lines that replaced them. */
function pairUp(rows: Row[]): Pair[] {
  const out: Pair[] = [];
  let removed: Line[] = [];
  let added: Line[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) out.push({ kind: "pair", left: removed[i], right: added[i] });
    removed = [];
    added = [];
  };
  for (const row of rows) {
    if (row.kind === "hunk") { flush(); out.push(row); continue; }
    if (row.type === "-") { if (added.length) flush(); removed.push(row); }
    else if (row.type === "+") added.push(row);
    else { flush(); out.push({ kind: "pair", left: row, right: row }); }
  }
  flush();
  return out;
}

export function DiffBody({ target }: { target: DiffTarget }) {
  const compact = useCompactViewport();
  const [state, setState] = React.useState<{ key?: string; patch?: string; error?: string }>({});
  const key = `${target.session}\n${target.turn}\n${target.path}`;
  React.useEffect(() => {
    let live = true;
    get<{ patch: string }>(`/api/sessions/${encodeURIComponent(target.session)}/diff?turn=${encodeURIComponent(target.turn)}&path=${encodeURIComponent(target.path)}`)
      .then((r) => { if (live) setState({ key, patch: r.patch }); })
      .catch((e) => { if (live) setState({ key, error: (e as Error).message }); });
    return () => { live = false; };
  }, [key, target.session, target.turn, target.path]);
  const rows = React.useMemo(() => (state.key === key && state.patch ? parsePatch(state.patch) : []), [state, key]);
  // Coloured as one text, in the patch's order: close enough line by line.
  const lines = React.useMemo(() => rows.filter((r): r is Line => r.kind === "line"), [rows]);
  const tokens = useTokens(React.useMemo(() => lines.map((l) => l.text).join("\n"), [lines]), baseName(target.path));
  const tok = React.useMemo(() => new Map(lines.map((l, i) => [l, tokens?.[i]] as const)), [lines, tokens]);

  const index = target.files.findIndex((f) => f.path === target.path);
  const step = (by: number) => {
    const next = target.files[index + by];
    if (next) openPreview({ ...target, path: next.path });
  };

  return (
    <div className="grid min-w-0 gap-3">
      {target.files.length > 1 ? (
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <Button aria-label="上一個檔案" disabled={index <= 0} onClick={() => step(-1)} size="icon-sm" variant="ghost"><CaretLeft /></Button>
          <span className="tabular-nums">第 {index + 1} / {target.files.length} 個檔案</span>
          <Button aria-label="下一個檔案" disabled={index >= target.files.length - 1} onClick={() => step(1)} size="icon-sm" variant="ghost"><CaretRight /></Button>
        </div>
      ) : null}
      {state.key !== key ? <LoadingList label="載入中" rows={3} />
        : state.error ? <ErrorState message={state.error} retryLabel="重試" title="看不到這個變更" />
        : !rows.length ? <p className="py-6 text-sm text-ink-muted">{state.patch === "" ? "二進位檔案，沒有逐行的變更可以顯示。" : "沒有內容上的變更。"}</p>
        : compact ? <Unified rows={rows} tok={tok} /> : <SideBySide rows={rows} tok={tok} />}
    </div>
  );
}

const TONE = { "+": "bg-[color-mix(in_oklab,var(--positive)_14%,transparent)]", "-": "bg-[color-mix(in_oklab,var(--danger)_14%,transparent)]", " ": "" };
const CELL = "whitespace-pre px-2";
const NUM = "select-none px-2 text-right text-ink-faint";
type Tok = Map<Line, ThemedToken[] | undefined>;
const Text = ({ line, tok }: { line: Line; tok: Tok }) => { const t = tok.get(line); return t ? <Tokens line={t} /> : <>{line.text || " "}</>; };

function Unified({ rows, tok }: { rows: Row[]; tok: Tok }) {
  return (
    <div className="code-tokens overflow-x-auto rounded-tile bg-surface-raised py-2 font-mono text-[0.8125rem] leading-[1.6]" data-selectable="">
      <div className="grid min-w-max grid-cols-[auto_auto_auto_1fr]">
        {rows.map((r, i) => r.kind === "hunk"
          ? <div className="col-span-4 px-3 py-1 text-ink-faint" key={i}>{r.text}</div>
          : (
            <div className="contents" key={i}>
              <span className={cn(NUM, TONE[r.type])}>{r.old ?? ""}</span>
              <span className={cn(NUM, TONE[r.type])}>{r.new ?? ""}</span>
              <span className={cn("select-none pl-1 text-ink-faint", TONE[r.type])}>{r.type === " " ? "" : r.type}</span>
              <span className={cn(CELL, TONE[r.type])}><Text line={r} tok={tok} /></span>
            </div>
          ))}
      </div>
    </div>
  );
}

function SideBySide({ rows, tok }: { rows: Row[]; tok: Tok }) {
  const pairs = React.useMemo(() => pairUp(rows), [rows]);
  const side = (line: Line | undefined, which: "left" | "right", key: string) => {
    const type = line ? (line.type === " " ? " " : which === "left" ? "-" : "+") : null;
    const tone = type ? TONE[type] : "bg-surface-solid/40";
    return (
      <React.Fragment key={key}>
        <span className={cn(NUM, tone)}>{line ? (which === "left" ? line.old : line.new) : ""}</span>
        <span className={cn("whitespace-pre-wrap break-all px-2", tone)}>{line ? <Text line={line} tok={tok} /> : " "}</span>
      </React.Fragment>
    );
  };
  return (
    <div className="code-tokens overflow-x-auto rounded-tile bg-surface-raised py-2 font-mono text-[0.8125rem] leading-[1.6]" data-selectable="">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        {pairs.map((p, i) => p.kind === "hunk"
          ? <div className="col-span-4 px-3 py-1 text-ink-faint" key={i}>{p.text}</div>
          : [side(p.left, "left", `${i}l`), side(p.right, "right", `${i}r`)])}
      </div>
    </div>
  );
}
