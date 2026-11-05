import { redirect } from "next/navigation";

// The desk tester moved INTO the console (one login, one flow) — it now also
// stamps the session with the client selected in the portal, which the
// standalone page could not do.
//
// NOTE: redirect() already applies basePath; do NOT wrap in withBase().
export default function EnterprisePage() {
  redirect("/superadmin?tab=desk");
}
