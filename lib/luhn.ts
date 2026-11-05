// Pure, dependency-free IMEI checksum — safe to import from client components
// (kept separate from lib/imei.ts, which pulls in server-only db/settings via
// its lookup path and can't be bundled for the browser).

// IMEI carries a Luhn checksum — free, offline validity check.
export function luhnValid(imei: string): boolean {
  if (!/^\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = imei.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
