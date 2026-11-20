// Keeps a session's message box the same on every device: what is typed here goes to the server
// shortly after, and what another device types shows up here unless this one has unsent typing.
import * as React from "react";
import { send, subscribe } from "./socket";

const SEND_MS = 250;

export function useComposerSync(session: string, text: string, setText: (text: string) => void, input: React.RefObject<HTMLTextAreaElement | null>) {
  const atKey = `imnotcc:composer:at:${session}`;
  // The text the server is known to have; typing that differs from it is still to be sent.
  const synced = React.useRef<string | null>(null);
  const latest = React.useRef(text);
  latest.current = text;
  const timer = React.useRef<number | undefined>(undefined);

  const editedAt = () => { try { return Number(localStorage.getItem(atKey)) || 0; } catch { return 0; } };
  const setEditedAt = (at: number) => { try { localStorage.setItem(atKey, String(at)); } catch { /* storage blocked */ } };

  React.useEffect(() => {
    synced.current = null;
    const off = subscribe(session, (m) => {
      if (m.kind === "snapshot") {
        // (Re)connected: offer what this device has; the server keeps whichever is newer.
        const text = latest.current;
        if (text || editedAt()) send(session, { t: "composer", text, at: editedAt() });
        synced.current = text;
        return;
      }
      if (m.kind !== "composer" || typeof m.text !== "string") return;
      // Typing here that has not gone out yet wins; it is about to be sent.
      if (synced.current !== null && latest.current !== synced.current) return;
      synced.current = m.text;
      if (typeof m.at === "number") setEditedAt(m.at);
      if (m.text === latest.current) return;
      const el = input.current;
      const focused = !!el && document.activeElement === el;
      // Keep the caret where it was, counted from the end, so text added above it does not jump it.
      const fromEnd = focused && el ? latest.current.length - el.selectionEnd : 0;
      setText(m.text);
      if (focused && el) requestAnimationFrame(() => {
        const at = Math.max(0, m.text.length - fromEnd);
        el.setSelectionRange(at, at);
      });
    });
    return () => { off(); window.clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  React.useEffect(() => {
    if (synced.current === null || text === synced.current) return;
    setEditedAt(Date.now());
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const value = latest.current;
      if (value === synced.current) return;
      if (send(session, { t: "composer", text: value })) synced.current = value;
    }, SEND_MS);
  }, [session, text]);
}
