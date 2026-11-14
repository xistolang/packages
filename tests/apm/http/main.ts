// dd-trace with node:http and fetch: a server span per request (its parent from the caller's headers), client spans
// for fetch and http.get, the trace carried from client to server, a 404 as a client error
import tracer from "dd-trace";
import http from "node:http";

tracer.init({ flushInterval: 50, startupLogs: false, runtimeMetrics: false });

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const server = http.createServer((req, res) => {
  tracer.trace("handler.work", { resource: req.url ?? "" }, () => {
    res.statusCode = req.url === "/missing" ? 404 : 200;
  });
  res.end("ok");
});
server.listen(0, async () => {
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : 0;
  await tracer.trace("client.job", { resource: "calls" }, async () => {
    const r = await fetch(`http://127.0.0.1:${port}/users?id=1`);
    console.log("fetch", r.status, await r.text());
    const r2 = await fetch(`http://127.0.0.1:${port}/missing`);
    console.log("fetch", r2.status, await r2.text());
  });
  http.get({ hostname: "127.0.0.1", port: port, path: "/via-http" }, (res) => {
    res.resume();
    res.on("end", async () => {
      console.log("http.get", res.statusCode);
      server.close();
      await sleep(300);
    });
  });
});
