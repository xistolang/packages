// The OTLP exporters' OpenTelemetry view (newrelic here): span names and attributes by OpenTelemetry's semantic
// conventions (http.request.method, http.route, http.response.status_code, url.full, server.address, db.system,
// db.operation, db.collection.name...), client spans failing on 4xx and 5xx, an exception event only for a real
// error, and the OTLP delta metrics New Relic's APM pages read (http.server.request.duration,
// http.client.request.duration, db.client.operation.duration) plus recordMetric / incrementMetric.
import newrelic from "newrelic";
import http from "node:http";
import { ApmSpanOptions, newSpan } from "xisto-apm";

let port = 0;
// a database call as the pg package records it (its span, without a server to talk to)
function query(sql: string, fail: boolean): void {
  const o = new ApmSpanOptions();
  o.resource = sql;
  o.type = "sql";
  o.kind = "client";
  o.component = "pg";
  const span = newSpan("pg.query", o);
  if (span === null) return;
  span.setText("db.type", "postgres");
  span.setText("db.name", "shop");
  span.setText("out.host", "db.internal");
  if (fail) span.setError(new Error('relation "missing" does not exist'));
  span.finish();
}
const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (url.startsWith("/front")) {
    const r = await fetch(`http://127.0.0.1:${port}/back?x=1`);
    res.end("front+" + (await r.text()));
    return;
  }
  if (url.startsWith("/back")) {
    query("SELECT id, total FROM orders WHERE customer = $1", false);
    query("INSERT INTO audit (what) VALUES ($1)", false);
    res.end("back");
    return;
  }
  if (url.startsWith("/broken")) {
    query("SELECT * FROM missing", true);
    newrelic.noticeError(new Error("card declined"), { step: "charge" });
    res.statusCode = 500;
    res.end("broken");
    return;
  }
  res.statusCode = 404;
  res.end("missing");
});
server.listen(0, async () => {
  const a = server.address();
  port = a !== null && typeof a === "object" ? a.port : 0;
  for (const path of ["/front", "/front", "/broken", "/missing"]) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    console.log(path, r.status, await r.text());
  }
  newrelic.recordMetric("Custom/cart/size", 3);
  newrelic.incrementMetric("Custom/checkouts");
  newrelic.incrementMetric("Custom/checkouts", 2);
  server.close();
});
