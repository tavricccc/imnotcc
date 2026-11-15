import * as React from "react";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Input } from "@/ui/field";

/** Asks for a conversation's new name; shared by the chat's options and the session list. */
export function RenameDialog({ initial, onOpenChange, onSave, open }: { initial: string; onOpenChange: (o: boolean) => void; onSave: (title: string) => Promise<void>; open: boolean }) {
  const [value, setValue] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => { if (open) { setValue(initial); setError(""); } }, [open, initial]);
  async function save() {
    setBusy(true);
    try { await onSave(value.trim()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={!value.trim()} onClick={() => void save()} status={busy ? "loading" : "idle"} variant="primary">儲存</Button>
        </>
      }
      onOpenChange={onOpenChange}
      open={open}
      title="改名"
    >
      <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (value.trim()) void save(); }}>
        <Input aria-label="新名稱" autoFocus onChange={(e) => setValue(e.target.value)} value={value} />
        {error ? <p className="message-in px-1 text-sm text-danger" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}
