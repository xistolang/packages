#!/usr/bin/env python3
# The first profile a fake Agent got from dd-trace's profiler (collectors.py, kind "dd-profile"), normalized for
# comparison with what dd-trace 5.131.1 sends on Node: times, ids, the machine and the runtime's version as
# placeholders. What xisto's profiler sends differently on purpose is reduced to its shape, and said here:
#   attachments      Node: wall.pprof, space.pprof, events.pprof (wall time, heap, timeline); xisto: cpu.pprof
#   settings         the same keys; their values describe each runtime's profilers
#   profiler.wall/.events   Node's per-profiler infos (no such profilers in xisto)
#   _dd.rc.client_id Node's remote-configuration client (xisto has no remote configuration)
#   process_tags     the same field; Node names a script, xisto an executable
# usage: normalize_dd_profile.py RECORDED.jsonl
import json, sys

rec = None
for line in open(sys.argv[1]):
    o = json.loads(line)
    if o["kind"] == "dd-profile":
        rec = o
        break
if rec is None:
    print("no profile")
    sys.exit(1)
ev = rec["event"]
for k in ("start", "end"):
    ev[k] = "<time>"
ev["attachments"] = "<attachments>"
ev["process_tags"] = "<process_tags>" if ev.get("process_tags") else None
tags = []
VOLATILE = {"process_id", "runtime-id", "runtime_version", "runtime_arch", "runtime_os"}
for t in ev["tags_profiler"].split(","):
    k, _, v = t.partition(":")
    if k == "_dd.rc.client_id":
        continue
    tags.append("%s:%s" % (k, "<%s>" % k if k in VOLATILE else v))
ev["tags_profiler"] = tags
info = ev["info"]
info["application"]["start_time"] = "<time>"
for k in ("kernel_release", "kernel_version", "kernel_name"):
    if k in info["platform"]:
        info["platform"][k] = "<%s>" % k
info["runtime"]["available_processors"] = "<n>"
info["runtime"]["version"] = "<version>"
prof = info["profiler"]
for k in ("wall", "events", "cpu", "space"):
    prof.pop(k, None)


def shape(v):
    if isinstance(v, dict):
        return {k: shape(x) for k, x in v.items()}
    return "<value>"


prof["settings"] = shape(prof["settings"])
print(json.dumps({"path": rec["path"], "headers": rec["headers"], "content_type": rec["content_type"], "event_part": rec["event_part"]}, sort_keys=True))
print(json.dumps(ev, sort_keys=True, indent=1))
