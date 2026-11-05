import { jsPDF } from "jspdf";
import { STAGE_LABEL, type Stage } from "./sessionStage";
import { sessionAlias } from "./sessionAlias";
import type { SensorScanReport } from "./sensorScan";

export type DiagnosticSummaryData = {
  summary: {
    pass: number;
    fail: number;
    skip: number;
    total: number;
    sessionsTested: number;
  };
  byTest: Array<{
    id: string;
    name: string;
    pass: number;
    fail: number;
    skip: number;
    total: number;
  }>;
};

export type SummaryPdfInput = {
  clientId: string;
  inspectionsToday: number;
  totalSessions: number;
  gradesIssued: number;
  openExceptions: number;
  purchasesCount: number;
  funnel: Array<{ stage: Stage; count: number }>;
  diagnostics: DiagnosticSummaryData;
  latestSensorScan?: SensorScanReport | null;
  storeMeta?: {
    phone?: string;
    imei?: string;
    model?: string;
    storeId?: string;
    storeName?: string;
    storeBranch?: string;
    storePhone?: string;
    storeAddress?: string;
    timezone?: string;
    datetime?: string;
  };
  sessions: Array<{
    id: string;
    imei?: string;
    phone?: string;
    model: string;
    stage: Stage;
    cosmetic_grade: string;
    overall_grade: string;
    recorded_at?: string;
    timezone?: string;
    store_id?: string;
    store_name?: string;
    updated_at: string;
    functional_summary?: { pass: number; fail: number; skip: number };
  }>;
};

/**
 * Generates and downloads a multi-section Operations & Diagnostic Summary PDF
 * for the currently selected client on the Superadmin Overview page.
 */
export function generateSummaryPdf(input: SummaryPdfInput): void {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;
  let y = 40;

  const ensureSpace = (needed: number) => {
    if (y + needed > pageHeight - 45) {
      doc.addPage();
      y = 40;
    }
  };

  // Header Banner
  doc.setFillColor(29, 29, 31);
  doc.roundedRect(margin, y, contentWidth, 86, 8, 8, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("GradeIQ — Diagnostic & Operations Summary", margin + 18, y + 26);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(200, 205, 212);
  const clientLabel = input.clientId === "all" ? "All Clients (Cross-Tenant)" : `Client: ${input.clientId}`;
  const tz = input.storeMeta?.timezone || "UTC";
  const stamp = (input.storeMeta?.datetime || new Date().toISOString()).slice(0, 19).replace("T", " ");
  doc.text(`${clientLabel}   ·   Generated: ${stamp}   ·   Timezone: ${tz}`, margin + 18, y + 44);

  const storeLineParts = [
    input.storeMeta?.storeName ? `Store: ${input.storeMeta.storeName}` : "",
    input.storeMeta?.storeBranch ? `Branch: ${input.storeMeta.storeBranch}` : "",
    input.storeMeta?.phone ? `Phone: ${input.storeMeta.phone}` : "",
    input.storeMeta?.imei ? `IMEI: ${input.storeMeta.imei}` : "",
  ].filter(Boolean);
  if (storeLineParts.length > 0) {
    doc.text(storeLineParts.join("   ·   ").slice(0, 105), margin + 18, y + 58);
  }

  const diagTotal = input.diagnostics.summary.total;
  const passRate =
    diagTotal > 0 ? Math.round((input.diagnostics.summary.pass / diagTotal) * 100) : 0;
  doc.text(
    `Sessions Analyzed: ${input.totalSessions}   ·   Diagnostic Checks: ${diagTotal}   ·   Pass Rate: ${passRate}%`,
    margin + 18,
    y + 72,
  );

  y += 106;

  // Section 1: Key Operational KPIs
  doc.setTextColor(20, 20, 24);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("1. Operational Overview", margin, y);
  y += 12;

  const kpis = [
    ["Inspections Today", String(input.inspectionsToday)],
    ["Total Sessions", String(input.totalSessions)],
    ["Grades Issued", String(input.gradesIssued)],
    ["Open Exceptions", String(input.openExceptions)],
    ["Retail Purchases", String(input.purchasesCount)],
  ];
  const boxW = (contentWidth - 16) / 5;
  kpis.forEach(([label, val], idx) => {
    const bx = margin + idx * (boxW + 4);
    doc.setFillColor(246, 246, 244);
    doc.setDrawColor(224, 222, 216);
    doc.roundedRect(bx, y, boxW, 44, 5, 5, "FD");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(105, 105, 110);
    doc.text(label, bx + 8, y + 16);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(25, 25, 28);
    doc.text(val, bx + 8, y + 35);
  });

  y += 64;

  // Section 2: Diagnostic Outcomes Distribution (Pass / Fail / Skip)
  doc.setTextColor(20, 20, 24);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("2. Diagnostic Outcomes Distribution (Pass / Fail / Skip)", margin, y);
  y += 14;

  const { pass, fail, skip, total, sessionsTested } = input.diagnostics.summary;
  const passPct = total > 0 ? Math.round((pass / total) * 100) : 0;
  const failPct = total > 0 ? Math.round((fail / total) * 100) : 0;
  const skipPct = total > 0 ? Math.max(0, 100 - passPct - failPct) : 0;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(60, 60, 66);
  doc.text(
    `Sessions with functional diagnostics: ${sessionsTested}   |   Total checks recorded: ${total}`,
    margin,
    y,
  );
  y += 10;

  // Horizontal stacked distribution bar
  const barH = 14;
  doc.setFillColor(235, 235, 232);
  doc.roundedRect(margin, y, contentWidth, barH, 4, 4, "F");
  if (total > 0) {
    let curX = margin;
    const wPass = (pass / total) * contentWidth;
    const wFail = (fail / total) * contentWidth;
    const wSkip = Math.max(0, contentWidth - wPass - wFail);
    if (wPass > 0) {
      doc.setFillColor(22, 163, 74); // #16A34A
      doc.rect(curX, y, wPass, barH, "F");
      curX += wPass;
    }
    if (wFail > 0) {
      doc.setFillColor(220, 38, 38); // #DC2626
      doc.rect(curX, y, wFail, barH, "F");
      curX += wFail;
    }
    if (wSkip > 0) {
      doc.setFillColor(217, 119, 6); // #D97706
      doc.rect(curX, y, wSkip, barH, "F");
    }
  }
  y += barH + 14;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor(22, 163, 74);
  doc.text(`PASS: ${pass} (${passPct}%)`, margin, y);
  doc.setTextColor(220, 38, 38);
  doc.text(`FAIL: ${fail} (${failPct}%)`, margin + 150, y);
  doc.setTextColor(217, 119, 6);
  doc.text(`SKIP: ${skip} (${skipPct}%)`, margin + 300, y);
  y += 18;

  // Per-Test Breakdown Table
  if (input.diagnostics.byTest.length > 0) {
    ensureSpace(36);
    doc.setFillColor(240, 240, 236);
    doc.rect(margin, y, contentWidth, 18, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(60, 60, 66);
    doc.text("Diagnostic Check / Sensor", margin + 8, y + 12);
    doc.text("Pass", margin + 260, y + 12);
    doc.text("Fail", margin + 325, y + 12);
    doc.text("Skip", margin + 390, y + 12);
    doc.text("Pass Rate", margin + 450, y + 12);
    y += 18;

    doc.setFont("helvetica", "normal");
    for (const row of input.diagnostics.byTest) {
      ensureSpace(18);
      const rowTotal = row.pass + row.fail + row.skip;
      const rate = rowTotal > 0 ? `${Math.round((row.pass / rowTotal) * 100)}%` : "—";
      doc.setTextColor(30, 30, 34);
      doc.text(row.name.slice(0, 38), margin + 8, y + 12);
      doc.setTextColor(22, 163, 74);
      doc.text(String(row.pass), margin + 260, y + 12);
      doc.setTextColor(220, 38, 38);
      doc.text(String(row.fail), margin + 325, y + 12);
      doc.setTextColor(180, 100, 10);
      doc.text(String(row.skip), margin + 390, y + 12);
      doc.setTextColor(60, 60, 66);
      doc.text(rate, margin + 450, y + 12);
      doc.setDrawColor(235, 235, 232);
      doc.line(margin, y + 16, margin + contentWidth, y + 16);
      y += 16;
    }
    y += 14;
  }

  // Section 3: Qualification Funnel
  ensureSpace(90);
  doc.setTextColor(20, 20, 24);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("3. Qualification Funnel Conversion", margin, y);
  y += 12;

  doc.setFillColor(240, 240, 236);
  doc.rect(margin, y, contentWidth, 18, "F");
  doc.setFontSize(8.5);
  doc.setTextColor(60, 60, 66);
  doc.text("Stage", margin + 8, y + 12);
  doc.text("Sessions Reached", margin + 260, y + 12);
  doc.text("Conversion %", margin + 410, y + 12);
  y += 18;

  doc.setFont("helvetica", "normal");
  for (const f of input.funnel) {
    ensureSpace(16);
    const pct = input.totalSessions > 0 ? Math.round((f.count / input.totalSessions) * 100) : 0;
    doc.setTextColor(30, 30, 34);
    doc.text(STAGE_LABEL[f.stage] || f.stage, margin + 8, y + 12);
    doc.text(String(f.count), margin + 260, y + 12);
    doc.text(`${pct}%`, margin + 410, y + 12);
    doc.setDrawColor(235, 235, 232);
    doc.line(margin, y + 15, margin + contentWidth, y + 15);
    y += 15;
  }
  y += 16;

  // Section 4: Latest Live Hardware Sensor Scan (if present)
  if (input.latestSensorScan) {
    ensureSpace(90);
    doc.setTextColor(20, 20, 24);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("4. Live Hardware Sensor Scan Telemetry", margin, y);
    y += 12;

    doc.setFillColor(240, 240, 236);
    doc.rect(margin, y, contentWidth, 18, "F");
    doc.setFontSize(8.5);
    doc.setTextColor(60, 60, 66);
    doc.text("Sensor", margin + 8, y + 12);
    doc.text("Verdict", margin + 175, y + 12);
    doc.text("Live Reading", margin + 235, y + 12);
    y += 18;

    doc.setFont("helvetica", "normal");
    for (const item of input.latestSensorScan.items) {
      ensureSpace(16);
      doc.setTextColor(30, 30, 34);
      doc.text(item.name.slice(0, 28), margin + 8, y + 12);
      doc.setTextColor(
        item.status === "pass" ? 22 : item.status === "fail" ? 220 : 180,
        item.status === "pass" ? 163 : item.status === "fail" ? 38 : 100,
        item.status === "pass" ? 74 : item.status === "fail" ? 38 : 10,
      );
      doc.text(item.status.toUpperCase(), margin + 175, y + 12);
      doc.setTextColor(60, 60, 66);
      doc.text(item.reading.slice(0, 52), margin + 235, y + 12);
      doc.setDrawColor(235, 235, 232);
      doc.line(margin, y + 15, margin + contentWidth, y + 15);
      y += 15;
    }
    y += 16;
  }

  // Section 5: Recent Sessions Register
  if (input.sessions.length > 0) {
    ensureSpace(80);
    doc.setTextColor(20, 20, 24);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(
      `${input.latestSensorScan ? "5" : "4"}. Recent Sessions (${Math.min(20, input.sessions.length)} of ${input.sessions.length})`,
      margin,
      y,
    );
    y += 12;

    doc.setFillColor(240, 240, 236);
    doc.rect(margin, y, contentWidth, 18, "F");
    doc.setFontSize(8);
    doc.setTextColor(60, 60, 66);
    doc.text("Session", margin + 6, y + 12);
    doc.text("Phone / IMEI", margin + 62, y + 12);
    doc.text("Device Model", margin + 168, y + 12);
    doc.text("Store", margin + 268, y + 12);
    doc.text("P/F/S", margin + 355, y + 12);
    doc.text("Date/Time & TZ", margin + 402, y + 12);
    y += 18;

    doc.setFont("helvetica", "normal");
    for (const s of input.sessions.slice(0, 20)) {
      ensureSpace(16);
      const fs = s.functional_summary ?? { pass: 0, fail: 0, skip: 0 };
      const phoneImei = [s.phone, s.imei].filter(Boolean).join(" / ") || "—";
      const storeLabel = (s.store_name || s.store_id || "—").slice(0, 16);
      const dt = (s.recorded_at || s.updated_at || "").slice(0, 16).replace("T", " ");
      const tzShort = (s.timezone || "UTC").split(" ")[0].slice(0, 14);
      doc.setTextColor(30, 30, 34);
      doc.text(`#${sessionAlias(s.id)}`, margin + 6, y + 12);
      doc.text(phoneImei.slice(0, 20), margin + 62, y + 12);
      doc.text((s.model || "Unknown").slice(0, 18), margin + 168, y + 12);
      doc.text(storeLabel, margin + 268, y + 12);
      doc.text(`${fs.pass}/${fs.fail}/${fs.skip}`, margin + 355, y + 12);
      doc.text(`${dt} (${tzShort})`.slice(0, 24), margin + 402, y + 12);
      doc.setDrawColor(235, 235, 232);
      doc.line(margin, y + 15, margin + contentWidth, y + 15);
      y += 15;
    }
  }

  const safeClient = (input.clientId || "all").replace(/[^a-z0-9_-]/gi, "-");
  const datePart = new Date().toISOString().slice(0, 10);
  doc.save(`gradeiq-summary-${safeClient}-${datePart}.pdf`);
}
