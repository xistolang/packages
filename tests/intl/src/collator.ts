// Intl.Collator and s.localeCompare(t, locale, options): accents and case ordered as on Node (ICU), pt-BR and en-US
const names = ["Álvaro", "ana", "Zé", "André", "andre", "Ana", "Éder", "eder", "item 10", "item 2", "São Paulo", "Sao Paulo", "sorocaba",
  "coração", "coracao", "Coração", "ação", "acao", "pêssego", "pessego", "Ç", "c", "C", "Ñandu", "nandu", "straße", "strasse", "Æsir", "aesir",
  "x-ray", "xray", "x ray", "file9.txt", "file10.txt", "", " ", "1", "10", "2", "$100", "€50", "Ελλάδα", "日本"];
for (const loc of ["pt-BR", "en-US"]) {
  console.log(loc, [...names].sort(new Intl.Collator(loc).compare).join(","));
  console.log(loc, [...names].sort((a, b) => a.localeCompare(b, loc)).join(","));
  console.log(loc, [...names].sort((a, b) => a.localeCompare(b, loc, { numeric: true })).join(","));
  console.log(loc, [...names].sort(new Intl.Collator(loc, { caseFirst: "upper" }).compare).join(","));
}
const base = new Intl.Collator("pt-BR", { sensitivity: "base" });
const accent = new Intl.Collator("pt-BR", { sensitivity: "accent" });
const kase = new Intl.Collator("pt-BR", { sensitivity: "case" });
for (const [a, b] of [["Ação", "acao"], ["ação", "acao"], ["Acao", "acao"], ["José", "jose"], ["a", "b"]]) {
  console.log(a, b, base.compare(a, b), accent.compare(a, b), kase.compare(a, b), new Intl.Collator("en-US").compare(a, b));
}
