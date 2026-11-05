import { db, getSession, newToken, type Session } from "./db";
import { getSetting } from "./settings";
import { resolveClient } from "./clients";
import { estimateValue } from "./valuation";

/**
 * RETAIL PURCHASES — the walk-in buyback pipeline behind /channel/retail.
 *
 * A purchase is the COMMERCIAL wrapper around a GradeIQ session (the technical
 * check). Staged deliberately, per the India retail flow:
 *
 *   intake    — name + mobile only (light touch; nobody hands over their Aadhaar
 *               before they've even seen a price)
 *   checking  — the linked GradeIQ session is running (90-second check)
 *   offered   — the check produced a ₹ offer
 *   accepted  — customer said yes → NOW collect KYC (ID type + last-4 + name)
 *   cleared   — clearance verified: FMiP/iCloud OFF, not blacklisted, SIM out,
 *               factory reset. FMiP + blacklist are AUTO-checked from the
 *               session's own IMEI lookup — the operator can't "forget" them.
 *   paid      — Razorpay payout fired to the STORE's registered UPI and the
 *               store's credit line reduced by the amount. (The store hands the
 *               customer their money; the platform settles the store.)
 *   declined / cancelled — terminal.
 *
 * CREDIT LEDGER — each client (store) has an opening credit line (settings key
 * credit:<clientId>, ₹ whole rupees). Every payout appends a negative ledger row.
 * Balance = opening + Σ(deltas). Append-only: history is the audit trail.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS purchases (
    id          TEXT PRIMARY KEY,
    client_id   TEXT NOT NULL,
    created_by  TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'intake',
    customer    TEXT NOT NULL DEFAULT '{}',
    phone       TEXT NOT NULL DEFAULT '',
    imei        TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    kyc         TEXT NOT NULL DEFAULT '{}',
    session_id  TEXT NOT NULL DEFAULT '',
    offer       TEXT NOT NULL DEFAULT '{}',
    clearance   TEXT NOT NULL DEFAULT '{}',
    payout      TEXT NOT NULL DEFAULT '{}',
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    timezone    TEXT NOT NULL DEFAULT 'UTC',
    store_id    TEXT NOT NULL DEFAULT '',
    store_name  TEXT NOT NULL DEFAULT '',
    store_info  TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_purchases_client ON purchases(client_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_purchases_session ON purchases(session_id);

  CREATE TABLE IF NOT EXISTS credit_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id     TEXT NOT NULL,
    delta         INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    ref           TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    at            TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_client ON credit_ledger(client_id, id);
`);

for (const [col, def] of [
  ["phone", "TEXT NOT NULL DEFAULT ''"],
  ["imei", "TEXT NOT NULL DEFAULT ''"],
  ["model", "TEXT NOT NULL DEFAULT ''"],
  ["recorded_at", "TEXT NOT NULL DEFAULT ''"],
  ["timezone", "TEXT NOT NULL DEFAULT 'UTC'"],
  ["store_id", "TEXT NOT NULL DEFAULT ''"],
  ["store_name", "TEXT NOT NULL DEFAULT ''"],
  ["store_info", "TEXT NOT NULL DEFAULT '{}'"],
] as const) {
  const has = (
    db.prepare("PRAGMA table_info(purchases)").all() as { name: string }[]
  ).some((c) => c.name === col);
  if (!has) {
    try {
      db.exec(`ALTER TABLE purchases ADD COLUMN ${col} ${def};`);
    } catch {
      /* concurrent init */
    }
  }
}

export type PurchaseStatus =
  | "intake" | "checking" | "offered" | "accepted" | "cleared" | "paying" | "paid"
  | "declined" | "cancelled";

export type Customer = { name: string; phone: string };
export type StoreMetadata = {
  storeId?: string;
  storeName?: string;
  branch?: string;
  storePhone?: string;
  address?: string;
  city?: string;
  operator?: string;
  vpa?: string;
  currency?: string;
  imei?: string;
  model?: string;
  recordedAt?: string;
  timezone?: string;
};
export type Kyc = { idType: string; idLast4: string; idName: string; address?: string };
export type Clearance = {
  fmip: "clear" | "locked" | "unknown";
  blacklist: "clean" | "flagged" | "unknown";
  simRemoved: boolean;
  factoryReset: boolean;
  verifiedBy: string;
  at: string;
};
export type Payout = {
  method: "razorpay" | "razorpay-mock" | "simulated";
  payoutId?: string;
  utr?: string;
  amount: number;
  currency: string;
  vpa?: string;
  status: "processed" | "queued" | "failed";
  at: string;
  note?: string;
};

export type Purchase = {
  id: string;
  client_id: string;
  created_by: string;
  status: PurchaseStatus;
  customer: Partial<Customer>;
  phone: string;
  imei: string;
  model: string;
  kyc: Partial<Kyc>;
  session_id: string;
  offer: { value?: number; currency?: string; grade?: string; note?: string; at?: string };
  clearance: Partial<Clearance>;
  payout: Partial<Payout>;
  recorded_at: string;
  timezone: string;
  store_id: string;
  store_name: string;
  store_info: Record<string, any>;
  created_at: string;
  updated_at: string;
};

function hydrate(row: Record<string, unknown>): Purchase {
  const j = (v: unknown) => {
    try { return JSON.parse(String(v || "{}")); } catch { return {}; }
  };
  const customer = j(row.customer) as Partial<Customer>;
  return {
    ...(row as object),
    customer,
    phone: String(row.phone || customer?.phone || ""),
    imei: String(row.imei || ""),
    model: String(row.model || ""),
    recorded_at: String(row.recorded_at || row.created_at || ""),
    timezone: String(row.timezone || "UTC"),
    store_id: String(row.store_id || ""),
    store_name: String(row.store_name || ""),
    store_info: j(row.store_info),
    kyc: j(row.kyc),
    offer: j(row.offer),
    clearance: j(row.clearance),
    payout: j(row.payout),
  } as Purchase;
}

export function getPurchase(id: string): Purchase | null {
  const row = db.prepare("SELECT * FROM purchases WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? hydrate(row) : null;
}

export function listPurchases(clientId: string, limit = 30): Purchase[] {
  return (db
    .prepare("SELECT * FROM purchases WHERE client_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(clientId, limit) as Record<string, unknown>[]).map(hydrate);
}

export function findPurchaseBySession(sessionId: string): Purchase | null {
  const row = db.prepare("SELECT * FROM purchases WHERE session_id = ? LIMIT 1").get(sessionId) as
    | Record<string, unknown>
    | undefined;
  return row ? hydrate(row) : null;
}

function touch(id: string, fields: Record<string, string>) {
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE purchases SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
    ...Object.values(fields),
    id
  );
}

/** intake — name + mobile + optional IMEI, model, datetime, timezone, and store metadata. */
export function createPurchase(
  clientId: string,
  createdBy: string,
  customer: Customer,
  meta?: StoreMetadata
): Purchase {
  const name = String(customer.name || "").trim().slice(0, 80);
  const phone = String(customer.phone || "").replace(/[^\d+]/g, "").slice(0, 16);
  if (!name || phone.replace(/\D/g, "").length < 10) {
    throw new Error("Customer name and a valid 10-digit mobile number are required.");
  }
  const clientDef = resolveClient(clientId);
  const storeVpa = getSetting(`payout_vpa:${clientId}`) || "";
  const imei = String(meta?.imei || "").replace(/\D/g, "").slice(0, 15);
  const model = String(meta?.model || "").trim().slice(0, 80);
  const timezone = String(meta?.timezone || "UTC").trim().slice(0, 64) || "UTC";
  const recordedAt = String(meta?.recordedAt || new Date().toISOString()).slice(0, 40);
  const storeId = String(meta?.storeId || `${clientId}-main`).trim().slice(0, 64);
  const storeName = String(meta?.storeName || clientDef.name).trim().slice(0, 120);
  const storeInfo = {
    storeId,
    storeName,
    branch: String(meta?.branch || "Main Counter").slice(0, 80),
    storePhone: String(meta?.storePhone || phone).slice(0, 24),
    address: String(meta?.address || "").slice(0, 160),
    city: String(meta?.city || "").slice(0, 64),
    operator: createdBy,
    vpa: storeVpa,
    currency: clientDef.currency,
    customerName: name,
    customerPhone: phone,
    imei,
    model,
    recordedAt,
    timezone,
  };

  const id = `p_${newToken()}`;
  db.prepare(
    `INSERT INTO purchases (
       id, client_id, created_by, status, customer,
       phone, imei, model, recorded_at, timezone, store_id, store_name, store_info
     ) VALUES (?, ?, ?, 'intake', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    clientId,
    createdBy,
    JSON.stringify({ name, phone }),
    phone,
    imei,
    model,
    recordedAt,
    timezone,
    storeId,
    storeName,
    JSON.stringify(storeInfo)
  );

  try {
    db.prepare(
      `INSERT INTO stores (id, client_id, store_name, branch, phone, address, city, timezone, vpa, operator, store_info)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         store_name = excluded.store_name,
         branch = excluded.branch,
         phone = CASE WHEN excluded.phone <> '' THEN excluded.phone ELSE stores.phone END,
         timezone = excluded.timezone,
         vpa = excluded.vpa,
         operator = excluded.operator,
         store_info = excluded.store_info,
         updated_at = datetime('now')`
    ).run(
      storeId,
      clientId,
      storeName,
      storeInfo.branch,
      storeInfo.storePhone,
      storeInfo.address,
      storeInfo.city,
      timezone,
      storeVpa,
      createdBy,
      JSON.stringify(storeInfo)
    );
  } catch {
    /* non-blocking store directory sync */
  }

  return getPurchase(id)!;
}

/**
 * Link the GradeIQ session created for this purchase (called from session POST,
 * which has ALREADY verified an authenticated portal user whose tenant owns the
 * purchase). Immutable: a purchase links exactly one session, ever —
 * re-linking would let a second device swap in a different (better) phone after
 * the first was priced. The session's tenant must equal the purchase's tenant.
 */
export function linkSession(purchaseId: string, sessionId: string): void {
  const p = getPurchase(purchaseId);
  if (!p || p.status !== "intake" || p.session_id) return;
  const s = getSession(sessionId);
  if (!s || String((s as { client_id?: string }).client_id || "") !== p.client_id) return;
  const imei = s.imei || p.imei || "";
  const model = s.model || p.model || "";
  touch(purchaseId, {
    session_id: sessionId,
    status: "checking",
    ...(imei ? { imei } : {}),
    ...(model ? { model } : {}),
  });
  try {
    db.prepare(
      `UPDATE sessions
       SET phone = CASE WHEN phone = '' THEN ? ELSE phone END,
           imei = CASE WHEN imei = '' THEN ? ELSE imei END,
           timezone = CASE WHEN timezone = '' OR timezone = 'UTC' THEN ? ELSE timezone END,
           store_id = CASE WHEN store_id = '' THEN ? ELSE store_id END,
           store_name = CASE WHEN store_name = '' THEN ? ELSE store_name END,
           store_info = CASE WHEN store_info = '{}' THEN ? ELSE store_info END,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      p.phone || p.customer?.phone || "",
      imei,
      p.timezone || "UTC",
      p.store_id || "",
      p.store_name || "",
      JSON.stringify(p.store_info ?? {}),
      sessionId
    );
  } catch {
    /* non-blocking session enrichment */
  }
}

/**
 * The live offer for a purchase — read from the linked session's valuation.
 * Promotes checking → offered ONLY once the check actually produced a grade:
 * estimateValue prices an ungraded session too (conservative defaults), and
 * freezing that number seconds after the session opens would lock in a price
 * for a phone nobody has inspected yet.
 */
export function refreshOffer(p: Purchase): Purchase {
  if (!p.session_id) return p;
  const s = getSession(p.session_id);
  if (!s) return p;
  const syncFields: Record<string, string> = {};
  if (s.imei && s.imei !== p.imei) syncFields.imei = s.imei;
  if (s.model && s.model !== p.model) syncFields.model = s.model;
  if (p.status !== "checking") {
    if (Object.keys(syncFields).length > 0) {
      touch(p.id, syncFields);
      return getPurchase(p.id)!;
    }
    return p;
  }
  const graded = !!(s.cosmetic_grade || s.overall_grade) || s.status === "graded";
  if (!graded) {
    if (Object.keys(syncFields).length > 0) {
      touch(p.id, syncFields);
      return getPurchase(p.id)!;
    }
    return p;
  }
  const v = estimateValue(s);
  if (v.value > 0) {
    touch(p.id, {
      ...syncFields,
      status: "offered",
      offer: JSON.stringify({ value: v.value, currency: v.currency, grade: v.grade, note: v.note, at: new Date().toISOString() }),
    });
    return getPurchase(p.id)!;
  }
  if (Object.keys(syncFields).length > 0) {
    touch(p.id, syncFields);
    return getPurchase(p.id)!;
  }
  return p;
}

/** Customer said yes to the ₹ number → unlock the KYC step. */
export function acceptOffer(id: string): Purchase {
  const p = getPurchase(id);
  if (!p) throw new Error("Purchase not found.");
  if (p.status !== "offered") throw new Error(`Can't accept from status "${p.status}".`);
  touch(id, { status: "accepted" });
  return getPurchase(id)!;
}

export function declineOffer(id: string): Purchase {
  const p = getPurchase(id);
  if (!p) throw new Error("Purchase not found.");
  // A customer can walk away any time BEFORE money moves — never after.
  if (!["offered", "accepted", "cleared"].includes(p.status)) {
    throw new Error(`Can't decline from status "${p.status}".`);
  }
  touch(id, { status: "declined" });
  return getPurchase(id)!;
}

/** KYC AFTER acceptance — ID reference only (type + last 4 + name as printed). */
export function saveKyc(id: string, kyc: Kyc): Purchase {
  const p = getPurchase(id);
  if (!p) throw new Error("Purchase not found.");
  if (p.status !== "accepted") throw new Error("KYC is collected after the customer accepts the offer.");
  const idType = String(kyc.idType || "").slice(0, 20);
  const idLast4 = String(kyc.idLast4 || "").replace(/\D/g, "").slice(-4);
  const idName = String(kyc.idName || "").trim().slice(0, 80);
  if (!idType || idLast4.length !== 4 || !idName) {
    throw new Error("ID type, the last 4 digits, and the name as printed are required.");
  }
  touch(id, { kyc: JSON.stringify({ idType, idLast4, idName, address: String(kyc.address || "").slice(0, 160) }) });
  return getPurchase(id)!;
}

/**
 * Auto-clearance from the session's own data — the operator can't skip these.
 * FMiP/iCloud + blacklist come from the IMEI lookup / Phonecheck pulled at
 * session creation; "unknown" is honest when the lookup had no data.
 */
export function autoClearance(s: Session | null): { fmip: Clearance["fmip"]; blacklist: Clearance["blacklist"] } {
  const info = (s?.imei_info ?? {}) as { fmip?: string; blacklist?: string; lock?: string };
  const pc = (s?.phonecheck ?? {}) as { fmip?: string; blacklist?: string };
  const fmipRaw = String(info.fmip ?? pc.fmip ?? "").toLowerCase();
  const blRaw = String(info.blacklist ?? pc.blacklist ?? "").toLowerCase();
  const fmip: Clearance["fmip"] = /off|clear|clean|no/.test(fmipRaw)
    ? "clear"
    : /on|lock|active|yes/.test(fmipRaw)
      ? "locked"
      : "unknown";
  const blacklist: Clearance["blacklist"] = /clean|clear|no/.test(blRaw)
    ? "clean"
    : /black|lost|stolen|flag|yes/.test(blRaw)
      ? "flagged"
      : "unknown";
  return { fmip, blacklist };
}

/**
 * Record clearance. HARD GATES: an FMiP-locked or blacklisted phone can never
 * clear — that's the compliance line, not a checkbox. simRemoved/factoryReset
 * are the operator's physical confirmation.
 */
export function verifyClearance(
  id: string,
  by: string,
  manual: { simRemoved: boolean; factoryReset: boolean; fmipVisuallyOff?: boolean }
): Purchase {
  const p = getPurchase(id);
  if (!p) throw new Error("Purchase not found.");
  if (p.status !== "accepted") throw new Error("Clearance runs after KYC (accepted status).");
  if (!p.kyc?.idLast4) throw new Error("Record the customer's ID first.");
  const s = p.session_id ? getSession(p.session_id) : null;
  const auto = autoClearance(s);
  // "unknown" FMiP can be overridden by the operator LOOKING at the device
  // (Settings → Apple ID shows no Find My) — but a positive "locked" cannot.
  const fmip = auto.fmip === "unknown" && manual.fmipVisuallyOff ? "clear" : auto.fmip;
  if (fmip === "locked") throw new Error("Find My / activation lock is ON — the phone cannot be purchased until it's removed.");
  // A station's MDM status used to be read AS Find My, so an MDM-managed phone
  // was stopped by the line above. Find My now comes only from the activation-
  // lock fields; MDM keeps stopping the purchase, under its own name.
  if ((s?.phonecheck as { mdm?: string } | undefined)?.mdm === "on")
    throw new Error("Device management (MDM) is ON — the phone cannot be purchased until it's released.");
  if (auto.blacklist === "flagged") throw new Error("This IMEI is flagged lost/stolen — do not purchase. Return the device.");
  if (auto.blacklist !== "clean") {
    throw new Error("Blacklist status is unknown — obtain an authoritative IMEI/GSMA result before payout.");
  }
  if (!manual.simRemoved || !manual.factoryReset) {
    throw new Error("Confirm the SIM is out and the phone is factory reset.");
  }
  const clearance: Clearance = {
    fmip,
    blacklist: auto.blacklist,
    simRemoved: true,
    factoryReset: true,
    verifiedBy: by,
    at: new Date().toISOString(),
  };
  touch(id, { status: "cleared", clearance: JSON.stringify(clearance) });
  return getPurchase(id)!;
}

// ── Credit ledger ────────────────────────────────────────────────────────────

/** Opening credit line for a client, ₹ whole rupees (settings: credit:<id>). */
export function openingCredit(clientId: string): number {
  const raw = getSetting(`credit:${clientId}`).trim();
  // Only an UNSET key falls back to the default — an explicit "0" means an
  // admin froze this store's line, and must not silently restore ₹50,00,000.
  if (raw !== "") {
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  }
  // Sensible default for INR retail partners; USD/EUR tenants default to 0
  // (credit lines are an India-retail concept here).
  return resolveClient(clientId).currency === "INR" ? 5_000_000 : 0;
}

export function creditBalance(clientId: string): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(delta), 0) AS used FROM credit_ledger WHERE client_id = ?")
    .get(clientId) as { used: number };
  return openingCredit(clientId) + (row?.used ?? 0);
}

export function creditHistory(clientId: string, limit = 20) {
  return db
    .prepare("SELECT * FROM credit_ledger WHERE client_id = ? ORDER BY id DESC LIMIT ?")
    .all(clientId, limit);
}

/**
 * RESERVE → CAPTURE payout, so real money and the ledger can never diverge:
 *
 *   claimPayout()  — atomically: re-check status, currency, and balance, then
 *                    RESERVE the credit (negative ledger row) and set status
 *                    "paying". A concurrent second claim sees "paying" and is
 *                    rejected BEFORE any external call. Runs before Razorpay.
 *   commitPayout() — after a successful Razorpay call: persist the payout
 *                    result, status "paid". Cannot fail on balance (already
 *                    reserved), so a successful payout is always recorded.
 *   releasePayout()— after a FAILED Razorpay call: refund the reservation
 *                    (positive ledger row), persist the failure on the
 *                    purchase, status back to "cleared". Nothing is lost.
 *   reversePayout()— operational credit-back for an async UPI reversal
 *                    (RazorpayX can reverse a "queued" payout hours later).
 *                    Appends the compensating +row and stamps the payout
 *                    "reversed". Until a webhook exists this is invoked from
 *                    the API by a super admin.
 *
 * better-sqlite3 transactions are synchronous and the process is single-
 * threaded, so two concurrent HTTP claims serialize — exactly one wins.
 */
export function claimPayout(id: string): { purchase: Purchase; amount: number } {
  let amount = 0;
  const tx = db.transaction(() => {
    const p = getPurchase(id);
    if (!p) throw new Error("Purchase not found.");
    if (p.status === "paying") throw new Error("A payout for this purchase is already in flight.");
    if (p.status !== "cleared") throw new Error(`Payout requires cleared status (is "${p.status}").`);
    if (p.payout?.status === "processed" || p.payout?.status === "queued") throw new Error("Already paid.");
    amount = Math.round(Number(p.offer?.value ?? 0));
    if (!(amount > 0)) throw new Error("No priced offer on this purchase.");
    // The ledger and RazorpayX both denominate in ₹ — refuse to move a USD/EUR
    // figure through them at face value. (No FX, same rule as the pricebooks.)
    const cur = String(p.offer?.currency || "");
    if (cur !== "INR") throw new Error(`Offer is in ${cur || "an unknown currency"} — payouts settle in INR only.`);
    const bal = creditBalance(p.client_id);
    if (bal < amount) throw new Error(`Insufficient credit: balance ₹${bal.toLocaleString("en-IN")}, needed ₹${amount.toLocaleString("en-IN")}.`);
    db.prepare(
      "INSERT INTO credit_ledger (client_id, delta, balance_after, ref, note) VALUES (?, ?, ?, ?, ?)"
    ).run(p.client_id, -amount, bal - amount, id, `Payout reserved · ${p.customer?.name ?? ""}`);
    touch(id, { status: "paying" });
  });
  tx();
  return { purchase: getPurchase(id)!, amount };
}

export function commitPayout(id: string, payout: Payout): Purchase {
  const tx = db.transaction(() => {
    const p = getPurchase(id);
    if (!p) throw new Error("Purchase not found.");
    if (p.status !== "paying") throw new Error(`Commit expects an in-flight payout (is "${p.status}").`);
    touch(id, { status: "paid", payout: JSON.stringify(payout) });
  });
  tx();
  return getPurchase(id)!;
}

export function releasePayout(id: string, reason: string): Purchase {
  const tx = db.transaction(() => {
    const p = getPurchase(id);
    if (!p) throw new Error("Purchase not found.");
    if (p.status !== "paying") return; // nothing reserved → nothing to release
    const amount = Math.round(Number(p.offer?.value ?? 0));
    const bal = creditBalance(p.client_id);
    db.prepare(
      "INSERT INTO credit_ledger (client_id, delta, balance_after, ref, note) VALUES (?, ?, ?, ?, ?)"
    ).run(p.client_id, amount, bal + amount, id, `Payout failed — reservation released`);
    touch(id, {
      status: "cleared",
      payout: JSON.stringify({ status: "failed", amount, currency: "INR", at: new Date().toISOString(), note: reason.slice(0, 300) }),
    });
  });
  tx();
  return getPurchase(id)!;
}

/**
 * Settle a MOCK payout on read — mirrors RazorpayX's async UPI lifecycle:
 * queued at payout time, processed (with a UTR) a few seconds later. Only ever
 * touches method "razorpay-mock" rows; real Razorpay statuses are never
 * invented here (those need the webhook/polling to change).
 */
const MOCK_SETTLE_MS = 8_000;
export function settleMockPayout(p: Purchase): Purchase {
  const pay = p.payout as Partial<Payout> & { at?: string };
  if (p.status !== "paid" || pay?.method !== "razorpay-mock" || pay?.status !== "queued") return p;
  const at = Date.parse(pay.at || "") || 0;
  if (Date.now() - at < MOCK_SETTLE_MS) return p;
  const utr = `MOCKUTR${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}${Date.now() % 1000}`;
  touch(p.id, {
    payout: JSON.stringify({ ...pay, status: "processed", utr, note: "Razorpay MOCK — settled. No real money moved." }),
  });
  return getPurchase(p.id)!;
}

export function reversePayout(id: string, by: string, reason: string): Purchase {
  const tx = db.transaction(() => {
    const p = getPurchase(id);
    if (!p) throw new Error("Purchase not found.");
    if (p.status !== "paid") throw new Error(`Only a paid purchase can be reversed (is "${p.status}").`);
    if (!p.payout?.amount || p.payout?.status === "failed") throw new Error("No committed payout to reverse.");
    if ((p.payout as { reversedAt?: string }).reversedAt) throw new Error("Already reversed.");
    const amount = Math.round(Number(p.payout.amount));
    const bal = creditBalance(p.client_id);
    db.prepare(
      "INSERT INTO credit_ledger (client_id, delta, balance_after, ref, note) VALUES (?, ?, ?, ?, ?)"
    ).run(p.client_id, amount, bal + amount, id, `Payout reversed by ${by}: ${reason.slice(0, 120)}`);
    touch(id, {
      payout: JSON.stringify({ ...p.payout, status: "failed", reversedAt: new Date().toISOString(), note: `Reversed by ${by}: ${reason.slice(0, 200)}` }),
    });
  });
  tx();
  return getPurchase(id)!;
}
