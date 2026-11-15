import newrelic from "newrelic";
void newrelic;
import http from "node:http";
const server = http.createServer((req, res) => {
  if (req.url === "/quit") {
    res.end("bye");
    server.close();
    return;
  }
  res.end("ok");
});
server.listen(Math.trunc(Number(process.env.PORT ?? "9180")), () => console.log("listening"));
