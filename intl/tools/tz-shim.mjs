// xisto:tz on Node, for tools/verify.mjs: the wall clock of a zone at an instant, as xisto's runtime gives it
// ([year, month 1-12, day, hour, minute, second, weekday 0-6]).
export function __xs_tz_fields(ms, zone) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return [+g("year"), +g("month"), +g("day"), +g("hour"), +g("minute"), +g("second"), ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday"))];
}
