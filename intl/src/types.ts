// The shapes of the generated locale data (data/*.ts, made by tools/gen.mjs from Node's ICU).

/** A locale's number symbols and patterns. */
export class NumLocale {
  decimal: string;
  group: string;
  minus: string;
  percentPrefix: string;
  percentSuffix: string;
  currencyPrefix: string; // "¤" stands for the symbol
  currencySuffix: string;
  alphaSpace: string; // between a symbol that ends in a letter and the digits ("XYZ 5.00")
  nan: string;
  infinity: string;
  minGrouping: int; // digits the integer part needs before it is grouped: 1 groups 1,234; 2 leaves 1234
  constructor(decimal: string, group: string, minus: string, percentPrefix: string, percentSuffix: string, currencyPrefix: string,
    currencySuffix: string, alphaSpace: string, nan: string, infinity: string, minGrouping: int) {
    this.decimal = decimal;
    this.group = group;
    this.minus = minus;
    this.percentPrefix = percentPrefix;
    this.percentSuffix = percentSuffix;
    this.currencyPrefix = currencyPrefix;
    this.currencySuffix = currencySuffix;
    this.alphaSpace = alphaSpace;
    this.nan = nan;
    this.infinity = infinity;
    this.minGrouping = minGrouping;
  }
}

/** A locale's month and weekday names ("|" between names; standalone forms "" when they are the format ones). */
export class DtLocale {
  monthsLong: string[];
  monthsShort: string[];
  monthsNarrow: string[];
  standaloneMonths: string[][];
  weekdaysLong: string[];
  weekdaysShort: string[];
  weekdaysNarrow: string[];
  standaloneWeekdays: string[][];
  am: string;
  pm: string;
  hour12: boolean; // the locale's clock when the options do not say
  constructor(monthsLong: string, monthsShort: string, monthsNarrow: string, standaloneMonths: string, weekdaysLong: string,
    weekdaysShort: string, weekdaysNarrow: string, standaloneWeekdays: string, am: string, pm: string, hour12: boolean) {
    this.monthsLong = monthsLong.split("|");
    this.monthsShort = monthsShort.split("|");
    this.monthsNarrow = monthsNarrow.split("|");
    this.standaloneMonths = standaloneMonths === "" ? [this.monthsLong, this.monthsShort, this.monthsNarrow] : standaloneMonths.split("#").map((s: string): string[] => s.split("|"));
    this.weekdaysLong = weekdaysLong.split("|");
    this.weekdaysShort = weekdaysShort.split("|");
    this.weekdaysNarrow = weekdaysNarrow.split("|");
    this.standaloneWeekdays = standaloneWeekdays === "" ? [this.weekdaysLong, this.weekdaysShort, this.weekdaysNarrow] : standaloneWeekdays.split("#").map((s: string): string[] => s.split("|"));
    this.am = am;
    this.pm = pm;
    this.hour12 = hour12;
  }
}
