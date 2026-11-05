import { db } from "./db";
import { resolveClient } from "./clients";
import { getProgramConfig } from "./programConfig";
import {
  defaultCatalog,
  normalizeCatalog,
  type PriceCatalog,
  type StoredCatalog,
  type Currency,
} from "./priceCatalogTypes";

/**
 * Per-client storage for the grade & fault pricing catalog (see
 * ./priceCatalogTypes.ts for the model and the two rules it enforces).
 *
 * One settings row per client — `price_catalog:swapmore-in` etc. The currency
 * comes from the CLIENT REGISTRY, not from the stored blob: a tenant's currency
 * is a property of the tenant, so a saved catalog can never drift into quoting
 * the wrong one.
 */

const key = (clientId: string) => `price_catalog:${clientId}`;

export function currencyFor(clientId: string): Currency {
  return resolveClient(clientId).currency;
}

/** The catalog in force for a client — saved if there is one, else the starter defaults. */
export function catalogFor(clientId: string): StoredCatalog {
  const currency = currencyFor(clientId);
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key(clientId)) as
    | { value: string }
    | undefined;
  if (!row) return { ...defaultCatalog(currency), source: "default" };
  try {
    const saved = JSON.parse(row.value) as { catalog?: unknown; updatedAt?: string; updatedBy?: string };
    return {
      ...normalizeCatalog(saved.catalog, currency),
      source: "catalog",
      updatedAt: saved.updatedAt,
      updatedBy: saved.updatedBy,
    };
  } catch {
    // A corrupt blob must not price a device. Fall back to the defaults and say so.
    return { ...defaultCatalog(currency), source: "default" };
  }
}

/**
 * The catalog the OFFER ENGINE should use.
 *
 * Back-compat: before this catalog existed, an operator could override grade
 * factors / repair costs / margin / promo through the chat Configurator
 * (settings → program_config, always USD). Those overrides are live prices, so
 * they still apply — but ONLY while this client is still on starter defaults
 * and only for a USD tenant. The moment someone saves a catalog here, the
 * catalog is the single source of truth and the legacy blob is ignored.
 */
export function effectiveCatalog(clientId: string): StoredCatalog {
  const cat = catalogFor(clientId);
  if (cat.source === "catalog" || cat.currency !== "USD") return cat;

  const legacy = getProgramConfig().pricing;
  const hasLegacy =
    Object.keys(legacy.gradeFactors ?? {}).length > 0 ||
    Object.keys(legacy.repairCosts ?? {}).length > 0 ||
    typeof legacy.marginRate === "number" ||
    typeof legacy.promoBonus === "number";
  if (!hasLegacy) return cat;

  const merged: PriceCatalog = {
    ...cat,
    gradeFactors: { ...cat.gradeFactors, ...(legacy.gradeFactors as PriceCatalog["gradeFactors"]) },
    faultCosts: { ...cat.faultCosts, ...(legacy.repairCosts ?? {}) },
    marginRate: typeof legacy.marginRate === "number" ? legacy.marginRate : cat.marginRate,
    promoBonus: typeof legacy.promoBonus === "number" ? legacy.promoBonus : cat.promoBonus,
  };
  return { ...normalizeCatalog(merged, cat.currency), source: "default" };
}

export function saveCatalog(clientId: string, input: unknown, updatedBy: string): StoredCatalog {
  const currency = currencyFor(clientId);
  const catalog = normalizeCatalog(input, currency);
  const updatedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key(clientId), JSON.stringify({ catalog, updatedAt, updatedBy }));
  return { ...catalog, source: "catalog", updatedAt, updatedBy };
}

/** Revert a client to the starter defaults for its currency. */
export function resetCatalog(clientId: string): StoredCatalog {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key(clientId));
  return { ...defaultCatalog(currencyFor(clientId)), source: "default" };
}

export type { PriceCatalog, StoredCatalog };
