import * as React from "react";
import { Plus, X } from "@phosphor-icons/react/ssr";
import { readImage, type PickedImage } from "@/lib/prompt";
import { Button } from "@/ui/button";

export function PromptImages({ disabled, images, onRemove }: {
  disabled?: boolean; images: PickedImage[]; onRemove: (index: number) => void;
}) {
  if (!images.length) return null;
  return (
    <div className="message-in mb-2 flex gap-2 overflow-x-auto p-1.5">
      {images.map((img, index) => (
        <div className="relative shrink-0" key={index}>
          <img alt="" className="size-16 rounded-tile object-cover shadow-panel" src={img.url} />
          <button aria-label="移除圖片" className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-contrast text-on-contrast shadow-float disabled:opacity-40" disabled={disabled} onClick={() => onRemove(index)} type="button">
            <X className="size-3" weight="bold" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ImagePicker({ disabled, onPick, onReading }: {
  disabled?: boolean; onPick: (images: PickedImage[]) => void; onReading?: (reading: boolean) => void;
}) {
  const picker = React.useRef<HTMLInputElement>(null);
  return (
    <>
      <input accept="image/*" className="hidden" multiple onChange={async (event) => {
        const files = [...(event.target.files ?? [])].slice(0, 8);
        event.target.value = "";
        onReading?.(true);
        try {
          const picked = await Promise.all(files.map(readImage));
          onPick(picked.filter((image): image is PickedImage => image !== null));
        } finally { onReading?.(false); }
      }} ref={picker} type="file" />
      <Button aria-label="加入圖片" className="size-9" disabled={disabled} onClick={() => picker.current?.click()} size="icon" variant="ghost"><Plus weight="bold" /></Button>
    </>
  );
}
