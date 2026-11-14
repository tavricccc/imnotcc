import * as React from "react";
import { toast } from "sonner";
import {
  cancelClaudeLogin,
  claudeAuth,
  loggedOutTargets,
  startClaudeLogin,
  submitClaudeCode,
  TARGET_LABEL,
  type ClaudeTarget,
} from "@/lib/claude-auth";
import { useStore } from "@/lib/store-core";
import { isTauri, tauriInvoke } from "@/lib/tauri";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Sheet } from "@/ui/sheet";

const TOAST_ID = "claude-auth";

function openExternal(url: string) {
  // The desktop window would open the link inside itself, so it goes to the system browser.
  if (isTauri()) void tauriInvoke("open_external", { url }).catch((e) => toast.error(String(e)));
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** Signs Claude Code in on the server computer: fetch a link, sign in anywhere, paste the code back. */
export function ClaudeLoginSheet({ onOpenChange, open, target }: { onOpenChange: (open: boolean) => void; open: boolean; target: ClaudeTarget }) {
  const [url, setUrl] = React.useState<string>();
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const done = React.useRef(false);

  React.useEffect(() => {
    if (!open) return;
    done.current = false;
    setUrl(undefined);
    setCode("");
    setError(undefined);
    let live = true;
    startClaudeLogin(target)
      .then((r) => { if (live) setUrl(r.url); })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => {
      live = false;
      if (!done.current) void cancelClaudeLogin();
    };
  }, [open, target]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await submitClaudeCode(code.trim());
      done.current = true;
      onOpenChange(false);
      toast.success(`Claude（${TARGET_LABEL[target]}）已登入`);
    } catch (e) {
      // The CLI ends its login after a refused code, so the next try needs a new link.
      setError((e as Error).message);
      setUrl(undefined);
      startClaudeLogin(target).then((r) => setUrl(r.url)).catch(() => {});
    } finally { setBusy(false); }
  }

  return (
    <Sheet
      description={`登入的是 server 電腦上的 Claude Code（${TARGET_LABEL[target]}）。在任何裝置的瀏覽器登入都可以。`}
      onOpenChange={onOpenChange}
      open={open}
      title="登入 Claude"
    >
      <form className="grid gap-4 pb-2" onSubmit={submit}>
        <ol className="grid list-decimal gap-1 pl-5 text-sm text-ink-muted">
          <li>開啟登入頁面，用你的 Claude 帳號登入</li>
          <li>登入後頁面會顯示一段代碼，複製下來</li>
          <li>貼到下面，按「完成登入」</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!url} onClick={() => url && openExternal(url)} status={url ? "idle" : error ? "idle" : "loading"} type="button" variant="primary">開啟登入頁面</Button>
          <Button disabled={!url} onClick={() => url && void navigator.clipboard.writeText(url).then(() => toast.success("已複製連結"))} type="button" variant="ghost">複製連結</Button>
        </div>
        <Field error={error} label="登入代碼">
          {({ describedBy, id, invalid }) => (
            <Input aria-describedby={describedBy} aria-invalid={invalid || undefined} autoComplete="off" id={id} onChange={(e) => setCode(e.target.value)} spellCheck={false} value={code} />
          )}
        </Field>
        <Button disabled={!url || !code.trim()} size="lg" status={busy ? "loading" : "idle"} type="submit" variant="primary">完成登入</Button>
      </form>
    </Sheet>
  );
}

/** Raises a lasting notice while a Claude Code login is missing or refused, with a way to sign in. */
export function ClaudeLoginWatcher() {
  const { dismissed, status } = useStore(claudeAuth);
  const [target, setTarget] = React.useState<ClaudeTarget>();
  const out = loggedOutTargets(status);
  const first = out[0];
  const expired = first ? !!status[first]?.expired : false;

  React.useEffect(() => {
    if (!first || dismissed || target) { toast.dismiss(TOAST_ID); return; }
    const where = out.length > 1 ? out.map((t) => TARGET_LABEL[t]).join("、") : TARGET_LABEL[first];
    toast.warning(expired ? `Claude 的登入已失效（${where}）` : `Claude 還沒登入（${where}）`, {
      action: { label: "登入", onClick: () => setTarget(first) },
      description: "登入之前，session 沒辦法回覆。",
      duration: Infinity,
      id: TOAST_ID,
      onDismiss: () => claudeAuth.set({ dismissed: true }),
    });
  }, [first, dismissed, expired, target, out.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  return target ? <ClaudeLoginSheet onOpenChange={(o) => { if (!o) setTarget(undefined); }} open target={target} /> : null;
}
