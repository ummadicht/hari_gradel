import { NextResponse } from "next/server";

// Token minting is retired — the Pandas-compatible API now authenticates with a
// Keycloak `client_credentials` access token. Callers request one directly from
// the realm's token endpoint:
//   POST {KEYCLOAK_ISSUER}/protocol/openid-connect/token
//   grant_type=client_credentials&client_id=pandas-api&client_secret=…
// then call /api/customers/* with `Authorization: Bearer <token>` (audience `gradeiq`).
export async function POST() {
  return NextResponse.json(
    {
      error: {
        code: "endpoint_retired",
        message: "Request tokens from the Keycloak token endpoint (grant_type=client_credentials).",
        token_endpoint: `${(process.env.KEYCLOAK_ISSUER || "").replace(/\/$/, "")}/protocol/openid-connect/token`,
      },
    },
    { status: 410 }
  );
}
