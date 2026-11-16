// Intl.DateTimeFormat: dateStyle/timeStyle and the year, month, day, weekday, hour, minute, second and timeZoneName
// fields, as Node (ICU) prints them for the locales in data/datetime.ts; a timeZone of the system's TZ database.
import { DtLocale } from "./types";
import { localeIndex, localeTag } from "../data/locales";
import { dtLocale, dtPatterns, dtIndex, dtZoneNames, dtStyle, dtLocale_pt_BR, dtLocale_en_US, dtPatterns_pt_BR, dtPatterns_en_US, dtIndex_pt_BR, dtIndex_en_US, dtStyle_pt_BR, dtStyle_en_US } from "../data/datetime";
import { base90, lookup } from "./table";
import { __xs_tz_fields, __xs_tz_local } from "xisto:tz";

// (no module-level state: a top-level const would be compiled into every program, and runs after the program's own
// statements when the compiler loads this package for Intl)

export interface Intl_DateTimeFormatOptions {
  dateStyle?: string; // "full", "long", "medium", "short"
  timeStyle?: string;
  weekday?: string; // "long", "short", "narrow"
  era?: string;
  year?: string; // "numeric", "2-digit"
  month?: string; // "numeric", "2-digit", "long", "short", "narrow"
  day?: string;
  hour?: string;
  minute?: string;
  second?: string;
  fractionalSecondDigits?: number;
  dayPeriod?: string;
  timeZoneName?: string; // "short", "long", "shortOffset", "longOffset"
  timeZone?: string;
  hour12?: boolean;
  hourCycle?: string; // "h11", "h12", "h23", "h24"
  localeMatcher?: string;
  formatMatcher?: string;
}

export interface Intl_DateTimeFormatPart {
  type: string;
  value: string;
}

export interface Intl_ResolvedDateTimeFormatOptions {
  locale: string;
  calendar: string;
  numberingSystem: string;
  timeZone: string;
}

function dateTimeStyles(): string[] {
  return ["full", "long", "medium", "short"];
}

function styleIndex(name: string, v: string | undefined): int {
  if (v === undefined || v === null) return -1;
  const i = dateTimeStyles().indexOf(v);
  if (i < 0) throw new Error("Value " + v + " out of range for Intl.DateTimeFormat options property " + name);
  return i;
}

function fieldOption(name: string, v: string | undefined, allowed: string[]): string {
  if (v === undefined || v === null) return "";
  if (allowed.indexOf(v) < 0) throw new Error("Value " + v + " out of range for Intl.DateTimeFormat options property " + name);
  return v;
}

function numericWidths(): string[] {
  return ["numeric", "2-digit"];
}
function textWidths(): string[] {
  return ["narrow", "short", "long"];
}
function monthWidths(): string[] {
  return ["numeric", "2-digit", "narrow", "short", "long"];
}
function zoneNameStyles(): string[] {
  return ["short", "long", "shortOffset", "longOffset"];
}
function hourCycles(): string[] {
  return ["h11", "h12", "h23", "h24"];
}

function pad2(n: int): string {
  return n < 10 ? "0" + n : "" + n;
}

// the zone the program runs in (Node's default: $TZ), or "" when only its offsets are known
function localZone(): string {
  const tz = process.env.TZ ?? "";
  if (tz !== "") return tz.startsWith(":") ? tz.substring(1) : tz;
  const sys = __xs_tz_local(); // (/etc/localtime, as Node's ICU finds the zone)
  if (sys !== "") return sys;
  const y = new Date().getFullYear();
  if (new Date(y, 0, 1).getTimezoneOffset() === 0 && new Date(y, 6, 1).getTimezoneOffset() === 0) return "UTC";
  return "";
}

function canonicalZone(z: string): string {
  const u = z.toUpperCase();
  if (u === "UTC" || u === "ETC/UTC" || u === "GMT" || u === "ETC/GMT" || u === "UCT" || u === "ETC/UCT" || u === "ZULU" || u === "ETC/ZULU") return "UTC";
  return z;
}

// a pattern token's kind (see tools/gen.mjs: {y} {yy} {M1} {MMM}... in the patterns)
function tokenKind(f: string): int {
  switch (f) {
    case "y": return 1;
    case "yy": return 2;
    case "M": return 3;
    case "MMM": return 4;
    case "MMMM": return 5;
    case "MMMMM": return 6;
    case "LLL": return 7;
    case "LLLL": return 8;
    case "LLLLL": return 9;
    case "d": return 10;
    case "E": return 11;
    case "EEEE": return 12;
    case "EEEEE": return 13;
    case "c": return 14;
    case "cccc": return 15;
    case "ccccc": return 16;
    case "h":
    case "H":
      return 17;
    case "m": return 18;
    case "s": return 19;
    case "a": return 20;
    case "z": return 21;
    case "zl": return 22;
    default: return 0;
  }
}

/** new Intl.DateTimeFormat(locale, options).format(date) */
export class Intl_DateTimeFormat {
  li: int;
  data: DtLocale;
  locale: string;
  zone: string; // "" for the local time
  zoneName: string; // "", "short", "long", "shortOffset", "longOffset"
  cycle: string; // "h11", "h12", "h23", "h24"
  // the pattern, as tokens: kinds (0 literal text, else tokenKind), a literal's text, a numeric field's width
  kinds: int[] = [];
  texts: string[] = [];
  widths: int[] = [];

  /** kind: what the options must hold and what they default to: "any" (DateTimeFormat), "all" (toLocaleString),
      "date" (toLocaleDateString), "time" (toLocaleTimeString) */
  // (written so that literal arguments, new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }), are decided when the
  // program is compiled: xisto reads the options of a constructor called once as the literals they are and compiles
  // only the branches they take: each option compared with literals, the locale's data chosen by ?:)
  constructor(locales: string | null = null, options: Intl_DateTimeFormatOptions | null = null, kind: string = "any") {
    const li: int = locales === "pt-BR" ? 1 : locales === "en-US" ? 0 : localeIndex(locales);
    this.li = li;
    this.locale = li === 1 ? "pt-BR" : li === 0 ? "en-US" : localeTag(li);
    this.data = li === 1 ? dtLocale_pt_BR() : li === 0 ? dtLocale_en_US() : dtLocale(li);
    const o: Intl_DateTimeFormatOptions = options ?? {};
    if (o.era != null || o.fractionalSecondDigits != null || o.dayPeriod != null)
      throw new Error("xisto intl: Intl.DateTimeFormat supports dateStyle, timeStyle, weekday, year, month, day, hour, minute, second, timeZoneName, timeZone, hour12 and hourCycle");
    const z = o.timeZone ?? "";
    this.zone = z === "" ? "" : canonicalZone(z);
    if (this.zone !== "" && this.zone !== "UTC") __xs_tz_fields(0, this.zone); // (an unknown zone is a RangeError here, as in Node)
    const ow = o.weekday;
    const weekday = ow === undefined || ow === null ? "" : fieldOption("weekday", ow, textWidths());
    const oy = o.year;
    let year = oy === undefined || oy === null ? "" : fieldOption("year", oy, numericWidths());
    const om = o.month;
    let month = om === undefined || om === null ? "" : fieldOption("month", om, monthWidths());
    const od = o.day;
    let day = od === undefined || od === null ? "" : fieldOption("day", od, numericWidths());
    const oh = o.hour;
    let hour = oh === undefined || oh === null ? "" : oh === "2-digit" || oh === "numeric" ? oh : fieldOption("hour", oh, numericWidths());
    const omi = o.minute;
    let minute = omi === undefined || omi === null ? "" : omi === "2-digit" || omi === "numeric" ? omi : fieldOption("minute", omi, numericWidths());
    const os = o.second;
    let second = os === undefined || os === null ? "" : os === "2-digit" || os === "numeric" ? os : fieldOption("second", os, numericWidths());
    const ozn = o.timeZoneName;
    const zoneName = ozn === undefined || ozn === null ? "" : fieldOption("timeZoneName", ozn, zoneNameStyles());
    this.zoneName = zoneName;
    const ohc = o.hourCycle;
    const hc = ohc === undefined || ohc === null ? "" : fieldOption("hourCycle", ohc, hourCycles());
    const h12 = o.hour12;
    const localeH12 = li === 1 ? false : li === 0 ? true : this.data.hour12;
    const cycle = h12 !== undefined && h12 !== null ? (h12 ? "h12" : "h23") : hc !== "" ? hc : localeH12 ? "h12" : "h23";
    this.cycle = cycle;
    const mode: int = cycle === "h11" || cycle === "h12" ? 0 : 1; // (the styles: h12 or h23 patterns)
    const cyc: int = cycle === "h24" ? 2 : mode; // (the fields: h24 has patterns of its own)
    const ods = o.dateStyle;
    const ds: int = ods === undefined || ods === null ? -1 : ods === "full" ? 0 : ods === "long" ? 1 : ods === "medium" ? 2 : ods === "short" ? 3 : styleIndex("dateStyle", ods);
    const ots = o.timeStyle;
    const ts: int = ots === undefined || ots === null ? -1 : ots === "full" ? 0 : ots === "long" ? 1 : ots === "medium" ? 2 : ots === "short" ? 3 : styleIndex("timeStyle", ots);
    const hasDate = weekday !== "" || year !== "" || month !== "" || day !== "";
    const hasTime = hour !== "" || minute !== "" || second !== "";
    let pattern = "";
    if (ds >= 0 || ts >= 0) {
      if (hasDate || hasTime || zoneName !== "") throw new Error("Can't set option " + (hasDate ? "date fields" : hasTime ? "time fields" : "timeZoneName") + " when " + (ds >= 0 ? "dateStyle" : "timeStyle") + " is used");
      if (kind === "date" && ds < 0) throw new Error("Invalid option : timeStyle");
      if (kind === "time" && ts < 0) throw new Error("Invalid option : dateStyle");
      // the style patterns (data/datetime.ts, dtStyle): 0-3 dateStyle, 4-7 timeStyle h12, 8-11 h23, 12-15 their glue
      const dslot: int = ds >= 0 ? ds : -1;
      const tslot: int = ts >= 0 ? 4 + mode * 4 + ts : -1;
      const gslot: int = ds >= 0 && ts >= 0 ? 12 + ds : -1;
      const dp = li === 1 ? dtStyle_pt_BR(dslot) : li === 0 ? dtStyle_en_US(dslot) : dtStyle(li, dslot);
      const tp = li === 1 ? dtStyle_pt_BR(tslot) : li === 0 ? dtStyle_en_US(tslot) : dtStyle(li, tslot);
      const gp = li === 1 ? dtStyle_pt_BR(gslot) : li === 0 ? dtStyle_en_US(gslot) : dtStyle(li, gslot);
      pattern = dp + gp + tp;
    } else {
      // the locale's patterns (data/datetime.ts): one string, and an index of where each shape's pattern is
      const pats = li === 1 ? dtPatterns_pt_BR() : li === 0 ? dtPatterns_en_US() : dtPatterns(li);
      const index = li === 1 ? dtIndex_pt_BR() : li === 0 ? dtIndex_en_US() : dtIndex(li);
      const shapes = index.indexOf("!") + 1;
      const pat = (slot: int): string => {
        const id = base90(index, shapes + slot * 2, 2);
        return pats.substring(base90(index, id * 3, 3), base90(index, id * 3 + 3, 3));
      };
      let needDate = kind === "date" || kind === "all" || kind === "any";
      let needTime = kind === "time" || kind === "all";
      if (kind === "date") needDate = !hasDate;
      else if (kind === "time") needTime = !hasTime;
      else if (hasDate || hasTime) {
        needDate = false;
        needTime = false;
      }
      if (needDate) {
        year = "numeric";
        month = "numeric";
        day = "numeric";
      }
      if (needTime) {
        hour = "numeric";
        minute = "numeric";
        second = "numeric";
      }
      // the shape keys of tools/gen.mjs: ((y * 6 + M) * 3 + d) * 4 + w and (((h * 3 + m) * 3 + s) * 2 + h23) * 5 + z
      const yi = numericWidths().indexOf(year) + 1;
      const mi = month === "" ? 0 : month === "numeric" ? 1 : month === "2-digit" ? 2 : month === "short" ? 3 : month === "long" ? 4 : 5;
      const di = numericWidths().indexOf(day) + 1;
      const wi = weekday === "" ? 0 : weekday === "short" ? 1 : weekday === "long" ? 2 : 3;
      const dk = ((yi * 6 + mi) * 3 + di) * 4 + wi;
      const hi = numericWidths().indexOf(hour) + 1;
      const ni = numericWidths().indexOf(minute) + 1;
      const si = numericWidths().indexOf(second) + 1;
      const zi = zoneNameStyles().indexOf(this.zoneName) + 1;
      const tk = hi + ni + si === 0 ? 0 : (((hi * 3 + ni) * 3 + si) * 3 + cyc) * 5 + zi;
      const dp = dk > 0 ? pat(dk) : "";
      if (dk > 0 && tk > 0) {
        // the glue of the date shape, unless the pair is listed with another one
        let g = pat(216 + 405 + dk);
        const key = dk * 405 + tk;
        for (let p = index.indexOf("!", shapes) + 1; p + 5 <= index.length; p += 5) {
          if (base90(index, p, 3) === key) {
            const id = base90(index, p + 3, 2);
            g = pats.substring(base90(index, id * 3, 3), base90(index, id * 3 + 3, 3));
            break;
          }
        }
        if (g.startsWith("=")) pattern = g.substring(1); // (a pattern that is not date + glue + time)
        else pattern = dp + g + pat(216 + tk);
      } else if (tk > 0) pattern = pat(216 + tk);
      else pattern = zi > 0 ? dp + pat(216 + 405 + 216 + dk * 5 + zi) + "{z}" : dp;
    }
    this.compile(pattern);
  }

  // the pattern's tokens: {field} (a digit after a numeric field: its width) or literal text
  compile(p: string): void {
    let i = 0;
    while (i < p.length) {
      const open = p.indexOf("{", i);
      const lit = open < 0 ? p.substring(i) : p.substring(i, open);
      if (lit.length > 0) {
        this.kinds.push(0);
        this.texts.push(lit);
        this.widths.push(0);
      }
      if (open < 0) break;
      const close = p.indexOf("}", open);
      let f = p.substring(open + 1, close);
      let w: int = 0;
      const last = f.charAt(f.length - 1);
      if (last === "1" || last === "2") {
        w = last === "2" ? 2 : 1;
        f = f.substring(0, f.length - 1);
      }
      this.kinds.push(tokenKind(f));
      this.texts.push("");
      this.widths.push(w);
      i = close + 1;
    }
  }

  formatToParts(date: Date): Intl_DateTimeFormatPart[] {
    const ms = date.getTime();
    if (isNaN(ms)) throw new Error("Invalid time value");
    let yy: int = 0;
    let mo: int = 0;
    let dd: int = 0;
    let hh: int = 0;
    let mi: int = 0;
    let ss: int = 0;
    let wd: int = 0;
    if (this.zone === "UTC") {
      yy = date.getUTCFullYear();
      mo = date.getUTCMonth() + 1;
      dd = date.getUTCDate();
      hh = date.getUTCHours();
      mi = date.getUTCMinutes();
      ss = date.getUTCSeconds();
      wd = date.getUTCDay();
    } else if (this.zone !== "") {
      const f = __xs_tz_fields(ms, this.zone);
      yy = f[0];
      mo = f[1];
      dd = f[2];
      hh = f[3];
      mi = f[4];
      ss = f[5];
      wd = f[6];
    } else {
      yy = date.getFullYear();
      mo = date.getMonth() + 1;
      dd = date.getDate();
      hh = date.getHours();
      mi = date.getMinutes();
      ss = date.getSeconds();
      wd = date.getDay();
    }
    const out: Intl_DateTimeFormatPart[] = [];
    const L = this.data;
    for (let i = 0; i < this.kinds.length; i++) {
      const k = this.kinds[i];
      const two = this.widths[i] === 2;
      let type = "";
      let v = "";
      switch (k) {
        case 0:
          if (out.length > 0 && out[out.length - 1].type === "literal") {
            out[out.length - 1].value += this.texts[i];
            continue;
          }
          type = "literal";
          v = this.texts[i];
          break;
        case 1:
        case 2:
          type = "year";
          v = k === 2 ? pad2(yy % 100) : "" + yy;
          break;
        case 3:
          type = "month";
          v = two ? pad2(mo) : "" + mo;
          break;
        case 4:
        case 5:
        case 6:
          type = "month";
          v = (k === 4 ? L.monthsShort : k === 5 ? L.monthsLong : L.monthsNarrow)[mo - 1];
          break;
        case 7:
        case 8:
        case 9:
          type = "month";
          v = L.standaloneMonths[k === 8 ? 0 : k === 7 ? 1 : 2][mo - 1];
          break;
        case 10:
          type = "day";
          v = two ? pad2(dd) : "" + dd;
          break;
        case 11:
        case 12:
        case 13:
          type = "weekday";
          v = (k === 11 ? L.weekdaysShort : k === 12 ? L.weekdaysLong : L.weekdaysNarrow)[wd];
          break;
        case 14:
        case 15:
        case 16:
          type = "weekday";
          v = L.standaloneWeekdays[k === 15 ? 0 : k === 14 ? 1 : 2][wd];
          break;
        case 17: {
          type = "hour";
          let h = hh;
          if (this.cycle === "h12") h = hh % 12 === 0 ? 12 : hh % 12;
          else if (this.cycle === "h11") h = hh % 12;
          else if (this.cycle === "h24") h = hh === 0 ? 24 : hh;
          v = two ? pad2(h) : "" + h;
          break;
        }
        case 18:
          type = "minute";
          v = two ? pad2(mi) : "" + mi;
          break;
        case 19:
          type = "second";
          v = two ? pad2(ss) : "" + ss;
          break;
        case 20:
          type = "dayPeriod";
          v = hh < 12 ? L.am : L.pm;
          break;
        default:
          type = "timeZoneName";
          v = this.zoneText(ms, yy, mo, dd, hh, mi, ss, k === 22 ? "long" : this.zoneName === "" ? "short" : this.zoneName);
      }
      out.push({ type: type, value: v });
    }
    return out;
  }

  // the zone's name at that instant (its wall clock given), or its offset from GMT as ICU prints it
  zoneText(ms: number, yy: int, mo: int, dd: int, hh: int, mi: int, ss: int, style: string): string {
    const off = Math.round((Date.UTC(yy, mo - 1, dd, hh, mi, ss) - Math.floor(ms / 1000) * 1000) / 60000);
    const zone = this.zone !== "" ? this.zone : canonicalZone(localZone());
    if (zone !== "" && (style === "short" || style === "long")) {
      const std = Math.min(this.offsetAt(Date.UTC(yy, 0, 1)), this.offsetAt(Date.UTC(yy, 6, 1)));
      const names = lookup(dtZoneNames(this.li), zone);
      if (names !== null) {
        const n = names.split(",")[(off > std ? 2 : 0) + (style === "long" ? 1 : 0)];
        if (n !== "") return n;
      }
    }
    const a = Math.abs(off);
    const h = Math.floor(a / 60);
    const m = a % 60;
    const sign = off < 0 ? "-" : "+";
    if (style === "long" || style === "longOffset") return "GMT" + sign + pad2(h) + ":" + pad2(m);
    return "GMT" + sign + h + (m !== 0 ? ":" + pad2(m) : "");
  }

  offsetAt(ms: number): number {
    if (this.zone === "UTC") return 0;
    if (this.zone === "") return -new Date(ms).getTimezoneOffset();
    const f = __xs_tz_fields(ms, this.zone);
    return Math.round((Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4], f[5]) - ms) / 60000);
  }

  format(date: Date): string {
    let r = "";
    for (const p of this.formatToParts(date)) r += p.value;
    return r;
  }

  resolvedOptions(): Intl_ResolvedDateTimeFormatOptions {
    const z = this.zone !== "" ? this.zone : canonicalZone(localZone());
    return { locale: this.locale, calendar: "gregory", numberingSystem: "latn", timeZone: z === "" ? "UTC" : z };
  }
}

/** d.toLocaleString / toLocaleDateString / toLocaleTimeString(locales, options) with this package installed (the
    compiler routes the calls here; kind "any" is toLocaleString). */
export function __intl_date_to_locale(date: Date, kind: string, locales: string | null = null, options: Intl_DateTimeFormatOptions | null = null): string {
  return new Intl_DateTimeFormat(locales, options, kind === "any" ? "all" : kind).format(date);
}
