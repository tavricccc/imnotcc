import * as React from "react";

/** iOS can pan and shrink the visual viewport without resizing the layout viewport. */
export function useVisualViewport(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  React.useLayoutEffect(() => {
    const element = ref.current;
    const viewport = window.visualViewport;
    if (!enabled || !element || !viewport) return;
    const sync = () => {
      if (viewport.scale !== 1) return;
      element.style.setProperty("--visual-height", `${viewport.height}px`);
      element.style.setProperty("--visual-top", `${viewport.offsetTop}px`);
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      element.style.removeProperty("--visual-height");
      element.style.removeProperty("--visual-top");
    };
  }, [enabled, ref]);
}
