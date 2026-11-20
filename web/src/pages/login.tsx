import * as React from "react";
import { auth, post } from "@/lib/api";
import { isTauri, tauriInvoke } from "@/lib/tauri";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Panel } from "@/ui/panel";

export function LoginPage() {
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await post("/api/login", { password });
      auth.set({ authed: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-svh place-items-center px-[var(--gutter)] py-10">
      <form className="content-in grid w-full max-w-sm justify-items-center gap-6" onSubmit={submit}>
        <span className="drop-shadow-[0_8px_20px_rgb(0_0_0/0.14)]"><img alt="" className="app-icon size-20" src="/icon.svg" /></span>
        <div className="grid gap-1 text-center">
          <h1 className="text-2xl font-bold tracking-tight">imnotcc</h1>
          <p className="text-[0.9375rem] text-ink-muted">Claude Code 的圖形介面，電腦和手機都接得上</p>
        </div>
        <Panel className="grid w-full gap-4">
          <Field error={error} label="密碼">
            {({ describedBy, id, invalid }) => (
              <Input
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                autoComplete="current-password"
                autoFocus
                id={id}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                value={password}
              />
            )}
          </Field>
          <Button disabled={!password} size="lg" status={busy ? "loading" : "idle"} type="submit" variant="primary">登入</Button>
          {isTauri() ? (
            <Button onClick={() => void tauriInvoke("open_setup")} size="sm" type="button" variant="ghost">切換 Server / 初始設定</Button>
          ) : null}
        </Panel>
      </form>
    </main>
  );
}
