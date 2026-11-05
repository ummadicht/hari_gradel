import { withBase } from "@/lib/basePath";
import { effectiveAuthMode } from "@/lib/auth-mode";
import { safeReturnTo } from "@/lib/authUrls";
import { defaultsPausedAfterCutover } from "@/lib/portalAuth";
import LegacyLoginForm from "./LegacyLoginForm";

export const dynamic = "force-dynamic";

// Staff sign-in. Renders whichever mechanism is ACTUALLY live:
//   legacy → username + password against the portal/enterprise accounts
//   oidc   → hand off to Keycloak (there is no password form in this mode)
// Every message promises only a way in that exists on this page: with Keycloak
// down there is no password fallback (it would re-open the built-in defaults),
// so the page says to retry, and that a signed-in session keeps working.
const RETRY = "Please try again.";
const ERRORS: Record<string, string> = {
  idp_unavailable:
    "Single sign-on isn't answering right now, so new sign-ins can't finish. If you're already signed in on this device, you still are. Try again in a minute — if it keeps happening, tell your GradeIQ administrator.",
  sso_misconfigured:
    "Single sign-on isn't set up correctly on this server, so sign-in can't finish. Your GradeIQ administrator can see why in the server log.",
  no_access:
    "Your account doesn't have access to GradeIQ. Ask your administrator to give you GradeIQ access for your client, or sign in with a different account.",
  access_denied: "Sign-in was cancelled.",
  callback_failed: `Sign-in could not be completed. ${RETRY}`,
  token_exchange_failed: `Sign-in could not be completed. ${RETRY}`,
  state_mismatch: "Your sign-in link expired. Please start again.",
  missing_tx: "Your sign-in link expired. Please start again.",
  bad_tx: "Your sign-in link expired. Please start again.",
  token_verify_failed: `We couldn't verify your sign-in. ${RETRY}`,
  nonce_mismatch: "Your sign-in link expired. Please start again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; returnTo?: string }>;
}) {
  const sp = await searchParams;
  const msg = sp.error ? ERRORS[sp.error] ?? `Sign-in failed. ${RETRY}` : null;
  const returnTo = safeReturnTo(sp.returnTo);
  const mode = effectiveAuthMode();
  // A plain <a>, not next/link: /auth/login is a route handler that redirects
  // off-site, and <Link> adds the basePath itself — wrapping its href in
  // withBase() produced /apps/gradeiq/apps/gradeiq/auth/login, a 404, as the
  // only control on the page every logout and every sign-in error lands on.
  const href = withBase(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  const paused = mode === "legacy" && defaultsPausedAfterCutover();

  return (
    <div className="min-h-[100dvh] grid place-items-center bg-[var(--bg)] px-4">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-center">
        <div className="brandmark mx-auto h-11 w-11 text-[15px]">IQ</div>
        <h1 className="mt-4 text-xl font-semibold">Sign in to GradeIQ</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">Staff &amp; partner console.</p>

        {msg && (
          <p role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
            {msg}
          </p>
        )}
        {paused && (
          <p role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
            The built-in default passwords are switched off on this server. Sign in with a password your
            administrator set, or ask them to finish the sign-in setup.
          </p>
        )}

        {mode === "oidc" ? (
          <>
            <a
              href={href}
              className="mt-6 inline-flex w-full items-center justify-center rounded-full px-6 py-3 text-sm font-semibold text-white"
              style={{ background: "var(--grad)" }}
            >
              {msg ? "Try again →" : "Continue to sign in →"}
            </a>
            {sp.error === "no_access" && (
              <a href={withBase("/auth/logout")} className="mt-3 inline-block text-sm font-medium text-[var(--muted)] underline">
                Use a different account
              </a>
            )}
          </>
        ) : (
          <LegacyLoginForm returnTo={returnTo} />
        )}
      </div>
    </div>
  );
}
