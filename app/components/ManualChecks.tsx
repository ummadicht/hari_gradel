"use client";
import { useState } from "react";
import { withBase } from "@/lib/basePath";
import { FUNCTIONAL_TESTS, testById } from "@/lib/tests";

// The functional report, grouped like a proper diagnostics sheet. LEFT: every
// check GradeIQ can ACTUALLY run in a browser (auto results + manual fallback
// for anything the device couldn't reach). RIGHT: the deep-hardware items a
// browser genuinely can't read — shown honestly as "needs attestation", never
// faked with green checks (that data would come from Phonecheck / OEM tools).

type St = "pass" | "fail" | "skip" | "untested";
type LensSt = "pass" | "fail" | "manual";
/**
 * `by` is WHO decided this lens, and it is not cosmetic detail.
 *
 * The browser cannot select an iPhone's ultrawide or telephoto — it exposes one
 * rear camera for three or four lenses — so those verdicts come from a person
 * tapping Working/Faulty on this report, not from a measurement. Rendered
 * identically, an asserted fault is indistinguishable from a tested one, and a
 * payout dispute has no way to tell them apart. Absent on lenses written before
 * this existed, which is read as "browser". "vision" is the lens check from the
 * seller's own zoom photos — a model's reading, so the operator can overrule it.
 */
type Lens = {
  id: string;
  name: string;
  facing: string;
  state: LensSt;
  by?: "browser" | "operator" | "vision";
  at?: string;
};

/** Who decided a lens, in words — never "tested by browser" for a photo verdict. */
const provenance = (by: Lens["by"]) =>
  by === "operator" ? "checked by hand" : by === "vision" ? "from seller photos" : "tested by browser";

const GROUPS: { title: string; ids: string[] }[] = [
  { title: "Touch & Display", ids: ["touch", "multitouch", "display"] },
  { title: "Audio", ids: ["speaker", "mic"] },
  { title: "Cameras", ids: ["camera"] },
  { title: "Sensors & Motion", ids: ["motion", "vibration"] },
  { title: "Biometrics", ids: ["faceid"] },
  { title: "Buttons", ids: ["buttons"] },
];

// Deep hardware a browser CANNOT read — honest, greyed, never a fake pass.
// `answeredBy` names the Diagnostics item that can answer it from a Phonecheck
// station record; when the report's Diagnostics show it from a station, the
// line points there instead of claiming it still needs Phonecheck.
const ATTEST: { name: string; why: string; answeredBy?: "battery" | "activationLock" }[] = [
  { name: "Battery health & cycle count", why: "OEM battery data", answeredBy: "battery" },
  { name: "Secure Enclave / activation lock", why: "Phonecheck ESN", answeredBy: "activationLock" },
  { name: "LiDAR scanner", why: "no browser API" },
  { name: "UWB (ultra-wideband)", why: "no browser API" },
  { name: "Cellular / Wi-Fi / Bluetooth radios", why: "no browser API" },
  { name: "GPS / GNSS antenna", why: "location ≠ radio health" },
  { name: "True Tone / ambient light", why: "no browser API" },
  { name: "Taptic Engine calibration", why: "buzz ≠ calibration" },
];

export default function ManualChecks({
  sessionId,
  initial,
  camera,
  deviceOs,
  canOverride = false,
  stationAnswered = {},
}: {
  sessionId: string;
  initial: Record<string, string>;
  camera?: { lenses?: Lens[] };
  deviceOs?: string; // "ios" | "android" | "" — hides platform-specific tests
  /**
   * Staff only. Overruling a photo verdict can REMOVE a camera repair
   * deduction, and this component also renders on the seller's own report — a
   * seller must never be offered a button that clears their own fault. Marking
   * an unmeasured lens is staff-only for the same reason: it is recorded as
   * "checked by hand" (and /functional refuses that stamp without a sign-in).
   */
  canOverride?: boolean;
  /**
   * Items the report's Diagnostics already show from a Phonecheck station
   * record (lib/passport.ts) — so this card does not contradict them.
   */
  stationAnswered?: { battery?: boolean; activationLock?: boolean };
}) {
  // Only show a platform-specific test (e.g. Face ID = iOS, Vibration = Android)
  // when it matches the device; "all" tests always show, and if we can't tell
  // the OS we show everything.
  const platOk = (p?: string) => p === "all" || !deviceOs || p === deviceOs;
  const [state, setState] = useState<Record<string, string>>(initial);
  const [lenses, setLenses] = useState<Lens[]>(camera?.lenses ?? []);
  /** What the server said about the last tap, when it did not simply save it. */
  const [msg, setMsg] = useState<string | null>(null);

  /**
   * Save one tap, then show what the RECORD holds. The server may keep an
   * earlier result (a fault recorded before stays until the store clears it)
   * or refuse the write (the check is final), and the buttons used to show the
   * tap regardless.
   */
  async function save(body: Record<string, unknown>, undo: () => void) {
    try {
      const r = await fetch(withBase(`/api/sessions/${sessionId}/functional`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        undo();
        setMsg(typeof d?.error === "string" && d.error ? d.error : `Not saved (the server answered ${r.status}).`);
        return;
      }
      if (d?.session?.functional && typeof d.session.functional === "object") setState(d.session.functional);
      if (Array.isArray(d?.session?.camera?.lenses)) setLenses(d.session.camera.lenses);
      setMsg(typeof d?.notice === "string" && d.notice ? d.notice : null);
    } catch {
      undo();
      setMsg("Not saved — check the connection and try again.");
    }
  }

  async function mark(id: string, res: "pass" | "fail") {
    const before = state;
    setState((s) => ({ ...s, [id]: res }));
    await save({ functional: { [id]: res }, merge: true }, () => setState(before));
  }

  async function markLens(lensId: string, res: LensSt) {
    const beforeLenses = lenses;
    const beforeState = state;
    const next: Lens[] = lenses.map((l) =>
      // Stamp WHO decided it. Without this the record cannot distinguish a lens
      // the browser measured from one a person asserted, and on a camera the
      // browser can never select, every verdict here is an assertion.
      l.id === lensId ? { ...l, state: res, by: "operator" as const, at: new Date().toISOString() } : l
    );
    setLenses(next);
    const anyFail = next.some((l) => l.state === "fail");
    const anyPending = next.some((l) => l.state === "manual");
    const camState = anyFail ? "fail" : anyPending ? "skip" : "pass";
    setState((s) => ({ ...s, camera: camState }));
    await save(
      {
        functional: { camera: camState },
        /* RECOUNT, don't just swap the array.
         *
         * `expected/verified/manual/failed` were written once by the automatic
         * test and then left alone while the lens states changed underneath
         * them. That left records asserting `failed: 0, manual: 2` alongside two
         * lenses marked "fail" — a contradiction that reads as a broken pipeline
         * to anyone auditing it, and that is exported to SuperIQ as-is. */
        camera: {
          ...(camera || {}),
          lenses: next,
          expected: next.length,
          verified: next.filter((l) => l.state === "pass").length,
          manual: next.filter((l) => l.state === "manual").length,
          failed: next.filter((l) => l.state === "fail").length,
        },
        merge: true,
      },
      () => {
        setLenses(beforeLenses);
        setState(beforeState);
      }
    );
  }

  const st = (id: string): St => (state[id] as St) || "untested";
  const tested = FUNCTIONAL_TESTS.filter((t) => st(t.id) === "pass" || st(t.id) === "fail");
  const passed = tested.filter((t) => st(t.id) === "pass").length;

  const Dot = ({ s }: { s: St }) => (
    <span
      className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px]"
      style={{
        background:
          s === "pass"
            ? "color-mix(in oklch, var(--green) 20%, transparent)"
            : s === "fail"
              ? "color-mix(in oklch, var(--bad) 18%, transparent)"
              : "var(--bg-soft)",
        color: s === "pass" ? "var(--green-ink)" : s === "fail" ? "var(--bad)" : "var(--muted)",
      }}
    >
      {s === "pass" ? "✓" : s === "fail" ? "✕" : "–"}
    </span>
  );

  function Row({ id }: { id: string }) {
    const t = testById(id);
    if (!t) return null;
    const s = st(id);
    const needsManual = s === "skip" || s === "untested";
    // With a lens list, "camera working" means every lens was checked — the
    // same staff-only call as the lens buttons below (the API keeps the camera
    // at "skip" for anyone else while a lens is unchecked).
    const lensGated = id === "camera" && lenses.length > 0 && !canOverride;
    return (
      <div className="flex items-center justify-between gap-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <Dot s={s} />
          <div>
            <div className="text-[14px] font-medium">{t.name}</div>
            {needsManual && (
              <div className="text-[11.5px]" style={{ color: "var(--gold-2)" }}>
                Not auto-tested — check manually
              </div>
            )}
          </div>
        </div>
        {s === "pass" ? (
          <span className="text-[12.5px] font-medium" style={{ color: "var(--green-ink)" }}>
            Working
          </span>
        ) : s === "fail" ? (
          <span className="text-[12.5px] font-medium" style={{ color: "var(--bad)" }}>
            Faulty
          </span>
        ) : lensGated ? (
          <span className="text-[12px] text-[var(--muted)]">Needs a hands-on check</span>
        ) : (
          <div className="flex gap-1.5">
            <button onClick={() => mark(id, "pass")} className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[12px]" style={{ color: "var(--green-ink)" }}>
              Working
            </button>
            <button onClick={() => mark(id, "fail")} className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[12px]" style={{ color: "var(--bad)" }}>
              Faulty
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="mt-4 grid gap-4 md:grid-cols-2">
      {msg && (
        <div
          role="status"
          className="rounded-2xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-[13px] md:col-span-2"
          style={{ color: "var(--gold-2)" }}
        >
          {msg}
        </div>
      )}
      {/* LEFT — real browser-native checks */}
      <div className="rounded-3xl border border-[var(--border)] bg-[var(--card)] px-6 py-8 sm:px-8">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-[15px] font-bold">GradeIQ Functional Checks</h2>
          <span className="rounded-full px-2.5 py-0.5 text-[13px] font-semibold" style={{ background: "var(--bg-soft)", color: "var(--muted)" }}>
            {passed} / {tested.length || FUNCTIONAL_TESTS.length}
          </span>
        </div>
        <p className="mb-4 text-[12.5px] text-[var(--muted)]">
          Browser-native · auto-run on the device, manual fallback for the rest.
        </p>

        {GROUPS.map((g) => {
          const rows = g.ids.filter((id) => { const t = testById(id); return !!t && platOk(t.platform); });
          if (!rows.length) return null;
          const groupPass = rows.filter((id) => st(id) === "pass").length;
          return (
            <div key={g.title} className="mb-4">
              <div className="mb-1 flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
                  {g.title}
                </h3>
                {/* For Cameras, count LENSES not tests. The group used to read
                    "1/1" because there is one `camera` test — while two of the
                    four actual lenses had never been tested. The summary has to
                    count the same things the rows below it list. */}
                {g.ids.includes("camera") && lenses.length ? (
                  <span
                    className="text-[11px] font-semibold"
                    style={{
                      color: lenses.some((l) => l.state === "fail")
                        ? "var(--bad)"
                        : lenses.some((l) => l.state === "manual")
                          ? "var(--gold-2)"
                          : "var(--muted)",
                    }}
                  >
                    {lenses.filter((l) => l.state === "pass").length}/{lenses.length} lenses verified
                  </span>
                ) : (
                  <span className="text-[11px] text-[var(--muted)]">{groupPass}/{rows.length}</span>
                )}
              </div>
              <div className="divide-y divide-[var(--border)]">
                {rows.map((id) => (
                  <Row key={id} id={id} />
                ))}
                {/* Per-lens camera breakdown lives under Cameras */}
                {g.ids.includes("camera") &&
                  lenses.map((l) => {
                    const manual = l.state === "manual";
                    return (
                      <div key={l.id} className="flex items-center justify-between gap-3 py-2.5 pl-7">
                        <div>
                          <div className="text-[13.5px]">
                            {l.name}{" "}
                            <span className="text-[11px] text-[var(--muted)]">{l.facing}</span>
                          </div>
                          {manual && (
                            <div className="text-[11.5px]" style={{ color: "var(--gold-2)" }}>
                              <b>Not tested.</b> The browser could not open this lens on its own —
                              check it by hand before trusting the camera result.
                            </div>
                          )}
                        </div>
                        {l.state === "pass" ? (
                          <div className="text-right">
                            <span
                              className="text-[12.5px] font-medium"
                              style={{ color: "var(--green-ink)" }}
                              title="The lens opened and delivered a live image. This does not test focus, or detect a cracked lens or blur."
                            >
                              {l.by === "operator" ? "Working" : "Verified"}
                            </span>
                            {/* Only when we actually KNOW. Lenses recorded before
                                provenance existed have no `by`, and defaulting
                                those to "tested by browser" would assert a
                                measurement that may never have happened — the
                                exact overclaim this line exists to prevent. */}
                            {l.by && (
                              <div className="text-[10.5px] text-[var(--muted)]">{provenance(l.by)}</div>
                            )}
                            {/* A photo verdict is a model's reading — the operator may overrule it. */}
                            {canOverride && l.by === "vision" && (
                              <button
                                onClick={() => markLens(l.id, "fail")}
                                className="mt-0.5 text-[10.5px] underline text-[var(--muted)]"
                              >
                                Mark faulty
                              </button>
                            )}
                          </div>
                        ) : l.state === "fail" ? (
                          <div className="text-right">
                            <span className="text-[12.5px] font-medium" style={{ color: "var(--bad)" }}>
                              Faulty
                            </span>
                            {/* A lens the browser cannot select was never measured, so
                                saying only "Faulty" would present someone's tap as a
                                test result. On a dispute that difference is the case. */}
                            {/* Only when we actually KNOW. Lenses recorded before
                                provenance existed have no `by`, and defaulting
                                those to "tested by browser" would assert a
                                measurement that may never have happened — the
                                exact overclaim this line exists to prevent. */}
                            {l.by && (
                              <div className="text-[10.5px] text-[var(--muted)]">{provenance(l.by)}</div>
                            )}
                            {/* A photo verdict is a model's reading — the operator may overrule it. */}
                            {canOverride && l.by === "vision" && (
                              <button
                                onClick={() => markLens(l.id, "pass")}
                                className="mt-0.5 text-[10.5px] underline text-[var(--muted)]"
                              >
                                Mark working
                              </button>
                            )}
                          </div>
                        ) : canOverride ? (
                          <div className="flex gap-1.5">
                            <button onClick={() => markLens(l.id, "pass")} className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[12px]" style={{ color: "var(--green-ink)" }}>
                              Working
                            </button>
                            <button onClick={() => markLens(l.id, "fail")} className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[12px]" style={{ color: "var(--bad)" }}>
                              Faulty
                            </button>
                          </div>
                        ) : (
                          /* A tap here is stamped "checked by hand" — an operator's
                             word on the record. The API takes that stamp only from
                             a staff sign-in (403 otherwise), so the seller's own
                             report only says the lens still needs a person to look. */
                          <span className="text-[12px] text-[var(--muted)]">Needs a hands-on check</span>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          );
        })}
      </div>

      {/* RIGHT — honest attestation boundary (never faked) */}
      <div className="rounded-3xl border border-[var(--border)] bg-[var(--card)] px-6 py-8 sm:px-8">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-[15px] font-bold">Deep hardware attestation</h2>
          <span className="rounded-full px-2.5 py-0.5 text-[12px] font-semibold" style={{ background: "color-mix(in oklch, var(--gold) 14%, transparent)", color: "var(--gold-2)" }}>
            Needs a station or OEM test
          </span>
        </div>
        <p className="mb-4 text-[12.5px] text-[var(--muted)]">
          A browser can&apos;t read these — GradeIQ will not fake them. They need
          a hands-on test on a Phonecheck station or an OEM tool; what a station
          record on this report answers is shown under Diagnostics.
        </p>
        <div className="divide-y divide-[var(--border)]">
          {ATTEST.map((a) => {
            const answered = !!(a.answeredBy && stationAnswered[a.answeredBy]);
            return (
              <div key={a.name} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--bg-soft)] text-[11px] text-[var(--muted)]">
                    {answered ? "→" : "○"}
                  </span>
                  <div className="text-[14px] text-[var(--muted)]">{a.name}</div>
                </div>
                <span className="text-[11px] text-[var(--muted)]">
                  {answered ? "See Diagnostics · Phonecheck station" : a.why}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
