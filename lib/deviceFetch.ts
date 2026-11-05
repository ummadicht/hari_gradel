// Best-effort device identification from the browser, WITH permission where a
// signal needs it. The web deliberately hides IMEI and (on iOS) the exact
// model, so this is an *approximation* used to auto-fill the session and skip
// manual typing — the IMEI still comes from the barcode scan.

export type DeviceInfo = {
  modelGuess: string;
  platform: string;
  browser: string;
  screen: string;
  pixelRatio: number;
  cores?: number;
  memoryGB?: number;
  storageGB?: number;
  battery?: { level: number; charging: boolean };
  ua: string;
  fetchedAt: string;
};

function guessBrowser(ua: string): string {
  if (/CriOS|Chrome/.test(ua)) return "Chrome";
  if (/FxiOS|Firefox/.test(ua)) return "Firefox";
  if (/EdgiOS|Edg/.test(ua)) return "Edge";
  if (/Safari/.test(ua)) return "Safari";
  return "Browser";
}

// Rough iOS model bucket from screen size (Apple hides the real model on web).
function iosScreenModel(w: number, h: number): string {
  const key = `${Math.min(w, h)}x${Math.max(w, h)}`;
  const map: Record<string, string> = {
    "375x667": "iPhone SE / 8",
    "390x844": "iPhone 12/13/14",
    "393x852": "iPhone 14 Pro / 15",
    "428x926": "iPhone 12–14 Pro Max",
    "430x932": "iPhone 15/16 Pro Max",
    "360x780": "iPhone 12 mini",
    "768x1024": 'iPad 9.7"',
    "834x1194": 'iPad Pro 11"',
    "1024x1366": 'iPad Pro 12.9"',
  };
  return map[key] ? `${map[key]} (est.)` : "iPhone/iPad (est.)";
}

export async function fetchDeviceInfo(): Promise<DeviceInfo> {
  const nav = navigator as any;
  const ua = nav.userAgent as string;
  const isApple = /iP(hone|ad|od)|Macintosh/.test(ua) && "ontouchend" in document;

  let modelGuess = "";
  let platform = "";

  // Android Chrome / Chromium exposes real high-entropy hints (with a prompt-
  // free client hint) — this gives the actual marketing model.
  if (nav.userAgentData?.getHighEntropyValues) {
    try {
      const hints = await nav.userAgentData.getHighEntropyValues([
        "model",
        "platform",
        "platformVersion",
      ]);
      modelGuess = hints.model || "";
      platform = `${hints.platform ?? ""} ${hints.platformVersion ?? ""}`.trim();
    } catch {
      /* ignore */
    }
  }

  const w = screen.width;
  const h = screen.height;
  if (!modelGuess) {
    modelGuess = isApple
      ? iosScreenModel(w, h)
      : /Android/.test(ua)
        ? "Android device"
        : "Unknown device";
  }
  if (!platform)
    platform = isApple ? "iOS/iPadOS" : /Android/.test(ua) ? "Android" : "Web";

  const info: DeviceInfo = {
    modelGuess,
    platform,
    browser: guessBrowser(ua),
    screen: `${w}×${h} @${window.devicePixelRatio}x`,
    pixelRatio: window.devicePixelRatio,
    cores: nav.hardwareConcurrency,
    memoryGB: nav.deviceMemory,
    ua,
    fetchedAt: new Date().toISOString(),
  };

  // Storage estimate (approximate capacity signal).
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) info.storageGB = Math.round(est.quota / 1e9);
  } catch {
    /* ignore */
  }

  // Battery (Android/Chrome only; iOS Safari dropped this API).
  try {
    const b = await nav.getBattery?.();
    if (b) info.battery = { level: Math.round(b.level * 100), charging: b.charging };
  } catch {
    /* ignore */
  }

  return info;
}
