// When GradeIQ is served under a subpath (e.g. swapmore.com/apps/gradeiq),
// Next.js `basePath` auto-prefixes <Link>, assets and router nav — but NOT
// plain fetch() URLs, <a href>, window.location, QR strings, or <img src>.
// Prefix those with withBase(). Locally NEXT_PUBLIC_BASE_PATH is unset → "".
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
export const withBase = (p: string) => `${BASE_PATH}${p}`;
