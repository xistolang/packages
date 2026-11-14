#!/usr/bin/env python3
# Normalizes what the fake collectors (collectors.py) recorded so that two runs (Node with the real agent, or the
# xisto build) can be compared: ids become relations (the name of the span or transaction they point to), times,
# durations, pids, host names, argv and agent/runtime versions are taken out (after checking their form), error
# stack traces become "<frames>" and the events are sorted.
# usage: normalize.py RECORDED.jsonl elastic|otlp   (prints the normalized JSON)
import json, re, sys

HEX16 = re.compile(r"^[0-9a-f]{16}$")
HEX32 = re.compile(r"^[0-9a-f]{32}$")
records = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
kind = sys.argv[2]
records = [r for r in records if r["kind"] == kind]
problems = []


def check(cond, what):
    if not cond:
        problems.append(what)


def elastic():
    headers = sorted({json.dumps(r["headers"], sort_keys=True) for r in records})
    events = [e for r in records for e in r["events"]]
    metas = [e["metadata"] for e in events if "metadata" in e]
    meta = metas[0] if metas else {}
    for m in metas:
        check(m["service"] == meta["service"], "metadata differs between requests")
    meta = json.loads(json.dumps(meta))
    check(isinstance(meta.get("process", {}).get("pid"), int), "metadata.process.pid")
    meta.pop("process", None)
    for k in ("version", "activation_method"):
        meta.get("service", {}).get("agent", {}).pop(k, None)
    meta.get("service", {}).pop("runtime", None)
    meta.get("system", {}).pop("detected_hostname", None)
    names = {}
    txs = [e["transaction"] for e in events if "transaction" in e]
    spans = [e["span"] for e in events if "span" in e]
    errors = [e["error"] for e in events if "error" in e]
    for t in txs:
        names[t["id"]] = "tx:" + t["name"]
        if "parent_id" not in t:
            names[t["trace_id"]] = "trace:" + t["name"]
    for s in spans:
        names[s["id"]] = "span:" + s["name"]
    out = []
    for typ, lst in (("transaction", txs), ("span", spans), ("error", errors)):
        for e in lst:
            e = json.loads(json.dumps(e))
            check(HEX32.match(e.get("trace_id", "0" * 32)) is not None, typ + " trace_id")
            for k in ("id", "trace_id", "parent_id", "transaction_id"):
                if k in e:
                    if typ == "error" and k == "id":
                        check(HEX32.match(e["id"]) is not None, "error id")
                        e["id"] = "<id>"
                    else:
                        check(HEX16.match(e[k]) is not None or HEX32.match(e[k]) is not None, typ + " " + k)
                        e[k] = names.get(e[k], "<unknown>")
            check(isinstance(e.pop("timestamp", None), int), typ + " timestamp")
            if typ != "error":
                d = e.pop("duration", None)
                check(isinstance(d, (int, float)) and d >= 0, typ + " duration")
            else:
                ex = e.get("exception", {})
                if "stacktrace" in ex:
                    check(isinstance(ex["stacktrace"], list), "error stacktrace")
                    ex["stacktrace"] = "<frames>"
                e.pop("culprit", None)
            out.append({typ: e})
    out.sort(key=lambda e: json.dumps(e, sort_keys=True))
    return {"headers": headers, "metadata": meta, "events": out}


def value(v):
    for k in ("stringValue", "boolValue", "doubleValue"):
        if k in v:
            return v[k]
    if "intValue" in v:
        return int(v["intValue"])
    return v


def attrs(lst, drop=()):
    return {a["key"]: value(a["value"]) for a in lst if a["key"] not in drop}


def otlp():
    headers = sorted({json.dumps(r["headers"], sort_keys=True) for r in records})
    resources = set()
    spans = []
    scopes = set()
    for r in records:
        for rs in r["body"].get("resourceSpans", []):
            res = attrs(rs.get("resource", {}).get("attributes", []))
            check("host.name" in res, "resource host.name")
            for k in ("host.name", "process.pid", "telemetry.sdk.version"):
                res.pop(k, None)
            resources.add(json.dumps(res, sort_keys=True))
            for ss in rs.get("scopeSpans", []):
                scopes.add(json.dumps(ss.get("scope", {}), sort_keys=True))
                spans.extend(ss.get("spans", []))
    names = {}
    for s in spans:
        names[s["spanId"]] = "span:" + s["name"]
        if not s.get("parentSpanId"):
            names[s["traceId"]] = "trace:" + s["name"]
    out = []
    for s in spans:
        s = json.loads(json.dumps(s))
        check(HEX32.match(s["traceId"]) is not None, "traceId")
        check(HEX16.match(s["spanId"]) is not None, "spanId")
        st, en = int(s.pop("startTimeUnixNano")), int(s.pop("endTimeUnixNano"))
        check(st > 1.6e18 and en >= st, "span times")
        s["traceId"] = names.get(s["traceId"], "<remote trace>")
        s["spanId"] = names[s["spanId"]]
        if s.get("parentSpanId"):
            s["parentSpanId"] = names.get(s["parentSpanId"], "<remote parent>")
        s["attributes"] = attrs(s.get("attributes", []))
        for ev in s.get("events", []):
            check(int(ev.pop("timeUnixNano")) >= st, "event time")
            ev["attributes"] = attrs(ev.get("attributes", []))
            if "exception.stacktrace" in ev["attributes"]:
                ev["attributes"]["exception.stacktrace"] = "<frames>"
        out.append(s)
    out.sort(key=lambda s: json.dumps(s, sort_keys=True))
    return {"headers": headers, "resources": sorted(json.loads(r) for r in resources), "scopes": sorted(scopes), "spans": out}


result = elastic() if kind == "elastic" else otlp()
if problems:
    result["problems"] = sorted(set(problems))
print(json.dumps(result, indent=1, sort_keys=True))
