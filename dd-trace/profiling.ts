// dd-trace's continuous profiler (Datadog's Profiles tab) on xisto's sampling CPU profiler (xisto:profiler).
// init({ profiling: true }) or DD_PROFILING_ENABLED=true starts it; every DD_PROFILING_UPLOAD_PERIOD seconds (65 by
// default, as dd-trace 5) the samples of the period go up as dd-trace's agent exporter sends them: a multipart POST
// with event.json (family "node", the same tags_profiler and info) and the profile, to the Agent's
// /profiling/v1/input, or, with DD_PROFILING_AGENTLESS=true, straight to Datadog's intake
// (https://intake.profile.<DD_SITE>/api/v2/profile, with DD_API_KEY), as dd-trace before 5 and Datadog's other
// profilers do.
// What differs from dd-trace on Node: one profile type, CPU time ("cpu.pprof": sample/count and cpu/nanoseconds,
// sampled 99 times per second of CPU across every thread, frames are the TypeScript functions with file and line);
// Node sends wall time (wall.pprof, which counts time off the CPU too), heap (space.pprof) and timeline events.
// No code hotspots (span ids on samples), no endpoint counts. gzip, as dd-trace on Node before 24 (zstd since).
// Not on Windows (xisto:profiler has no sampler there: the profiler does not start). The upload at exit is not sent.
import { start as startSampling, collect as collectProfile, lastSamples } from "xisto:profiler";
import { gzipSync } from "node:zlib";
import { release, version, type, availableParallelism } from "node:os";
import { Apm, ApmServiceInfo, newId } from "xisto-apm";

const TRACER_VERSION = "5.131.1";

function envOr(name: string, dflt: string): string {
  const v = process.env[name];
  return v !== null && v.length > 0 ? v : dflt;
}

function isTrue(v: string): boolean {
  return v === "true" || v === "1";
}

/** Where profiles go: the Agent, or Datadog's intake (agentless). */
export class ProfileTarget {
  url: string = "";
  apiKey: string = "";
  agentless: boolean = false;
}

/** The profiler's settings as dd-trace reports them (info.profiler.settings), for what xisto's profiler does. */
function settingsJson(): string {
  return (
    `{"allocationProfilingEnabled":false,"asyncContextFrameEnabled":false,"codeHotspotsEnabled":false,` +
    `"cpuProfilingEnabled":true,"debugSourceMaps":false,"endpointCollectionEnabled":false,"heapSamplingInterval":524288,` +
    `"oomMonitoring":{"enabled":false,"exportStrategies":[],"heapLimitExtensionSize":"auto","maxHeapExtensionCount":0},` +
    `"profilerTypes":["cpu"],"sourceMap":false,"timelineEnabled":false,"timelineSamplingEnabled":false,` +
    `"uploadCompression":{"method":"gzip"},"v8ProfilerBugWorkaroundEnabled":false}`
  );
}

/** A process tag value as dd-trace writes it (lower case, anything but [a-zA-Z0-9/_.-] as "_"). */
function sanitize(v: string): string {
  return v.toLowerCase().replace(/[^a-zA-Z0-9/_.-]+/g, "_");
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/** The uploads: one profile per period. */
export class ProfileUploader {
  target: ProfileTarget;
  info: ApmServiceInfo;
  runtimeId: string;
  serviceFromUser: boolean;
  seq: int = 0;
  periodStart: Date = new Date();
  processStart: Date;
  timeoutMs: int;
  constructor(target: ProfileTarget, info: ApmServiceInfo, runtimeId: string, serviceFromUser: boolean) {
    this.target = target;
    this.info = info;
    this.runtimeId = runtimeId;
    this.serviceFromUser = serviceFromUser;
    this.processStart = new Date(Date.now() - process.uptime() * 1000);
    this.timeoutMs = Math.trunc(Number(envOr("DD_PROFILING_UPLOAD_TIMEOUT", "60000")));
  }

  /** tags_profiler: the profiler's own tags, then the tracer's (service, env, version, DD_TAGS, runtime-id). */
  tagsProfiler(): string {
    const info = this.info;
    const t: string[] = [
      "language:javascript",
      "runtime:nodejs",
      `runtime_arch:${process.arch}`,
      `runtime_os:${process.platform}`,
      `runtime_version:${process.version}`,
      `process_id:${process.pid}`,
      `profiler_version:${TRACER_VERSION}`,
      "format:pprof",
    ];
    for (const k of info.tags.keys()) t.push(`${k}:${info.tags.get(k) ?? ""}`);
    t.push(`service:${info.service}`);
    if (info.env.length > 0) t.push(`env:${info.env}`);
    if (info.version.length > 0) t.push(`version:${info.version}`);
    t.push(`runtime-id:${this.runtimeId}`);
    t.push("snapshot:periodic");
    t.push(`profile_seq:${this.seq}`);
    return t.join(",");
  }

  processTags(): string {
    const exe = process.argv.length > 1 ? process.argv[1] : "";
    const t: string[] = [];
    if (exe.length > 0) {
      const dir = exe.lastIndexOf("/") > 0 ? exe.slice(0, exe.lastIndexOf("/")) : ".";
      t.push(`entrypoint.basedir:${sanitize(baseName(dir === "." ? process.cwd() : dir))}`);
      t.push(`entrypoint.name:${sanitize(baseName(exe))}`);
    }
    t.push("entrypoint.type:executable");
    t.push(`entrypoint.workdir:${sanitize(baseName(process.cwd()))}`);
    t.push(this.serviceFromUser ? "svc.user:true" : `svc.auto:${sanitize(this.info.service)}`);
    return t.join(",");
  }

  /** event.json, as dd-trace's EventSerializer writes it. */
  event(start: Date, end: Date): string {
    const info = this.info;
    const app: string[] = [];
    if (info.env.length > 0) app.push(`"env":${JSON.stringify(info.env)}`);
    app.push(`"service":${JSON.stringify(info.service)}`);
    app.push(`"start_time":${JSON.stringify(this.processStart.toISOString())}`);
    if (info.version.length > 0) app.push(`"version":${JSON.stringify(info.version)}`);
    const platform: string[] = [];
    if (isTrue(envOr("DD_TRACE_REPORT_HOSTNAME", "false"))) platform.push(`"hostname":${JSON.stringify(info.hostname)}`);
    platform.push(`"kernel_name":${JSON.stringify(type())}`);
    platform.push(`"kernel_release":${JSON.stringify(release())}`);
    platform.push(`"kernel_version":${JSON.stringify(version())}`);
    return (
      `{"attachments":["cpu.pprof"],"start":${JSON.stringify(start.toISOString())},"end":${JSON.stringify(end.toISOString())},` +
      `"family":"node","version":"4","tags_profiler":${JSON.stringify(this.tagsProfiler())},"endpoint_counts":{},` +
      `"info":{"application":{${app.join(",")}},"platform":{${platform.join(",")}},` +
      `"profiler":{"activation":"manual","ssi":{"mechanism":"none"},"version":"${TRACER_VERSION}","serverless":false,` +
      `"settings":${settingsJson()},"hasMissingSourceMaps":false},` +
      `"runtime":{"available_processors":${availableParallelism()},"engine":"nodejs","version":${JSON.stringify(process.version.slice(1))}}},` +
      `"process_tags":${JSON.stringify(this.processTags())}}`
    );
  }

  /** The samples since the last upload, sent (an Agent or intake that is not there loses them, as in dd-trace). */
  async upload(): Promise<void> {
    const start = this.periodStart;
    const end = new Date();
    this.periodStart = end;
    const pprof = gzipSync(collectProfile());
    const ev = this.event(start, end);
    this.seq++;
    const boundary = newId();
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="event"; filename="event.json"\r\n` +
          `Content-Type: application/json\r\n\r\n${ev}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="cpu.pprof"; filename="cpu.pprof"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      pprof,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const headers: Record<string, string> = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "DD-EVP-ORIGIN": "dd-trace-js",
      "DD-EVP-ORIGIN-VERSION": TRACER_VERSION,
    };
    if (this.target.agentless) headers["DD-API-KEY"] = this.target.apiKey;
    try {
      Apm.skipNextFetch(); // (its own request is not traced, as dd-trace's)
      const res = await fetch(this.target.url, { method: "POST", headers: headers, body: body, signal: AbortSignal.timeout(this.timeoutMs) });
      if (isTrue(envOr("DD_TRACE_DEBUG", "false"))) console.error(`dd-trace: profile upload ${this.seq - 1}: HTTP ${res.status}, ${lastSamples()} samples`);
    } catch (err) {
      if (isTrue(envOr("DD_TRACE_DEBUG", "false"))) console.error(`dd-trace: profile upload: ${(err as Error).message}`);
    }
  }
}

let uploader: ProfileUploader | null = null;

/** Whether profiling is on: init({ profiling }) first, else DD_PROFILING_ENABLED (dd-trace's precedence). */
export function profilingWanted(option: boolean | null): boolean {
  if (option !== null) return option as boolean;
  return isTrue(envOr("DD_PROFILING_ENABLED", "false"));
}

/** Starts sampling and the periodic uploads (once); false when the process has no sampler (Windows), when another
 * thread already profiles it, or when agentless has no API key. */
export function startProfiling(info: ApmServiceInfo, runtimeId: string, agentUrl: string, serviceFromUser: boolean): boolean {
  if (uploader !== null) return true;
  const target = new ProfileTarget();
  if (isTrue(envOr("DD_PROFILING_AGENTLESS", "false"))) {
    target.agentless = true;
    target.apiKey = envOr("DD_API_KEY", "");
    target.url = envOr("DD_PROFILING_INTAKE_URL", `https://intake.profile.${envOr("DD_SITE", "datadoghq.com")}/api/v2/profile`);
    if (target.apiKey.length === 0) {
      console.error("dd-trace: DD_PROFILING_AGENTLESS needs DD_API_KEY: profiling is off");
      return false;
    }
  } else {
    target.url = agentUrl + "/profiling/v1/input";
  }
  if (!startSampling(99)) return false;
  const up = new ProfileUploader(target, info, runtimeId, serviceFromUser);
  uploader = up;
  const period = Math.max(1, Number(envOr("DD_PROFILING_UPLOAD_PERIOD", "65")));
  setInterval(() => {
    up.upload();
  }, Math.trunc(period * 1000)).unref();
  return true;
}

/** Samples in the last upload (tests). */
export function lastProfileSamples(): int {
  return lastSamples();
}
