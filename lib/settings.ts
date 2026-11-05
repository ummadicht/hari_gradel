import { db } from "./db";

// Server-side settings (API keys, pricing overrides) stored in the settings
// table so they can be set from /settings without redeploying. Falls back to
// environment variables.
export function getSetting(key: string, envVar?: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row?.value) return row.value;
  return (envVar && process.env[envVar]) || "";
}

export function setSetting(key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function hasSetting(key: string, envVar?: string): boolean {
  return getSetting(key, envVar).length > 0;
}
