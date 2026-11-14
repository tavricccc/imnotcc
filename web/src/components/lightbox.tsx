import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ArrowSquareOut, X } from "@phosphor-icons/react/ssr";
import { createStore, useStore } from "@/lib/store-core";
import { cn } from "@/lib/utils";

const shown = createStore<{ src: string | null }>({ src: null });

/** Shows an image over everything, fitted to the screen; tapping it toggles its full size. */
export const openImage = (src: string) => shown.set({ src });

export function Lightbox() {
  const { src } = useStore(shown);
  const [zoomed, setZoomed] = React.useState(false);
  React.useEffect(() => setZoomed(false), [src]);
  return (
    <DialogPrimitive.Root onOpenChange={(open) => { if (!open) shown.set({ src: null }); }} open={!!src}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="scrim fixed inset-0 z-[60] bg-black/85" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn("fixed inset-0 z-[60] overflow-auto overscroll-contain outline-none", !zoomed && "grid place-items-center p-[max(1rem,var(--safe-top))]")}
          onClick={(event) => { if (event.target === event.currentTarget) shown.set({ src: null }); }}
        >
          <DialogPrimitive.Title className="sr-only">圖片</DialogPrimitive.Title>
          {src ? (
            <img
              alt=""
              className={cn("select-none", zoomed ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain")}
              onClick={() => setZoomed(!zoomed)}
              src={src}
            />
          ) : null}
          <div className="fixed right-[max(0.75rem,var(--safe-right,0px))] top-[max(0.75rem,var(--safe-top))] flex gap-2">
            {src && !src.startsWith("data:") ? (
              <a aria-label="在新分頁開啟" className="grid size-10 place-items-center rounded-full bg-black/60 text-white" href={src} rel="noopener noreferrer" target="_blank">
                <ArrowSquareOut className="size-5" weight="bold" />
              </a>
            ) : null}
            <DialogPrimitive.Close aria-label="關閉" className="grid size-10 place-items-center rounded-full bg-black/60 text-white">
              <X className="size-5" weight="bold" />
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * A small preview that opens in the lightbox. Given several sources it shows the first that
 * loads, and it disappears if none does.
 */
export function Thumb({ className, src }: { className?: string; src: string | string[] }) {
  const sources = Array.isArray(src) ? src : [src];
  const [tried, setTried] = React.useState(0);
  const current = sources[tried];
  if (!current) return null;
  return (
    <button className={cn("shrink-0 overflow-hidden rounded-tile shadow-panel outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]", className)} onClick={() => openImage(current)} type="button">
      <img alt="" className="block size-20 object-cover" loading="lazy" onError={() => setTried(tried + 1)} src={current} />
    </button>
  );
}
