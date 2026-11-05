import { db, getSession } from "./db";
import { combineGrade } from "./grading";

// Recompute the overall grade from whatever parts exist and persist it.
export function recomputeOverall(id: string) {
  const s = getSession(id);
  if (!s) return;
  const overall = combineGrade(s.cosmetic_grade, s.functional_grade);
  const status =
    s.cosmetic_grade && s.functional_grade
      ? "graded"
      : s.functional_grade
        ? "functional_done"
        : "open";
  db.prepare(
    "UPDATE sessions SET overall_grade = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(overall, status, id);
}
