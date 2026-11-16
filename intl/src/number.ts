// Intl.NumberFormat: style decimal, percent and currency, as Node (ICU) prints them for the locales in data/number.ts.
import { NumLocale } from "./types";
import { localeIndex, localeTag } from "../data/locales";
import { numLocale, numSymbols, numNarrowSymbols, currencyDigitsTable } from "../data/number";
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
  if (!(v >= min && v <= max)) throw new Error(name + " value is out of range.");
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

function isLetter(c: string): boolean {
  return c.toLowerCase() !== c.toUpperCase();
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
  minInt: int;
  minFrac: int;
  maxFrac: int;
  grouping: boolean;

  constructor(locales: string | null = null, options: Intl_NumberFormatOptions | null = null) {
    const li = localeIndex(locales);
    this.locale = localeTag(li);
    this.data = numLocale(li);
    const o: Intl_NumberFormatOptions = options ?? {};
    this.style = o.style ?? "decimal";
    this.currency = "";
    let fracDefault = 0;
    if (this.style === "currency") {
      const code = o.currency ?? "";
      if (code === "") throw new Error("Currency code is required with currency style.");
      if (code.length !== 3 || !isLetter(code.charAt(0)) || !isLetter(code.charAt(1)) || !isLetter(code.charAt(2))) throw new Error("Invalid currency code : " + code);
      this.currency = code.toUpperCase();
      fracDefault = currencyDigits(this.currency);
      const display = o.currencyDisplay ?? "symbol";
      let sym = "";
      if (display === "code") sym = this.currency;
      else if (display === "symbol") sym = lookup(numSymbols(li), this.currency) ?? this.currency;
      else if (display === "narrowSymbol") sym = lookup(numNarrowSymbols(li), this.currency) ?? lookup(numSymbols(li), this.currency) ?? this.currency;
      else throw new Error("xisto intl: currencyDisplay '" + display + "' is not supported (symbol, narrowSymbol and code are)");
      let pre = this.data.currencyPrefix;
      const at = pre.indexOf("¤");
      if (at >= 0) {
        // ICU's currency spacing: a symbol that does not end in a symbol character (XYZ, Cg.) is set apart from the digits
        if (at === pre.length - 1 && !isSymbolChar(sym.charCodeAt(sym.length - 1))) this.digitsGap = this.data.alphaSpace;
        pre = pre.substring(0, at) + sym + pre.substring(at + 1);
      }
      this.prefix = pre;
      this.suffix = this.data.currencySuffix.replace("¤", sym);
    } else if (this.style === "percent") {
      this.prefix = this.data.percentPrefix;
      this.suffix = this.data.percentSuffix;
    } else if (this.style === "decimal") {
      this.prefix = "";
      this.suffix = "";
    } else {
      throw new Error("Value " + this.style + " out of range for Intl.NumberFormat options property style");
    }
    this.minInt = digitOption("minimumIntegerDigits", o.minimumIntegerDigits, 1, 21, 1);
    const maxDefault = this.style === "currency" ? fracDefault : this.style === "percent" ? 0 : 3;
    const mn = o.minimumFractionDigits;
    const mx = o.maximumFractionDigits;
    if (mn === undefined && mx === undefined) {
      this.minFrac = fracDefault;
      this.maxFrac = maxDefault;
    } else if (mx === undefined) {
      this.minFrac = digitOption("minimumFractionDigits", mn, 0, 100, 0);
      this.maxFrac = Math.max(maxDefault, this.minFrac);
    } else if (mn === undefined) {
      this.maxFrac = digitOption("maximumFractionDigits", mx, 0, 100, 0);
      this.minFrac = Math.min(fracDefault, this.maxFrac);
    } else {
      this.minFrac = digitOption("minimumFractionDigits", mn, 0, 100, 0);
      this.maxFrac = digitOption("maximumFractionDigits", mx, 0, 100, 0);
      if (this.minFrac > this.maxFrac) throw new Error("maximumFractionDigits value is out of range.");
    }
    this.grouping = o.useGrouping ?? true;
  }

  format(value: number): string {
    const d = this.data;
    if (isNaN(value)) return this.prefix + d.nan + this.suffix;
    const neg = value < 0 || (value === 0 && 1 / value < 0);
    const sign = neg ? d.minus : "";
    if (!isFinite(value)) return sign + this.prefix + d.infinity + this.suffix;
    // the shortest decimal that reads back as the value (as ICU starts from), as all its digits and where the point goes
    const s = String(Math.abs(value));
    let digits = "";
    let point = 0;
    const e = s.indexOf("e");
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
    if (this.style === "percent") point += 2;
    if (point < 0) {
      digits = "0".repeat(-point) + digits;
      point = 0;
    }
    if (point > digits.length) digits = digits + "0".repeat(point - digits.length);
    // round half away from zero at maxFrac digits
    if (digits.length - point > this.maxFrac) {
      const cut = point + this.maxFrac;
      const up = digits.charCodeAt(cut) >= 53; // '5'
      digits = digits.substring(0, cut);
      if (up) {
        let i = digits.length - 1;
        let tail = "";
        while (i >= 0 && digits.charAt(i) === "9") {
          tail += "0";
          i--;
        }
        if (i < 0) {
          digits = "1" + tail;
          point++;
        } else {
          digits = digits.substring(0, i) + String.fromCharCode(digits.charCodeAt(i) + 1) + tail;
        }
      }
    }
    let int = digits.substring(0, point);
    let frac = digits.substring(point);
    let end = frac.length;
    while (end > this.minFrac && frac.charAt(end - 1) === "0") end--;
    frac = frac.substring(0, end);
    if (frac.length < this.minFrac) frac = frac + "0".repeat(this.minFrac - frac.length);
    let lead = 0;
    while (lead < int.length && int.charAt(lead) === "0") lead++;
    int = int.substring(lead);
    if (int.length < this.minInt) int = "0".repeat(this.minInt - int.length) + int;
    if (this.grouping && int.length >= 3 + d.minGrouping) {
      let g = "";
      let first = int.length % 3;
      if (first === 0) first = 3;
      g = int.substring(0, first);
      for (let i = first; i < int.length; i += 3) g += d.group + int.substring(i, i + 3);
      int = g;
    }
    return sign + this.prefix + this.digitsGap + int + (frac.length > 0 ? d.decimal + frac : "") + this.suffix;
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
    if (this.style === "currency") r.currency = this.currency;
    return r;
  }
}

/** n.toLocaleString(locales, options) with this package installed (the compiler routes the call here). */
export function __intl_number_to_locale(value: number, locales: string | null = null, options: Intl_NumberFormatOptions | null = null): string {
  return new Intl_NumberFormat(locales, options).format(value);
}
