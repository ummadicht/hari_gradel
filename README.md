# GradeIQ

**Browser-native, gamified phone grading.** No app install, no USB cable — the
device grades *itself* in its own browser, while AI grades its cosmetics from a
second device. A frictionless alternative to Phonecheck / Blancco / NSYS /
BlackBelt for wholesale and marketplace sellers.

## How it works

```
STAFF CONSOLE (/)                       DEVICE UNDER TEST (/s/<id>)
scan IMEI → create session ──QR──►      runs 9 gamified functional mini-games
      │                                 (touch, multi-touch, display, motion,
      │                                  mic, speaker, cameras, vibration, buttons)
      ▼                                        │ results ▼
COSMETIC CAPTURE (/staff/<id>)          one session, keyed by IMEI
photograph 4–6 angles → Gemini Vision ──────►  combined grade
      ▼
REPORT (/report/<id>)  →  cosmetic tier (Premium/A/B/C/D) · functional Working/Faulty
```

## Why it's different

- **Zero install / zero cable.** Everything runs through the phone's browser via
  Web APIs (Pointer, DeviceOrientation, getUserMedia, Web Audio, Vibration).
- **Gamified = full coverage.** Each test is a 5-second game (pop the bubbles,
  blow out the candles, roll the ball), so testers actually complete every check.
- **AI cosmetic grading.** Gemini Vision grades housing/glass from photos taken
  on any second phone or iPad.
- **Honest about limits.** Hardware buttons have no web API (manual confirm), and
  iOS Safari lacks Vibration/Bluetooth/NFC — those tests degrade gracefully.

## Run

```bash
npm install
npm run dev            # http://localhost:3700
```

Cosmetic grading runs on a deterministic **stub** until you add a key:

```bash
cp .env.local.example .env.local   # then set GEMINI_API_KEY
```

Get a key from Google AI Studio. Model: `gemini-2.5-flash`.

## Checks

```bash
npm test               # every lib/**/*.test.mjs and scripts/**/*.test.mjs
npm run check:authz    # every route handler's caller class (scripts/authz-map.json)
npx tsc --noEmit
npm run lint           # ESLint, eslint-config-next's flat configs (eslint.config.mjs)
```

**Lint baseline (SUP-57, 2026-10-22): 124 problems, 81 errors and 43 warnings**,
in 282 files. Lint had never run before (the old config crashed on load), so
these are old findings, not regressions, and `npm run lint` exits 1 until they
are fixed. The errors are almost all the React Compiler rules in
`react-hooks` 7: `set-state-in-effect` 33, `static-components` 25, `refs` 12,
`immutability` 5, `purity` 2; then `prefer-const` 2, `no-require-imports` 1,
`no-unescaped-entities` 1. Most warnings are unused variables (36). Fix them in
their own changes; a change should not raise these numbers.

## Notes for real-device testing

Camera / mic / motion sensors require **HTTPS or localhost**. To test on a real
phone over LAN, front it with an HTTPS tunnel (e.g. cloudflared) so the browser
grants sensor permissions.

## Stack

Next.js 16 · React 19 · Tailwind v4 · better-sqlite3 · Gemini 2.5 Flash Vision.

## Roadmap

- Barcode/IMEI auto-scan is wired (Android Chrome `BarcodeDetector`); add box-label OCR.
- Battery health, GPS, biometric (WebAuthn), flashlight games.
- SuperIQ integration: push grade + IMEI into the refurb ERP device record.
