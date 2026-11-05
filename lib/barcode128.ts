// Minimal, dependency-free Code 128-B encoder.
// Returns the alternating bar/space module widths so a label can render scannable
// <rect> stripes inline (no external image service / npm dep). Code set B covers
// all printable ASCII 32–126, which is everything our lot barcodes use
// (e.g. "AP-42-000007").

// Standard Code 128 symbol table — index = code value, each entry is the 6 (or 7
// for STOP) element widths, alternating bar/space starting with a bar.
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104;
const STOP = 106;

export interface Code128 {
  /** Alternating widths in modules: index 0 = bar, 1 = space, 2 = bar … */
  widths: number[];
  /** Total width in modules (sum of widths). */
  units: number;
}

/** Encode an ASCII string (32–126) as Code 128-B module widths. */
export function encodeCode128B(text: string): Code128 {
  const codes: number[] = [START_B];
  let sum = START_B;
  for (let i = 0; i < text.length; i++) {
    const v = text.charCodeAt(i) - 32; // Code B value
    const safe = v >= 0 && v <= 94 ? v : 0; // out-of-range → space
    codes.push(safe);
    sum += safe * (i + 1);
  }
  codes.push(sum % 103); // checksum
  codes.push(STOP);

  const widths: number[] = [];
  for (const c of codes) for (const ch of PATTERNS[c]) widths.push(Number(ch));
  return { widths, units: widths.reduce((a, b) => a + b, 0) };
}
