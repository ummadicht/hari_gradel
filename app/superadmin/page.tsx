"use client";
import { useCallback, useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";
import { checkSessionDevices } from "@/lib/deviceMatch";
import { sessionAlias } from "@/lib/sessionAlias";
import ExceptionQueue, { countExceptions } from "./ExceptionQueue";
import CompliancePanel from "./CompliancePanel";
import {
  STAGES,
  STAGE_LABEL,
  TAG_LABEL,
  type Stage,
  type SessionTag,
} from "@/lib/sessionStage";
import {
  MIN_ENABLED_STEPS,
  ALL_DISPLAY_PATTERNS,
  type ClientJourney,
  type ChannelConfig,
} from "@/lib/journeyTypes";
import IntegrationsPanel from "./IntegrationsPanel";
import DeskPanel from "./DeskPanel";
import AuditPanel from "./AuditPanel";
import CatalogPanel from "./CatalogPanel";
import RegradeBar from "@/app/components/RegradeBar";
import RegradePanel from "./RegradePanel";
import RetailPanel from "./RetailPanel";
import UsersPanel from "./UsersPanel";
import CommandCenter from "./CommandCenter";

// Super-admin portal — Pandas-Hub-style layout: dark sidebar + wide content,
// built for laptop screens. admin/admin → every client; denovo / swapmoreus /
// swapmoreind → their own tenant. Journey edits apply to the LIVE flow on save;
// the Sessions monitor click-through shows the full session incl. the browser
// provenance of both devices (origin / camera / self-reported).

type Me = {
  user: { username: string; role: "super" | "client"; clientId: string | null };
  clients: { id: string; name: string; currency: string }[];
};

type SessionRow = {
  id: string;
  imei: string;
  model: string;
  status: string;
  client_id: string;
  cosmetic_grade: string;
  overall_grade: string;
  tier: string | null;
  review: number | null;
  capture_verdict: string | null;
  /** Derived server-side in lib/sessionStage.ts — where the phone actually got
   *  to, and what is worth knowing. Never a stored column. */
  stage: Stage;
  tags: SessionTag[];
  photo_count: number | null;
  /** Seller-picked, not IMEI-derived — see the sessions query. */
  storage: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
};

type Browser = {
  ua: string;
  ip?: string;
  at?: string;
  parsed: { kind: string; os: string; browser: string; model: string };
  platform?: string;
  screen?: string;
  battery?: { level: number; charging: boolean } | null;
  /**
   * Model resolved from the fingerprint, because the UA cannot carry it: iOS
   * never exposed it and Android Chrome redacted it to "K". `agrees` compares
   * that against the model the seller claimed.
   */
  model?: { label: string; candidates: string[]; basis: string };
  agrees?: "match" | "mismatch" | "unknown";
};

type SessionDetailData = {
  id: string;
  clientId: string;
  status: string;
  imei: string;
  model: string;
  grades: { cosmetic: string; functional: string; overall: string };
  vision: {
    tierUsed: string | null;
    escalated: boolean | null;
    score: number | null;
    conclusive: boolean | null;
    needsHumanReview: boolean | null;
    coverage: number | null;
    deviceMatch: { make?: string; model?: string; match?: string; reason?: string } | null;
    oem: { verdict?: string; evidence?: string[] } | null;
    obstruction: { present?: boolean; type?: string; note?: string } | null;
    findings: number;
    /** SUP-63: absent from an older server. */
    refine?: { state: "none" | "running" | "unfinished"; startedAt: string | null; unfinishedAfterSeconds: number };
    specialists: { id: string; grade: string; confidence: number; findings: number; notes: string }[];
  };
  capture: { verdict?: string; code?: string; reasons?: string[]; attempt?: number } | null;
  functional: Record<string, string>;
  offer: { offer?: number; currency?: string; blocked?: boolean; flags?: string[] } | Record<string, never>;
  photos: string[];
  shots: { url: string; kind?: string }[];
  ocrRead: { imei?: string; model?: string; storage?: string; batteryHealth?: number | null; serial?: string };
  display: {
    verdict: string;
    note: string;
    captures: { pattern: string; photo: string }[];
    requested: string[];
    missing: string[];
  };
  browsers: {
    origin: Browser | null;
    camera: Browser | null;
    reported: Browser | null;
    /** Second device checked in at this time even if its UA wasn't recorded. */
    cameraConnectedAt?: string;
  };
  path: {
    step: string;
    firstAt: string;
    lastAt: string;
    stayedSec: number | null;
    events: { event: string; at: string; detail: Record<string, any> }[];
  }[];
  events: { id: number; step: string; event: string; at: string; detail: Record<string, any> }[];
  profile: { segment?: string; channel?: string };
  created_at: string;
  updated_at: string;
};

function dur(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

const KIND_CHIP: Record<string, string> = {
  mobile: "SMARTPHONE",
  tablet: "TABLET",
  desktop: "DESKTOP",
  bot: "BOT",
  unknown: "UNKNOWN",
};

export default function SuperAdminPortal() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    fetch(withBase("/api/portal/me"))
      .then((r) => r.json().catch(() => null))
      .then((d) => {
        // Signed out while sign-in is Keycloak (e.g. a revoked session cookie
        // got past the middleware): go to single sign-on — the password form
        // below is the legacy mechanism and cannot sign anyone in.
        if (!d?.user && typeof d?.signIn === "string") {
          const back = window.location.pathname.replace(withBase(""), "") + window.location.search;
          window.location.replace(`${d.signIn}?returnTo=${encodeURIComponent(back || "/superadmin")}`);
          return;
        }
        setMe(d?.user ? d : null);
        setChecked(true);
      })
      .catch(() => setChecked(true));
  }, []);

  if (!checked)
    return (
      <div className="grid min-h-screen place-items-center text-sm text-[var(--muted)]">Loading…</div>
    );
  if (!me) return <Login onDone={setMe} />;
  return <Portal me={me} onLogout={() => setMe(null)} />;
}

// ── Login (centered, Pandas-style minimal) ──
function Login({ onDone }: { onDone: (m: Me) => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(withBase("/api/portal/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      if (!r.ok) {
        setErr("Wrong username or password.");
        return;
      }
      const m = await fetch(withBase("/api/portal/me")).then((x) => x.json());
      onDone(m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="card w-full max-w-sm p-6">
        <div className="mb-1 text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">
          GradeIQ hub
        </div>
        <h1 className="text-xl font-extrabold">Client console</h1>
        <p className="mb-4 mt-1 text-[13px] text-[var(--muted)]">
          Super admin manages every client; client admins manage their own.
        </p>
        <input className="input mb-2" placeholder="Username" value={u} onChange={(e) => setU(e.target.value)} autoCapitalize="none" />
        <input
          className="input mb-3"
          placeholder="Password"
          type="password"
          value={p}
          onChange={(e) => setP(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
        {err && <p className="mb-2 text-[13px] text-[var(--bad)]">{err}</p>}
        <button className="btn w-full" onClick={go} disabled={busy || !u || !p}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </div>
  );
}

// ── Portal shell: sidebar + wide main ──
type Tab = "overview" | "exceptions" | "compliance" | "journey" | "desk" | "retail" | "sessions" | "regrade" | "audit" | "pricing" | "integrations" | "users";

const TABS: Tab[] = ["overview", "journey", "desk", "retail", "sessions", "regrade", "audit", "pricing", "integrations", "users"];

function Portal({ me, onLogout }: { me: Me; onLogout: () => void }) {
  /**
   * A super admin opens the console on EVERY tenant.
   *
   * Defaulting to `clients[0]` meant the dashboard, the exception queue and the
   * badge all silently answered for one client while the operator read them as
   * estate-wide — and after the session monitor started defaulting to "all",
   * two screens on the same page disagreed about how many phones existed.
   * A client admin has exactly one tenant, so nothing changes for them.
   */
  const [client, setClient] = useState(
    me.user.role === "super" ? "all" : me.clients[0]?.id || "default",
  );
  // Clicking a session id in the Audit log jumps straight into its detail.
  const [jumpSession, setJumpSession] = useState<string | null>(null);
  // ?tab= lets the legacy /settings and /enterprise URLs redirect straight to
  // their panel instead of dumping a bookmarked operator on the journey editor.
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "overview";
    const t = new URLSearchParams(window.location.search).get("tab") as Tab | null;
    return t && TABS.includes(t) ? t : "overview";
  });

  async function logout() {
    const r = await fetch(withBase("/api/portal/logout"), { method: "POST" }).catch(() => null);
    // A Keycloak sign-in also has to end at Keycloak — the API hands back its
    // end-session URL. A legacy sign-in just drops back to the login form.
    const j = await r?.json().catch(() => null);
    if (typeof j?.redirect === "string") {
      window.location.href = j.redirect;
      return;
    }
    onLogout();
  }

  // One console, one login: the desk tester (was /enterprise) and platform
  // integrations (was /settings) are tabs here, not separate apps with their own
  // sign-ins. Integrations is platform-wide, so it sits under a PLATFORM group
  // and is read-only for client admins (the API enforces that too).
  /**
   * Grouped by the JOB, not by who owns the setting.
   *
   * The old split was "client" (8 items) and "platform" (2), which told you
   * nothing about when to use anything — Pricing sat between Audit log and
   * Integrations for no reason an operator could feel. These four answer
   * different questions: what is happening, what needs me, what do I do to a
   * device, and how is this tenant set up.
   */
  /**
   * Exception count for the sidebar badge. Polls the same endpoint the queue
   * uses, so the number on the nav and the number in the queue are the same
   * derivation — a badge that disagrees with the page it links to is worse
   * than no badge.
   */
  const [exceptionCount, setExceptionCount] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(withBase(`/api/portal/sessions?client=${encodeURIComponent(client)}&limit=200`));
        if (!r.ok || stop) return;
        setExceptionCount(countExceptions((await r.json()).sessions ?? []));
      } catch {
        /* a badge is never worth an error state */
      }
    };
    void tick();
    const iv = window.setInterval(tick, 30000);
    return () => {
      stop = true;
      window.clearInterval(iv);
    };
  }, [client]);

  const GROUPS = [
    { key: "monitor", label: "Monitor" },
    { key: "operate", label: "Operate" },
    { key: "configure", label: "Configure" },
    { key: "platform", label: "Platform" },
  ] as const;
  type NavGroup = (typeof GROUPS)[number]["key"];

  const NAV: { key: Tab; label: string; icon: string; group: NavGroup; superOnly?: boolean }[] = [
    { key: "overview", label: "Operations", icon: "◉", group: "monitor" },
    { key: "exceptions", label: "Exceptions", icon: "⚠", group: "monitor" },
    { key: "sessions", label: "Session monitor", icon: "🖥", group: "monitor" },
    { key: "compliance", label: "Fraud & mismatch", icon: "🛡", group: "monitor" },
    { key: "audit", label: "Audit log", icon: "📜", group: "monitor" },
    { key: "retail", label: "Retail desk", icon: "🏪", group: "operate" },
    { key: "desk", label: "Desk tester", icon: "🏭", group: "operate" },
    { key: "regrade", label: "Re-grade desk", icon: "↻", group: "operate" },
    { key: "journey", label: "Journey studio", icon: "🧭", group: "configure" },
    { key: "pricing", label: "Pricing", icon: "💲", group: "configure" },
    { key: "integrations", label: "Integrations", icon: "🔌", group: "platform" },
    { key: "users", label: "Users & access", icon: "👥", group: "platform" },
  ];

  return (
    // `console` scopes the Apple-like theme to the operator tools. The seller
    // flow shares these CSS variables and is tenant-branded, so this must not
    // become a :root change.
    <div className="console flex min-h-screen w-full">
      {/* Sidebar — Pandas-hub style */}
      <aside
        className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-[var(--border)] md:flex"
        style={{ background: "color-mix(in oklch, var(--card) 60%, var(--bg))" }}
      >
        <div className="px-5 py-5">
          <div className="text-[17px] font-extrabold tracking-tight">gradeiq hub</div>
          <div className="text-[11px] text-[var(--muted)]">client & channel console</div>
        </div>
        <div className="px-3">
          {GROUPS.map((g) => {
            const items = NAV.filter((n) => n.group === g.key);
            if (!items.length) return null;
            return (
              <div key={g.key}>
                <div className="px-2 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--muted)]">
                  {g.label}
                </div>
                {items.map((n) => (
                  <button
                    key={n.key}
                    onClick={() => setTab(n.key)}
                    className="mb-0.5 flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-[14px] font-semibold"
                    style={{
                      background:
                        tab === n.key ? "color-mix(in oklch, var(--brand) 14%, transparent)" : "transparent",
                      color: tab === n.key ? "var(--text)" : "var(--muted)",
                    }}
                  >
                    <span aria-hidden="true">{n.icon}</span>
                    <span className="flex-1">{n.label}</span>
                    {/* A queue you are meant to empty should say how full it is
                        without being opened. Only shown when non-zero — a
                        permanent "0" is noise. */}
                    {n.key === "exceptions" && exceptionCount > 0 && (
                      <span className="pill chip-red" style={{ fontSize: 10, padding: "1px 7px" }}>
                        {exceptionCount}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <div className="mt-auto border-t border-[var(--border)] px-5 py-4">
          <div className="text-[13px] font-bold">{me.user.username}</div>
          <div className="text-[11px] text-[var(--muted)]">
            {me.user.role === "super" ? "super admin" : "client admin"} ·{" "}
            <button className="underline" onClick={logout}>Sign out</button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="min-w-0 flex-1">
        {/* Mobile top bar */}
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3 md:hidden" style={{ overflowX: "auto" }}>
          {NAV.map((n) => (
            <button key={n.key} className="pill" style={{ fontWeight: 700, border: tab === n.key ? "2px solid var(--brand)" : "1px solid var(--border)" }} onClick={() => setTab(n.key)}>
              {n.label}
            </button>
          ))}
          <button className="pill" onClick={logout}>Sign out</button>
        </div>

        <div className="mx-auto w-full max-w-[1400px] px-5 py-6 sm:px-8">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight">
                {NAV.find((n) => n.key === tab)?.label}
              </h1>
              <p className="text-[13px] text-[var(--muted)]">
                {me.user.role === "super" ? "All clients" : me.clients[0]?.name}
              </p>
            </div>
            {(me.clients.length > 1 || me.user.role === "super") && (
              <select className="input" style={{ maxWidth: 260 }} value={client} onChange={(e) => setClient(e.target.value)}>
                {me.user.role === "super" && <option value="all">All clients</option>}
                {me.clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} · {c.currency}</option>
                ))}
              </select>
            )}
          </div>

          {tab === "overview" && (
            <CommandCenter
              clientId={client}
              onOpenSession={(id) => {
                setJumpSession(id);
                setTab("sessions");
              }}
              onStartInspection={() => setTab("desk")}
            />
          )}
          {tab === "exceptions" && (
            <ExceptionQueue
              clientId={client}
              // Same hand-off CommandCenter already uses: park the id, switch to
              // the monitor, and let it open the detail. One path, so the queue
              // and the dashboard behave identically when you click a row.
              onOpenSession={(id) => {
                setJumpSession(id);
                setTab("sessions");
              }}
            />
          )}
          {tab === "compliance" && (
            <CompliancePanel
              clientId={client}
              onOpenSession={(id) => {
                setJumpSession(id);
                setTab("sessions");
              }}
            />
          )}
          {tab === "journey" && <JourneyEditor clientId={client} />}
          {tab === "desk" && <DeskPanel clientId={client} />}
          {tab === "sessions" && (
            <Sessions
              clientId={client}
              isSuper={me.user.role === "super"}
              jumpTo={jumpSession}
              onJumped={() => setJumpSession(null)}
            />
          )}
          {tab === "regrade" && (
            <RegradePanel
              clientId={client}
              isSuper={me.user.role === "super"}
              onOpenSession={(id) => {
                setJumpSession(id);
                setTab("sessions");
              }}
            />
          )}
          {tab === "audit" && (
            <AuditPanel
              clientId={client}
              isSuper={me.user.role === "super"}
              onOpenSession={(id) => {
                setJumpSession(id);
                setTab("sessions");
              }}
            />
          )}
          {tab === "retail" && <RetailPanel clientId={client} />}
          {tab === "pricing" && <Pricing clientId={client} />}
          {tab === "integrations" && <IntegrationsPanel isSuper={me.user.role === "super"} />}
          {tab === "users" && <UsersPanel />}
        </div>
      </main>
    </div>
  );
}

// ── Journey editor — two-column on wide screens + sticky save bar ──
function JourneyEditor({ clientId }: { clientId: string }) {
  const [journey, setJourney] = useState<ClientJourney | null>(null);
  const [channel, setChannel] = useState("consumer");
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    setJourney(null);
    setDirty(false);
    fetch(withBase(`/api/portal/config?client=${clientId}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => setJourney(d.journey))
      .catch((s) => setErr(s === 403 ? "Not your client." : "Couldn't load config."));
  }, [clientId]);
  useEffect(load, [load]);

  if (err) return <div className="card p-5 text-sm text-[var(--bad)]">{err}</div>;
  if (!journey) return <div className="card p-5 text-sm text-[var(--muted)]">Loading journey…</div>;

  const cfg = journey.channels[channel];
  if (!cfg) return null;

  const patch = (fn: (c: ChannelConfig) => ChannelConfig) => {
    setJourney({ channels: { ...journey.channels, [channel]: fn(structuredClone(cfg)) } });
    setDirty(true);
    setSaved(false);
  };
  const enabledCount = cfg.captureSteps.filter((s) => s.enabled).length;

  async function save() {
    setErr("");
    const r = await fetch(withBase(`/api/portal/config?client=${clientId}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ journey }),
    });
    if (!r.ok) {
      setErr("Save failed.");
      return;
    }
    const d = await r.json();
    setJourney(d.journey);
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="pb-24">
      {/* channel picker */}
      <div className="mb-4 flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Channel</span>
        {Object.keys(journey.channels).map((ch) => (
          <button
            key={ch}
            className="pill"
            style={{ fontWeight: 700, border: channel === ch ? "2px solid var(--brand)" : "1px solid var(--border)" }}
            onClick={() => setChannel(ch)}
          >
            {ch}
          </button>
        ))}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[1.15fr_1fr]">
        {/* capture steps */}
        <section className="card p-5">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-lg font-bold">Capture steps</h2>
            <span className={`pill ${enabledCount >= MIN_ENABLED_STEPS ? "chip-green" : "chip-red"}`} style={{ fontSize: 11 }}>
              {enabledCount} enabled · min {MIN_ENABLED_STEPS}
            </span>
          </div>
          <p className="mb-3 text-[12px] text-[var(--muted)]">
            The angles the camera walks through, in order. The quality gate needs at least{" "}
            {MIN_ENABLED_STEPS} distinct views, so it re-enables steps if you go below that.
          </p>
          <div className="flex flex-col gap-2">
            {cfg.captureSteps.map((s, i) => (
              <div key={s.id} className="flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2">
                <button
                  aria-label={`Toggle ${s.label}`}
                  onClick={() => patch((c) => { c.captureSteps[i].enabled = !c.captureSteps[i].enabled; return c; })}
                  className="pill"
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    background: s.enabled ? "var(--brand)" : "transparent",
                    color: s.enabled ? "#fff" : "var(--muted)",
                  }}
                >
                  {s.enabled ? "ON" : "off"}
                </button>
                <input
                  className="input"
                  style={{ flex: 1, opacity: s.enabled ? 1 : 0.5 }}
                  value={s.label}
                  onChange={(e) => patch((c) => { c.captureSteps[i].label = e.target.value; return c; })}
                />
                <span className="hidden text-[11px] text-[var(--muted)] lg:block" style={{ width: 150 }}>{s.how}</span>
                <button className="pill" disabled={i === 0} onClick={() => patch((c) => { const t = c.captureSteps[i - 1]; c.captureSteps[i - 1] = c.captureSteps[i]; c.captureSteps[i] = t; return c; })}>↑</button>
                <button className="pill" disabled={i === cfg.captureSteps.length - 1} onClick={() => patch((c) => { const t = c.captureSteps[i + 1]; c.captureSteps[i + 1] = c.captureSteps[i]; c.captureSteps[i] = t; return c; })}>↓</button>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-col gap-4">
          {/* Journey stations — the employee-journey stops (identify → diagnostics
              → photos → review → complete). Config-driven exactly like the capture
              steps: the /j/<journey>/s/<session> runner reads this. identify /
              review / complete are the structural frame and stay locked on. */}
          <section className="card p-5">
            <h2 className="mb-1 text-lg font-bold">Journey stations</h2>
            <p className="mb-3 text-[12px] text-[var(--muted)]">
              The stops the employee journey walks a device through, for this channel. Diagnostics
              and photos are optional (grade-only or test-only desks); identify, review and complete
              always run.
            </p>
            <div className="grid gap-2">
              {(cfg.stations ?? []).map((st, i) => {
                const locked = st.id === "identify" || st.id === "review" || st.id === "complete";
                return (
                  <div key={st.id} className="rounded-xl border border-[var(--border)] px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={st.enabled}
                        disabled={locked}
                        onChange={() => patch((c) => { c.stations[i].enabled = !c.stations[i].enabled; return c; })}
                      />
                      <input
                        className="input flex-1"
                        style={{ fontWeight: 600 }}
                        value={st.label}
                        onChange={(e) => patch((c) => { c.stations[i].label = e.target.value; return c; })}
                      />
                      {locked && <span className="pill" style={{ fontSize: 10 }}>always on</span>}
                    </div>
                    <input
                      className="input mt-2 text-[12px]"
                      value={st.blurb}
                      placeholder="One line shown under the station title"
                      onChange={(e) => patch((c) => { c.stations[i].blurb = e.target.value; return c; })}
                    />
                  </div>
                );
              })}
            </div>
          </section>

          {/* phase blocks */}
          <section className="card p-5">
            <h2 className="mb-1 text-lg font-bold">Flow blocks</h2>
            <p className="mb-3 text-[12px] text-[var(--muted)]">
              Which parts of the journey run for this channel. Grading rules and the offer engine are not configurable — only the experience around them.
            </p>
            <div className="grid gap-2">
              {(
                [
                  ["battery", "Battery screenshot", "Seller uploads their Battery Health screenshot"],
                  ["functional", "Functional tests", "Touch, cameras, audio, sensors mini-games"],
                  ["torchPass", "Torch pass", "Second flash-lit shot per angle (Android cameras)"],
                  ["displaySweep", "Display sweep", "Screen colour patterns filmed for LCD defects"],
                  ["settingsOcr", "Settings capture", "Capture Settings → About and Battery Health for IMEI / battery facts"],
                  ["gradeAtEnd", "Grade at the end", "Collect photos, LCD sweep and Settings first, then grade once from all of it (off = grade the photos immediately, LCD arrives after the number)"],
                ] as const
              ).map(([k, label, hint]) => (
                <label key={k} className="flex items-start gap-3 rounded-xl border border-[var(--border)] px-3 py-2.5">
                  <input type="checkbox" checked={cfg.phases[k]} onChange={() => patch((c) => { c.phases[k] = !c.phases[k]; return c; })} className="mt-1" />
                  <span>
                    <span className="block text-[14px] font-semibold">{label}</span>
                    <span className="block text-[12px] text-[var(--muted)]">{hint}</span>
                  </span>
                </label>
              ))}
            </div>

            {/* HOW the Settings step captures. Only meaningful while the block
                above is on, so it is nested under it rather than sitting as a
                peer that does nothing. */}
            {cfg.phases.settingsOcr && (
              <div className="mt-3 rounded-xl border border-[var(--border)] p-3">
                <div className="text-[13px] font-semibold">Settings capture method</div>
                <p className="mt-0.5 text-[12px] text-[var(--muted)]">
                  Photo hands the shutter to the seller, so the frames are of the screens they
                  actually opened. Film grabs four frames on a timer — it captures whatever is on
                  screen when the window elapses, which is why it read a battery figure on 11
                  sessions and an IMEI on none.
                </p>
                <div className="mt-2 flex gap-2">
                  {(
                    [
                      ["photo", "Photo (recommended)"],
                      ["film", "Film on a timer"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      onClick={() => patch((c) => { c.settingsCapture = mode; return c; })}
                      className="rounded-full border px-3 py-1.5 text-[12.5px] font-semibold"
                      style={
                        (cfg.settingsCapture ?? "photo") === mode
                          ? { borderColor: "var(--brand)", color: "var(--brand)" }
                          : { borderColor: "var(--border)", color: "var(--muted)" }
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Screen test patterns — which colours the display sweep drives.
              Only patterns the camera can VERIFY on the phone's screen get
              captured, so a long list under glare produces a short strip and an
              "unknown" display verdict; a channel can choose a short reliable
              sweep instead. */}
          <section className="card p-5">
            <h2 className="mb-1 text-lg font-bold">Screen test patterns</h2>
            <p className="mb-3 text-[12px] text-[var(--muted)]">
              Driven in this order during the display sweep. Each one is only captured once the
              camera confirms the phone is actually showing it — unconfirmed patterns are reported
              as missing, never captured blind. White and black catch most dead pixels, backlight
              bleed and foldable crease damage.
            </p>
            <div className="flex flex-wrap gap-2">
              {ALL_DISPLAY_PATTERNS.map((p) => {
                const on = cfg.displayPatterns.includes(p);
                return (
                  <button
                    key={p}
                    className={`pill ${on ? "chip-green" : ""}`}
                    style={{ fontSize: 12, opacity: on ? 1 : 0.55 }}
                    onClick={() =>
                      patch((c) => {
                        c.displayPatterns = on
                          ? c.displayPatterns.filter((x) => x !== p)
                          : [...c.displayPatterns, p];
                        return c;
                      })
                    }
                  >
                    <span
                      className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-middle"
                      style={{
                        // `p` is a CSS colour name for every pattern except the
                        // striped one, which has to be drawn.
                        background:
                          p === "stripes"
                            ? "repeating-linear-gradient(90deg,#000 0 2px,#fff 2px 4px)"
                            : p,
                        border: "1px solid rgba(0,0,0,0.2)",
                      }}
                    />
                    {p}
                    {on ? " ✓" : ""}
                  </button>
                );
              })}
            </div>
            {cfg.displayPatterns.length === 0 && (
              <p className="mt-2 text-[12px]" style={{ color: "var(--bad)" }}>
                No patterns selected — the sweep would have nothing to verify, so the defaults will
                be used instead. Turn the whole sweep off in Flow blocks if that is what you want.
              </p>
            )}
          </section>

          {/* copy */}
          <section className="card p-5">
            <h2 className="mb-3 text-lg font-bold">Copy</h2>
            <label className="mb-2 block text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Intro title</label>
            <input className="input mb-3" placeholder="Trade in your device (default)" value={cfg.copy.introTitle} onChange={(e) => patch((c) => { c.copy.introTitle = e.target.value; return c; })} />
            <label className="mb-2 block text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">Tagline</label>
            <input className="input" placeholder="Uses the client theme's tagline when empty" value={cfg.copy.tagline} onChange={(e) => patch((c) => { c.copy.tagline = e.target.value; return c; })} />
          </section>
        </div>
      </div>

      {/* Sticky release bar — Pandas' "Release & make live" */}
      {(dirty || saved) && (
        <div className="fixed bottom-5 right-5 z-40 flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 shadow-xl">
          <span className="text-[13px] text-[var(--muted)]">{saved ? "Live ✓" : "Unsaved changes"}</span>
          {!saved && <button className="btn" onClick={save}>Save & make live</button>}
          {err && <span className="text-[13px] text-[var(--bad)]">{err}</span>}
        </div>
      )}
    </div>
  );
}

// ── Sessions monitor: wide table → click-through detail ──
function Sessions({
  clientId,
  isSuper,
  jumpTo,
  onJumped,
}: {
  clientId: string;
  isSuper: boolean;
  jumpTo?: string | null;
  onJumped?: () => void;
}) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  /**
   * Follows the console-wide client picker, which now defaults to "all" for a
   * super admin. Hardcoding "all" here instead made the monitor disagree with
   * the dashboard beside it whenever someone narrowed to one tenant.
   */
  const [scope, setScope] = useState<string>(clientId);
  const [sel, setSel] = useState<string | null>(null);
  const [f, setF] = useState({ q: "", grade: "", status: "", tier: "", flag: "", since: "", color: "", storage: "", stage: "", tag: "", model: "" });
  /**
   * Sorting, because "latest first" is only one of the questions this table
   * answers. An operator triaging a batch wants everything of one model
   * together, or every colour variant of it, and a fixed updated_at ordering
   * makes them scroll for it. Sorted client-side over the rows already loaded —
   * the list is capped, so this needs no extra query.
   */
  const [sortKey, setSortKey] = useState<"updated_at" | "created_at" | "model" | "color" | "storage" | "cosmetic_grade" | "client_id">("updated_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    setScope(clientId);
    setSel(null);
  }, [clientId]);
  // Arriving from the Audit log with a session id — open it directly.
  useEffect(() => {
    if (jumpTo) {
      setSel(jumpTo);
      onJumped?.();
    }
  }, [jumpTo, onJumped]);

  useEffect(() => {
    setRows(null);
    fetch(withBase(`/api/portal/sessions?client=${scope}&limit=200`))
      .then((r) => (r.ok ? r.json() : { sessions: [] }))
      .then((d) => setRows(d.sessions));
  }, [scope]);

  if (sel) return <SessionDetail id={sel} onBack={() => setSel(null)} />;

  // Newest activity first, then narrowed by the filters. Filtering happens over
  // the fetched page (the API already returns them updated_at DESC) so typing is
  // instant; `q` matches the three things an operator actually pastes in — a
  // session id, an IMEI, or a model name.
  const filtered = (rows ?? []).filter((r) => {
    if (f.grade && r.cosmetic_grade !== f.grade) return false;
    if (f.model && (r.model || "") !== f.model) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.stage && r.stage !== f.stage) return false;
    // Tag filter is "carries this tag", not "is exactly this" — a session can
    // be stalled AND missing Settings proof, and hiding it from both lists
    // would be the opposite of useful.
    if (f.tag && !(r.tags ?? []).includes(f.tag as SessionTag)) return false;
    if (f.tier && (r.tier || "") !== f.tier) return false;
    if (f.color && (r.color || "") !== f.color) return false;
    if (f.storage && (r.storage || "") !== f.storage) return false;
    if (f.flag === "review" && !r.review) return false;
    if (f.flag === "retake" && r.capture_verdict !== "retake") return false;
    if (f.flag === "clean" && (r.review || r.capture_verdict === "retake")) return false;
    if (f.since && r.updated_at < f.since) return false;
    if (f.q) {
      const hay = `${r.id} ${r.imei} ${r.model} ${r.client_id}`.toLowerCase();
      if (!hay.includes(f.q.toLowerCase().trim())) return false;
    }
    return true;
  });
  // Blank values always sink to the bottom regardless of direction: a column of
  // "—" at the top is never what someone sorting by colour is looking for.
  const sorted = [...filtered].sort((a, b) => {
    const av = String((a as any)[sortKey] ?? "");
    const bv = String((b as any)[sortKey] ?? "");
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    const cmp = sortKey === "updated_at" || sortKey === "created_at" ? av.localeCompare(bv) : av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
    return sortDir === "asc" ? cmp : -cmp;
  });

  const opts = (pick: (r: SessionRow) => string) =>
    Array.from(new Set((rows ?? []).map(pick).filter(Boolean))).sort();

  /** A sortable column header — click to sort, click again to flip direction. */
  const Th = ({ k, label }: { k: typeof sortKey; label: string }) => (
    <th className="py-2 pr-3">
      <button
        className="uppercase tracking-wide"
        style={{ font: "inherit", color: sortKey === k ? "var(--brand)" : "inherit" }}
        onClick={() => {
          if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
          else {
            setSortKey(k);
            setSortDir(k === "updated_at" ? "desc" : "asc");
          }
        }}
      >
        {label}
        {sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  const Sel = ({ k, label, list }: { k: keyof typeof f; label: string; list: string[] }) => (
    <select className="input" style={{ maxWidth: 170 }} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
      <option value="">{label}</option>
      {list.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );

  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Sessions</h2>
          <p className="text-[12px] text-[var(--muted)]">Click a column heading to sort. Click any row for the full session.</p>
        </div>
        {isSuper && (
          <button className="pill" style={{ fontSize: 12 }} onClick={() => setScope(scope === "all" ? clientId : "all")}>
            {scope === "all" ? "This client only" : "All clients"}
          </button>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          className="input"
          style={{ maxWidth: 240 }}
          placeholder="Search id, IMEI or model…"
          value={f.q}
          onChange={(e) => setF({ ...f, q: e.target.value })}
        />
        <Sel k="model" label="All models" list={opts((r) => r.model || "")} />
        <Sel k="grade" label="All grades" list={opts((r) => r.cosmetic_grade || "")} />
        {/* Stage is the funnel position; Tag is orthogonal. Two selects, not
            one merged list — combining them would let you pick "graded" and
            "needs review" as if they were alternatives. */}
        <select
          className="input"
          style={{ maxWidth: 150 }}
          value={f.stage}
          onChange={(e) => setF({ ...f, stage: e.target.value })}
        >
          <option value="">All stages</option>
          {STAGES.map((st) => (
            <option key={st} value={st}>
              {STAGE_LABEL[st]}
            </option>
          ))}
        </select>
        <select
          className="input"
          style={{ maxWidth: 160 }}
          value={f.tag}
          onChange={(e) => setF({ ...f, tag: e.target.value })}
        >
          <option value="">Any tag</option>
          {(Object.keys(TAG_LABEL) as SessionTag[]).map((t) => (
            <option key={t} value={t}>
              {TAG_LABEL[t]}
            </option>
          ))}
        </select>
        <Sel k="status" label="All statuses" list={opts((r) => r.status || "")} />
        <Sel k="tier" label="All tiers" list={opts((r) => r.tier || "")} />
        <Sel k="color" label="All colours" list={opts((r) => r.color || "")} />
        <Sel k="storage" label="All storage" list={opts((r) => r.storage || "")} />
        <Sel k="flag" label="All rows" list={["review", "retake", "clean"]} />
        {[
          ["1h", 1 / 24],
          ["24h", 1],
          ["7d", 7],
          ["30d", 30],
        ].map(([label, days]) => (
          <button
            key={label as string}
            className="pill"
            style={{ fontSize: 12 }}
            onClick={() =>
              setF({
                ...f,
                since: new Date(Date.now() - (days as number) * 86400000).toISOString().slice(0, 19).replace("T", " "),
              })
            }
          >
            {label}
          </button>
        ))}
        <button
          className="pill"
          style={{ fontSize: 12 }}
          onClick={() => setF({ q: "", grade: "", status: "", tier: "", flag: "", since: "", color: "", storage: "", stage: "", tag: "", model: "" })}
        >
          Reset
        </button>
        <span className="ml-auto text-[12px] text-[var(--muted)]">
          {rows ? `${filtered.length} of ${rows.length}` : "…"}
        </span>
      </div>

      {!rows ? (
        <p className="text-sm text-[var(--muted)]">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          {rows.length ? "No sessions match these filters." : "No sessions yet for this client."}
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                <th className="py-2 pr-3">Session</th>
                {scope === "all" && <th className="py-2 pr-3">Client</th>}
                <Th k="model" label="Device" />
                <Th k="storage" label="Storage" />
                <Th k="color" label="Colour" />
                <th className="py-2 pr-3">IMEI</th>
                <Th k="cosmetic_grade" label="Grade" />
                <th className="py-2 pr-3">Stage</th>
                <th className="py-2 pr-3">Tier</th>
                <th className="py-2 pr-3">Tags</th>
                <th className="py-2 pr-3">Photos</th>
                {/* Both, because they answer different questions. `updated_at`
                    is LAST TOUCHED — background writes (capture telemetry, camera
                    frames, an AI assessment landing) bump it, so an old session
                    can float to the top without anyone touching the phone.
                    `created_at` is when the device actually arrived. */}
                <Th k="created_at" label="Started" />
                <Th k="updated_at" label="Updated" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer border-t border-[var(--border)] hover:bg-[color-mix(in_oklch,var(--brand)_6%,transparent)]"
                  onClick={() => setSel(r.id)}
                >
                  <td className="py-2.5 pr-3">
                    <span className="mono font-semibold text-[var(--brand)]" title={r.id}>#{sessionAlias(r.id)}</span>
                  </td>
                  {scope === "all" && <td className="py-2.5 pr-3">{r.client_id}</td>}
                  <td className="py-2.5 pr-3">{r.model || <span className="text-[var(--muted)]">—</span>}</td>
                  <td className="py-2.5 pr-3">{r.storage || <span className="text-[var(--muted)]">—</span>}</td>
                  <td className="py-2.5 pr-3">{r.color || <span className="text-[var(--muted)]">—</span>}</td>
                  <td className="py-2.5 pr-3 mono text-[12px] text-[var(--muted)]">{r.imei || "—"}</td>
                  <td className="py-2.5 pr-3 font-bold">{r.cosmetic_grade || "—"}</td>
                  <td className="py-2.5 pr-3">
                    <span
                      className="pill"
                      style={{
                        fontSize: 10,
                        // Green once a price exists, amber while in flight —
                        // the eye should find the stuck ones, not the finished.
                        background:
                          r.stage === "accepted" || r.stage === "offered"
                            ? "color-mix(in oklch, var(--good) 18%, transparent)"
                            : "color-mix(in oklch, var(--brand) 12%, transparent)",
                      }}
                    >
                      {STAGE_LABEL[r.stage] ?? r.stage}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3">{r.tier || "—"}</td>
                  <td className="py-2.5 pr-3">
                    <span className="flex flex-wrap gap-1">
                      {(r.tags ?? []).map((t) => (
                        <span
                          key={t}
                          className={`pill ${
                            t === "camera-fault" || t === "review" || t === "blocked"
                              ? "chip-red"
                              : "chip-yellow"
                          }`}
                          style={{ fontSize: 10 }}
                        >
                          {TAG_LABEL[t] ?? t}
                        </span>
                      ))}
                      {!(r.tags ?? []).length && <span className="text-[var(--muted)]">—</span>}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3">{r.photo_count ?? 0}</td>
                  <td className="py-2.5 pr-3 whitespace-nowrap text-[var(--muted)]">{r.created_at}</td>
                  <td className="py-2.5 pr-3 whitespace-nowrap text-[var(--muted)]">{r.updated_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Session detail — the Pandas "Sessions > tradein" click-through ──
/**
 * Verification chips — the five questions an operator asks before paying.
 *
 * Green means CHECKED AND AGREED, red means checked and disagreed, grey means
 * NOT CHECKED. The grey is the important one: an unverified IMEI is not a pass,
 * and colouring it green because nothing objected is how an unproven identity
 * gets mistaken for a proven one. Every chip that cannot be answered says so.
 */
function VerifyChips({ d }: { d: any }) {
  const chips: { label: string; tone: "good" | "bad" | "none"; title?: string }[] = [];

  // 1. Does the device in the photos look like the device claimed?
  const vm = d?.vision?.deviceMatch?.match;
  chips.push({
    label: vm === "match" ? "Visual match" : vm === "mismatch" ? "Visual mismatch" : "Visual unverified",
    tone: vm === "match" ? "good" : vm === "mismatch" ? "bad" : "none",
    title: d?.vision?.deviceMatch?.reason || undefined,
  });

  // 2. Was the IMEI proven by the device's own screen, not just typed?
  const readImei = String(d?.ocrRead?.imei || "");
  const sessImei = String(d?.imei || "");
  chips.push(
    readImei && sessImei && readImei === sessImei
      ? { label: "IMEI verified", tone: "good", title: "read off the device's own screen" }
      : readImei && sessImei && readImei !== sessImei
        ? { label: "IMEI mismatch", tone: "bad", title: `${sessImei} vs ${readImei}` }
        : { label: "IMEI unproven", tone: "none", title: "no Settings/*#06# read to corroborate it" },
  );

  // 3. Colour: the spec (Phonecheck where available) against the photographs.
  const spec = d?.spec || {};
  const want = String(spec.colour || "").toLowerCase();
  const seen = String(spec.seenColour || "").toLowerCase();
  const words = (v: string) => new Set(v.split(/[^a-z]+/).filter((w) => w.length > 2));
  if (want && seen) {
    const agree = [...words(want)].some((w) => words(seen).has(w));
    chips.push({
      label: agree ? `Colour ${spec.colour}` : `Colour ${spec.colour} ≠ ${spec.seenColour}`,
      tone: agree ? "good" : "bad",
      title: `${spec.source} spec vs what the photos show`,
    });
  } else if (want) {
    // The real one from the IMEI lookup is shown even when the photos could not
    // settle it — knowing the phone SHOULD be Phantom Black is useful on its own.
    chips.push({ label: `Colour ${spec.colour}`, tone: "none", title: `${spec.source} spec — photos did not report a colour` });
  }

  // 4. Was the IMEI actually looked up anywhere authoritative?
  //
  // Until now a not-found lookup fabricated "clean / unlocked / 86%" from the
  // IMEI's last three digits, and nothing said so. An operator cannot tell a
  // verdict from an invention unless the UI distinguishes them, so it does.
  const pcSrc = String(d?.phonecheckSource || "");
  if (pcSrc) {
    const live = pcSrc === "api";
    chips.push({
      label: live ? "Phonecheck ✓" : pcSrc === "demo" ? "DEMO DATA" : "No Phonecheck record",
      tone: live ? "good" : pcSrc === "demo" ? "bad" : "none",
      title: live
        ? "blacklist, SIM-lock and battery came from a real lookup"
        : pcSrc === "demo"
          ? "fabricated demo values — not a lookup"
          : `no lookup result (${pcSrc}) — lock and blacklist status are unknown, not clean`,
    });
  }

  // 5. Functional faults, counted.
  const fn = (d?.functional || {}) as Record<string, string>;
  const fails = Object.entries(fn).filter(([, v]) => v === "fail").map(([k]) => k);
  const passes = Object.values(fn).filter((v) => v === "pass").length;
  if (passes || fails.length) {
    chips.push(
      fails.length
        ? { label: `${fails.length} function fault${fails.length > 1 ? "s" : ""}`, tone: "bad", title: fails.join(", ") }
        : { label: `${passes} functions pass`, tone: "good" },
    );
  }

  // 6. How much of the device was actually seen.
  const cov = d?.vision?.coverage;
  if (typeof cov === "number") {
    chips.push({
      label: `Coverage ${Math.round(cov * 100)}%`,
      tone: cov >= 0.999 ? "good" : "none",
      title: "share of structural surfaces the inspection could assess",
    });
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((c, i) => (
        <span
          key={i}
          title={c.title}
          className={`pill ${c.tone === "good" ? "chip-green" : c.tone === "bad" ? "chip-red" : ""}`}
          style={{ fontSize: 11 }}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

function SessionDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<SessionDetailData | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    fetch(withBase(`/api/portal/sessions/${id}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setD)
      .catch((s) => setErr(s === 403 ? "Not your client." : "Couldn't load session."));
  }, [id]);
  useEffect(load, [load]);

  if (err) return <div className="card p-5 text-sm text-[var(--bad)]">{err}</div>;
  if (!d) return <div className="card p-5 text-sm text-[var(--muted)]">Loading session…</div>;

  const kv: [string, React.ReactNode][] = [
    ["Status", d.status || "open"],
    ["Client", d.clientId],
    ["Channel", d.profile.channel || "consumer"],
    ["IMEI", d.imei || "—"],
    ["Cosmetic", d.grades.cosmetic || "—"],
    ["Functional", d.grades.functional || "—"],
    ["Overall", d.grades.overall || "—"],
    ["Photos", String(d.photos?.length ?? 0)],
    ["Started", d.created_at],
    ["Updated", d.updated_at],
  ];

  return (
    <div className="flex flex-col gap-4 pb-10">
      <div className="flex items-center justify-between">
        <button className="pill" onClick={onBack}>← Sessions</button>
        <div className="flex gap-2">
          <a className="pill" href={withBase(`/report/${d.id}`)} target="_blank" rel="noreferrer">Open report ↗</a>
        </div>
      </div>

      {/* Admin re-grade — right here in the monitor, so an operator reviewing a
          session doesn't have to open the report to re-run it. Reuses the exact
          same staff-gated endpoint; onDone refetches this panel in place instead
          of a full reload (which would drop them out of the console). */}
      <RegradeBar
        sessionId={d.id}
        overall={d.grades.overall}
        lastGraded={d.updated_at}
        tierUsed={d.vision.tierUsed || undefined}
        onDone={() => load()}
        unfinished={
          d.vision.refine?.state === "unfinished"
            ? {
                since: d.vision.refine.startedAt ? `${d.vision.refine.startedAt.slice(0, 16).replace("T", " ")} UTC` : null,
                afterMinutes: Math.round(d.vision.refine.unfinishedAfterSeconds / 60),
              }
            : undefined
        }
      />

      {/* Header card */}
      <section className="card p-5">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-xl font-extrabold">
            {d.model || "Unknown device"} <span className="mono text-[14px] text-[var(--muted)]" title={d.id}>#{sessionAlias(d.id)}</span>
            <VerifyChips d={d} />
          </h2>
          {d.vision.needsHumanReview && <span className="pill chip-red" style={{ fontSize: 11 }}>needs review</span>}
          {d.capture?.verdict === "retake" && <span className="pill chip-yellow" style={{ fontSize: 11 }}>retake requested</span>}
        </div>
        <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-5">
          {kv.map(([k, v]) => (
            <div key={k}>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">{k}</div>
              <div className="text-[14px] font-semibold">{v}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Browser provenance — the Pandas Device / Initiated device / IP block */}
      <section className="card p-5">
        <h3 className="mb-3 text-lg font-bold">Devices & browsers</h3>
        {/* THE QUESTION THESE THREE ROWS EXIST TO ANSWER.
            Rows 1 and 3 should be one handset and row 2 a different one; if the
            session was started on a different phone from the one tested, that is
            a swap. Reading it off three UA strings by eye is not a check, so the
            verdict is computed. IP is deliberately ignored — two of these come
            from mobile networks and differ by carrier NAT for the same person in
            the same room, and row 3 has no IP at all. */}
        {(() => {
          const v = checkSessionDevices({
            origin: d.browsers.origin as any,
            camera: d.browsers.camera as any,
            reported: d.browsers.reported as any,
          });
          const tone = v.concern
            ? { border: "var(--bad)", bg: "color-mix(in oklch, var(--bad) 10%, transparent)" }
            : v.underTest.verdict === "same"
              ? { border: "var(--green)", bg: "color-mix(in oklch, var(--green) 10%, transparent)" }
              : { border: "var(--border)", bg: "var(--bg-soft)" };
          return (
            <div
              className="mb-3 rounded-xl border px-4 py-3"
              style={{ borderColor: tone.border, background: tone.bg }}
            >
              <div className="text-[13.5px] font-semibold">
                {v.concern ? "⚠ " : v.underTest.verdict === "same" ? "✓ " : "· "}
                {v.summary}
              </div>
              <div className="mt-1 text-[11.5px] text-[var(--muted)]">
                Started vs tested — {v.underTest.reasons.join(" · ") || "nothing comparable"}
              </div>
              {/* Say which evidence carried it. The caveat about identical
                  handsets is only true WITHOUT a browser token — once both
                  records carry one, that limit is gone, and repeating it would
                  understate the check. */}
              {v.underTest.verdict === "same" && (
                <div className="mt-1 text-[11px] text-[var(--muted)]">
                  {v.underTest.reasons.some((r) => r.includes("browser token"))
                    ? "Proven by a per-browser token — the same browser made both requests, so two identical handsets are no longer indistinguishable."
                    : "Compared on model, OS, screen and browser build. Two identical handsets on the same build cannot be told apart this way — this session predates the browser token."}
                </div>
              )}
            </div>
          );
        })()}
        <div className="flex flex-col gap-3">
          {(
            [
              ["Session started on", d.browsers.origin],
              ["Camera device", d.browsers.camera],
              ["Device under test (self-reported)", d.browsers.reported],
            ] as const
          ).map(([label, b]) =>
            b ? (
              <div key={label} className="rounded-xl border border-[var(--border)] px-4 py-3">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">{label}</span>
                  <span className="pill" style={{ fontSize: 10, fontWeight: 800 }}>{KIND_CHIP[b.parsed.kind] || "UNKNOWN"}</span>
                  <span className="pill chip-green" style={{ fontSize: 10 }}>{b.parsed.browser}</span>
                  <span className="pill" style={{ fontSize: 10 }}>{b.parsed.os}</span>
                  {b.parsed.model && <span className="pill" style={{ fontSize: 10 }}>{b.parsed.model}</span>}
                  {/* The model the UA could never tell us — from the Client Hint
                      on Android, or the CSS viewport on Apple hardware. Tinted by
                      whether it agrees with the model the seller claimed. */}
                  {!b.parsed.model && b.model?.label && (
                    <span
                      className={`pill ${b.agrees === "match" ? "chip-green" : b.agrees === "mismatch" ? "chip-red" : ""}`}
                      style={{ fontSize: 10, fontWeight: 700 }}
                      title={
                        (b.model.candidates.length > 1
                          ? `Consistent with: ${b.model.candidates.join(", ")}`
                          : b.model.label) + ` · from ${b.model.basis.replace(/-/g, " ")}`
                      }
                    >
                      {b.model.label}
                      {b.agrees === "mismatch" ? " ✕" : b.agrees === "match" ? " ✓" : ""}
                    </span>
                  )}
                  {b.ip && <span className="mono text-[11px] text-[var(--muted)]">{b.ip}</span>}
                  {b.at && <span className="text-[11px] text-[var(--muted)]">· {b.at}</span>}
                </div>
                <div className="mono break-all text-[11px] text-[var(--muted)]">{b.ua}</div>
                {"screen" in b && b.screen && (
                  <div className="mt-1 text-[11px] text-[var(--muted)]">
                    screen {b.screen}
                    {b.platform ? ` · ${b.platform}` : ""}
                    {b.battery ? ` · battery ${Math.round((b.battery.level ?? 0) * 100)}%${b.battery.charging ? " ⚡" : ""}` : ""}
                  </div>
                )}
                {/* Say it in words, not just a coloured pill: this contradicts
                    the claimed model and is worth an operator's attention. */}
                {b.agrees === "mismatch" && b.model?.label && (
                  <div className="mt-1 text-[11px] font-semibold" style={{ color: "var(--bad)" }}>
                    This viewport ({b.screen}) belongs to {b.model.label}, which is not the model on this session.
                  </div>
                )}
              </div>
            ) : (
              <div key={label} className="rounded-xl border border-dashed border-[var(--border)] px-4 py-3 text-[12px] text-[var(--muted)]">
                {label}: not captured
                {label === "Camera device" &&
                  (d.browsers.cameraConnectedAt
                    ? ` — but a second device DID check in at ${d.browsers.cameraConnectedAt} (its browser wasn't recorded)`
                    : " (no second device checked in)")}
              </div>
            ),
          )}
          {d.vision.deviceMatch?.match && (
            <div className="flex items-start gap-2 rounded-xl px-4 py-3" style={{ background: d.vision.deviceMatch.match === "mismatch" ? "rgba(220,38,38,0.08)" : "rgba(22,163,74,0.08)" }}>
              <span className={`pill ${d.vision.deviceMatch.match === "match" ? "chip-green" : d.vision.deviceMatch.match === "mismatch" ? "chip-red" : "chip-yellow"}`} style={{ fontSize: 10, fontWeight: 800 }}>
                {d.vision.deviceMatch.match.toUpperCase()}
              </span>
              <div className="text-[12px]">
                <b>Visual identity:</b> {[d.vision.deviceMatch.make, d.vision.deviceMatch.model].filter(Boolean).join(" ") || "—"}
                {d.vision.deviceMatch.reason && <span className="text-[var(--muted)]"> — {d.vision.deviceMatch.reason}</span>}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* PATH — the audit trail with dwell time, Pandas-style */}
      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-bold">Path</h3>
          <span className="text-[12px] text-[var(--muted)]">
            {d.events.length} event{d.events.length === 1 ? "" : "s"} · append-only
          </span>
        </div>
        {d.path.length === 0 ? (
          <p className="text-[13px] text-[var(--muted)]">
            No trail recorded — this session predates audit logging.
          </p>
        ) : (
          <ol className="flex flex-col">
            {d.path.map((p, i) => (
              <li key={i} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white"
                    style={{ background: "var(--brand)" }}
                  >
                    {i + 1}
                  </span>
                  {i < d.path.length - 1 && (
                    <span className="my-1 w-px flex-1" style={{ background: "var(--border)" }} />
                  )}
                </div>
                <div className="min-w-0 flex-1 pb-4">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-[15px] font-bold">{p.step}</span>
                    <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                      {p.stayedSec == null ? "current / last step" : `stayed for ${dur(p.stayedSec)}`}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-col gap-1">
                    {p.events.map((e, j) => (
                      <div key={j} className="flex flex-wrap items-center gap-2 text-[12px]">
                        <span className="pill" style={{ fontSize: 10, fontWeight: 700 }}>{e.event}</span>
                        <span className="text-[var(--muted)]">{e.at}</span>
                        <span className="mono text-[11px] text-[var(--muted)]">
                          {Object.entries(e.detail || {})
                            .filter(([, v]) => v !== null && v !== undefined && v !== "")
                            .slice(0, 5)
                            .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : v}`)
                            .join("  ")}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {/* Inspection summary */}
        <section className="card p-5">
          <h3 className="mb-3 text-lg font-bold">Inspection</h3>
          <div className="mb-3 flex flex-wrap gap-2">
            <span className="pill" style={{ fontSize: 11 }}>tier: {d.vision.tierUsed || "—"}{d.vision.escalated ? " (escalated)" : ""}</span>
            <span className="pill" style={{ fontSize: 11 }}>score: {d.vision.score ?? "—"}</span>
            <span className="pill" style={{ fontSize: 11 }}>coverage: {d.vision.coverage != null ? Math.round(d.vision.coverage * 100) + "%" : "—"}</span>
            <span className="pill" style={{ fontSize: 11 }}>findings: {d.vision.findings}</span>
            {d.vision.oem?.verdict && <span className={`pill ${d.vision.oem.verdict === "likely_oem" ? "chip-green" : d.vision.oem.verdict === "suspect_aftermarket" ? "chip-red" : "chip-yellow"}`} style={{ fontSize: 11 }}>{d.vision.oem.verdict.replace(/_/g, " ")}</span>}
          </div>
          {d.vision.obstruction?.present && (
            <p className="mb-2 rounded-lg px-3 py-2 text-[12px]" style={{ background: "rgba(251,191,36,0.12)" }}>
              ⚠ {d.vision.obstruction.note || `Cover detected: ${d.vision.obstruction.type}`}
            </p>
          )}
          <table className="w-full text-[13px]">
            <tbody>
              {d.vision.specialists.map((sp) => (
                <tr key={sp.id} className="border-t border-[var(--border)]">
                  <td className="py-1.5 pr-2 font-semibold capitalize">{sp.id}</td>
                  <td className="py-1.5 pr-2 font-bold">{sp.grade || "not assessed"}</td>
                  <td className="py-1.5 pr-2 text-[var(--muted)]">conf {Math.round((sp.confidence || 0) * 100)}%</td>
                  <td className="py-1.5 text-[12px] text-[var(--muted)]">{sp.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.capture?.verdict === "retake" && (
            <p className="mt-2 rounded-lg px-3 py-2 text-[12px]" style={{ background: "rgba(251,191,36,0.12)" }}>
              📷 Capture rejected ({d.capture.code}) — {(d.capture.reasons || []).join(" ")}
            </p>
          )}
        </section>

        {/* Functional + offer */}
        <section className="card p-5">
          <h3 className="mb-3 text-lg font-bold">Functional & offer</h3>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {Object.entries(d.functional || {}).length === 0 && <span className="text-[13px] text-[var(--muted)]">No functional results yet.</span>}
            {Object.entries(d.functional || {}).map(([k, v]) => (
              <span key={k} className={`pill ${v === "pass" ? "chip-green" : v === "fail" ? "chip-red" : ""}`} style={{ fontSize: 11 }}>
                {k}: {v}
              </span>
            ))}
          </div>
          {"offer" in (d.offer || {}) ? (
            <div className="rounded-xl border border-[var(--border)] px-4 py-3">
              <div className="text-[22px] font-extrabold">
                {(d.offer as any).blocked ? "Blocked" : `${(d.offer as any).currency === "INR" ? "₹" : "$"}${(d.offer as any).offer ?? 0}`}
              </div>
              {((d.offer as any).flags || []).map((f: string, i: number) => (
                <div key={i} className="mt-1 text-[12px] text-[var(--muted)]">{f}</div>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-[var(--muted)]">No offer computed yet.</p>
          )}
          {/* EVERY piece of evidence this session produced, in one place: the
              angle photos, the device's own Settings/battery screenshots, and
              the screen test patterns. The last two were written to disk and
              then only ever shown on the report — an operator working a dispute
              from the console couldn't see the source of the IMEI or the panel. */}
          {d.shots?.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">
                Device screenshots · {d.shots.length}
                {d.ocrRead?.imei ? ` · IMEI ${d.ocrRead.imei}` : ""}
                {typeof d.ocrRead?.batteryHealth === "number" ? ` · battery ${d.ocrRead.batteryHealth}%` : ""}
              </div>
              <div className="flex gap-2" style={{ overflowX: "auto" }}>
                {d.shots.map((sh, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={withBase(sh.url)}
                    alt={sh.kind || "settings"}
                    title={sh.kind || "settings"}
                    className="h-28 w-auto rounded-lg border border-[var(--border)] bg-black object-contain"
                  />
                ))}
              </div>
            </div>
          )}

          {(d.display?.captures?.length > 0 || d.display?.missing?.length > 0) && (
            <div className="mt-4">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">
                Screen test patterns
                {d.display.requested?.length
                  ? ` · ${d.display.captures.length}/${d.display.requested.length} confirmed`
                  : ""}
                {d.display.verdict ? ` · ${d.display.verdict}` : ""}
              </div>
              <div className="flex gap-2" style={{ overflowX: "auto" }}>
                {d.display.captures.map((c, i) => (
                  <figure key={i} className="shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={withBase(c.photo)}
                      alt={c.pattern}
                      className="h-28 w-auto rounded-lg border border-[var(--border)] bg-black object-contain"
                    />
                    <figcaption className="mt-0.5 text-center text-[10px] uppercase text-[var(--muted)]">
                      {c.pattern}
                    </figcaption>
                  </figure>
                ))}
              </div>
              {d.display.missing?.length > 0 && (
                <p className="mt-1 text-[11px] text-[var(--muted)]">
                  Never confirmed on screen: {d.display.missing.join(", ")}
                </p>
              )}
              {d.display.note && <p className="mt-1 text-[11px] text-[var(--muted)]">{d.display.note}</p>}
            </div>
          )}

          {d.photos?.length > 0 && (
            <div className="mt-3 flex gap-1.5" style={{ overflowX: "auto" }}>
              {d.photos.slice(0, 8).map((p, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={withBase(p)} alt="" className="h-16 w-12 rounded-lg object-cover" />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ── Pricing: the client's live pricebook, inline ──
function Pricing({ clientId }: { clientId: string }) {
  const [d, setD] = useState<{ source: string; book: any } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    setD(null);
    setErr("");
    fetch(withBase(`/api/clients/${clientId}/pricebook`))
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setD)
      .catch(() => setErr("No pricebook for this client."));
  }, [clientId]);

  if (err) return <div className="card p-5 text-sm text-[var(--muted)]">{err}</div>;
  if (!d) return <div className="card p-5 text-sm text-[var(--muted)]">Loading pricebook…</div>;

  const models = d.book?.models ?? [];
  const cur = d.book?.currency === "INR" ? "₹" : d.book?.currency === "EUR" ? "€" : "$";

  return (
    <div className="flex flex-col gap-4">
      {/* The money model an operator actually edits. The synced pricebook below
          supplies the per-model base; this catalog turns that base into an offer. */}
      <CatalogPanel clientId={clientId} />

      <section className="card p-5">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">Model pricebook · {clientId}</h2>
          <div className="flex items-center gap-2">
            <span className={`pill ${d.source === "synced" ? "chip-green" : "chip-yellow"}`} style={{ fontSize: 11 }}>
              {d.source === "synced" ? "synced from client" : "seed snapshot"}
            </span>
            <span className="pill" style={{ fontSize: 11 }}>{d.book?.currency || "—"}</span>
            <a className="pill" href={withBase(`/console/${clientId}`)} target="_blank" rel="noreferrer">
              Full console ↗
            </a>
          </div>
        </div>
        <p className="text-[12px] text-[var(--muted)]">
          Prices are owned by the client and pushed into GradeIQ, which then holds
          them and quotes offline. {models.length} models.
        </p>
      </section>

      {models.length > 0 && (
        <section className="card p-5">
          <div style={{ overflowX: "auto", maxHeight: 520 }}>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  <th className="py-2 pr-3">Model</th>
                  <th className="py-2 pr-3">Base ({cur})</th>
                </tr>
              </thead>
              <tbody>
                {models.slice(0, 200).map((m: any, i: number) => (
                  <tr key={i} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-3">{m.name ?? m.model ?? "—"}</td>
                    <td className="py-1.5 pr-3 font-semibold">
                      {cur}
                      {/* the synced book's field is basePrice — reading only
                          base/price printed "$—" for every model */}
                      {m.basePrice ?? m.base ?? m.price ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
