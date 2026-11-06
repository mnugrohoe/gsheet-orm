/** 1-based column number -> A, B, ..., Z, AA, ... */
export function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export const quoteSheet = (title: string): string =>
  `'${title.replace(/'/g, "''")}'`;
