// Intl.NumberFormat and n.toLocaleString(locale, options): decimal, percent and currency in pt-BR and en-US, as on Node
const values = [0, -0, 1, -1, 0.5, 1.005, 2.5, -2.5, 0.07, 1234, 12345.678, -1234.5678, 1234567.891, 9.995, 0.0001, 1e21, 1.5e-7, NaN, Infinity, -Infinity];
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
for (const v of values) console.log(brl.format(v), "|", usd.format(v));
const opts: Intl.NumberFormatOptions[] = [
  {},
  { style: "percent" },
  { style: "percent", maximumFractionDigits: 2 },
  { minimumFractionDigits: 2 },
  { maximumFractionDigits: 0 },
  { minimumFractionDigits: 1, maximumFractionDigits: 4 },
  { useGrouping: false },
  { minimumIntegerDigits: 3 },
  { style: "currency", currency: "EUR" },
  { style: "currency", currency: "JPY" },
  { style: "currency", currency: "BRL", maximumFractionDigits: 0 },
  { style: "currency", currency: "USD", currencyDisplay: "code" },
  { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" },
  { style: "currency", currency: "XYZ" },
];
for (const loc of ["pt-BR", "en-US"]) {
  for (const o of opts) {
    const f = new Intl.NumberFormat(loc, o);
    console.log(loc, JSON.stringify(o), f.format(1234.5), f.format(-0.125), f.format(0.07));
  }
}
const price = 1999.9;
console.log(price.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }), price.toLocaleString("en-US"), (0.256).toLocaleString("pt-BR", { style: "percent" }));
console.log((42).toLocaleString("pt-BR", { minimumFractionDigits: 2 }), (1234567).toLocaleString("en-US"));
const r = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).resolvedOptions();
console.log(r.locale, r.style, r.currency, r.minimumFractionDigits, r.maximumFractionDigits);
try {
  new Intl.NumberFormat("pt-BR", { style: "currency" });
} catch (e) {
  console.log("error:", (e as Error).message);
}
try {
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 1 });
} catch (e) {
  console.log("error:", (e as Error).message);
}
