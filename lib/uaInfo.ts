/**
 * Tiny user-agent reader for the portal's session detail — turns a raw UA string
 * into the "SMARTPHONE · Samsung SM-F956U1 · Chrome 150 · Android 10" style line
 * Pandas Hub shows. Heuristic by design: a UA is a claim, not an attestation, so
 * the portal shows BOTH the parsed summary and the raw string.
 */

export type UaInfo = {
  kind: "mobile" | "tablet" | "desktop" | "bot" | "unknown";
  os: string;
  browser: string;
  /** Device model token when the UA carries one (Android does, iOS/desktop don't). */
  model: string;
};

export function parseUa(ua: string): UaInfo {
  const s = ua || "";
  const kind: UaInfo["kind"] = !s
    ? "unknown"
    : /bot|crawler|spider|curl|wget/i.test(s)
      ? "bot"
      : /iPad|Tablet/i.test(s)
        ? "tablet"
        : /Mobi|iPhone|Android/i.test(s)
          ? "mobile"
          : "desktop";

  let os = "unknown";
  if (/Windows NT/i.test(s)) os = "Windows";
  else if (/iPhone|iPad|iPod/i.test(s)) os = "iOS" + (s.match(/OS (\d+)_/) ? ` ${s.match(/OS (\d+)_/)![1]}` : "");
  else if (/Mac OS X/i.test(s)) os = "macOS";
  else if (/Android ([\d.]+)/i.test(s)) os = `Android ${s.match(/Android ([\d.]+)/i)![1]}`;
  else if (/Android/i.test(s)) os = "Android";
  else if (/Linux/i.test(s)) os = "Linux";

  let browser = "unknown";
  const pick = (re: RegExp, name: string) => {
    const m = s.match(re);
    if (m) browser = `${name} ${m[1].split(".")[0]}`;
  };
  if (/Edg(iOS|A)?\//.test(s)) pick(/Edg(?:iOS|A)?\/([\d.]+)/, "Edge");
  else if (/CriOS\//.test(s)) pick(/CriOS\/([\d.]+)/, "Chrome");
  else if (/FxiOS\//.test(s)) pick(/FxiOS\/([\d.]+)/, "Firefox");
  else if (/Chrome\//.test(s)) pick(/Chrome\/([\d.]+)/, "Chrome");
  else if (/Firefox\//.test(s)) pick(/Firefox\/([\d.]+)/, "Firefox");
  else if (/Version\/[\d.]+.*Safari/.test(s)) pick(/Version\/([\d.]+)/, "Safari");

  // Android UAs carry the model between "; " and " Build/" or ")".
  let model = "";
  const am = s.match(/;\s*([A-Za-z0-9 _-]+?)\s*(?:Build\/|\))/);
  if (am && /Android/i.test(s)) {
    const cand = am[1].trim();
    if (!/^(Linux|U|K|wv|Android[\d .]*)$/i.test(cand)) model = cand;
  }

  return { kind, os, browser, model };
}

/** Best-effort client IP behind Caddy/proxies. */
export function clientIpFrom(headers: Headers): string {
  const xf = headers.get("x-forwarded-for") || "";
  if (xf) return xf.split(",")[0].trim();
  return headers.get("x-real-ip") || "";
}
