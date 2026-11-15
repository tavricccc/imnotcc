import * as React from "react";
import { ArrowUp, Stop } from "@phosphor-icons/react/ssr";
import { readImage, type PickedImage } from "@/lib/prompt";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { ImagePicker, PromptImages } from "./prompt-images";

export function Composer({ attaching, busy, children, disabled, images, input, locked, onChange, onFiles, onImages, onInterrupt, onKeyDown, onLongPressSend, placeholder, text }: {
  /** Files are still uploading: sending waits for them. */
  attaching?: boolean;
  busy?: boolean;
  /** A long press on the send button calls this instead of submitting. */
  onLongPressSend?: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  images: PickedImage[];
  input: React.RefObject<HTMLTextAreaElement | null>;
  locked?: boolean;
  onChange: (value: string) => void;
  /** Files that are not images (picked, dropped or pasted); without it only images are taken. */
  onFiles?: (files: File[]) => void;
  onImages: React.Dispatch<React.SetStateAction<PickedImage[]>>;
  onInterrupt?: () => void;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  placeholder: string;
  text: string;
}) {
  const longPress = useLongPress(onLongPressSend);
  const [reading, setReading] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const full = locked || reading || images.length >= 8;
  // Pasted and dropped files take the same path as the picker.
  const addFiles = async (files: File[]) => {
    const others = onFiles ? files.filter((file) => !file.type.startsWith("image/")) : [];
    if (others.length) onFiles?.(others);
    const picked = files.filter((file) => file.type.startsWith("image/")).slice(0, 8 - images.length);
    if (!picked.length) return others.length > 0;
    setReading(true);
    try {
      const read = await Promise.all(picked.map(readImage));
      onImages((items) => [...items, ...read.filter((image): image is PickedImage => image !== null)].slice(0, 8));
    } finally { setReading(false); }
    return true;
  };
  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");
  React.useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [input, text]);

  return (
    <div
      className={cn("glass-float rounded-[1.625rem] px-2 pb-2 pt-1.5 transition-shadow duration-[var(--motion-control)]", dragging && "ring-2 ring-[var(--focus-ring)]")}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = full ? "none" : "copy";
        setDragging(!full);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        if (!full) void addFiles([...event.dataTransfer.files]);
      }}
    >
      <PromptImages disabled={locked} images={images} onRemove={(index) => onImages((items) => items.filter((_, i) => i !== index))} />
      <textarea aria-label="訊息" className="block max-h-[min(10rem,calc(var(--visual-height,100dvh)*0.35))] min-h-11 w-full resize-none bg-transparent px-2.5 py-2.5 text-base leading-6 outline-none placeholder:text-ink-muted" onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
        if ((reading || attaching) && event.key === "Enter" && !event.shiftKey && matchMedia("(pointer: fine)").matches) event.preventDefault();
        else onKeyDown(event);
      }} onPaste={(event) => {
        const files = [...event.clipboardData.files];
        if (full || !files.some((file) => onFiles || file.type.startsWith("image/"))) return;
        event.preventDefault();
        void addFiles(files);
      }} placeholder={placeholder} readOnly={locked} ref={input} rows={1} value={text} />
      <div className="mt-1 flex min-w-0 items-center gap-0.5 sm:gap-1">
        <ImagePicker disabled={full} onFiles={onFiles} onPick={(picked) => onImages((items) => [...items, ...picked].slice(0, 8))} onReading={setReading} />
        {children}
        {onInterrupt && !text.trim() && !images.length ? (
          <Button aria-label="中斷" className="ml-1 size-9" onClick={onInterrupt} size="icon" variant="primary"><Stop weight="fill" /></Button>
        ) : (
          <Button aria-label="送出" className="ml-1 size-9 touch-none select-none" disabled={disabled || reading || attaching || (!text.trim() && !images.length)} size="icon" status={busy ? "loading" : "idle"} type="submit" variant="primary" {...longPress}>{busy ? null : <ArrowUp weight="bold" />}</Button>
        )}
      </div>
    </div>
  );
}

/** Pointer handlers that fire `onLong` after a held press and swallow the click that follows. */
function useLongPress(onLong?: () => void) {
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const fired = React.useRef(false);
  if (!onLong) return {};
  const clear = () => clearTimeout(timer.current);
  return {
    onClick: (e: React.MouseEvent) => { if (fired.current) { e.preventDefault(); fired.current = false; } },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      fired.current = false;
      clear();
      timer.current = setTimeout(() => { fired.current = true; navigator.vibrate?.(10); onLong(); }, 500);
    },
    onPointerLeave: clear,
    onPointerUp: clear,
    onPointerCancel: clear,
  };
}
