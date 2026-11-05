// Colors the grade the SwapMore way: top grades green, then blue, gold, red.
function tierGradient(letter: string, faulty: boolean): string {
  if (faulty) return "linear-gradient(135deg, oklch(0.62 0.24 25), oklch(0.68 0.2 40))";
  switch (letter.toUpperCase()) {
    case "PREMIUM":
    case "A":
      return "var(--grad-green)";
    case "B":
      return "linear-gradient(135deg, oklch(0.65 0.2 240), oklch(0.6 0.19 255))";
    case "C":
      return "var(--grad-gold)";
    case "D":
      return "linear-gradient(135deg, oklch(0.62 0.24 25), oklch(0.66 0.21 35))";
    default:
      return "var(--card-2)";
  }
}

export default function GradeBadge({
  grade,
  small,
}: {
  grade: string;
  small?: boolean;
}) {
  const faulty = /FAULTY/i.test(grade);
  const letter = (grade || "—").split(" ")[0];
  const bg = grade ? tierGradient(letter, faulty) : "var(--card-2)";
  const light = /^(C)$/i.test(letter) && !faulty; // gold needs dark text
  return (
    <div
      className={`grid place-items-center rounded-2xl font-black ${
        small ? "h-11 min-w-11 px-2 text-sm" : "h-16 min-w-16 px-3 text-xl"
      }`}
      style={{
        background: bg,
        color: !grade
          ? "var(--muted)"
          : light
            ? "oklch(0.28 0.08 75)"
            : "#fff",
      }}
    >
      <span>{letter}</span>
      {faulty && !small && (
        <span className="text-[10px] font-bold tracking-wide">FAULTY</span>
      )}
    </div>
  );
}
