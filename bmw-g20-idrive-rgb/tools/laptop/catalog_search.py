#!/usr/bin/env python3
"""catalog_search.py - search a copy of the head unit's SOME/IP master catalog for lighting interfaces.

The catalog lives on the MGU at /etc/oap/someip/someip-interfaces.json (idrive7-apps README 4.2) and is
never published. Copy it off your own unit (scp over the root SSH the idrive7-8-ssh-root tool enables)
and run:

    python catalog_search.py someip-interfaces.json [--out lighting-interfaces.json] [--terms ambient,light,...]

It prints every interface, field, method, event / broadcast, datatype and enum item whose NAME contains
one of the terms, with the data types expanded the way idrive7-apps kit/tools/sigdoc.py does, and writes
a JSON extract you can share. This is what decides whether a native SOME/IP lighting path exists
(Approach 1 in ARCHITECTURE.md); until it finds a writable colour field, that approach is "unknown".
"""
import argparse
import json
import re
import sys

DEFAULT_TERMS = ["ambient", "ambien", "light", "licht", "leucht", "illum", "colour", "color", "farb", "rgb", "led", "innen", "interior", "lci", "lic_", "dimm", "bright", "hellig"]


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def expand(db, ref, depth=0):
    d = db.get("datatypes", {}).get(ref)
    if not d:
        return ref
    t = d.get("type")
    if t == "struct":
        mem = []
        dd = d
        while True:
            mem = dd.get("members", []) + mem
            if not dd.get("extends"):
                break
            dd = db["datatypes"][dd["extends"]]
        if depth > 2:
            return "struct"
        return "{" + ", ".join(m["name"] + ":" + expand(db, m["dataRef"], depth + 1) for m in mem) + "}"
    if t == "enum":
        items = list(d.get("items", {}).items())
        return "enum(" + ",".join("%s=%s" % (k, v) for k, v in items[:12]) + (",.." if len(items) > 12 else "") + ")"
    if t == "typedef":
        return expand(db, d.get("dataRef", d.get("baseType", "?")), depth)
    if t == "array":
        return "[" + expand(db, d.get("elementDataRef", "?"), depth + 1) + "]"
    return t or ref


def search(db, terms):
    pat = re.compile("|".join(re.escape(t) for t in terms), re.I)
    hits = {"interfaces": [], "members": [], "datatypes": []}
    for name, iface in sorted(db.get("interfaces", {}).items()):
        if pat.search(name):
            hits["interfaces"].append({"interface": name, "serviceId": iface.get("serviceId"), "instance": db.get("instanceIDs", {}).get(name),
                                       "fields": list((iface.get("fields") or {}).keys()), "methods": list((iface.get("methods") or {}).keys()),
                                       "events": list((iface.get("events") or {}).keys()) + list((iface.get("broadcasts") or {}).keys())})
        for kind in ("fields", "methods", "events", "broadcasts"):
            for mname, m in (iface.get(kind) or {}).items():
                if pat.search(mname):
                    entry = {"interface": name, "kind": kind, "name": mname}
                    if kind == "fields":
                        entry["getter"] = bool((m.get("getter") or {}).get("id") or m.get("getter"))
                        entry["setter"] = bool((m.get("setter") or {}).get("id") or m.get("setter"))
                        entry["notifier"] = bool(m.get("notifier"))
                        entry["type"] = expand(db, m.get("dataRef", "?"))
                    else:
                        entry["in"] = [expand(db, a.get("dataRef", "?")) for a in (m.get("inArgs") or m.get("in") or [])]
                        entry["out"] = [expand(db, a.get("dataRef", "?")) for a in (m.get("outArgs") or m.get("out") or [])]
                    hits["members"].append(entry)
    for name, d in sorted(db.get("datatypes", {}).items()):
        s = json.dumps(d)
        if pat.search(name) or (d.get("type") == "enum" and pat.search(s)):
            hits["datatypes"].append({"name": name, "type": d.get("type"), "expanded": expand(db, name)})
    return hits


def main(argv=None):
    ap = argparse.ArgumentParser(description="search someip-interfaces.json for lighting interfaces")
    ap.add_argument("catalog")
    ap.add_argument("--out", default="lighting-interfaces.json")
    ap.add_argument("--terms", default=",".join(DEFAULT_TERMS))
    args = ap.parse_args(argv)
    db = load(args.catalog)
    terms = [t for t in args.terms.split(",") if t]
    hits = search(db, terms)
    print("catalog: %d interfaces, %d datatypes" % (len(db.get("interfaces", {})), len(db.get("datatypes", {}))))
    print("interfaces matching: %d" % len(hits["interfaces"]))
    for h in hits["interfaces"]:
        print("  %s  svc %s  inst %s  fields %d  methods %d" % (h["interface"], h["serviceId"], h["instance"], len(h["fields"]), len(h["methods"])))
    print("members matching: %d" % len(hits["members"]))
    for m in hits["members"]:
        flags = ""
        if m["kind"] == "fields":
            flags = " [%s%s%s]" % ("get " if m["getter"] else "", "SET " if m["setter"] else "", "notify" if m["notifier"] else "")
        print("  %s . %s (%s)%s %s" % (m["interface"], m["name"], m["kind"], flags, m.get("type") or (m.get("in"), m.get("out"))))
    print("datatypes matching: %d" % len(hits["datatypes"]))
    for d in hits["datatypes"][:60]:
        print("  %s %s %s" % (d["name"], d["type"], d["expanded"][:200]))
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"terms": terms, "hits": hits}, f, indent=1)
    print("written " + args.out)
    writable = [m for m in hits["members"] if m["kind"] == "fields" and m.get("setter")]
    print("\nwritable fields among the hits: %d%s" % (len(writable), "" if writable else " (no SOME/IP lighting setter found: Approach 1 stays unknown)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
