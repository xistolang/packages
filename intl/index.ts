// intl for xisto: JavaScript's Intl for back-end programs, printing what Node 26 (ICU 78, CLDR 48) prints. Intl is not
// built into xisto: with this package installed (xisto add intl), Intl.NumberFormat is its class Intl_NumberFormat
// (and Intl.NumberFormatOptions its interface), and n.toLocaleString(locale, options), d.toLocaleString /
// toLocaleDateString / toLocaleTimeString(locale, options) and s.localeCompare(t, locale, options) come here.
//
// Only what a program uses is compiled into it: each formatter is a class, and its locale data (data/*.ts, made by
// tools/gen.mjs from Node's own Intl) is a set of functions reached only from the formatter that uses it, with no
// module-level state. A program that uses NumberFormat has no date patterns or collation weights, and one that uses
// no Intl has nothing of this package (tests/intl/size).
//
// Supported:
//   Intl.NumberFormat(locale, { style: decimal | percent | currency, currency, currencyDisplay: symbol |
//     narrowSymbol | code, minimumIntegerDigits, minimumFractionDigits, maximumFractionDigits, useGrouping })
//     .format(n), .resolvedOptions(); every ISO 4217 currency's symbol and digits
//   Intl.DateTimeFormat(locale, { dateStyle, timeStyle, weekday, year, month, day, hour, minute, second,
//     timeZoneName: short | long | shortOffset | longOffset, timeZone, hour12, hourCycle })
//     .format(d), .formatToParts(d), .resolvedOptions(); a timeZone of the system's TZ database, the local zone by
//     default ($TZ); zone names for UTC, Brazil's, the Americas', Europe's and some of Asia's zones, the GMT offset
//     for the others
//   Intl.Collator(locale, { sensitivity, numeric, caseFirst, usage }).compare(a, b) (a function value:
//     xs.sort(collator.compare)): ICU's root order, which is pt's and en's (accents, case, ß = ss, æ = ae...)
//   Locales: en-US and pt-BR; another pt-* formats as pt-BR, any other locale as en-US (Node would use that locale).
//
// Differences from Node (tools/verify.mjs checks the package's code against Node's Intl over ~1 million cases):
//   - errors are Error with Node's message, not RangeError / TypeError (those classes cost a program ~57 KB in xisto)
//   - hourCycle h11 / h24: the hour is counted as asked, but laid out as h12 / h23 (ICU picks other patterns)
//   - a zone without a kept name prints its long name as GMT-03:00 (Node: e.g. "Nepal Time")
//   - Collator: ½ ¼ ¾ and ligatures (ﬁ) sort as single symbols (ICU expands them); scripts other than Latin
//     sort after it by code point (ICU orders Greek, Cyrillic, Han... among themselves by their own rules);
//     ignorePunctuation is not supported
//   - not supported: NumberFormat notation / compact / unit / signDisplay / significant digits / formatToParts,
//     DateTimeFormat era / dayPeriod / fractionalSecondDigits / formatRange, PluralRules, RelativeTimeFormat,
//     ListFormat, Segmenter, DisplayNames, locale arrays
export type { Intl_NumberFormatOptions, Intl_ResolvedNumberFormatOptions } from "./src/number";
export { Intl_NumberFormat, __intl_number_to_locale } from "./src/number";
export type { Intl_DateTimeFormatOptions, Intl_DateTimeFormatPart, Intl_ResolvedDateTimeFormatOptions } from "./src/datetime";
export { Intl_DateTimeFormat, __intl_date_to_locale } from "./src/datetime";
export type { Intl_CollatorOptions, Intl_ResolvedCollatorOptions } from "./src/collator";
export { Intl_Collator, __intl_locale_compare } from "./src/collator";
