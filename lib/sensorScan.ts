// Hardware & Browser Sensor Scan Engine.
// Probes physical device sensors and browser hardware APIs, returning structured
// Pass / Fail / Skip verdicts, live telemetry readings, and a functional map
// compatible with GradeIQ's session functional column.

export type SensorVerdict = "pass" | "fail" | "skip";

export type SensorScanItem = {
  id: string;
  /** Corresponding key in sessions.functional (plus extended sensor keys). */
  functionalKey: string;
  name: string;
  category: "Motion" | "Environmental" | "Power" | "Input" | "Media" | "System";
  api: string;
  status: SensorVerdict;
  reading: string;
  metrics: Record<string, string | number | boolean | null>;
  durationMs: number;
  scannedAt: string;
};

export type SensorScanReport = {
  scannedAt: string;
  totalDurationMs: number;
  summary: {
    pass: number;
    fail: number;
    skip: number;
    total: number;
  };
  items: SensorScanItem[];
  /** Map ready for POST /api/sessions/[id]/functional */
  functionalMap: Record<string, SensorVerdict>;
};

export const SENSOR_CATALOG: Array<{
  id: string;
  functionalKey: string;
  name: string;
  category: SensorScanItem["category"];
  api: string;
}> = [
  {
    id: "accelerometer",
    functionalKey: "motion",
    name: "Accelerometer (3-Axis)",
    category: "Motion",
    api: "DeviceMotionEvent",
  },
  {
    id: "gyroscope",
    functionalKey: "gyroscope",
    name: "Gyroscope & Orientation",
    category: "Motion",
    api: "DeviceOrientationEvent",
  },
  {
    id: "magnetometer",
    functionalKey: "magnetometer",
    name: "Magnetometer / Compass",
    category: "Motion",
    api: "Compass Heading / Absolute Orientation",
  },
  {
    id: "ambient_light",
    functionalKey: "display",
    name: "Ambient Light & Display Gamut",
    category: "Environmental",
    api: "AmbientLightSensor & Display Media",
  },
  {
    id: "battery_sensor",
    functionalKey: "battery_sensor",
    name: "Battery & Power Telemetry",
    category: "Power",
    api: "Navigator.getBattery()",
  },
  {
    id: "touch_haptics",
    functionalKey: "touch",
    name: "Touch Digitizer & Haptic Motor",
    category: "Input",
    api: "Pointer / MaxTouchPoints / Vibration API",
  },
  {
    id: "media_bus",
    functionalKey: "camera",
    name: "Camera & Audio Sensor Bus",
    category: "Media",
    api: "MediaDevices.enumerateDevices()",
  },
  {
    id: "system_telemetry",
    functionalKey: "system_telemetry",
    name: "CPU, Memory & Network Link",
    category: "System",
    api: "HardwareConcurrency / Storage / NetworkInformation",
  },
];

/** 1. Scan 3-Axis Accelerometer via DeviceMotionEvent */
export async function scanAccelerometer(timeoutMs = 750): Promise<SensorScanItem> {
  const t0 = performance.now();
  const scannedAt = new Date().toISOString();

  if (typeof window === "undefined" || !("DeviceMotionEvent" in window)) {
    return {
      id: "accelerometer",
      functionalKey: "motion",
      name: "Accelerometer (3-Axis)",
      category: "Motion",
      api: "DeviceMotionEvent",
      status: "skip",
      reading: "DeviceMotion API unsupported in this browser",
      metrics: { supported: false },
      durationMs: Math.round(performance.now() - t0),
      scannedAt,
    };
  }

  // Request iOS 13+ permission if required and triggered by user gesture
  try {
    const dm = DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    if (typeof dm.requestPermission === "function") {
      const perm = await dm.requestPermission();
      if (perm !== "granted") {
        return {
          id: "accelerometer",
          functionalKey: "motion",
          name: "Accelerometer (3-Axis)",
          category: "Motion",
          api: "DeviceMotionEvent",
          status: "fail",
          reading: "Motion permission denied by user",
          metrics: { permission: perm },
          durationMs: Math.round(performance.now() - t0),
          scannedAt,
        };
      }
    }
  } catch {
    /* non-gesture context on iOS or desktop browser */
  }

  return new Promise<SensorScanItem>((resolve) => {
    let settled = false;
    const handler = (ev: DeviceMotionEvent) => {
      const acc = ev.accelerationIncludingGravity || ev.acceleration;
      if (!acc || (acc.x === null && acc.y === null && acc.z === null)) return;
      settled = true;
      window.removeEventListener("devicemotion", handler);
      const x = Number((acc.x ?? 0).toFixed(2));
      const y = Number((acc.y ?? 0).toFixed(2));
      const z = Number((acc.z ?? 0).toFixed(2));
      const mag = Number(Math.sqrt(x * x + y * y + z * z).toFixed(2));
      resolve({
        id: "accelerometer",
        functionalKey: "motion",
        name: "Accelerometer (3-Axis)",
        category: "Motion",
        api: "DeviceMotionEvent",
        status: mag > 0 ? "pass" : "fail",
        reading: `x=${x}, y=${y}, z=${z} m/s² (|a|=${mag} m/s²)`,
        metrics: { x, y, z, magnitude: mag, intervalMs: ev.interval ?? null },
        durationMs: Math.round(performance.now() - t0),
        scannedAt,
      });
    };

    window.addEventListener("devicemotion", handler, { passive: true });
    window.setTimeout(() => {
      if (settled) return;
      window.removeEventListener("devicemotion", handler);
      const isDesktop =
        typeof navigator !== "undefined" && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      resolve({
        id: "accelerometer",
        functionalKey: "motion",
        name: "Accelerometer (3-Axis)",
        category: "Motion",
        api: "DeviceMotionEvent",
        status: isDesktop ? "skip" : "fail",
        reading: isDesktop
          ? "No IMU frames emitted (desktop host — skipped)"
          : "No accelerometer frames received within timeout",
        metrics: { desktopHost: isDesktop, timeoutMs },
        durationMs: Math.round(performance.now() - t0),
        scannedAt,
      });
    }, timeoutMs);
  });
}

/** 2. Scan Gyroscope & Euler Orientation via DeviceOrientationEvent */
export async function scanGyroscope(timeoutMs = 750): Promise<SensorScanItem> {
  const t0 = performance.now();
  const scannedAt = new Date().toISOString();

  if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) {
    return {
      id: "gyroscope",
      functionalKey: "gyroscope",
      name: "Gyroscope & Orientation",
      category: "Motion",
      api: "DeviceOrientationEvent",
      status: "skip",
      reading: "DeviceOrientation API unsupported",
      metrics: { supported: false },
      durationMs: Math.round(performance.now() - t0),
      scannedAt,
    };
  }

  return new Promise<SensorScanItem>((resolve) => {
    let settled = false;
    const handler = (ev: DeviceOrientationEvent) => {
      if (ev.alpha === null && ev.beta === null && ev.gamma === null) return;
      settled = true;
      window.removeEventListener("deviceorientation", handler);
      const alpha = Number((ev.alpha ?? 0).toFixed(1));
      const beta = Number((ev.beta ?? 0).toFixed(1));
      const gamma = Number((ev.gamma ?? 0).toFixed(1));
      resolve({
        id: "gyroscope",
        functionalKey: "gyroscope",
        name: "Gyroscope & Orientation",
        category: "Motion",
        api: "DeviceOrientationEvent",
        status: "pass",
        reading: `α=${alpha}° · β=${beta}° · γ=${gamma}°`,
        metrics: { alpha, beta, gamma, absolute: !!ev.absolute },
        durationMs: Math.round(performance.now() - t0),
        scannedAt,
      });
    };

    window.addEventListener("deviceorientation", handler, { passive: true });
    window.setTimeout(() => {
      if (settled) return;
      window.removeEventListener("deviceorientation", handler);
      const isDesktop =
        typeof navigator !== "undefined" && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      resolve({
        id: "gyroscope",
        functionalKey: "gyroscope",
        name: "Gyroscope & Orientation",
        category: "Motion",
        api: "DeviceOrientationEvent",
        status: isDesktop ? "skip" : "fail",
        reading: isDesktop
          ? "No gyroscope frames emitted (desktop host — skipped)"
          : "No orientation frames received within timeout",
        metrics: { desktopHost: isDesktop, timeoutMs },
        durationMs: Math.round(performance.now() - t0),
        scannedAt,
      });
    }, timeoutMs);
  });
}

/** 3. Scan Magnetometer / Compass Heading */
export async function scanMagnetometer(timeoutMs = 700): Promise<SensorScanItem> {
  const t0 = performance.now();
  const scannedAt = new Date().toISOString();

  if (typeof window === "undefined") {
    return {
      id: "magnetometer",
      functionalKey: "magnetometer",
      name: "Magnetometer / Compass",
      category: "Motion",
      api: "Compass Heading / Absolute Orientation",
      status: "skip",
      reading: "SSR environment",
      metrics: {},
      durationMs: 0,
      scannedAt,
    };
  }

  return new Promise<SensorScanItem>((resolve) => {
    let settled = false;
    const handler = (ev: DeviceOrientationEvent) => {
      const webkitHeading = (ev as DeviceOrientationEvent & { webkitCompassHeading?: number })
        .webkitCompassHeading;
      const heading =
        typeof webkitHeading === "number"
          ? webkitHeading
          : ev.absolute && typeof ev.alpha === "number"
            ? (360 - ev.alpha) % 360
            : null;
      if (heading === null) return;
      settled = true;
      window.removeEventListener("deviceorientationabsolute" as any, handler);
      window.removeEventListener("deviceorientation", handler);
      const deg = Number(heading.toFixed(1));
      resolve({
        id: "magnetometer",
        functionalKey: "magnetometer",
        name: "Magnetometer / Compass",
        category: "Motion",
        api: "Compass Heading / Absolute Orientation",
        status: "pass",
        reading: `Heading ${deg}° (${cardinalDirection(deg)})`,
        metrics: { headingDeg: deg, direction: cardinalDirection(deg) },
        durationMs: Math.round(performance.now() - t0),
        scannedAt,
      });
    };

    window.addEventListener("deviceorientationabsolute" as any, handler, { passive: true });
    window.addEventListener("deviceorientation", handler, { passive: true });
    window.setTimeout(() => {
      if (settled) return;
      window.removeEventListener("deviceorientationabsolute" as any, handler);
      window.removeEventListener("deviceorientation", handler);
      resolve({
        id: "magnetometer",
        functionalKey: "magnetometer",
        name: "Magnetometer / Compass",
        category: "Motion",
        api: "Compass Heading / Absolute Orientation",
        status: "skip",
        reading: "Compass sensor unavailable or uncalibrated on this device",
        metrics: { calibrated: false },
        durationMs: Math.round(performance.now() - t0),
        scannedAt,
      });
    }, timeoutMs);
  });
}

function cardinalDirection(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

/** 4. Scan Ambient Light Sensor & Display Color/HDR Capabilities */
export async function scanAmbientLight(timeoutMs = 450): Promise<SensorScanItem> {
  const t0 = performance.now();
  const scannedAt = new Date().toISOString();

  if (typeof window === "undefined") {
    return {
      id: "ambient_light",
      functionalKey: "display",
      name: "Ambient Light & Display Gamut",
      category: "Environmental",
      api: "AmbientLightSensor & Display Media",
      status: "skip",
      reading: "SSR environment",
      metrics: {},
      durationMs: 0,
      scannedAt,
    };
  }

  const w = window as unknown as { AmbientLightSensor?: new () => any };
  const p3 = window.matchMedia?.("(color-gamut: p3)")?.matches ?? false;
  const hdr = window.matchMedia?.("(dynamic-range: high)")?.matches ?? false;
  const colorDepth = window.screen?.colorDepth ?? 24;
  const dpr = window.devicePixelRatio ?? 1;
  const resolution = `${window.screen?.width ?? 0}×${window.screen?.height ?? 0} @${dpr}x`;

  if (typeof w.AmbientLightSensor === "function") {
    try {
      const lux = await new Promise<number | null>((resolve) => {
        let done = false;
        try {
          const sensor = new w.AmbientLightSensor!();
          sensor.onreading = () => {
            if (done) return;
            done = true;
            const val = typeof sensor.illuminance === "number" ? sensor.illuminance : null;
            try {
              sensor.stop();
            } catch {
              /* ignore */
            }
            resolve(val);
          };
          sensor.onerror = () => {
            if (done) return;
            done = true;
            resolve(null);
          };
          sensor.start();
          window.setTimeout(() => {
            if (done) return;
            done = true;
            try {
              sensor.stop();
            } catch {
              /* ignore */
            }
            resolve(null);
          }, timeoutMs);
        } catch {
          resolve(null);
        }
      });

      if (lux !== null) {
        return {
          id: "ambient_light",
          functionalKey: "display",
          name: "Ambient Light & Display Gamut",
          category: "Environmental",
          api: "AmbientLightSensor & Display Media",
          status: "pass",
          reading: `${Math.round(lux)} lux · ${resolution} · ${colorDepth}-bit${p3 ? " · P3" : ""}${hdr ? " · HDR" : ""}`,
          metrics: { illuminanceLux: Math.round(lux), resolution, colorDepth, p3Gamut: p3, hdr },
          durationMs: Math.round(performance.now() - t0),
          scannedAt,
        };
      }
    } catch {
      /* fall through to display telemetry */
    }
  }

  const validDisplay = (window.screen?.width ?? 0) > 0 && colorDepth >= 24;
  return {
    id: "ambient_light",
    functionalKey: "display",
    name: "Ambient Light & Display Gamut",
    category: "Environmental",
    api: "AmbientLightSensor & Display Media",
    status: validDisplay ? "pass" : "fail",
    reading: `${resolution} · ${colorDepth}-bit${p3 ? " · Wide P3" : " · sRGB"}${hdr ? " · HDR" : ""}`,
    metrics: { illuminanceLux: null, resolution, colorDepth, p3Gamut: p3, hdr },
    durationMs: Math.round(performance.now() - t0),
    scannedAt,
  };
}

/** 5. Scan Battery & Power Management Telemetry */
export async function scanBatteryTelemetry(): Promise<SensorScanItem> {
  const t0 = performance.now();
  const scannedAt = new Date().toISOString();

  if (typeof navigator === "undefined") {
    return {
      id: "battery_sensor",
      functionalKey: "battery_sensor",
      name: "Battery & Power Telemetry",
      category: "Power",
      api: "Navigator.getBattery()",
      status: "skip",
      reading: "Navigator unavailable",
      metrics: {},
      durationMs: 0,
      scannedAt,
    };
  }

  const nav = navigator as Navigator & {
    getBattery?: () => Promise<{
      level: number;
      charging: boolean;
      chargingTime: number;
      dischargingTime: number;
    }>;
  };

  if (typeof nav.getBattery !== "function") {
    return {
      id: "battery_sensor",
      functionalKey: "battery_sensor",
      name: "Battery & Power Telemetry",
      category: "Power",
      api: "Navigator.getBattery()",
      status: "skip",
      reading: "Battery Status API restricted by browser (Safari/Firefox)",
      metrics: { supported: false },
      durationMs: Math.round(performance.now() - t0),
      scannedAt,
    };
  }

  try {
    const bat = await nav.getBattery();
    const levelPct = Math.round((bat.level ?? 0) * 100);
    const healthy = levelPct > 5;
    return {
      id: "battery_sensor",
      functionalKey: "battery_sensor",
      name: "Battery & Power Telemetry",
      category: "Power",
      api: "Navigator.getBattery()",
      status: healthy ? "pass" : "fail",
      reading: `${levelPct}% · ${bat.charging ? "Charging (AC/USB)" : "On battery"}`,
      metrics: {
        levelPct,
        charging: bat.charging,
        chargingTimeSec: Number.isFinite(bat.chargingTime) ? bat.chargingTime : null,
        dischargingTimeSec: Number.isFinite(bat.dischargingTime) ? bat.dischargingTime : null,
      },
      durationMs: Math.round(performance.now() - t0),
      scannedAt,
    };
  } catch {
    return {
      id: "battery_sensor",
      functionalKey: "battery_sensor",
      name: "Battery & Power Telemetry",
      category: "Power",
      api: "Navigator.getBattery()",
      status: "skip",
      reading: "Battery sensor permission blocked",
      metrics: { supported: false },
      durationMs: Math.round(performance.now() - t0),
      scannedAt,
    };
  }
}

/** 6. Scan Touch Digitizer & Haptic Motor */
export async function scanTouchAndHaptics(): Promise<SensorScanItem> {
  const t0 = performance.now();
  const scannedAt = new Date().toISOString();

  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return {
      id: "touch_haptics",
      functionalKey: "touch",
      name: "Touch Digitizer & Haptic Motor",
      category: "Input",
      api: "Pointer / MaxTouchPoints / Vibration API",
      status: "skip",
      reading: "SSR environment",
      metrics: {},
      durationMs: 0,
      scannedAt,
    };
  }

  const maxTouchPoints = navigator.maxTouchPoints ?? 0;
  const coarse = window.matchMedia?.("(any-pointer: coarse)")?.matches ?? false;
  const fine = window.matchMedia?.("(any-pointer: fine)")?.matches ?? false;
  const hasVibrate = typeof navigator.vibrate === "function";

  let pulsed = false;
  if (hasVibrate) {
    try {
      pulsed = navigator.vibrate(35);
    } catch {
      pulsed = false;
    }
  }

  const pointerDesc = coarse ? "Capacitive touch" : fine ? "Precision pointer" : "Standard input";
  const status: SensorVerdict = maxTouchPoints > 0 || coarse || fine ? "pass" : "fail";

  return {
    id: "touch_haptics",
    functionalKey: "touch",
    name: "Touch Digitizer & Haptic Motor",
    category: "Input",
    api: "Pointer / MaxTouchPoints / Vibration API",
    status,
    reading: `${pointerDesc} (${maxTouchPoints} touch pts) · Haptics ${hasVibrate ? (pulsed ? "active" : "ready") : "unavailable"}`,
    metrics: {
      maxTouchPoints,
      coarsePointer: coarse,
      finePointer: fine,
      vibrationApi: hasVibrate,
    },
    durationMs: Math.round(performance.now() - t0),
    scannedAt,
  };
}

/** 7. Scan Camera & Audio Hardware Sensor Bus */
export async function scanMediaSensors(): Promise<SensorScanItem> {
  const t0 = performance.now();
  const scannedAt = new Date().toISOString();

  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.enumerateDevices !== "function"
  ) {
    return {
      id: "media_bus",
      functionalKey: "camera",
      name: "Camera & Audio Sensor Bus",
      category: "Media",
      api: "MediaDevices.enumerateDevices()",
      status: "skip",
      reading: "MediaDevices API unavailable (requires HTTPS or localhost)",
      metrics: { supported: false },
      durationMs: Math.round(performance.now() - t0),
      scannedAt,
    };
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((d) => d.kind === "videoinput").length;
    const mics = devices.filter((d) => d.kind === "audioinput").length;
    const speakers = devices.filter((d) => d.kind === "audiooutput").length;
    const total = cameras + mics + speakers;

    return {
      id: "media_bus",
      functionalKey: "camera",
      name: "Camera & Audio Sensor Bus",
      category: "Media",
      api: "MediaDevices.enumerateDevices()",
      status: total > 0 ? "pass" : "fail",
      reading: `${cameras} camera(s) · ${mics} mic(s) · ${speakers} audio out`,
      metrics: {
        videoInputs: cameras,
        audioInputs: mics,
        audioOutputs: speakers,
      },
      durationMs: Math.round(performance.now() - t0),
      scannedAt,
    };
  } catch {
    return {
      id: "media_bus",
      functionalKey: "camera",
      name: "Camera & Audio Sensor Bus",
      category: "Media",
      api: "MediaDevices.enumerateDevices()",
      status: "fail",
      reading: "Could not enumerate media hardware bus",
      metrics: {},
      durationMs: Math.round(performance.now() - t0),
      scannedAt,
    };
  }
}

/** 8. Scan CPU, RAM, Storage Quota & Network Telemetry */
export async function scanSystemAndNetworkSensors(): Promise<SensorScanItem> {
  const t0 = performance.now();
  const scannedAt = new Date().toISOString();

  if (typeof navigator === "undefined") {
    return {
      id: "system_telemetry",
      functionalKey: "system_telemetry",
      name: "CPU, Memory & Network Link",
      category: "System",
      api: "HardwareConcurrency / Storage / NetworkInformation",
      status: "skip",
      reading: "SSR environment",
      metrics: {},
      durationMs: 0,
      scannedAt,
    };
  }

  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { effectiveType?: string; downlink?: number; rtt?: number };
  };

  const cores = nav.hardwareConcurrency ?? null;
  const memoryGB = nav.deviceMemory ?? null;
  let storageGB: number | null = null;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) storageGB = Math.round(est.quota / 1e9);
  } catch {
    /* ignore */
  }

  const netType = nav.connection?.effectiveType ?? (navigator.onLine ? "online" : "offline");
  const downlink = nav.connection?.downlink ?? null;
  const rtt = nav.connection?.rtt ?? null;

  const parts: string[] = [];
  if (cores) parts.push(`${cores} cores`);
  if (memoryGB) parts.push(`${memoryGB}GB RAM`);
  if (storageGB) parts.push(`~${storageGB}GB quota`);
  parts.push(`Net: ${netType}${downlink ? ` (${downlink} Mbps)` : ""}`);

  return {
    id: "system_telemetry",
    functionalKey: "system_telemetry",
    name: "CPU, Memory & Network Link",
    category: "System",
    api: "HardwareConcurrency / Storage / NetworkInformation",
    status: navigator.onLine ? "pass" : "fail",
    reading: parts.join(" · "),
    metrics: {
      cores,
      memoryGB,
      storageGB,
      networkType: netType,
      downlinkMbps: downlink,
      rttMs: rtt,
    },
    durationMs: Math.round(performance.now() - t0),
    scannedAt,
  };
}

/** Run a single sensor scan by its catalog ID */
export async function runSingleSensorScan(sensorId: string): Promise<SensorScanItem> {
  switch (sensorId) {
    case "accelerometer":
      return scanAccelerometer();
    case "gyroscope":
      return scanGyroscope();
    case "magnetometer":
      return scanMagnetometer();
    case "ambient_light":
      return scanAmbientLight();
    case "battery_sensor":
      return scanBatteryTelemetry();
    case "touch_haptics":
      return scanTouchAndHaptics();
    case "media_bus":
      return scanMediaSensors();
    case "system_telemetry":
      return scanSystemAndNetworkSensors();
    default:
      throw new Error(`Unknown sensor ID: ${sensorId}`);
  }
}

/** Run the complete hardware & browser sensor scan suite */
export async function runFullSensorScan(
  onProgress?: (item: SensorScanItem, index: number, total: number) => void,
): Promise<SensorScanReport> {
  const t0 = performance.now();
  const items: SensorScanItem[] = [];
  const total = SENSOR_CATALOG.length;

  for (let i = 0; i < total; i++) {
    const entry = SENSOR_CATALOG[i];
    const item = await runSingleSensorScan(entry.id);
    items.push(item);
    onProgress?.(item, i + 1, total);
  }

  let pass = 0;
  let fail = 0;
  let skip = 0;
  const functionalMap: Record<string, SensorVerdict> = {};

  for (const item of items) {
    if (item.status === "pass") pass++;
    else if (item.status === "fail") fail++;
    else skip++;

    functionalMap[item.id] = item.status;
    functionalMap[item.functionalKey] = item.status;

    // Map multi-sensor buses to canonical functional test IDs so session grading
    // and diagnostic charts reflect the full scan immediately.
    if (item.id === "media_bus") {
      const mics = Number(item.metrics.audioInputs ?? 0);
      const speakers = Number(item.metrics.audioOutputs ?? 0);
      functionalMap.mic = mics > 0 ? "pass" : item.status;
      functionalMap.speaker = speakers > 0 ? "pass" : item.status;
    }
    if (item.id === "touch_haptics") {
      const pts = Number(item.metrics.maxTouchPoints ?? 0);
      functionalMap.multitouch = pts >= 2 ? "pass" : "skip";
      functionalMap.vibration = item.metrics.vibrationApi ? "pass" : "skip";
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    totalDurationMs: Math.round(performance.now() - t0),
    summary: {
      pass,
      fail,
      skip,
      total: items.length,
    },
    items,
    functionalMap,
  };
}
