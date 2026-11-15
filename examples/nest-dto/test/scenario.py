#!/usr/bin/env python3
"""@Query() dto and @Param() dto: the whole query string / the route's parameters as one object, converted and
validated by the ValidationPipe (transform, implicit conversion), or as they come (strings) without a pipe.
Prints one line per request (status and body); test/expected-*.txt is the output against Nest 11 on Node.
Usage: scenario.py http://127.0.0.1:3198 pipe|plain
  plain (no pipe): only the DTOs of strings (a number field holding a string is Node's, not representable in xisto)"""
import json, sys, urllib.request, urllib.error

BASE = sys.argv[1].rstrip("/")
PIPE = sys.argv[2] == "pipe"

def call(path):
    try:
        r = urllib.request.urlopen(BASE + path)
        status, text = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode()
    try:
        shown = json.dumps(json.loads(text), sort_keys=True, ensure_ascii=False)
    except ValueError:
        shown = repr(text)
    print(f"GET {path} -> {status} {shown}")

if PIPE:
    for q in ["?term=abc", "?term=abc&page=3&size=20&active=true&order=desc", "?term=abc&page=0", "?term=abc&page=x",
              "?term=abc&size=500", "?term=abc&active=false", "?term=abc&order=up", "", "?term=", "?term=a&term=b",
              "?term=caf%C3%A9&page=2", "?term=abc&page=2.5", "?term=abc&page="]:
        call("/dto/list" + q)
    for q in ["?from=1&to=9", "?from=a&to=2", "?from=1"]:
        call("/dto/range" + q)
    for p in ["/7/blue-shoe", "/0/blue-shoe", "/x/blue-shoe", "/7/Blue_Shoe", "/12/caf%C3%A9"]:
        call("/dto/items" + p)
    call("/dto/both/12/red?term=t&page=4")
    call("/dto/both/0/RED?page=4")
for q in ["?term=abc", "?term=abc&lang=pt", "?term=caf%C3%A9&lang=en", "?term=a%20b%2Bc"]:
    call("/dto/text" + q)
for p in ["/doc/intro?term=x", "/faq/a-b?term=y", "/doc/caf%C3%A9?term=z"]:
    call("/dto/pages" + p)
if PIPE:
    for q in ["", "?term=abc&lang=es", "?term="]:
        call("/dto/text" + q)
    for p in ["/blog/intro?term=x", "/doc/Intro?term=x", "/doc/intro"]:
        call("/dto/pages" + p)
