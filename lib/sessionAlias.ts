// The canonical session id is a UUID — great for URLs, APIs and client interop,
// but a 36-char string on a badge is not something a human should read or repeat.
// `sessionAlias` is the SHORT, friendly code we SHOW on screen; the UUID stays the
// system id everywhere it matters. Deterministic (no storage, stable per session),
// and pure (no server deps) so both server and client components can import it.
//
// Legacy short-token ids (pre-UUID sessions) are already friendly, so they pass
// through unchanged — the report/passport of an old session still reads the same.
export function sessionAlias(id: string): string {
  if (!id) return "";
  const compact = id.replace(/-/g, "");
  const isUuid = /^[0-9a-f]{32}$/i.test(compact);
  // First 6 hex of a v4 UUID = 24 random bits ≈ 16.7M codes — plenty to tell one
  // session from another at a glance (the full UUID is the real, unique key).
  return (isUuid ? compact.slice(0, 6) : id).toUpperCase();
}
