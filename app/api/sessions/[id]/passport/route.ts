import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/db";
import { buildPassport } from "@/lib/passport";

// GET /api/sessions/<id>/passport[?print=1]
// Unauthenticated, self-contained printable HTML Device Passport (same trust
// model as the Pandas passport link — the UUID is the capability).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return new NextResponse("Unknown session", { status: 404 });

  const p = buildPassport(s);
  const print = new URL(req.url).searchParams.get("print") === "1";

  const esc = (v: string) =>
    String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

  const idRows = p.identification
    .map(
      (f) =>
        `<div class="cell"><div class="k">${esc(f.label)}</div><div class="v${f.mono ? " mono" : ""}">${esc(f.value)}</div></div>`
    )
    .join("");

  const funcRows = p.functional.items
    .map(
      (it) =>
        `<div class="frow"><span>${esc(it.name)}</span><span class="${it.state}">${
          it.state === "pass" ? "✓" : it.state === "fail" ? "✕" : it.state === "skip" ? "–" : "○"
        }</span></div>`
    )
    .join("");

  const compRows = p.cosmetic.components
    .map(
      (c) =>
        `<div class="frow"><span>${esc(c.name)}</span><span class="grade g${esc(c.grade)}">${esc(c.grade)}</span></div>`
    )
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Device Passport · ${esc(p.identification[1]?.value || "Device")}</title>
<style>
  :root{--ink:#0b0f16;--muted:#6b7280;--line:#e5e7eb;--bg:#fff}
  *{box-sizing:border-box}
  body{margin:0;background:#f4f4f5;color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif}
  .sheet{max-width:820px;margin:32px auto;background:var(--bg);border-radius:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden}
  .hd{display:flex;justify-content:space-between;align-items:center;padding:28px 36px;border-bottom:1px solid var(--line)}
  .brand{font-weight:800;font-size:20px;letter-spacing:-.02em}
  .badge{font-size:12px;font-weight:700;padding:6px 12px;border-radius:999px;background:${p.verified ? "#dcfce7;color:#166534" : "#fef3c7;color:#92400e"}}
  .sec{padding:24px 36px;border-bottom:1px solid var(--line)}
  .lbl{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border-radius:12px;overflow:hidden;border:1px solid var(--line)}
  .cell{background:#fff;padding:12px 14px}
  .k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .v{font-weight:600;margin-top:2px}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:32px}
  .frow{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line);font-size:14px}
  .frow:last-child{border:0}
  .pass{color:#16a34a}.fail{color:#dc2626}.skip,.untested{color:#9ca3af}
  .grade{font-weight:800}.gD{color:#dc2626}.gC,.gB{color:#b45309}.gA,.gPremium{color:#16a34a}
  .final{display:flex;align-items:center;gap:20px;padding:24px 36px;background:#fafafa}
  .big{font-size:56px;font-weight:800;line-height:1}
  .sig{font-family:ui-monospace,monospace;font-size:10px;color:var(--muted);word-break:break-all;padding:16px 36px}
  @media print{body{background:#fff}.sheet{box-shadow:none;margin:0;max-width:none}}
</style></head>
<body>
  <div class="sheet">
    <div class="hd">
      <div><div class="brand">DeviceFax</div><div class="mono" style="font-size:12px;color:var(--muted)">${esc(p.id)} · issued ${esc(p.issuedAt)}</div></div>
      <span class="badge">${p.verified ? "✓ VERIFIED" : "● PENDING"}</span>
    </div>
    <div class="sec">
      <div class="lbl">Device identification</div>
      <div class="grid">${idRows}</div>
    </div>
    <div class="sec">
      <div class="cols">
        <div><div class="lbl">Cosmetic · ${p.cosmetic.findings} findings</div>${compRows || '<div style="color:var(--muted);font-size:14px">Not graded</div>'}</div>
        <div><div class="lbl">Functional · ${esc(p.functional.verdict)}</div>${funcRows}</div>
      </div>
    </div>
    <div class="final">
      <div class="big g${esc(p.finalGrade)}">${esc(p.finalGrade)}</div>
      <div>
        <div style="font-weight:700">Final grade${p.score != null ? ` · ${p.score}/100` : ""}</div>
        <div style="color:var(--muted);font-size:14px">${esc(p.narrative)}</div>
      </div>
    </div>
    <div class="sig"><b>Signature · SHA-256</b><br/>${esc(p.signature)}</div>
  </div>
  ${print ? "<script>window.addEventListener('load',()=>window.print())</script>" : ""}
</body></html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
