"use client";
import { useCallback, useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";

// Users & access — who can sign in to the portal (/superadmin) and the retail
// desk (/channel/retail), and with which tenant scope. Built-ins are shown but
// managed via PORTAL_PW_* env; stored users are created/reset/deleted here, no
// redeploy. A client admin sees only their own tenant's logins and can only
// mint client-role users for it (the API enforces both).

type UserRow = {
  username: string;
  role: "super" | "client";
  clientId: string | null;
  builtin: boolean;
  createdBy: string;
  createdAt: string;
};
type Data = { users: UserRow[]; clients: { id: string; name: string }[]; canManageAll: boolean };

export default function UsersPanel() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  // new-user form
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"client" | "super">("client");
  const [clientId, setClientId] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch(withBase("/api/portal/users"));
      const j = await r.json();
      if (!r.ok) return setErr(j.error || "Failed to load.");
      setD(j);
      if (!j.canManageAll) setRole("client");
      if (!clientId && j.clients[0]) setClientId(j.clients[0].id);
    } catch {
      setErr("Failed to load.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function op(body: Record<string, unknown>, okMsg: string) {
    setBusy(true);
    setErr("");
    setOk("");
    try {
      const r = await fetch(withBase("/api/portal/users"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) {
        setErr(j.error || "Failed.");
        return false;
      }
      setOk(okMsg);
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const done = await op({ op: "create", username, password, role, clientId }, `Created "${username.toLowerCase().trim()}".`);
    if (done) {
      setUsername("");
      setPassword("");
    }
  }

  async function reset(u: UserRow) {
    const pw = window.prompt(`New password for ${u.username}:`);
    if (!pw) return;
    await op({ op: "reset", username: u.username, password: pw }, `Password reset for "${u.username}" — their old sessions are signed out.`);
  }

  async function remove(u: UserRow) {
    if (!window.confirm(`Delete the login "${u.username}"? They are signed out immediately.`)) return;
    await op({ op: "delete", username: u.username }, `Deleted "${u.username}".`);
  }

  if (!d) return <div className="card p-6 text-sm text-[var(--muted)]">{err || "Loading users…"}</div>;

  const clientName = (id: string | null) => (id ? d.clients.find((c) => c.id === id)?.name ?? id : "all clients");

  return (
    <div className="space-y-5">
      {err && <div className="card chip-red p-3 text-sm font-semibold">{err}</div>}
      {ok && <div className="card chip-green p-3 text-sm font-semibold">{ok}</div>}

      {/* add user */}
      <div className="card p-5">
        <div className="text-sm font-extrabold">Add a user</div>
        <p className="mt-0.5 text-[12px] text-[var(--muted)]">
          Portal + retail-desk login. Client users are scoped to their tenant; store staff for /channel/retail are client users.
        </p>
        <form onSubmit={create} className="mt-3 flex flex-wrap items-center gap-2">
          <input className="input" style={{ maxWidth: 180 }} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoCapitalize="none" />
          <input className="input" style={{ maxWidth: 180 }} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" type="text" />
          {d.canManageAll && (
            <select className="input" style={{ maxWidth: 140 }} value={role} onChange={(e) => setRole(e.target.value as "client" | "super")}>
              <option value="client">client admin</option>
              <option value="super">super admin</option>
            </select>
          )}
          {role === "client" && d.canManageAll && (
            <select className="input" style={{ maxWidth: 220 }} value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {d.clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
          <button className="pill" style={{ fontWeight: 700, border: "2px solid var(--brand)" }} disabled={busy || !username || !password} type="submit">
            ＋ Create user
          </button>
        </form>
      </div>

      {/* user list */}
      <div className="card overflow-hidden">
        <div className="border-b border-[var(--border)] px-5 py-3 text-sm font-extrabold">
          Users <span className="font-normal text-[var(--muted)]">· {d.users.length}</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="w-full text-left text-[13px]">
            <thead className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
              <tr>
                <th className="px-5 py-2.5">User</th>
                <th className="px-3 py-2.5">Role</th>
                <th className="px-3 py-2.5">Scope</th>
                <th className="px-3 py-2.5">Origin</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {d.users.map((u) => (
                <tr key={u.username} className="border-t border-[var(--border)]">
                  <td className="px-5 py-2.5 font-bold">{u.username}</td>
                  <td className="px-3 py-2.5">
                    <span className={`pill ${u.role === "super" ? "chip-yellow" : ""}`} style={{ fontSize: 11, fontWeight: 700 }}>{u.role}</span>
                  </td>
                  <td className="px-3 py-2.5 text-[var(--muted)]">{clientName(u.clientId)}</td>
                  <td className="px-3 py-2.5 text-[11px] text-[var(--muted)]">
                    {u.builtin ? "built-in · rotate via PORTAL_PW_* env" : `by ${u.createdBy || "?"} · ${u.createdAt.slice(0, 10)}`}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {!u.builtin && (
                      <>
                        <button className="pill" disabled={busy} onClick={() => reset(u)}>Reset password</button>
                        <button className="pill chip-red ml-1" disabled={busy} onClick={() => remove(u)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
