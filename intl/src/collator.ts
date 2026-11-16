// Intl.Collator and s.localeCompare(t, locale): ICU's root collation (pt and en order as root: no tailoring) for
// Latin text, from the weights in data/collation.ts. Characters outside U+0020..U+017F sort after those, by code point.
import { collationTable, collationTop } from "../data/collation";
import { localeIndex, localeTag } from "../data/locales";

export interface Intl_CollatorOptions {
  usage?: string; // "sort", "search"
  sensitivity?: string; // "base", "accent", "case", "variant" (the default)
  ignorePunctuation?: boolean;
  numeric?: boolean;
  caseFirst?: string; // "upper", "lower", "false"
  localeMatcher?: string;
}

export interface Intl_ResolvedCollatorOptions {
  locale: string;
  usage: string;
  sensitivity: string;
  ignorePunctuation: boolean;
  collation: string;
  numeric: boolean;
  caseFirst: string;
}

function weight(t: string, i: number): number {
  const c = t.charCodeAt(i);
  return c >= 93 ? c - 36 : c - 35;
}

// One string's collation elements, read one at a time at one level (primary, secondary, tertiary or case).
class Elements {
  s: string;
  i: int = 0;
  level: int;
  numeric: boolean;
  table: string;
  top: int;
  pending: number[] = []; // elements of an expansion or a number still to give
  constructor(s: string, level: int, numeric: boolean, table: string, top: int) {
    this.s = s;
    this.level = level;
    this.numeric = numeric;
    this.table = table;
    this.top = top;
  }

  // the weight at this level of the entry k of the table (a character of U+0020..U+017F): 0 when the character is
  // ignorable (no primary), -1 for an expansion; secondary, tertiary and case weights count from 1
  entry(k: number): number {
    const t = this.table;
    const o = k * 4;
    if (t.charCodeAt(o) === 126) return -1; // '~'
    const p = weight(t, o) * 90 + weight(t, o + 1);
    if (this.level === 1 || p === 0) return p;
    if (this.level === 2) return weight(t, o + 2) + 1;
    const ter = weight(t, o + 3);
    return this.level === 3 ? ter + 1 : (ter % 2) + 1;
  }

  // the next weight that is not ignorable at this level, or -1 at the end
  next(): number {
    while (true) {
      if (this.pending.length > 0) {
        const v = this.pending.shift()!;
        if (v !== 0) return v;
        continue;
      }
      if (this.i >= this.s.length) return -1;
      const c = this.s.charCodeAt(this.i);
      this.i++;
      if (this.numeric && c >= 48 && c <= 57) {
        // a run of digits compares as its number: its length (leading zeros aside), then its digits
        let start = this.i - 1;
        while (start < this.s.length && this.s.charCodeAt(start) === 48) start++;
        let end = this.i;
        while (end < this.s.length && this.s.charCodeAt(end) >= 48 && this.s.charCodeAt(end) <= 57) end++;
        if (start > end) start = end;
        this.i = end;
        if (this.level !== 1) {
          for (let k = start; k < end; k++) this.pending.push(1);
          continue;
        }
        const zero = this.entryOf(48);
        this.pending.push(zero + 0.5 + Math.min(end - start, 499) / 1000);
        for (let k = start; k < end; k++) this.pending.push(zero + (this.s.charCodeAt(k) - 48) / 10);
        continue;
      }
      const k = c >= 0x20 && c < 0x7f ? c - 0x20 : c >= 0xa0 && c < 0x180 ? c - 0xa0 + 95 : -1;
      if (k < 0) {
        if (c >= 0x300 && c < 0x370) { // a combining mark (text in NFD): an accent, no primary
          if (this.level === 2) return 100 + c - 0x300;
          continue;
        }
        if (this.level !== 1) return 1;
        // outside the table: punctuation, symbols and currency in their groups (before the digits), letters of other
        // scripts after the Latin ones, each group by code point
        if (c >= 0x2010 && c <= 0x205e) return this.entryOf(0x60) - 0.5 + c / 1e8;
        if (c >= 0x20a0 && c <= 0x20cf) return this.entryOf(0x30) - 0.5 + c / 1e8;
        if ((c >= 0x2100 && c <= 0x2bff) || (c >= 0xd800 && c <= 0xdfff) || (c >= 0x1f000 && c <= 0x1faff))
          return this.entryOf(0xa4) - 0.5 + c / 1e8;
        return this.top + c;
      }
      const v = this.entry(k);
      if (v > 0) return v;
      if (v === 0) continue;
      // an expansion (ß: s s): its two letters, with a secondary or tertiary mark after the first
      const o = k * 4;
      const a = weight(this.table, o + 1);
      const b = weight(this.table, o + 2);
      const flags = weight(this.table, o + 3);
      const first = this.entry(a);
      const second = this.entry(b);
      if (this.level === 2) {
        this.pending.push(first, flags === 1 ? 99 : 0, second);
      } else if (this.level === 3) {
        this.pending.push(first + (flags === 2 ? 100 : 0), second);
      } else {
        this.pending.push(first, second);
      }
    }
  }

  // the primary of a character of the table
  entryOf(c: number): number {
    return this.entry(c < 0x7f ? c - 0x20 : c - 0xa0 + 95);
  }
}

// a and b at one level: the first weight that differs
function compareLevel(a: string, b: string, level: int, numeric: boolean, upperFirst: boolean, table: string, top: int): int {
  const x = new Elements(a, level, numeric, table, top);
  const y = new Elements(b, level, numeric, table, top);
  const upper = upperFirst && level >= 3;
  while (true) {
    let p = x.next();
    let q = y.next();
    if (p < 0 || q < 0) return p < 0 && q < 0 ? 0 : p < 0 ? -1 : 1;
    if (upper) { // (tertiary and case weights: odd lower, even upper; upper first swaps them)
      p = p % 2 === 1 ? p + 1 : p - 1;
      q = q % 2 === 1 ? q + 1 : q - 1;
    }
    if (p !== q) return p < q ? -1 : 1;
  }
}

// sensitivity: 1 base, 2 accent, 3 variant, 4 case
function collate(a: string, b: string, sensitivity: int, numeric: boolean, upperFirst: boolean, table: string, top: int): number {
  if (a === b) return 0;
  const r = compareLevel(a, b, 1, numeric, upperFirst, table, top);
  if (r !== 0 || sensitivity === 1) return r;
  if (sensitivity === 4) return compareLevel(a, b, 4, numeric, upperFirst, table, top);
  const s = compareLevel(a, b, 2, numeric, upperFirst, table, top);
  if (s !== 0 || sensitivity === 2) return s;
  return compareLevel(a, b, 3, numeric, upperFirst, table, top);
}

/** new Intl.Collator(locale, options).compare(a, b); compare is a function value, as in JavaScript
    (xs.sort(collator.compare)) */
export class Intl_Collator {
  locale: string;
  sensitivity: string;
  numeric: boolean;
  caseFirst: string;
  ignorePunctuation: boolean;
  usage: string;
  compare: (a: string, b: string) => number;

  constructor(locales: string | null = null, options: Intl_CollatorOptions | null = null) {
    this.locale = localeTag(localeIndex(locales));
    const o: Intl_CollatorOptions = options ?? {};
    this.usage = o.usage ?? "sort";
    this.sensitivity = o.sensitivity ?? "variant";
    const sens = this.sensitivity === "base" ? 1 : this.sensitivity === "accent" ? 2 : this.sensitivity === "variant" ? 3 : this.sensitivity === "case" ? 4 : 0;
    if (sens === 0) throw new RangeError("Value " + this.sensitivity + " out of range for Intl.Collator options property sensitivity");
    this.numeric = o.numeric ?? false;
    this.caseFirst = o.caseFirst ?? "false";
    this.ignorePunctuation = o.ignorePunctuation ?? false;
    if (this.ignorePunctuation) throw new Error("xisto intl: Intl.Collator ignorePunctuation is not supported");
    // (the function holds the settings, not the collator: no cycle between the two)
    const numeric = this.numeric;
    const upper = this.caseFirst === "upper";
    const table = collationTable();
    const top = collationTop();
    this.compare = (a: string, b: string): number => collate(a, b, sens, numeric, upper, table, top);
  }

  resolvedOptions(): Intl_ResolvedCollatorOptions {
    return { locale: this.locale, usage: this.usage, sensitivity: this.sensitivity, ignorePunctuation: this.ignorePunctuation,
      collation: "default", numeric: this.numeric, caseFirst: this.caseFirst };
  }
}

/** s.localeCompare(t, locales, options) with this package installed (the compiler routes the call here). */
export function __intl_locale_compare(a: string, b: string, locales: string | null = null, options: Intl_CollatorOptions | null = null): number {
  const o: Intl_CollatorOptions = options ?? {};
  if (o.sensitivity === undefined && o.numeric === undefined && o.caseFirst === undefined && o.ignorePunctuation === undefined)
    return collate(a, b, 3, false, false, collationTable(), collationTop()); // (the usual call: no collator made)
  return new Intl_Collator(locales, options).compare(a, b);
}
