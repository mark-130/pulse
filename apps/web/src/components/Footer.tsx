import { useEffect, useState } from "react";

/** The project signature (D65). Exact text, no punctuation. */
export const TAGLINE = "Factum a Marco pro Marco";

/** True while the on-screen keyboard is open: the visual viewport is much shorter than the window, or a text field has focus. */
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = globalThis.visualViewport;
    const textField = () => {
      const el = document.activeElement;
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    };
    const update = () => setOpen((vv ? window.innerHeight - vv.height > 150 : false) || (textField() && (vv ? window.innerHeight - vv.height > 80 : false)));
    update();
    vv?.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      vv?.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);
  return open;
}

/**
 * Small muted signature at the end of the scrolling content. In normal flow, never fixed or sticky, not interactive.
 * Hidden while the keyboard is open, and under an open modal dialog (see .app-footer in index.css).
 */
export function Footer() {
  const keyboard = useKeyboardOpen();
  if (keyboard) return null;
  return (
    <footer className="app-footer mt-10 flex flex-col items-center gap-2 text-center">
      <span aria-hidden className="size-1 rounded-full bg-accent" />
      <p className="text-[12px] italic tracking-[0.04em] text-muted">{TAGLINE}</p>
    </footer>
  );
}
