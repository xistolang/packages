// Intl.DateTimeFormat, formatToParts and d.toLocaleDateString/... (locale, options): pt-BR and en-US, in UTC,
// America/Sao_Paulo and the local zone (TZ=America/New_York, as the suite runs), as on Node
const instants = [Date.UTC(2026, 2, 5, 14, 7, 9), Date.UTC(2026, 10, 12, 2, 3, 4), Date.UTC(2025, 0, 1, 0, 0, 0), Date.UTC(2016, 0, 15, 12, 30, 0)];
const opts: Intl.DateTimeFormatOptions[] = [
  {},
  { dateStyle: "full" },
  { dateStyle: "long", timeStyle: "short" },
  { dateStyle: "medium", timeStyle: "medium" },
  { dateStyle: "short", timeStyle: "long" },
  { timeStyle: "full" },
  { year: "numeric", month: "2-digit", day: "2-digit" },
  { year: "numeric", month: "long", day: "numeric", weekday: "long" },
  { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" },
  { hour: "numeric", minute: "2-digit", hour12: true },
  { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
  { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", timeZoneName: "short" },
  { weekday: "short", hour: "numeric", timeZoneName: "long" },
  { month: "long", year: "numeric" },
  { hour: "numeric", minute: "numeric", timeZoneName: "shortOffset" },
];
for (const ms of instants) {
  const d = new Date(ms);
  for (const loc of ["pt-BR", "en-US"]) {
    for (const zone of ["UTC", "America/Sao_Paulo", ""]) {
      for (const o of opts) {
        const oz: Intl.DateTimeFormatOptions = zone === "" ? o : { ...o, timeZone: zone };
        console.log(loc, zone, JSON.stringify(o), new Intl.DateTimeFormat(loc, oz).format(d));
      }
    }
  }
  console.log(d.toLocaleDateString("pt-BR"), "|", d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" }), "|", d.toLocaleString("en-US", { timeZone: "UTC" }));
  console.log(d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }), "|", d.toLocaleString("pt-BR"));
}
const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(instants[0]));
console.log(JSON.stringify(parts));
const byType: Record<string, string> = {};
for (const p of new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instants[1]))) byType[p.type] = p.value;
console.log(`${byType["year"]}-${byType["month"]}-${byType["day"]} ${byType["hour"]}:${byType["minute"]}:${byType["second"]}`);
console.log(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).resolvedOptions().timeZone);
// errors: Node's class and message
const bad: Intl.DateTimeFormatOptions[] = [{ dateStyle: "short", year: "numeric" }, { weekday: "x" }, { dateStyle: "x" }];
for (const o of bad) {
  try {
    new Intl.DateTimeFormat("pt-BR", o);
  } catch (e) {
    console.log("error:", (e as Error).name, (e as Error).message, e instanceof RangeError, e instanceof TypeError);
  }
}
try {
  new Intl.DateTimeFormat("pt-BR").format(new Date(NaN));
} catch (e) {
  console.log("error:", (e as Error).name, (e as Error).message, e instanceof RangeError);
}
