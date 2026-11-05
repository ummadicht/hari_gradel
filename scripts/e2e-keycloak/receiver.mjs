#!/usr/bin/env node
// receiver.mjs — stands in for SuperIQ's /api/diagnostics/ingest in the SUP-84
// e2e test (scripts/e2e-keycloak/run.sh). Records the Bearer token GradeIQ's push-superiq sends, verifies it
// against the mock IdP's JWKS (iss + signature), and reports aud/azp/sub so the
// test can assert GradeIQ minted a gradeiq-svc token for audience superiq-erp.
// Without Keycloak (SUP-77) SuperIQ's legacy ingest takes a static Bearer — its
// Phonecheck webhook secret — so RECV_STATIC_TOKEN is accepted too (`static`).
//
// It is also Phonecheck's Cloud DB for the SUP-72 checks (PHONECHECK_API_URL
// points here): GetDeviceInfo knows no device, CheckEsn answers a GSMA record,
// and GET /pc counts the calls.
//   RECV_PORT (37813)  RECV_ISSUER (mock issuer)  RECV_LOG (jsonl)  RECV_STATIC_TOKEN
import http from "node:http";
import fs from "node:fs";
import * as jose from "jose"; // GradeIQ's own dependency

const PORT = Number(process.env.RECV_PORT || 37813);
const ISSUER = process.env.RECV_ISSUER || "http://127.0.0.1:37812/realms/novetta";
const LOG = process.env.RECV_LOG || "";
const STATIC = process.env.RECV_STATIC_TOKEN || "";
let jwks;
const records = [];
const pcCalls = []; // "<path> <imei>"
const GSMA = {
  API: "G001",
  RawResponse: { marketingname: "Galaxy Z Flip5", brandname: "Samsung", manufacturer: "Samsung Korea", blackliststatus: "No", operatingsys: "Android", modelname: "SM-F731W" },
};

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  if (req.method === "GET" && req.url === "/last") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(records.at(-1) ?? null));
  }
  if (req.method === "GET" && req.url === "/pc") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ calls: pcCalls.length, imeis: [...new Set(pcCalls.map((c) => c.split(" ")[1]))] }));
  }
  if (req.method === "POST" && req.url.startsWith("/cloud/cloudDB/")) {
    const imei = new URLSearchParams(body).get("imei") || "";
    pcCalls.push(`${req.url} ${imei}`);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(req.url.startsWith("/cloud/cloudDB/CheckEsn") ? GSMA : { status: 0, msg: "No Data Found" }));
  }
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  const rec = { t: new Date().toISOString(), method: req.method, path: req.url, hasBearer: !!m, bodyBytes: body.length };
  try { const j = JSON.parse(body); rec.source = j.source; rec.rows = Array.isArray(j.rows) ? j.rows.length : null; rec.imei = j.rows?.[0]?.imei ?? j.rows?.[0]?.IMEI ?? null; } catch { rec.json = false; }
  if (m && STATIC && m[1] === STATIC) {
    rec.static = true; // the token itself is never recorded
  } else if (m) {
    try {
      const unverified = jose.decodeJwt(m[1]);
      rec.claims = { iss: unverified.iss, aud: unverified.aud, azp: unverified.azp, client_id: unverified.client_id, sub: unverified.sub, typ: unverified.typ, preferred_username: unverified.preferred_username };
      jwks ??= jose.createRemoteJWKSet(new URL(`${ISSUER}/protocol/openid-connect/certs`));
      await jose.jwtVerify(m[1], jwks, { issuer: ISSUER, audience: "superiq-erp" });
      rec.verified = true;
    } catch (e) {
      rec.verified = false;
      rec.verifyError = String(e?.code || e?.message || e);
    }
  }
  records.push(rec);
  if (LOG) try { fs.appendFileSync(LOG, JSON.stringify(rec) + "\n"); } catch { /* ignore */ }
  // SuperIQ would refuse anything that is not a valid superiq-erp token.
  const ok = rec.static === true || (rec.verified === true && rec.claims?.azp === "gradeiq-svc");
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify(ok ? { ok: true, ingested: rec.rows ?? 0 } : { error: "unauthorized", why: rec.verifyError ?? "azp" }));
}).listen(PORT, "127.0.0.1", () => console.log(`receiver listening :${PORT} (issuer ${ISSUER})`));
