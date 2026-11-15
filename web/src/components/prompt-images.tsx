import * as React from "react";
import { Plus, X } from "@phosphor-icons/react/ssr";
import { readImage, type PickedImage } from "@/lib/prompt";
import { Button } from "@/ui/button";
import { openImage } from "./lightbox";

export function PromptImages({ disabled, images, onRemove }: {
  disabled?: boolean; images: PickedImage[]; onRemove: (index: number) => void;
}) {
  if (!images.length) return null;
  return (
    <div className="message-in mb-2 flex gap-2 overflow-x-auto p-1.5">
      {images.map((img, index) => (
        <div className="relative shrink-0" key={index}>
          <button aria-label="放大圖片" className="block rounded-tile outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" onClick={() => openImage(img.url)} type="button"><img alt="" className="size-16 rounded-tile object-cover shadow-panel" src={img.url} /></button>
          <button aria-label="移除圖片" className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-contrast text-on-contrast shadow-float disabled:opacity-40" disabled={disabled} onClick={() => onRemove(index)} type="button">
            <X className="size-3" weight="bold" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The "+" button: images join the message; with `onFiles`, any other file is handed over too. */
export function ImagePicker({ disabled, onFiles, onPick, onReading }: {
  disabled?: boolean; onFiles?: (files: File[]) => void; onPick: (images: PickedImage[]) => void; onReading?: (reading: boolean) => void;
}) {
  const picker = React.useRef<HTMLInputElement>(null);
  const label = onFiles ? "加入圖片或檔案" : "加入圖片";
  return (
    <>
      <input accept={onFiles ? undefined : "image/*"} className="hidden" multiple onChange={async (event) => {
        const all = [...(event.target.files ?? [])];
        event.target.value = "";
        const others = onFiles ? all.filter((f) => !f.type.startsWith("image/")) : [];
        if (others.length) onFiles?.(others);
        const files = all.filter((f) => !others.includes(f)).slice(0, 8);
        if (!files.length) return;
        onReading?.(true);
        try {
          const picked = await Promise.all(files.map(readImage));
          onPick(picked.filter((image): image is PickedImage => image !== null));
        } finally { onReading?.(false); }
      }} ref={picker} type="file" />
      <Button aria-label={label} className="size-9" disabled={disabled} onClick={() => picker.current?.click()} size="icon" title={label} variant="ghost"><Plus weight="bold" /></Button>
    </>
  );
}
