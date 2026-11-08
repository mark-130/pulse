import { useEffect, useRef, type ReactNode } from "react";

/** Native modal dialog. Focus lands on the dialog itself, never on a button, so nothing is pre-selected. */
export function Modal({ open, onClose, labelledBy, children }: { open: boolean; onClose: () => void; labelledBy: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      d.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby={labelledBy}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100%-2.5rem))] overflow-y-auto rounded-3xl border border-border-strong bg-surface p-5 text-foreground outline-none backdrop:bg-black/60 max-md:mb-0 max-md:rounded-b-none"
    >
      {open && children}
    </dialog>
  );
}
