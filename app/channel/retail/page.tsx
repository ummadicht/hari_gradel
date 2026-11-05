import { redirect } from "next/navigation";

/**
 * DISCONTINUED — the retail desk is now CounterIQ at swapmore.com/counter.
 *
 * This was where a client's store staff (Gadget Rebirth's Inzmam in Mumbai)
 * logged in with their GradeIQ client credentials to collect phones: verify the
 * customer, prep the device, run the check, instant ₹ offer, documents, payout.
 *
 * REDIRECTED, NOT DELETED, on purpose:
 *
 *  • It is a live URL. Prod holds 14 retail-channel sessions and the partner has
 *    it bookmarked; deleting the route would 404 someone mid-shift.
 *  • `RetailDesk.tsx` and the GradeIQ `purchases` table stay exactly where they
 *    are. The superadmin Retail panel still reads and manages that history —
 *    discontinuing where new work STARTS must not erase what was already done.
 *  • It is reversible. Restoring the desk is deleting this file's redirect, not
 *    recovering deleted code.
 *
 * TWO THINGS THIS REDIRECT DOES NOT SOLVE, both flagged to the owner:
 *  1. AUTH. CounterIQ is a separate application (pm2 `retail-portal`) with its
 *     own credentials. A partner's GradeIQ client login does not work there, so
 *     this redirect lands them on a sign-in they cannot pass until they are
 *     issued CounterIQ access.
 *  2. TWO LEDGERS. CounterIQ writes to its own `counteriq.db`. Purchases made
 *     from here onward will not appear in GradeIQ's Retail panel, and the
 *     existing GradeIQ purchase history does not appear in CounterIQ.
 */
export const dynamic = "force-dynamic";

/** Absolute: CounterIQ is a different app behind the same domain, not a GradeIQ route. */
const COUNTER_URL = "https://swapmore.com/counter";

export default function RetailChannelPage() {
  redirect(COUNTER_URL);
}
