"use client";

import { useState } from "react";
import { withBase } from "@/lib/basePath";

/**
 * Username + password sign-in against the portal/enterprise accounts.
 *
 * This form was removed when staff sign-in was pointed at Keycloak. Since no
 * Keycloak exists, removing it left `/login` as a launcher whose only button led
 * back to a failing OIDC start — so there was no way into the console at all.
 * It is back, and it is what `legacy` mode renders.
 */
export default function LegacyLoginForm({ returnTo }: { returnTo: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(withBase("/api/portal/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!r.ok) {
        setErr("That username and password didn't match.");
        return;
      }
      // A full navigation, not a router push — the session cookie was just set
      // and the destination is a server-rendered, middleware-gated page.
      window.location.href = withBase(returnTo);
    } catch {
      setErr("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3 text-left">
      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Username</span>
        <input
          className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--brand)]"
          value={username}
          autoComplete="username"
          autoCapitalize="none"
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Password</span>
        <input
          className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--brand)]"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>

      {err && <p className="text-sm font-medium text-red-600">{err}</p>}

      <button
        type="submit"
        disabled={busy || !username || !password}
        className="mt-1 inline-flex w-full items-center justify-center rounded-full px-6 py-3 text-sm font-semibold text-white disabled:opacity-40"
        style={{ background: "var(--grad)" }}
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
