// @dynatrace/oneagent for xisto: `oneagent({ environmentid, apitoken, endpoint })` starts tracing (as the npm
// package's call starts OneAgent), on the xisto-apm core, exporting to Dynatrace's OpenTelemetry trace ingest:
// OTLP/HTTP JSON to https://{environmentid}.live.dynatrace.com/api/v2/otlp/v1/traces with the header
// "Authorization: Api-Token <apitoken>" (a token with the openTelemetryTrace.ingest scope).
//
// Configuration: the options win over the variables DT_ENVIRONMENTID (or DT_TENANT), DT_API_TOKEN (or
// DT_APITOKEN), DT_ENDPOINT (or DT_CONNECTION_POINT); xisto's DT_OTLP_URL gives the whole OTLP traces URL. The
// endpoint, when given, is the environment's URL: ".../communication" (OneAgent's) becomes
// ".../api/v2/otlp/v1/traces", a URL that already has "/api/v2/otlp" gets "/v1/traces" if missing, any other gets
// "/api/v2/otlp/v1/traces" appended (a Managed or ActiveGate URL such as https://host/e/{id}). The service is
// OTEL_SERVICE_NAME, else DT_SERVICE_NAME (xisto's), else "unknown_service:<process title>"; OTEL_RESOURCE_ATTRIBUTES
// ("k=v,k2=v2") adds resource attributes.
//
// Differences from the npm package:
// - The npm package installs and loads the real OneAgent (native code) that instruments the process and talks
//   Dynatrace's own protocol; here no agent is loaded: the spans come from @dynatrace/oneagent-sdk's tracers and
//   from the packages that call xisto-apm's hooks, and go out as OTLP.
// - The other OneAgent options (server, tenant, tenanttoken, loglevel...) are accepted and ignored: the OTLP ingest
//   needs an API token, not the tenant token.
// - Call it as `oneagent(options)` after `import oneagent from "@dynatrace/oneagent"`; xisto reads a top-level
//   `require("@dynatrace/oneagent")` as `import * as`, whose `start(options)` does the same. It returns true when
//   tracing is on (the npm package's call returns the agent's exports).
import { Apm, ApmOtlpExporter, ApmServiceInfo, hostName } from "xisto-apm";

/** The options of the npm package's call (the ones used here; the others are accepted). */
export interface OneAgentOptions {
  environmentid?: string;
  apitoken?: string;
  endpoint?: string;
  server?: string;
  tenant?: string;
  tenanttoken?: string;
  loglevel?: string;
}

function env(name: string): string | null {
  const v = process.env[name];
  return v === null || v === "" ? null : v;
}

/** The OTLP traces URL for an environment id and an optional endpoint. */
export function tracesUrl(environmentId: string, endpoint: string): string {
  if (endpoint.length === 0) return `https://${environmentId}.live.dynatrace.com/api/v2/otlp/v1/traces`;
  let e = endpoint;
  while (e.endsWith("/")) e = e.slice(0, e.length - 1);
  if (e.endsWith("/communication")) return e.slice(0, e.length - 14) + "/api/v2/otlp/v1/traces";
  if (e.indexOf("/api/v2/otlp") >= 0) return e.endsWith("/v1/traces") ? e : e + "/v1/traces";
  return e + "/api/v2/otlp/v1/traces";
}

let started = false;

/** Starts tracing to Dynatrace (once; later calls do nothing). False when there is no token or environment to send
 * to, or another xisto-apm agent is already tracing. */
export function start(options: OneAgentOptions | null = null): boolean {
  if (started) return Apm.on;
  const o: OneAgentOptions = options ?? {};
  const id = o.environmentid ?? o.tenant ?? env("DT_ENVIRONMENTID") ?? env("DT_TENANT") ?? "";
  const token = o.apitoken ?? env("DT_API_TOKEN") ?? env("DT_APITOKEN") ?? "";
  const endpoint = o.endpoint ?? env("DT_ENDPOINT") ?? env("DT_CONNECTION_POINT") ?? "";
  const custom = env("DT_OTLP_URL");
  if (token.length === 0 || (id.length === 0 && endpoint.length === 0 && custom === null)) return false;
  if (Apm.on) return false;
  started = true;
  const info = new ApmServiceInfo();
  info.service = env("OTEL_SERVICE_NAME") ?? env("DT_SERVICE_NAME") ?? `unknown_service:${process.title}`;
  info.hostname = hostName();
  const h = new Map<string, string>();
  h.set("Authorization", `Api-Token ${token}`);
  const ex = new ApmOtlpExporter(custom ?? tracesUrl(id, endpoint), h);
  const ra = env("OTEL_RESOURCE_ATTRIBUTES");
  if (ra !== null) {
    for (const kv of ra.split(",")) {
      const eq = kv.indexOf("=");
      if (eq > 0) ex.resourceAttrs.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
    }
  }
  Apm.start(info, ex);
  return true;
}

/** start() under a name of its own (for packages that import it next to a start of theirs). */
export function startOneAgent(options: OneAgentOptions | null = null): boolean {
  return start(options);
}

/** Whether this package started tracing. */
export function isStarted(): boolean {
  return started;
}

/** `oneagent(options)`: starts tracing to Dynatrace; true when it is on. */
export default function oneagent(options: OneAgentOptions | null = null): boolean {
  return start(options);
}
