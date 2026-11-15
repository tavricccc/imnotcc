// The app's own right-click menu, in place of the browser's (or WebView2's). A right-click asks
// the element under the pointer, and its ancestors, what can be done there (see `useContextItems`),
// and adds the basics: copy what is selected, cut/paste in a field, select all.
// Shift + right-click still opens the native menu; a touch long-press is left to the phone.
// Links to other sites get open / copy; in the desktop app a click on one opens the system browser.
import * as React from "react";
import { DropdownMenu } from "radix-ui";
import type { Icon } from "@phosphor-icons/react";
import { ArrowSquareOut, ClipboardText, Copy, Link, Quotes, Scissors, SelectionAll } from "@phosphor-icons/react/ssr";
import { externalHref, interceptLinks, OPEN_LINK_LABEL, openLink } from "@/lib/links";
import { cn } from "@/lib/utils";

export interface ContextItem {
  key: string;
  label: string;
  icon: Icon;
  onSelect: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
}
/** What a right-click on `target` (inside the element that registered) can do; null for nothing. */
type Provider = (target: Element) => ContextItem[] | null;

const providers = new WeakMap<Element, Provider>();

/** Offers `items` when the element behind `ref`, or anything inside it, is right-clicked. */
export function useContextItems(ref: React.RefObject<Element | null>, items: Provider) {
  const latest = React.useRef(items);
  latest.current = items;
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const provider: Provider = (target) => latest.current(target);
    providers.set(el, provider);
    return () => { if (providers.get(el) === provider) providers.delete(el); };
  });
}

/** Where 「引用到輸入框」 sends a quote: the open chat's composer, while there is one. */
let quoteTarget: ((text: string) => void) | null = null;
export function useQuoteTarget(fn: (text: string) => void) {
  const latest = React.useRef(fn);
  latest.current = fn;
  React.useEffect(() => {
    const target = (text: string) => latest.current(text);
    quoteTarget = target;
    return () => { if (quoteTarget === target) quoteTarget = null; };
  }, []);
}

type Field = HTMLInputElement | HTMLTextAreaElement;
const TEXT_INPUTS = new Set(["text", "search", "url", "email", "tel", "password", "number", ""]);
function fieldOf(target: Element): Field | HTMLElement | null {
  const field = target.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
  if (field instanceof HTMLInputElement && !TEXT_INPUTS.has(field.type)) return null;
  return field as Field | HTMLElement | null;
}
const isField = (el: Element): el is Field => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

interface Opened { x: number; y: number; items: ContextItem[][] }

export function ContextMenuHost() {
  const [menu, setMenu] = React.useState<Opened | null>(null);
  const touch = React.useRef(false);

  React.useEffect(() => {
    const onPointer = (e: PointerEvent) => { touch.current = e.pointerType === "touch"; };
    const onMenu = (e: MouseEvent) => {
      if (e.shiftKey || touch.current || !(e.target instanceof Element)) return;
      e.preventDefault();
      const target = e.target;
      const groups: ContextItem[][] = [];
      // The nearest element that offers something speaks for this spot.
      for (let el: Element | null = target; el; el = el.parentElement) {
        const provider = providers.get(el);
        const items = provider?.(target);
        if (items?.length) { groups.push(items); break; }
      }
      // A link to another site: open it (system browser in the desktop app, else a new tab) or copy it.
      const href = externalHref(target);
      if (href) groups.push([
        { key: "open-link", label: OPEN_LINK_LABEL(), icon: ArrowSquareOut, onSelect: () => openLink(href) },
        { key: "copy-link", label: "複製連結", icon: Link, onSelect: () => { void copy(href); } },
      ]);
      const basics = basicItems(target);
      if (basics.length) groups.push(basics);
      if (groups.length) setMenu({ x: e.clientX, y: e.clientY, items: groups });
    };
    window.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("contextmenu", onMenu);
    const stopLinks = interceptLinks();
    return () => {
      stopLinks();
      window.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("contextmenu", onMenu);
    };
  }, []);

  return (
    <DropdownMenu.Root modal={false} onOpenChange={(o) => { if (!o) setMenu(null); }} open={!!menu}>
      <DropdownMenu.Trigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className="float-surface z-[100] min-w-48 rounded-panel border border-line bg-surface-solid p-1 text-ink shadow-float"
          collisionPadding={8}
          // Focus goes back where the action needs it (a field), not to the hidden anchor.
          onCloseAutoFocus={(e) => e.preventDefault()}
          side="bottom"
          sideOffset={2}
        >
          {menu?.items.map((group, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <DropdownMenu.Separator className="mx-2 my-1 h-px bg-line" /> : null}
              {group.map(({ disabled, icon: ItemIcon, key, label, onSelect, tone }) => (
                <DropdownMenu.Item
                  className={cn(
                    "flex h-8.5 cursor-pointer items-center gap-2.5 rounded-tile px-2.5 text-[0.875rem] outline-none data-[disabled]:cursor-default data-[disabled]:opacity-40 data-[highlighted]:bg-surface-raised [&_svg]:size-4 [&_svg]:text-ink-muted",
                    tone === "danger" && "text-danger [&_svg]:!text-danger",
                  )}
                  disabled={disabled}
                  key={key}
                  onSelect={onSelect}
                >
                  <ItemIcon aria-hidden />{label}
                </DropdownMenu.Item>
              ))}
            </React.Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Copy, cut, paste and select all, as fit the spot that was right-clicked. */
function basicItems(target: Element): ContextItem[] {
  const field = fieldOf(target);
  if (field) {
    // Kept now: the menu takes focus, and the action puts it back with the same selection.
    const restore = rememberFocus(field);
    const selected = isField(field) ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0) : String(document.getSelection() ?? "");
    const editable = !(isField(field) && (field.readOnly || field.disabled));
    const secret = field instanceof HTMLInputElement && field.type === "password";
    return [
      { key: "cut", label: "剪下", icon: Scissors, disabled: !selected || !editable || secret, onSelect: () => { void copy(selected).then(() => { restore(); document.execCommand("delete"); }); } },
      { key: "copy", label: "複製", icon: Copy, disabled: !selected || secret, onSelect: () => { void copy(selected); restore(); } },
      { key: "paste", label: "貼上", icon: ClipboardText, disabled: !editable, onSelect: () => { void paste(restore); } },
      { key: "all", label: "全選", icon: SelectionAll, onSelect: () => { restore(); if (isField(field)) field.select(); else document.execCommand("selectAll"); } },
    ];
  }
  const selection = document.getSelection();
  const selected = selection && !selection.isCollapsed ? selection.toString() : "";
  const items: ContextItem[] = [];
  if (selected) {
    items.push({ key: "copy", label: "複製", icon: Copy, onSelect: () => { void copy(selected); } });
    const quote = quoteTarget;
    if (quote) items.push({ key: "quote", label: "引用到輸入框", icon: Quotes, onSelect: () => quote(selected) });
  }
  // The text of the area it is in (a reply, a file); the app's chrome is not selectable.
  const area = target.closest("[data-selectable], pre");
  if (area) items.push({ key: "all", label: "全選", icon: SelectionAll, onSelect: () => document.getSelection()?.selectAllChildren(area) });
  return items;
}

function rememberFocus(field: HTMLElement) {
  const start = isField(field) ? field.selectionStart : null;
  const end = isField(field) ? field.selectionEnd : null;
  const range = !isField(field) && document.getSelection()?.rangeCount ? document.getSelection()!.getRangeAt(0).cloneRange() : null;
  return () => {
    field.focus({ preventScroll: true });
    if (isField(field) && start != null && end != null) field.setSelectionRange(start, end);
    else if (range) { const sel = document.getSelection(); sel?.removeAllRanges(); sel?.addRange(range); }
  };
}

const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

async function paste(restore: () => void) {
  let text: string;
  try { text = await navigator.clipboard.readText(); } catch { restore(); return; }
  restore();
  // Typed in the way the browser would, so undo and the field's own change handling still work.
  if (!document.execCommand("insertText", false, text)) {
    const el = document.activeElement;
    if (el && isField(el)) el.setRangeText(text, el.selectionStart ?? 0, el.selectionEnd ?? 0, "end");
  }
}
