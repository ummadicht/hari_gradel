"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";
import { FUNCTIONAL_TESTS } from "@/lib/tests";
import { DEFAULT_PROFILE, Profile } from "@/lib/profiles";
import { fetchDeviceInfo, DeviceInfo } from "@/lib/deviceFetch";
import { GAMES, Result } from "./Games";

type Phase = "intro" | "playing" | "done";

export default function Gauntlet({
  sessionId,
  model,
  profile: rawProfile,
}: {
  sessionId: string;
  model: string;
  profile: Partial<Profile>;
}) {
  const profile: Profile = useMemo(
    () => ({ ...DEFAULT_PROFILE, ...(rawProfile as Profile) }),
    [rawProfile]
  );

  const isIOS = useMemo(
    () =>
      typeof navigator !== "undefined" &&
      /iP(hone|ad|od)/.test(navigator.userAgent),
    []
  );

  // Resolve the profile's test ids to real tests, dropping Android-only tests
  // on iOS. Order follows the profile.
  const tests = useMemo(() => {
    const byId = new Map(FUNCTIONAL_TESTS.map((t) => [t.id, t]));
    return profile.tests
      .map((id) => byId.get(id))
      .filter((t): t is NonNullable<typeof t> => !!t)
      .filter((t) => !(isIOS && t.platform === "android"));
  }, [profile.tests, isIOS]);

  const strict = profile.coverage === "strict";
  const scale = profile.tuning?.targetScale ?? 1;
  const isBlitz = profile.mode === "blitz";

  const [phase, setPhase] = useState<Phase>("intro");
  const [idx, setIdx] = useState(0);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(profile.timeLimitSec ?? 90);
  const finished = useRef(false);


  // Auto-fetch device signals on the intro and attach to the session.
  useEffect(() => {
    fetchDeviceInfo()
      .then((info) => {
        setDevice(info);
        fetch(withBase(`/api/sessions/${sessionId}/device`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device: info, model: info.modelGuess }),
        }).catch(() => {});
      })
      .catch(() => {});
  }, [sessionId]);

  // Blitz global countdown.
  useEffect(() => {
    if (phase !== "playing" || !isBlitz) return;
    const t = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(t);
          finishTimeout();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, isBlitz]);

  function record(r: Result) {
    if (finished.current) return;
    const test = tests[idx];
    const next = { ...results, [test.id]: r };
    setResults(next);
    if (idx + 1 < tests.length) setIdx(idx + 1);
    else finish(next);
  }

  // Immersive full-screen game (best-effort; iOS Safari on iPhone no-ops, but
  // the fixed .stage already fills the viewport).
  function startPlaying() {
    try {
      document.documentElement.requestFullscreen?.();
    } catch {
      /* not allowed */
    }
    setPhase("playing");
  }
  function exitFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen?.();
    } catch {
      /* noop */
    }
  }

  function finishTimeout() {
    // Whatever wasn't reached before the buzzer counts as skipped.
    const next = { ...results };
    tests.forEach((t) => {
      if (!next[t.id]) next[t.id] = "skip";
    });
    finish(next);
  }

  async function finish(final: Record<string, Result>) {
    if (finished.current) return;
    finished.current = true;
    exitFullscreen();
    setPhase("done");
    await fetch(withBase(`/api/sessions/${sessionId}/functional`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ functional: final }),
    }).catch(() => {});
  }

  /* ---------------- INTRO ---------------- */
  if (phase === "intro") {
    return (
      <div className="stage items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <div className="text-5xl floaty">{isBlitz ? "⚡" : "🎮"}</div>
          <h1 className="mt-4 text-2xl font-extrabold">
            Grade<span className="grad-text">IQ</span>{" "}
            {isBlitz ? "Blitz" : "self-test"}
          </h1>
          <p className="mt-2 text-[var(--muted)]">
            {model ? `${model} · ` : ""}
            {isBlitz
              ? `${tests.length} checks in ${profile.timeLimitSec}s — beat the clock!`
              : `${tests.length} quick mini-games check every part. ~90 seconds.`}
          </p>

          {profile.requireWipe && (
            <div className="card mt-4 p-3 text-left text-sm text-[var(--muted)]">
              💡 Keep the phone signed in &amp; working for the test. You&apos;ll
              sign out &amp; factory-reset <b>after</b> you accept the offer —
              right before payout.
            </div>
          )}

          {device && (
            <p className="mt-4 text-xs text-[var(--muted)]">
              Detected: <b>{device.modelGuess}</b> · {device.screen}
              {device.storageGB ? ` · ~${device.storageGB}GB` : ""}
              {device.battery ? ` · 🔋${device.battery.level}%` : ""}
            </p>
          )}

          <button
            className="btn mt-6 w-full"
            onClick={startPlaying}
          >
            {isBlitz ? "Start the clock ⚡" : "Start testing →"}
          </button>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Nothing is installed — this runs entirely in your browser.
          </p>
        </div>
      </div>
    );
  }

  /* ---------------- DONE ---------------- */
  if (phase === "done") {
    const passed = Object.values(results).filter((r) => r === "pass").length;
    const failed = Object.values(results).filter((r) => r === "fail").length;
    return (
      <div className="stage items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <div className="text-6xl">{failed ? "⚠️" : "✅"}</div>
          <h1 className="mt-4 text-2xl font-extrabold">
            {isBlitz ? `Score: ${passed}` : "All done!"}
          </h1>
          <p className="mt-2 text-[var(--muted)]">
            {passed} passed · {failed} failed
            {isBlitz && secondsLeft > 0 ? ` · ${secondsLeft}s to spare` : ""}.
          </p>

          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {tests.map((t) => (
              <span key={t.id} className="pill">
                {results[t.id] === "pass"
                  ? "✅"
                  : results[t.id] === "fail"
                    ? "❌"
                    : "⏭️"}{" "}
                {t.name}
              </span>
            ))}
          </div>

          {/* Two-device model: this phone just ran the tests; photos + offer
              happen on the inspector device, which picks up automatically. */}
          <div className="card mt-6 p-4 text-center">
            <p className="text-sm font-semibold">✅ Tests complete</p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Hand the phone back — the results just synced to the inspector.
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- PLAYING ---------------- */
  const test = tests[idx];
  const Game = GAMES[test.id];
  const passSoFar = Object.values(results).filter((r) => r === "pass").length;
  return (
    <div className="stage">
      {isBlitz ? (
        <div className="flex items-center justify-between px-4 pt-3">
          <span className="pill">🏆 {passSoFar}</span>
          <div className="mx-3 h-2 flex-1 overflow-hidden rounded-full bg-[var(--card-2)]">
            <div
              className="h-full transition-all"
              style={{
                width: `${(secondsLeft / (profile.timeLimitSec || 90)) * 100}%`,
                background:
                  secondsLeft < 15 ? "var(--bad)" : "var(--grad)",
              }}
            />
          </div>
          <span
            className="pill mono"
            style={{ color: secondsLeft < 15 ? "var(--bad)" : undefined }}
          >
            {secondsLeft}s
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-4 pt-3">
          {tests.map((t, i) => (
            <div
              key={t.id}
              className="h-1.5 flex-1 rounded-full"
              style={{
                background:
                  i < idx
                    ? "var(--good)"
                    : i === idx
                      ? "var(--brand)"
                      : "var(--card-2)",
              }}
            />
          ))}
        </div>
      )}
      <div className="px-4 pt-1 text-center text-xs text-[var(--muted)]">
        {idx + 1} / {tests.length}
      </div>
      <div className="flex-1 overflow-hidden">
        {Game ? (
          <Game
            test={test}
            onDone={record}
            strict={strict}
            scale={scale}
            model={model}
          />
        ) : null}
      </div>
    </div>
  );
}
