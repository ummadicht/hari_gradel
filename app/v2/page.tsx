import V2Flow from "../components/V2Flow";

// GradeIQ v2 — the "90-second inspection". A NEW, standalone flow; the original
// click-based flow (/, /inspect, /staff …) is unchanged and still works.
export const dynamic = "force-dynamic";

export default function V2Page() {
  return <V2Flow />;
}
