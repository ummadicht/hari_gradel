"use client";
import { useEffect, useRef, useState } from "react";

// ── Connectivity chrome for the v2 flow.
// A trade-in gets done standing in a shop, a hallway or a car park — the link
// drops mid-capture and the seller's instinct is "I've lost it, start again".
// This is the one piece of UI allowed to float above the flow: it says the
// progress is safe and that we retry for them, then gets out of the way.

const BACK_ONLINE_MS = 2500; // how long the recovery state lingers before self-hiding

type Status = "online" | "offline" | "recovered";

export default function OfflineBanner() {
  // First paint is always "online" so the server HTML and hydration agree —
  // navigator.onLine only exists in the browser and is reconciled on mount.
  const [status, setStatus] = useState<Status>("online");
  const statusRef = useRef<Status>("online");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const set = (next: Status) => {
      statusRef.current = next;
      setStatus(next);
    };
    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const onOffline = () => {
      clearTimer();
      set("offline");
    };
    const onOnline = () => {
      clearTimer();
      // Only celebrate a recovery we actually witnessed. Browsers fire `online`
      // on wake/route changes too; with no prior drop the banner stays silent.
      if (statusRef.current !== "offline") {
        set("online");
        return;
      }
      set("recovered");
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        set("online");
      }, BACK_ONLINE_MS);
    };

    // Mount-time correction: we may have hydrated already offline.
    if (typeof navigator !== "undefined" && navigator.onLine === false) set("offline");

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      clearTimer();
    };
  }, []);

  if (status === "online") return null;

  const offline = status === "offline";

  return (
    <div
      role="status"
      aria-live="polite"
      // Non-interactive, so it never steals a tap from the screen underneath.
      className="pointer-events-none fixed inset-x-0 top-0 z-[90] px-3"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 8px)" }}
    >
      <div
        className="mx-auto flex w-full max-w-[420px] items-center gap-3 rounded-2xl px-4 py-3 shadow-lg transition"
        style={{
          background: offline ? "var(--t-bad)" : "var(--t-ok)",
          // Ink for a solid status fill. --t-cta-text is the theme's "on a filled
          // brand surface" colour, which is exactly what this is.
          color: "var(--t-cta-text)",
        }}
      >
        <span className="shrink-0" aria-hidden="true">
          {offline ? <WifiOffIcon /> : <CheckIcon />}
        </span>
        <p className="text-[14px] font-semibold leading-snug">
          {offline ? "You're offline — we'll keep your progress and retry automatically." : "Back online"}
        </p>
      </div>
    </div>
  );
}

function WifiOffIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <path d="M2 3.5 21.5 22" />
      <path d="M1.9 7.6A16 16 0 0 1 8.4 4.3" />
      <path d="M14.2 4.4a16 16 0 0 1 8 3.2" />
      <path d="M5.4 11.1a11 11 0 0 1 3.9-2.2" />
      <path d="M18.7 11.1a11 11 0 0 0-3-1.9" />
      <path d="M8.9 14.6a6 6 0 0 1 5.6-.4" />
      <path d="M12 19h.01" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <path d="M20 6.5 9.5 17 4 11.5" />
    </svg>
  );
}
