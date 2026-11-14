// @dynatrace/oneagent-sdk with no agent (no OneAgent on Node, nothing started in xisto): the SDK is inactive, its
// tracers run the handlers and record nothing.
import { createInstance } from "@dynatrace/oneagent-sdk";

const sdk = createInstance();
console.log("state:", sdk.getCurrentState());
const t = sdk.traceIncomingRemoteCall({ serviceMethod: "m", serviceName: "S", serviceEndpoint: "/e" });
console.log("start value:", t.start(() => 5));
t.end();
const o = sdk.traceOutgoingRemoteCall({ serviceMethod: "m", serviceName: "S", serviceEndpoint: "/e", host: "h", port: 1 });
console.log("tag:", JSON.stringify(o.getDynatraceStringTag()));
console.log("end value:", o.end(() => 7));
const info = sdk.getTraceContextInfo();
console.log("context:", info.isValid, info.traceid, info.spanid);
