// Where an ImeiInfo answer came from. Dependency-free (like lib/luhn.ts) so
// client components can read it without pulling lib/imei.ts's fs access into
// the browser bundle.
//
// Every value says what actually answered. "api" used to cover the v2 ESN
// check, a station record and the GSMA registry alike, so nobody could tell a
// lost/stolen verdict from the registry apart from a battery reading off a
// station. It survives only in rows stored before the split.
export type ImeiSource =
  | "esn" //      api.phonecheck.com v2 most-accurate (adds SIM lock + Find My)
  | "station" //  Phonecheck Cloud DB — a device a station physically tested
  | "gsma" //     the GSMA registry via Cloud DB CheckEsn (make, model, lost/stolen)
  | "provider" // the optional IMEI_API_URL provider
  | "tac" //      the free offline TAC database — model only, no status
  | "stub"; //    the seed map / nothing known

/**
 * Did a live lookup answer? Only then can blacklist / lock / Find My be read as
 * facts — a TAC or stub answer carries a model at most, and its "unknown" must
 * never be shown as clean.
 */
export function isLiveImeiSource(source: unknown): boolean {
  return (
    source === "esn" ||
    source === "station" ||
    source === "gsma" ||
    source === "provider" ||
    source === "api" // legacy rows written before the source split
  );
}
