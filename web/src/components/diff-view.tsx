// One file's change in one turn, as a one-column diff. The turn's other files are a step away.
import * as React from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react/ssr";
import { get } from "@/lib/api";
import { openPreview, type PreviewTarget } from "@/lib/preview";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { ErrorState, LoadingList } from "@/ui/page";
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
export function DiffBody({ target }: { target: DiffTarget }) {
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
        : <DiffRows name={target.path} rows={rows} />}
    </div>
  );
}

/** Rows in one column, coloured by the file's language. */
export function DiffRows({ name, rows }: { name: string; rows: Row[] }) {
  // Coloured as one text, in the patch's order: close enough line by line.
  const lines = React.useMemo(() => rows.filter((r): r is Line => r.kind === "line"), [rows]);
  const tokens = useTokens(React.useMemo(() => lines.map((l) => l.text).join("\n"), [lines]), baseName(name));
  const tok = React.useMemo(() => new Map(lines.map((l, i) => [l, tokens?.[i]] as const)), [lines, tokens]);
  return <Unified rows={rows} tok={tok} />;
}

/** A tool's edit as diff rows: what it took out, then what it put in. No line numbers; the tool does not give them. */
export function editRows(edits: { old: string; new: string }[]): Row[] {
  const split = (t: string) => (t ? t.replace(/\r\n/g, "\n").split("\n") : []);
  return edits.flatMap((e, i) => [
    ...(i ? [{ kind: "hunk", text: "⋯" } as Row] : []),
    ...split(e.old).map((text): Row => ({ kind: "line", type: "-", text })),
    ...split(e.new).map((text): Row => ({ kind: "line", type: "+", text })),
  ]);
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
