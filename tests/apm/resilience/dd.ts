// An app under an APM agent whose collector misbehaves: it must answer as fast, keep its memory, and exit.
import tracer from "dd-trace";
import http from "node:http";

tracer.init({ flushInterval: 50, startupLogs: false, runtimeMetrics: false });

const server = http.createServer((req, res) => {
  tracer.trace("handler.work", { resource: req.url ?? "" }, () => {
    res.statusCode = 200;
  });
  if (req.url === "/quit") {
    res.end("bye");
    server.close();
    return;
  }
  res.end("ok");
});
server.listen(Math.trunc(Number(process.env.PORT ?? "9180")), () => console.log("listening"));
