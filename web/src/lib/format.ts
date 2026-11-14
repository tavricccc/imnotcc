export function ago(ms?: number) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "剛剛";
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ms).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
}

export function tokens(n?: number | null) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function until(iso?: string) {
  if (!iso) return "";
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return "即將重置";
  if (s < 3600) return `${Math.ceil(s / 60)} 分鐘後重置`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時 ${Math.floor((s % 3600) / 60)} 分後重置`;
  return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小時後重置`;
}

export const baseName = (p?: string) => (p || "").split(/[\\/]/).filter(Boolean).pop() || p || "";

export const MODES = [
  { value: "default", label: "預設", detail: "改檔案、跑指令前都先問你" },
  { value: "acceptEdits", label: "編輯", detail: "改檔案不問，跑指令會問" },
  { value: "plan", label: "規劃", detail: "只讀不改，先寫計畫給你看" },
  { value: "auto", label: "自動", detail: "由 Claude Code 判斷哪些要問" },
  { value: "bypassPermissions", label: "略過", detail: "什麼都不問，小心使用" },
] as const;
export const modeLabel = (v?: string | null) => MODES.find((m) => m.value === v)?.label ?? v ?? "";

export const EFFORTS = [
  { value: "", label: "預設" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

export const WINDOWS = [
  { value: "200k", label: "200k" },
  { value: "300k", label: "300k" },
  { value: "400k", label: "400k" },
  { value: "1000k", label: "1M" },
];

export type Tone = "ok" | "caution" | "danger";
/** Ring and bar tone by how full something is. */
export const tone = (pct: number): Tone => (pct >= 90 ? "danger" : pct >= 75 ? "caution" : "ok");

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
