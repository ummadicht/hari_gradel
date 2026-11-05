import { redirect } from "next/navigation";

// Platform integrations moved INTO the console (one login, one flow). Kept as a
// redirect so existing bookmarks still land in the right place.
//
// NOTE: next/navigation's redirect() already applies basePath — wrapping this in
// withBase() double-prefixes it to /apps/gradeiq/apps/gradeiq/...
export default function SettingsPage() {
  redirect("/superadmin?tab=integrations");
}
