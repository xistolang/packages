// Runs this package's TypeScript on Node (type stripping) against Node's own Intl, over many option combinations,
// and prints each difference. usage: node tools/verify.mjs [number|datetime|collator]...
// (xisto:tz, the one xisto module the package uses, is served by a stand-in built on Node's Intl.)
import { registerHooks } from "node:module";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "xisto:tz") return { url: "file://" + path.join(here, "tz-shim.mjs"), shortCircuit: true };
    if (spec.startsWith(".") && !spec.endsWith(".ts") && !spec.endsWith(".mjs")) spec += ".ts";
    return next(spec, ctx);
  },
});
globalThis.int = undefined;
const pkg = await import(path.join(here, "..", "index.ts"));
const which = process.argv.slice(2);
const want = (w) => which.length === 0 || which.includes(w);
let bad = 0, n = 0;
function check(what, got, exp) {
  n++;
  if (got !== exp) {
    bad++;
    if (bad <= +(process.env.MAXDIFF ?? 60)) console.log(`DIFF ${what}: xisto ${JSON.stringify(got)} node ${JSON.stringify(exp)}`);
  }
}
const run = (f) => { try { return f(); } catch (e) { return `throws ${e.constructor.name}: ${e.message}`; } }; // (the error's class and message too)

if (want("number")) {
  const values = [0, -0, 1, -1, 5, 0.5, 1.005, 2.5, -2.5, 0.07, 0.125, 1234, 12345, 123456.789, -1234.5678, 1e21, 1.5e-7, 9.995, 99.995,
    999999.9999, 0.0001, -0.0001, 123456789012345680000, NaN, Infinity, -Infinity, 1 / 3, 2 / 3, 0.1 + 0.2, 4.35, 1.45, 1e-10, 7e20];
  const opts = [{}, { style: "percent" }, { maximumFractionDigits: 0 }, { maximumFractionDigits: 2 }, { minimumFractionDigits: 2 },
    { minimumFractionDigits: 1, maximumFractionDigits: 4 }, { useGrouping: false }, { minimumIntegerDigits: 3 },
    { style: "percent", maximumFractionDigits: 2 }, { style: "percent", minimumFractionDigits: 1 }, { minimumFractionDigits: 5 },
    { maximumFractionDigits: 20 }, { minimumFractionDigits: 3, maximumFractionDigits: 1 }, { style: "currency" }, { style: "bogus" }];
  for (const c of Intl.supportedValuesOf("currency")) opts.push({ style: "currency", currency: c });
  for (const cd of ["code", "narrowSymbol"]) for (const c of ["BRL", "USD", "EUR", "JPY", "XYZ"]) opts.push({ style: "currency", currency: c, currencyDisplay: cd });
  opts.push({ style: "currency", currency: "BRL", maximumFractionDigits: 0 }, { style: "currency", currency: "USD", minimumFractionDigits: 0 },
    { style: "currency", currency: "brl" }, { style: "currency", currency: "JPY", minimumFractionDigits: 2 });
  for (const l of ["pt-BR", "en-US", "pt", "en", undefined]) for (const o of opts) for (const v of values)
    check(`${l} ${JSON.stringify(o)} ${v}`, run(() => new pkg.Intl_NumberFormat(l ?? null, o).format(v)), run(() => new Intl.NumberFormat(l ?? "en-US", o).format(v)));
}

if (want("datetime")) {
  const zones = [undefined, "UTC", "America/Sao_Paulo", "America/New_York", "Asia/Kolkata", "Europe/London", "Asia/Tokyo"];
  const dates = [Date.UTC(2026, 2, 5, 4, 7, 9), Date.UTC(2026, 10, 12, 23, 59, 59), Date.UTC(2025, 0, 1, 0, 0, 0), Date.UTC(2016, 0, 15, 12, 30, 0),
    Date.UTC(2026, 6, 4, 15, 0, 5), Date.UTC(1999, 11, 31, 11, 5, 0), Date.UTC(2026, 5, 21, 0, 30, 0)];
  const O = [];
  const Y = [undefined, "numeric", "2-digit"], M = [undefined, "numeric", "2-digit", "short", "long", "narrow"], D = [undefined, "numeric", "2-digit"];
  const W = [undefined, "short", "long", "narrow"], H = [undefined, "numeric", "2-digit"], N = [undefined, "numeric", "2-digit"];
  const H12 = [undefined, true, false, "h23", "h11", "h24", "h12"];
  for (const y of Y) for (const m of M) for (const d of D) for (const w of W) O.push({ year: y, month: m, day: d, weekday: w });
  const T = [];
  for (const h of H) for (const mi of N) for (const s of N) for (const c of H12) for (const z of [undefined, "short", "long", "shortOffset", "longOffset"]) {
    const o = { hour: h, minute: mi, second: s, timeZoneName: z };
    if (typeof c === "boolean") o.hour12 = c; else if (c) o.hourCycle = c;
    T.push(o);
  }
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const all = [{}];
  for (const o of O) all.push(clean(o));
  for (const t of T) all.push(clean(t));
  // dates with times: a sample (every date shape with a few time shapes, every time shape with a few date shapes)
  for (let i = 0; i < O.length; i++) for (let j = i % 7; j < T.length; j += 37) all.push(clean({ ...O[i], ...T[j] }));
  const ST = [undefined, "full", "long", "medium", "short"];
  for (const ds of ST) for (const ts of ST) for (const c of [undefined, true, false]) if (ds || ts) all.push(clean({ dateStyle: ds, timeStyle: ts, hour12: c }));
  const quick = process.env.QUICK ? 7 : 1; // QUICK=1: every 7th option set
  for (const l of ["pt-BR", "en-US"]) for (const z of zones) for (let oi = 0; oi < all.length; oi += quick) for (const t of dates) {
    const o = all[oi];
    const oo = z ? { ...o, timeZone: z } : o;
    check(`${l} ${JSON.stringify(oo)} ${new Date(t).toISOString()}`, run(() => new pkg.Intl_DateTimeFormat(l, oo).format(new Date(t))), run(() => new Intl.DateTimeFormat(l, oo).format(new Date(t))));
  }
  for (const l of ["pt-BR", "en-US"]) for (const t of dates) for (const z of zones) {
    const d = new Date(t);
    const o = z ? { timeZone: z } : {};
    check(`toLocaleString ${l} ${z}`, run(() => pkg.__intl_date_to_locale(d, "any", l, o)), d.toLocaleString(l, o));
    check(`toLocaleDateString ${l} ${z}`, run(() => pkg.__intl_date_to_locale(d, "date", l, o)), d.toLocaleDateString(l, o));
    check(`toLocaleTimeString ${l} ${z}`, run(() => pkg.__intl_date_to_locale(d, "time", l, o)), d.toLocaleTimeString(l, o));
    const p = { ...o, hour: "2-digit", minute: "2-digit", weekday: "long", month: "short", day: "numeric", timeZoneName: "short" };
    check(`formatToParts ${l} ${z}`, JSON.stringify(run(() => new pkg.Intl_DateTimeFormat(l, p).formatToParts(d))), JSON.stringify(new Intl.DateTimeFormat(l, p).formatToParts(d)));
  }
}

if (want("collator")) {
  const words = ["a", "A", "á", "Á", "à", "â", "ã", "ä", "b", "B", "c", "ç", "Ç", "e", "é", "ê", "E", "É", "i", "í", "o", "ó", "ô", "õ", "u", "ú", "ü",
    "n", "ñ", "Ana", "ana", "Ána", "André", "Andre", "andré", "Antônio", "Antonio", "António", "Álvaro", "Alvaro", "Zé", "ze", "José", "Jose", "joão",
    "João", "Joao", "Maria", "maria", "Mário", "Marcos", "São Paulo", "Sao Paulo", "são paulo", "Sorocaba", "coração", "coracao", "Coração", "cão",
    "cao", "ação", "acao", "Ação", "pêssego", "pessego", "peça", "peca", "item 2", "item 10", "item 1", "Item 1", "x-ray", "xray", "x ray", "x_ray",
    "x.ray", "co-op", "coop", "", " ", "1", "10", "2", "a1", "a10", "a2", "a01", "file9.txt", "file10.txt", "straße", "strasse", "Straße", "æsir",
    "aesir", "Æsir", "œuvre", "oeuvre", "Øre", "ore", "Ödön", "Odon", "résumé", "resume", "Resume", "naïve", "naive", "façade", "facade", "élan",
    "elan", "Ελλάδα", "日本", "😀", "$100", "€50", "#tag", "@user", "(x)", "[x]", "a b", "ab", "a-b", "a'b", "Ångström", "angstrom", "ı", "İ",
    "ß", "ss", "SS", "ﬁ", "fi", "ª", "º", "µ", "1/2", "½", "²", "2", "Ç", "ç", "Ñandu", "nandu", "ñandu", "ŀ", "l", "đ", "d", "ð", "þ", "th"];
  for (const l of ["pt-BR", "en-US"]) for (const o of [{}, { sensitivity: "base" }, { sensitivity: "accent" }, { sensitivity: "case" }, { sensitivity: "variant" }, { numeric: true }, { caseFirst: "upper" }]) {
    const mine = new pkg.Intl_Collator(l, o), theirs = new Intl.Collator(l, o);
    for (const a of words) for (const b of words) check(`${l} ${JSON.stringify(o)} ${JSON.stringify(a)} ${JSON.stringify(b)}`, Math.sign(mine.compare(a, b)), Math.sign(theirs.compare(a, b)));
  }
  check("localeCompare", pkg.__intl_locale_compare("a", "B", "pt-BR", null), "a".localeCompare("B", "pt-BR"));
}
console.log(`${n} checks, ${bad} differences`);
