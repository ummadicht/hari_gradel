// Per-CLIENT (tenant) registry. GradeIQ is multi-tenant: each client prices its
// offers differently, themes the v2 flow differently, and can configure its own
// journey (capture steps, phases, copy) per CHANNEL in the super-admin portal.
//
// The ids line up with the two systems that feed us:
//   • swapmore.com pushes region pricebooks keyed "swapmore" (US) and
//     "swapmore-in" (India) — so those ARE the tenant ids, one per market.
//     (Before this registry knew "swapmore-in", the India push 404'd.)
//   • ?client= on the v2 embed and session.client_id use the same ids.
// A session records its client_id and every valuation routes on it.

export type ClientId = "swapmore" | "swapmore-in" | "denovo" | "inzman" | "default";

export interface ClientDef {
  id: ClientId;
  name: string;
  currency: "USD" | "INR" | "EUR";
  /** "swapmore" = price from the synced pricebook; "heuristic" = GradeIQ's EUR estimate. */
  pricing: "swapmore" | "heuristic";
}

export const CLIENTS: Record<ClientId, ClientDef> = {
  swapmore: { id: "swapmore", name: "SwapMore US", currency: "USD", pricing: "swapmore" },
  "swapmore-in": { id: "swapmore-in", name: "SwapMore India", currency: "INR", pricing: "swapmore" },
  denovo: { id: "denovo", name: "DeNovo / SuperIQ", currency: "USD", pricing: "heuristic" },
  // India-exclusive retail vendor (Gadget Rebirth, Mumbai — the "Inzmam" account on
  // swapmore.vercel.app). Prices from a pricebook in ₹; until they push their own
  // book, loadPricebook falls back to the swapmore-in India book (same market).
  inzman: { id: "inzman", name: "Gadget Rebirth", currency: "INR", pricing: "swapmore" },
  default: { id: "default", name: "GradeIQ", currency: "EUR", pricing: "heuristic" },
};

export const CLIENT_IDS = Object.keys(CLIENTS) as ClientId[];

export function resolveClient(id?: string | null): ClientDef {
  const key = (id || "").toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(CLIENTS, key)
    ? CLIENTS[key as ClientId]
    : CLIENTS.default;
}

export function isClientId(id?: string | null): id is ClientId {
  const key = (id || "").toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(CLIENTS, key);
}
