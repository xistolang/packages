// dd-trace's profiler: tracer.init({ profiling: true }) and a CPU-bound app. With DD_PROFILING_UPLOAD_PERIOD=1 the
// profiler uploads every second to the (fake) Agent's /profiling/v1/input; the app does CPU work in slices so the
// event loop runs the uploads, as a server between requests.
import tracer from "dd-trace";

tracer.init({
  service: "prof-app",
  env: "test",
  version: "1.2.3",
  hostname: "127.0.0.1",
  port: Number(process.env.APM_DD_PORT ?? "8126"),
  profiling: true,
  startupLogs: false,
  runtimeMetrics: false,
});

function checksum(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s * 31 + i) % 1000003;
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const until = Date.now() + Number(process.env.APP_SECONDS ?? "3.5") * 1000;
  let acc = 0;
  while (Date.now() < until) {
    const slice = Date.now() + 40;
    while (Date.now() < slice) acc += checksum(20000) % 7;
    await sleep(5);
  }
  console.log("done", acc >= 0);
  await sleep(1500); // (the last upload)
  process.exit(0);
}
main();
