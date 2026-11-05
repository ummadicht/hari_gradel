import { getSetting } from "./settings";

/**
 * RazorpayX payouts — settle a completed buyback to the RETAIL STORE's UPI.
 *
 * Real mode needs three credentials (settings keys, falling back to env):
 *   razorpay_key_id     / RAZORPAY_KEY_ID
 *   razorpay_key_secret / RAZORPAY_KEY_SECRET
 *   razorpayx_account   / RAZORPAYX_ACCOUNT_NUMBER   (the X current-account no.)
 * plus the store's UPI VPA (settings: payout_vpa:<clientId>).
 *
 * The X flow is contact → fund_account(vpa) → payout(UPI, paise). We chain the
 * three calls per payout; Razorpay dedupes contacts server-side by details, so
 * repeat payouts to the same store are fine.
 *
 * KEYLESS → SIMULATED, honestly labeled (method:"simulated") — same stance as
 * the AI stubs: never fabricate a real-looking UTR. The credit ledger still
 * moves so the desk flow is fully rehearsable before keys exist.
 */

const API = "https://api.razorpay.com/v1";

export type PayoutResult = {
  method: "razorpay" | "razorpay-mock" | "simulated";
  payoutId?: string;
  utr?: string;
  status: "processed" | "queued" | "failed";
  note?: string;
};

function creds() {
  return {
    keyId: getSetting("razorpay_key_id", "RAZORPAY_KEY_ID"),
    keySecret: getSetting("razorpay_key_secret", "RAZORPAY_KEY_SECRET"),
    account: getSetting("razorpayx_account", "RAZORPAYX_ACCOUNT_NUMBER"),
  };
}

export function razorpayConfigured(): boolean {
  const c = creds();
  return !!(c.keyId && c.keySecret && c.account);
}

async function rp(pathname: string, body: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const { keyId, keySecret } = creds();
  const res = await fetch(`${API}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      // RazorpayX dedupes payout POSTs on this header — a network-level retry
      // of the same purchase can never mint a second payout.
      ...(idempotencyKey ? { "X-Payout-Idempotency": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const desc = (j?.error as { description?: string } | undefined)?.description || `HTTP ${res.status}`;
    throw new Error(`Razorpay ${pathname}: ${desc}`);
  }
  return j;
}

/**
 * Pay `amountINR` (whole rupees) to `vpa` via UPI. `name`/`phone` label the
 * receiving contact (the store) in the Razorpay dashboard; `ref` ties the payout
 * back to the purchase for reconciliation.
 */
export async function payoutToUpi(opts: {
  name: string;
  phone: string;
  vpa: string;
  amountINR: number;
  ref: string;
}): Promise<PayoutResult> {
  const amount = Math.round(opts.amountINR);
  if (!(amount > 0)) return { method: "simulated", status: "failed", note: "Invalid amount." };

  if (!razorpayConfigured()) {
    // RAZORPAY MOCK MODE — mirrors the real RazorpayX lifecycle so the desk
    // demos end-to-end without keys: the payout returns "queued" with a
    // Razorpay-shaped id (like a real async UPI payout), then settles to
    // "processed" with a UTR a few seconds later (settleMockPayout, read-time).
    // Every identifier is stamped MOCK — it can never pass for a real payment.
    const rand = () =>
      Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 34)]).join("");
    return {
      method: "razorpay-mock",
      payoutId: `pout_MOCK${rand()}`,
      status: "queued",
      note: "Razorpay MOCK mode — no real money moves. Add keys in Settings to go live.",
    };
  }

  const { account } = creds();
  const contact = await rp("/contacts", {
    name: opts.name.slice(0, 50),
    contact: opts.phone,
    type: "vendor",
    reference_id: opts.ref.slice(0, 40),
  });
  const fund = await rp("/fund_accounts", {
    contact_id: contact.id,
    account_type: "vpa",
    vpa: { address: opts.vpa },
  });
  const payout = (await rp(
    "/payouts",
    {
      account_number: account,
      fund_account_id: fund.id,
      amount: amount * 100, // paise
      currency: "INR",
      mode: "UPI",
      purpose: "payout",
      reference_id: opts.ref.slice(0, 40),
      narration: `GradeIQ buyback ${opts.ref}`.slice(0, 30),
    },
    `gradeiq-${opts.ref}` // one payout per purchase, ever
  )) as { id?: string; utr?: string; status?: string };

  const st = String(payout.status || "");
  return {
    method: "razorpay",
    payoutId: String(payout.id || ""),
    utr: payout.utr ? String(payout.utr) : undefined,
    // X payouts start "queued"/"processing" and settle async; both are success
    // states for the desk. Only an explicit rejection/failed is a failure.
    status: /reversed|cancelled|rejected|failed/.test(st) ? "failed" : st === "processed" ? "processed" : "queued",
  };
}
