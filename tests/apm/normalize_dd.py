#!/usr/bin/env python3
# The Datadog spans a collector got (collectors.py output), normalized for comparison: ids as relations (the parent's
# name, the trace root's name), no times, pids, runtime ids or process tags; an error stack reduced to its first line.
import json, sys
spans = []
for line in open(sys.argv[1]):
    o = json.loads(line)
    if o["kind"] != "dd":
        continue
    for t in o["traces"]:
        spans.extend(t)
by_id = {s["span_id"]: s for s in spans}
SKIP_META = {"runtime-id", "_dd.tags.process", "http.useragent"}  # (the user agent is the client runtime's own)
SKIP_METRICS = {"process_id"}
out = []
for s in spans:
    if s.get("meta", {}).get("_dd.integration") == "net":
        continue  # (Node's TCP connection spans: xisto's runtime has no net integration)
    meta = {k: v for k, v in s.get("meta", {}).items() if k not in SKIP_META}
    if "error.stack" in meta:
        meta["error.stack"] = meta["error.stack"].split("\n")[0]
    if "_dd.p.tid" in meta:
        meta["_dd.p.tid"] = "<tid>" if len(meta["_dd.p.tid"]) == 16 else meta["_dd.p.tid"]
    metrics = {k: v for k, v in s.get("metrics", {}).items() if k not in SKIP_METRICS}
    parent = by_id.get(s.get("parent_id"))
    root = s
    while root.get("parent_id") in by_id:
        root = by_id[root["parent_id"]]
    out.append(json.dumps({"name": s["name"], "resource": s.get("resource"), "service": s.get("service"), "type": s.get("type"),
                           "error": s.get("error", 0), "parent": parent["name"] if parent else None, "root": root["name"],
                           "same_trace": s["trace_id"] == root["trace_id"], "meta": meta, "metrics": metrics}, sort_keys=True))
for l in sorted(out):
    print(l)
