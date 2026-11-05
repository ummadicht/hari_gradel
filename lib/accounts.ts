// A GradeIQ customer logs in and their CHANNEL is fixed by their account — a
// retail store is always "retail", a wholesaler always "wholesale". Staff never
// pick the channel per device. The one exception is Consumer trade-in (c2b),
// which isn't a staff account at all: it's opened by an end-consumer via a QR /
// deep link from the SwapMore app (see /trade-in).

import { Segment } from "./profiles";

export type Account = {
  id: string;
  name: string;
  segment: Segment; // the channel this login is locked to
  emoji: string;
};

export const ACCOUNTS: Account[] = [
  { id: "techtrade", name: "TechTrade Retail", segment: "retail", emoji: "🏪" },
  { id: "fieldscout", name: "FieldScout Buyers", segment: "scout", emoji: "🧭" },
  {
    id: "bulkcell",
    name: "BulkCell Wholesale",
    segment: "wholesale",
    emoji: "📦",
  },
  {
    id: "target-dropbox",
    name: "Target — Drop-Box",
    segment: "enterprise",
    emoji: "🏢",
  },
];

export function accountById(id: string | null): Account | undefined {
  return ACCOUNTS.find((a) => a.id === id);
}

const KEY = "gradeiq_account";

export function loadAccount(): Account | undefined {
  if (typeof window === "undefined") return undefined;
  return accountById(localStorage.getItem(KEY));
}
export function saveAccount(id: string) {
  localStorage.setItem(KEY, id);
}
export function clearAccount() {
  localStorage.removeItem(KEY);
}
