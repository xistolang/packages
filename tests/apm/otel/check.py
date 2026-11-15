#!/usr/bin/env python3
# Checks the OTLP traces and metrics main.ts sent (recorded by collectors.py): prints one line per fact, compared
# with expected.txt by run.sh.
import json, sys, collections
recs = [json.loads(l) for l in open(sys.argv[1])]
spans = [s for r in recs if r["kind"] == "otlp" for x in r["body"]["resourceSpans"] for ss in x["scopeSpans"] for s in ss["spans"]]
def attrs(s): return {a["key"]: list(a["value"].values())[0] for a in s["attributes"]}
KIND = {1: "internal", 2: "server", 3: "client"}
out = []
for s in sorted(spans, key=lambda s: (KIND[s["kind"]], s["name"], attrs(s).get("http.response.status_code", ""), attrs(s).get("url.path", ""))):
    a = attrs(s)
    keep = ["http.request.method", "http.response.status_code", "http.route", "url.path", "server.address", "error.type",
            "db.system", "db.system.name", "db.operation", "db.operation.name", "db.collection.name", "db.sql.table", "db.query.text", "db.namespace"]
    st = s["status"].get("code", 0)
    ev = [(e["name"], {x["key"]: list(x["value"].values())[0] for x in e["attributes"]}.get("exception.message")) for e in s["events"]]
    out.append(f'span {KIND[s["kind"]]} "{s["name"]}" status={st} {s["status"].get("message", "")!r} ' +
               " ".join(f"{k}={a[k]}" for k in keep if k in a and not (k == "server.address" and a[k] == "127.0.0.1")) +
               (f" events={ev}" if ev else ""))
mets = collections.OrderedDict()
for r in recs:
    if r["kind"] != "otlp-metrics": continue
    for m in r["body"]["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]:
        kind = "histogram" if "histogram" in m else "gauge" if "gauge" in m else "sum"
        d = m[kind]
        for p in d["dataPoints"]:
            a = {x["key"]: list(x["value"].values())[0] for x in p.get("attributes", [])}
            a.pop("server.port", None)
            if a.get("server.address") == "127.0.0.1": a["server.address"] = "local"
            v = p.get("count") if kind == "histogram" else p.get("asDouble")
            temp = d.get("aggregationTemporality")
            mets.setdefault((m["name"], kind, temp, json.dumps(a, sort_keys=True)), 0)
            mets[(m["name"], kind, temp, json.dumps(a, sort_keys=True))] += float(v)
for (n, k, t, a), v in sorted(mets.items()):
    out.append(f"metric {n} {k} temporality={t} {a} -> {v:g}")
print("\n".join(out))
