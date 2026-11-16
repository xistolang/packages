// Reading the generated tables (data/*.ts): numbers as base-90 printable ASCII digits, and ";key=value" lists.

/** The n-digit base-90 number at t[at] ('#' is 0; '\' is skipped, as tools/gen.mjs writes them). */
export function base90(t: string, at: int, n: int): int {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const c = t.charCodeAt(at + i);
    v = v * 90 + (c >= 93 ? c - 36 : c - 35);
  }
  return Math.trunc(v);
}

/** The value of key in ";key=value;key=value;", or null. */
export function lookup(table: string, key: string): string | null {
  const k = table.indexOf(";" + key + "=");
  if (k < 0) return null;
  const start = k + key.length + 2;
  return table.substring(start, table.indexOf(";", start));
}
