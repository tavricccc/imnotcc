/**
 * Radix moves focus to the first button when a dialog opens, which is the close button, and the
 * browser then rings it as if it had been tabbed to. Focus the panel itself instead; a field that
 * focused itself on mount keeps it. Tab still walks into the dialog from there.
 */
export function focusPanel(event: Event) {
  event.preventDefault();
  const panel = event.currentTarget as HTMLElement | null;
  const active = document.activeElement as HTMLElement | null;
  if (panel && active && panel.contains(active) && active !== panel && active.matches("input, textarea, [contenteditable]")) return;
  if (panel && !panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
  panel?.focus({ preventScroll: true });
}
