"use client";
import { useEffect, type ReactNode } from "react";

/**
 * A SQUARE, contained popup — a dimmed backdrop with a centred card, info
 * overlaid on the card. Deliberately NOT a full-screen takeover: a full-page
 * step for every piece of guidance buries the thing the operator is looking at
 * and loses their place. This keeps the journey visible behind the dim and puts
 * the detail on top of it, closable, so context is never lost.
 */
export default function Modal({
  open,
  onClose,
  title,
  children,
  maxWidth = 460,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  maxWidth?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4"
      style={{ background: "rgba(8,12,16,0.55)", backdropFilter: "blur(2px)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full rounded-3xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-2xl"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          {title && <h3 className="text-lg font-bold">{title}</h3>}
          <button
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--muted)]"
            style={{ background: "var(--bg-soft, rgba(0,0,0,0.05))" }}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
