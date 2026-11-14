import * as React from "react";

/**
 * iOS can pan and shrink the visual viewport without resizing the layout viewport. The element
 * gets the visible height and offset, and `data-keyboard` while an on-screen keyboard covers the
 * bottom, so the home-indicator inset can be dropped there.
 */
export function useVisualViewport(ref: React.RefObject<HTMLElement | null>, enabled: boolean) {
  React.useLayoutEffect(() => {
    const element = ref.current;
    const viewport = window.visualViewport;
    if (!enabled || !element || !viewport) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      if (viewport.scale > 1.01) return;
      // A fixed layout never needs the document scrolled; iOS scrolls it to reveal the focused field.
      if (window.scrollY) window.scrollTo(0, 0);
      element.style.setProperty("--visual-height", `${viewport.height}px`);
      element.style.setProperty("--visual-top", `${viewport.offsetTop}px`);
      element.toggleAttribute("data-keyboard", window.innerHeight - viewport.height > 120);
    };
    const queue = () => { if (!frame) frame = requestAnimationFrame(sync); };
    sync();
    viewport.addEventListener("resize", queue);
    viewport.addEventListener("scroll", queue);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", queue);
      viewport.removeEventListener("scroll", queue);
      element.style.removeProperty("--visual-height");
      element.style.removeProperty("--visual-top");
      element.removeAttribute("data-keyboard");
    };
  }, [enabled, ref]);
}
