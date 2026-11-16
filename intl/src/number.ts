// Intl.NumberFormat: style decimal, percent and currency, as Node (ICU) prints them for the locales in data/number.ts.
import { NumLocale } from "./types";
import { localeIndex, localeTag } from "../data/locales";
import { numLocale, numSymbols, numNarrowSymbols, currencyDigitsTable, numLocale_pt_BR, numLocale_en_US, numSymbols_pt_BR, numSymbols_en_US } from "../data/number";
import { lookup } from "./table";

export interface Intl_NumberFormatOptions {
  style?: string; // "decimal" (the default), "percent", "currency"
  currency?: string; // ISO 4217 code, needed by style "currency"
  currencyDisplay?: string; // "symbol" (the default), "narrowSymbol" (as symbol), "code"
  minimumIntegerDigits?: number;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  useGrouping?: boolean;
}

export interface Intl_ResolvedNumberFormatOptions {
  locale: string;
  numberingSystem: string;
  style: string;
  currency?: string;
  minimumIntegerDigits: number;
  minimumFractionDigits: number;
  maximumFractionDigits: number;
}

function digitOption(name: string, v: number | undefined, min: int, max: int, fallback: int): int {
  if (v === undefined || v === null) return fallback;
  if (!(v >= min && v <= max)) throw new RangeError(name + " value is out of range.");
  return Math.floor(v);
}

// a character of Unicode's symbol categories, as currency symbols end ($, ¥, €, ₹...)
function isSymbolChar(c: number): boolean {
  return c === 36 || c === 43 || (c >= 60 && c <= 62) || c === 94 || c === 96 || c === 124 || c === 126 || (c >= 0xa2 && c <= 0xa9) || c === 0xac ||
    (c >= 0xae && c <= 0xb1) || c === 0xb4 || c === 0xb8 || c === 0xd7 || c === 0xf7 || (c >= 0x20a0 && c <= 0x20cf);
}

// the fraction digits of a currency: 2 unless the table lists it
function currencyDigits(code: string): int {
  const t = currencyDigitsTable();
  const k = t.indexOf(code);
  return k >= 0 && k % 4 === 0 ? Math.trunc(t.charCodeAt(k + 3)) - 48 : 2;
}

// the currency's code upper-cased, or the RangeError of a code that is not three ASCII letters
// (IsWellFormedCurrencyCode; a literal code is checked when the program is compiled: xisto folds the tests)
function currencyCode(code: string): string {
  const a = code.length === 3 ? code.charCodeAt(0) | 32 : 0;
  const b = code.length === 3 ? code.charCodeAt(1) | 32 : 0;
  const c = code.length === 3 ? code.charCodeAt(2) | 32 : 0;
  if (a < 97 || a > 122 || b < 97 || b > 122 || c < 97 || c > 122) throw new RangeError("Invalid currency code : " + code);
  return String.fromCharCode(a - 32, b - 32, c - 32);
}

// what goes before and after a currency's digits: the locale's pattern with the symbol in it, and the gap ICU sets
// between a symbol that does not end in a symbol character (XYZ, Cg.) and the digits; [prefix, suffix, gap]
function currencyAffixes(d: NumLocale, li: int, code: string, display: string): string[] {
  let sym = code;
  if (display === "symbol") sym = lookup(li === 1 ? numSymbols_pt_BR() : li === 0 ? numSymbols_en_US() : numSymbols(li), code) ?? code;
  else if (display === "narrowSymbol") sym = lookup(numNarrowSymbols(li), code) ?? lookup(numSymbols(li), code) ?? code;
  else if (display !== "code") throw new Error("xisto intl: currencyDisplay '" + display + "' is not supported (symbol, narrowSymbol and code are)");
  let pre = d.currencyPrefix;
  let gap = "";
  const at = pre.indexOf("¤");
  if (at >= 0) {
    if (at === pre.length - 1 && !isSymbolChar(sym.charCodeAt(sym.length - 1))) gap = d.alphaSpace;
    pre = pre.substring(0, at) + sym + pre.substring(at + 1);
  }
  return [pre, d.currencySuffix.replace("¤", sym), gap];
}

// 10^n (0 <= n <= 22: exact)
function pow10(n: int): number {
  let p = 1;
  for (let i = 0; i < n; i++) p *= 10;
  return p;
}

// the zeros that pad the integer v to width digits
function zeros(width: int, v: number): string {
  let z = "";
  let t = 1;
  for (let i = 1; i < width; i++) {
    t *= 10;
    if (v < t) z += "0";
  }
  return z;
}

/** new Intl.NumberFormat(locale, options).format(n) */
export class Intl_NumberFormat {
  data: NumLocale;
  locale: string;
  style: string;
  currency: string;
  prefix: string = ""; // what goes between the sign and the digits ("R$ ")
  suffix: string = ""; // after them ("%")
  digitsGap: string = ""; // between the prefix and digits (not NaN or ∞): "XYZ 5.00"
  shift: int = 0; // the decimal point moved right (percent: 2)
  minInt: int;
  minFrac: int;
  maxFrac: int;
  grouping: boolean;

  // (written so that literal arguments, new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }), are
  // decided when the program is compiled: xisto reads the options of a constructor called once as the literals they
  // are, and compiles only the branches they take; the tags and options compared with literals, data chosen by ?:)
  constructor(locales: string | null = null, options: Intl_NumberFormatOptions | null = null) {
    const li: int = locales === "pt-BR" ? 1 : locales === "en-US" ? 0 : localeIndex(locales);
    this.locale = li === 1 ? "pt-BR" : li === 0 ? "en-US" : localeTag(li);
    this.data = li === 1 ? numLocale_pt_BR() : li === 0 ? numLocale_en_US() : numLocale(li);
    const o: Intl_NumberFormatOptions = options ?? {};
    const style = o.style ?? "decimal";
    this.style = style;
    this.currency = "";
    let fracDefault = 0;
    let maxDefault = 3;
    if (style === "currency") {
      const given = o.currency ?? "";
      if (given === "") throw new TypeError("Currency code is required with currency style.");
      const code = currencyCode(given);
      this.currency = code;
      fracDefault = currencyDigits(code);
      maxDefault = fracDefault;
      const a = currencyAffixes(this.data, li, code, o.currencyDisplay ?? "symbol");
      this.prefix = a[0];
      this.suffix = a[1];
      this.digitsGap = a[2];
    } else if (style === "percent") {
      this.prefix = this.data.percentPrefix;
      this.suffix = this.data.percentSuffix;
      this.shift = 2;
      maxDefault = 0;
    } else if (style !== "decimal") {
      throw new RangeError("Value " + style + " out of range for Intl.NumberFormat options property style");
    }
    const mi = o.minimumIntegerDigits;
    this.minInt = mi === undefined || mi === null ? 1 : digitOption("minimumIntegerDigits", mi, 1, 21, 1);
    const mn = o.minimumFractionDigits;
    const mx = o.maximumFractionDigits;
    this.minFrac = fracDefault;
    this.maxFrac = maxDefault;
    if (!(mn === undefined || mn === null) || !(mx === undefined || mx === null)) {
      this.minFrac = digitOption("minimumFractionDigits", mn, 0, 100, -1);
      this.maxFrac = digitOption("maximumFractionDigits", mx, 0, 100, -1);
      if (this.minFrac < 0) this.minFrac = Math.min(fracDefault, this.maxFrac);
      else if (this.maxFrac < 0) this.maxFrac = Math.max(maxDefault, this.minFrac);
      else if (this.minFrac > this.maxFrac) throw new RangeError("maximumFractionDigits value is out of range.");
    }
    this.grouping = o.useGrouping ?? true;
  }

  format(value: number): string {
    const d = this.data;
    if (isNaN(value)) return this.prefix + d.nan + this.suffix;
    const sign = value < 0 || (value === 0 && 1 / value < 0) ? d.minus : "";
    if (!isFinite(value)) return sign + this.prefix + d.infinity + this.suffix;
    const a = Math.abs(value);
    const scale = pow10(this.maxFrac + this.shift);
    // a value whose rounded digits are exact in a double, with a place to spare: rounded and laid out with arithmetic.
    // ICU rounds the shortest decimal (half away from zero: 1.005 -> 1.01, not the double 1.00499...): the result is
    // n - 1, n or n + 1 for n = round(a * 10^k); a midpoint (n +- 0.5) / 10^k, one correctly rounded division,
    // compares with a as the shortest decimal compares with it, and is a only when that decimal is the midpoint
    // itself (decimals that fine are each their own double below 2^52 / 10)
    if (this.maxFrac + this.shift <= 15 && this.minInt === 1 && a * scale * 10 < 4503599627370496) {
      let n = Math.round(a * scale);
      if (a >= (n + 0.5) / scale) n += 1;
      else if (a < (n - 0.5) / scale) n -= 1;
      return sign + this.prefix + this.digitsGap + this.layout(n) + this.suffix;
    }
    // the shortest decimal that reads back as the value (as ICU starts from): its digits, and where the point goes
    const s = String(Math.abs(value));
    let digits = "";
    let point = 0;
    let e = s.indexOf("e");
    const mant = e >= 0 ? s.substring(0, e) : s;
    const dot = mant.indexOf(".");
    if (dot >= 0) {
      digits = mant.substring(0, dot) + mant.substring(dot + 1);
      point = dot;
    } else {
      digits = mant;
      point = mant.length;
    }
    if (e >= 0) point += parseInt(s.substring(e + 1), 10);
    point += this.shift;
    // the integer and fraction digits, the fraction cut at maxFrac digits, rounded half away from zero
    let int = "";
    let frac = "";
    if (point <= 0) {
      frac = "0".repeat(-point) + digits;
      int = "0";
    } else if (point >= digits.length) {
      int = digits + "0".repeat(point - digits.length);
    } else {
      int = digits.substring(0, point);
      frac = digits.substring(point);
    }
    if (frac.length > this.maxFrac) {
      const up = frac.charCodeAt(this.maxFrac) >= 53; // '5'
      frac = frac.substring(0, this.maxFrac);
      if (up) {
        // add one at the last kept digit: the trailing 9s become 0s
        const all = int + frac;
        let i = all.length - 1;
        while (i >= 0 && all.charCodeAt(i) === 57) i--;
        const bumped = (i < 0 ? "1" : all.substring(0, i) + String.fromCharCode(all.charCodeAt(i) + 1)) + "0".repeat(all.length - 1 - i);
        int = bumped.substring(0, bumped.length - frac.length);
        frac = bumped.substring(bumped.length - frac.length);
      }
    }
    let end = frac.length;
    while (end > this.minFrac && frac.charCodeAt(end - 1) === 48) end--;
    frac = frac.substring(0, end);
    if (frac.length < this.minFrac) frac = frac + "0".repeat(this.minFrac - frac.length);
    let lead = 0;
    while (lead < int.length - 1 && int.charCodeAt(lead) === 48) lead++;
    int = int.substring(lead);
    if (int === "0") int = "";
    if (int.length < this.minInt) int = "0".repeat(this.minInt - int.length) + int;
    if (this.grouping && int.length >= 3 + d.minGrouping) {
      let first = int.length % 3;
      if (first === 0) first = 3;
      let g = int.substring(0, first);
      for (let i = first; i < int.length; i += 3) g += d.group + int.substring(i, i + 3);
      int = g;
    }
    return sign + this.prefix + this.digitsGap + int + (frac.length > 0 ? d.decimal + frac : "") + this.suffix;
  }

  // n, the value times 10^(maxFrac + shift) rounded: its integer part grouped (minInt is 1 here), and its fraction
  // without the trailing zeros past minFrac
  layout(n: number): string {
    const d = this.data;
    const fp = pow10(this.maxFrac);
    let int = Math.floor(n / fp);
    let frac = n - int * fp;
    let places = this.maxFrac;
    while (places > this.minFrac && frac % 10 === 0) {
      frac = frac / 10;
      places--;
    }
    const fracText = places > 0 ? `${d.decimal}${zeros(places, frac)}${frac}` : "";
    let out = "";
    if (this.grouping && int >= pow10(2 + d.minGrouping)) {
      while (int >= 1000) {
        const g = int % 1000;
        out = `${d.group}${zeros(3, g)}${g}${out}`;
        int = Math.floor(int / 1000);
      }
    }
    return `${int}${out}${fracText}`;
  }

  resolvedOptions(): Intl_ResolvedNumberFormatOptions {
    const r: Intl_ResolvedNumberFormatOptions = {
      locale: this.locale,
      numberingSystem: "latn",
      style: this.style,
      minimumIntegerDigits: this.minInt,
      minimumFractionDigits: this.minFrac,
      maximumFractionDigits: this.maxFrac,
    };
    if (this.currency !== "") r.currency = this.currency;
    return r;
  }
}

/** n.toLocaleString(locales, options) with this package installed (the compiler routes the call here). */
export function __intl_number_to_locale(value: number, locales: string | null = null, options: Intl_NumberFormatOptions | null = null): string {
  return new Intl_NumberFormat(locales, options).format(value);
}
