#!/usr/bin/env python3
# Normalizes the log lines of tests/apm/dd-logs: time, pid and host masked; the "dd" ids become the spans they point
# to, looked up in the traces the fake Agent received (so the check is that a line carries the ids of the span active
# when it was written): trace_id "hex128:<root span>" (32 hex digits: _dd.p.tid + the low 64 bits) or
# "dec64:<root span>" (the low 64 bits in decimal), span_id "<span>".
# usage: normalize.py STDOUT RECORDED.jsonl
import json, re, sys

lines = open(sys.argv[1]).read().splitlines()
spans = {}  # decimal span id -> name
traces = {}  # decimal low trace id -> (tid, root name)
for rec in (json.loads(l) for l in open(sys.argv[2]) if l.strip()):
    if rec.get("kind") != "dd":
        continue
    for trace in rec["traces"]:
        for s in trace:
            spans[str(s["span_id"])] = s["name"]
            if not s.get("parent_id"):
                traces[str(s["trace_id"])] = (s.get("meta", {}).get("_dd.p.tid", ""), s["name"])
by_hex = {"%s%016x" % (tid, int(lo)): name for lo, (tid, name) in traces.items() if tid}

for line in lines:
    if not line.startswith("{"):
        print(line)
        continue
    o = json.loads(line)
    for k, v in (("time", "T"), ("pid", "P"), ("hostname", "H")):
        if k in o:
            o[k] = v
    dd = o.get("dd")
    if isinstance(dd, dict):
        t = dd.get("trace_id")
        if t is not None:
            if re.fullmatch(r"[0-9a-f]{32}", t):
                dd["trace_id"] = "hex128:" + by_hex.get(t, "<unknown>")
            elif re.fullmatch(r"[0-9]+", t):
                dd["trace_id"] = "dec64:" + traces.get(t, ("", "<unknown>"))[1]
            else:
                dd["trace_id"] = "<bad>"
        if "span_id" in dd:
            dd["span_id"] = spans.get(dd["span_id"], "<unknown>")
    print(json.dumps(o, separators=(",", ":")))
