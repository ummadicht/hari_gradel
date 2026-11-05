"use client";
import { useState } from "react";
import { withBase } from "@/lib/basePath";

export default function EnterpriseLogin() {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(withBase("/api/enterprise/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, pass }),
      });
      if (!r.ok) {
        setErr("Invalid credentials.");
        setBusy(false);
        return;
      }
      window.location.href = withBase("/enterprise");
    } catch {
      setErr("Network error.");
      setBusy(false);
    }
  }

  return (
    <div className="container grid min-h-screen place-items-center">
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <div className="text-center">
          <div
            className="mx-auto grid h-12 w-12 place-items-center rounded-xl text-xl font-black text-white"
            style={{ background: "var(--grad)" }}
          >
            G
          </div>
          <h1 className="mt-3 text-xl font-extrabold">
            Grade<span className="grad-text">IQ</span> Enterprise
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Desk-tester console · staff sign-in
          </p>
        </div>
        <label className="mt-5 block text-sm font-semibold">Login ID</label>
        <input
          className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--card-2)] p-2.5"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          autoCapitalize="none"
          autoComplete="username"
        />
        <label className="mt-3 block text-sm font-semibold">Password</label>
        <input
          type="password"
          className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--card-2)] p-2.5"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoComplete="current-password"
        />
        {err && <p className="mt-2 text-sm text-[var(--bad)]">{err}</p>}
        <button className="btn mt-5 w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in →"}
        </button>
      </form>
    </div>
  );
}
