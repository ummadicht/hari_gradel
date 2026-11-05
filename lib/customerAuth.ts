import crypto from "node:crypto";

// Pandas-compatible OAuth2 client_credentials → bearer token. Credentials come
// from env/settings; the "access_token" is an HMAC-signed value with an expiry
// (functionally a JWT-equivalent, as the docs describe). Default TTL 900s.

const TTL = Number(process.env.PANDAS_TOKEN_TTL || 900); // seconds

function creds() {
  return {
    id: process.env.PANDAS_CLIENT_ID || "cli_live_gradeiq",
    secret: process.env.PANDAS_CLIENT_SECRET || "csec_gradeiq_dev",
    signingKey: process.env.PANDAS_SIGNING_KEY || "gradeiq-pandas-signing-key",
  };
}

export function ttlSeconds() {
  return TTL;
}

export function validClient(id: string, secret: string): boolean {
  const c = creds();
  return id === c.id && secret === c.secret;
}

export function mintToken(): string {
  const c = creds();
  const exp = Math.floor(Date.now() / 1000) + TTL;
  const payload = `${c.id}.${exp}`;
  const sig = crypto
    .createHmac("sha256", c.signingKey)
    .update(payload)
    .digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

// Returns true if the bearer token is well-formed, correctly signed and unexpired.
export function verifyToken(token: string): boolean {
  const c = creds();
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  let payload: string;
  try {
    payload = Buffer.from(parts[0], "base64url").toString();
  } catch {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", c.signingKey)
    .update(payload)
    .digest("base64url");
  if (
    expected.length !== parts[1].length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]))
  )
    return false;
  const exp = Number(payload.split(".")[1]);
  return Number.isFinite(exp) && exp > Math.floor(Date.now() / 1000);
}

// Extract + verify the Authorization: Bearer header. Returns an error code
// matching the Pandas error taxonomy, or null on success.
export function bearerError(auth: string | null): string | null {
  if (!auth || !/^Bearer\s+/i.test(auth)) return "missing_bearer_token";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return verifyToken(token) ? null : "invalid_token";
}
