import type { Metadata } from "next";
import ReadingPrep from "./ReadingPrep";
import styles from "./reading-prep.module.css";

export const metadata: Metadata = {
  title: "Northstar Reading Lab — Grade 4 MAP-Style Practice",
  description:
    "Original Grade 4 reading practice across literature, informational text, vocabulary, craft, and structure.",
};

export default function ReadingPrepPage() {
  return (
    <main className={styles.page}>
      <ReadingPrep />
    </main>
  );
}
