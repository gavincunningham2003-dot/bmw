#!/usr/bin/env python3
"""build_app.py - build the release packages MGU Store installs (its "Releases" layout, docs/PUBLISHING.md).

    python scripts/build_app.py              # -> dist/ambient_rgb@<version>.tgz and .mgu, checked
    python scripts/build_app.py --check      # check the packages already in dist/ again, build nothing
    python scripts/build_app.py --ci         # GitHub Actions only: see "The SDK" below

What it does, in order:
  1. copies app/ambient_rgb into the MGU App Kit checkout and runs the kit's own build (kit/tools/build.py): that
     generates the package.json, the SOME/IP manifest, the permissions, the RHMI resources (uiDescriptions,
     texts, icon) and copies the kit runtime beside the app's modules;
  2. takes the kit's staged tree and makes the RELEASE tree from it:
       - node_modules/oap-sdk is REMOVED. BMW's oap-sdk is not redistributable and the Store wants none in a
         package: the head unit generates the module from a BMW app already on it when the package calls
         require('oap-sdk') (PUBLISHING.md, "Leave out node_modules/oap-sdk");
       - package.json gets "mguHmi": ["ID7"] (iDrive 7 only; the Store refuses it on an iDrive 8 unit);
       - kit/display.js gets this app's one runtime change (scripts/kit_patch.js: the knob to the app while it
         holds the controller grab);
  3. packs <id>@<version>.tgz (the package under package/, as npm pack) and <id>@<version>.mgu (meta.json, source/,
     rhmiData/, oapgen/), with fixed times and owners so the same sources give the same bytes;
  4. CHECKS both archives (structure, identity, entry point, every app module byte for byte, no SDK inside) and
     loads the packed entry point in Node (scripts/check_package.js);
  5. writes dist/BUILD.json (what was built from what, sizes, SHA-256), dist/mgu-store.json and dist/ambient_rgb.png
     (the Store's title, description and icon for a release).

The SDK. The kit's build copies <kit>/oap-sdk into the package, so it insists on one. This script therefore STOPS
when the real SDK is not there, and says how to get it from your own head unit; it never invents one. The release
packages do not contain it either way (step 2), which --ci relies on: a build machine can never have BMW's SDK, so
--ci gives the kit's copy step an empty stand-in that step 2 removes again, and step 4 proves nothing of it is
left. A --ci build and a local build of the same sources are the same bytes (BUILD.json's SHA-256 says so).
Nothing this script writes is ever labelled installable without having passed step 4.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIT = os.path.abspath(os.environ.get("IDRIVE7_APPS") or os.path.join(ROOT, "..", "research", "cauliflowermossgrape_idrive7-apps"))
APP = os.path.join(ROOT, "app", "ambient_rgb")
DIST = os.path.join(ROOT, "dist")
WORK = os.path.join(ROOT, "build", "release")
HMI = ["ID7"]
SDK_STEPS = """
The MGU App Kit's build needs BMW's oap-sdk, taken from an app on YOUR OWN head unit (it is not redistributable
and is in no repository). To get it:

  1. On the head unit (root SSH, see INSTALLATION.md), any BMW app carries it; x_call is always there:
         /var/opt/public/oap/oap_12204/source/javascript/app.js
     or  /usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz      (javascript/app.js inside the archive)
  2. Copy that one file to the laptop (run in PowerShell, on the car's network):
         scp root@<head unit address>:/var/opt/public/oap/oap_12204/source/javascript/app.js .\\x_call_app.js
  3. Extract the SDK into the kit checkout:
         node "%s" .\\x_call_app.js "%s"
  4. Run this script again.

The packages this script publishes do NOT contain the SDK (the Store generates it on the head unit).
""" % (os.path.join(KIT, "kit", "tools", "extract_sdk.js"), os.path.join(KIT, "oap-sdk"))


def die(msg):
    sys.exit("build_app: " + msg)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git(cwd, *args):
    try:
        return subprocess.run(["git"] + list(args), cwd=cwd, capture_output=True, text=True).stdout.strip()
    except OSError:
        return ""


def real_sdk():
    """The extracted SDK's version, or None when <kit>/oap-sdk is not a real one."""
    sdk = os.path.join(KIT, "oap-sdk")
    index, pkg = os.path.join(sdk, "index.js"), os.path.join(sdk, "package.json")
    if not (os.path.isfile(index) and os.path.isfile(pkg)):
        return None
    try:
        with open(pkg, encoding="utf-8") as f:
            version = json.load(f).get("version", "")
    except ValueError:
        return None
    # a stand-in is a few bytes; the real bundle is about a megabyte and defines the app class
    if "placeholder" in version or os.path.getsize(index) < 100000:
        return None
    with open(index, encoding="utf-8", errors="replace") as f:
        head = f.read()
    return version if "OnlineApp" in head else None


def kit_build(spec, ci):
    """Run the kit's build for this app; returns the kit's staged tree (dist/<id>)."""
    if not os.path.isfile(os.path.join(KIT, "kit", "tools", "build.py")):
        die("the MGU App Kit is not at %s\n  git clone https://github.com/cauliflowermossgrape/idrive7-apps \"%s\"\n  (or set IDRIVE7_APPS to a checkout)" % (KIT, KIT))
    with open(os.path.join(KIT, "kit", "tools", "build.py"), encoding="utf-8") as f:
        build_py = f.read()
    if "mguAppStartType" not in build_py:
        die("the MGU App Kit at %s is too old for a background (autostart) app: update it\n  git -C \"%s\" pull --ff-only" % (KIT, KIT))
    sdk_dir = os.path.join(KIT, "oap-sdk")
    version = real_sdk()
    stand_in = False
    if version is None:
        if not ci:
            die("BMW's oap-sdk is missing from %s: nothing was built.\n%s" % (sdk_dir, SDK_STEPS))
        if os.path.exists(sdk_dir) and os.listdir(sdk_dir):
            die("--ci: %s exists but is not a real SDK; remove it first" % sdk_dir)
        # --ci: an EMPTY stand-in for the kit's copy step only; removed from the tree in release_tree() and from disk below
        os.makedirs(sdk_dir, exist_ok=True)
        open(os.path.join(sdk_dir, "index.js"), "w", encoding="utf-8").write("")
        json.dump({"name": "oap-sdk", "version": "0.0.0"}, open(os.path.join(sdk_dir, "package.json"), "w", encoding="utf-8"))
        stand_in = True
    target = os.path.join(KIT, "apps", spec["id"])
    try:
        shutil.rmtree(target, ignore_errors=True)
        shutil.copytree(APP, target)
        r = subprocess.run([sys.executable, os.path.join("kit", "tools", "build.py"), spec["id"]], cwd=KIT)
        if r.returncode:
            die("the kit's build failed (see its output above)")
    finally:
        if stand_in:
            shutil.rmtree(sdk_dir, ignore_errors=True)
    stage = os.path.join(KIT, "dist", spec["id"])
    if not os.path.isfile(os.path.join(stage, "source", "package.json")):
        die("the kit's build left no staged tree at " + stage)
    return stage, version


def release_tree(stage, spec):
    """The kit's staged tree -> build/release/<id>: no SDK, mguHmi, this app's kit patch."""
    out = os.path.join(WORK, spec["id"])
    shutil.rmtree(WORK, ignore_errors=True)
    shutil.copytree(stage, out)
    src = os.path.join(out, "source")
    shutil.rmtree(os.path.join(src, "node_modules"), ignore_errors=True)      # the SDK: never in a release
    pkg_file = os.path.join(src, "package.json")
    pkg = json.load(open(pkg_file, encoding="utf-8"))
    pkg["mguHmi"] = HMI
    json.dump(pkg, open(pkg_file, "w", encoding="utf-8", newline="\n"), indent=2)
    r = subprocess.run(["node", os.path.join(ROOT, "scripts", "kit_patch.js"), os.path.join(src, "javascript", "kit", "display.js")])
    if r.returncode:
        die("the kit runtime patch did not apply (scripts/kit_patch.js): the kit's display.js changed")
    return out


def _flat(info):
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    info.mode = 0o755 if info.isdir() else 0o644
    return info


def pack(tree, spec):
    os.makedirs(DIST, exist_ok=True)
    name = "%s@%s" % (spec["id"], spec["version"])
    for f in os.listdir(DIST):                                  # one version in dist/: no stale package beside the new one
        if re.match(r"^%s@.*\.(tgz|mgu)$" % re.escape(spec["id"]), f):
            os.remove(os.path.join(DIST, f))
    tgz, mgu = os.path.join(DIST, name + ".tgz"), os.path.join(DIST, name + ".mgu")

    def write(path, members):
        with gzip.GzipFile(path, "wb", mtime=0) as gz, tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tf:
            for src, arc in members:
                for root, dirs, files in os.walk(src):
                    dirs.sort()
                    rel = os.path.relpath(root, src).replace(os.sep, "/")
                    base = arc if rel == "." else arc + "/" + rel
                    tf.add(root, arcname=base, recursive=False, filter=_flat)
                    for f in sorted(files):
                        tf.add(os.path.join(root, f), arcname=base + "/" + f, filter=_flat)

    write(tgz, [(os.path.join(tree, "source"), "package")])
    parts = [(os.path.join(tree, n), n) for n in ("source", "rhmiData", "rhmiDataStartWidget", "oapgen") if os.path.isdir(os.path.join(tree, n))]
    # meta.json first, then the folders
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.GNU_FORMAT) as tf:
        tf.add(os.path.join(tree, "meta.json"), arcname="meta.json", filter=_flat)
        for src, arc in parts:
            for root, dirs, files in os.walk(src):
                dirs.sort()
                rel = os.path.relpath(root, src).replace(os.sep, "/")
                base = arc if rel == "." else arc + "/" + rel
                tf.add(root, arcname=base, recursive=False, filter=_flat)
                for f in sorted(files):
                    tf.add(os.path.join(root, f), arcname=base + "/" + f, filter=_flat)
    with gzip.GzipFile(mgu, "wb", mtime=0) as gz:
        gz.write(buf.getvalue())
    return tgz, mgu


def check(tgz, mgu, spec):
    """Every claim made about the packages, checked on the archives themselves. Returns the list of problems."""
    bad = []
    ident = "%s@%s" % (spec["id"], spec["version"])
    if not re.match(r"^\d+\.\d+\.\d+$", spec["version"]):
        bad.append("version %r is not x.y.z" % spec["version"])
    for path, ext in ((tgz, ".tgz"), (mgu, ".mgu")):
        if os.path.basename(path) != ident + ext:
            bad.append("%s is not named %s%s" % (os.path.basename(path), ident, ext))
    app_modules = {("app.js" if f == "main.js" else f): open(os.path.join(APP, f), "rb").read() for f in os.listdir(APP) if f.endswith(".js")}

    def read(tf, name):
        try:
            return tf.extractfile(name).read()
        except (KeyError, AttributeError):
            return None

    def package(tf, prefix, label):
        names = set(tf.getnames())
        for n in names:
            if "oap-sdk" in n or "node_modules" in n:
                bad.append("%s: contains %s (BMW's SDK must not be in a release)" % (label, n))
            if n.startswith("/") or ".." in n.split("/"):
                bad.append("%s: unsafe member path %s" % (label, n))
        raw = read(tf, prefix + "package.json")
        if raw is None:
            bad.append("%s: no %spackage.json" % (label, prefix))
            return
        pkg = json.loads(raw.decode("utf-8"))
        want = {"name": spec["id"], "version": spec["version"], "main": "javascript/app.js", "mguHmi": HMI, "mguAppStartType": "autostart"}
        for k, v in want.items():
            if pkg.get(k) != v:
                bad.append("%s: package.json %s is %r, not %r" % (label, k, pkg.get(k), v))
        if pkg.get("dependencies"):
            bad.append("%s: package.json lists dependencies %r: nothing can be fetched on a head unit" % (label, pkg["dependencies"]))
        settings = pkg.get("oapAppSettings") or {}
        if settings.get("someipManifest") != "manifest.json" or not settings.get("loggingId"):
            bad.append("%s: package.json oapAppSettings incomplete" % label)
        for need in ("javascript/app.js", "manifest.json", "permissions.json", "npm-shrinkwrap.json", "config/base.json",
                     "javascript/kit/mgu.js", "javascript/kit/signals.js", "javascript/kit/diag.js", "javascript/kit/app-spec.json", "javascript/kit/locale.json",
                     "rhmiData/application.json", "rhmiData/uiDescriptions/ID7/application.xml", "rhmiData/uiDescriptions/ID7/uiDescription.json",
                     "rhmiData/variantGroups/Common/texts/en_GB.json", "rhmiData/variantGroups/Common/images/%s_icon.png" % spec["id"]):
            if prefix + need not in names:
                bad.append("%s: %s is missing" % (label, need))
        for f, body in sorted(app_modules.items()):
            got = read(tf, prefix + "javascript/" + f)
            if got is None:
                bad.append("%s: app module %s is missing" % (label, f))
            elif got != body:
                bad.append("%s: app module %s differs from app/ambient_rgb" % (label, f))
        mgu_js = read(tf, prefix + "javascript/kit/mgu.js") or b""
        if b"require('oap-sdk')" not in mgu_js:
            bad.append("%s: nothing requires oap-sdk: the Store would not generate it" % label)
        if b"impl.background" not in mgu_js:
            bad.append("%s: the kit runtime has no background start (kit too old)" % label)
        display = read(tf, prefix + "javascript/kit/display.js") or b""
        if b"ambient_rgb: grab -> onInput" not in display:
            bad.append("%s: kit/display.js lacks this app's controller patch" % label)
        rt = json.loads((read(tf, prefix + "javascript/kit/app-spec.json") or b"{}").decode("utf-8"))
        if rt.get("id") != spec["id"] or rt.get("version") != spec["version"] or len(rt.get("settings") or []) != len(spec["settings"]):
            bad.append("%s: kit/app-spec.json does not match app.json" % label)
        manifest = json.loads((read(tf, prefix + "manifest.json") or b"{}").decode("utf-8"))
        proxies = manifest.get("proxies") or {}
        for iface, fields in spec["signals"].items():
            if iface not in proxies:
                bad.append("%s: manifest.json has no proxy for %s" % (label, iface))
            for field, mode in (fields.items() if isinstance(fields, dict) else []):
                # the lighting and the car's state are read, never written: no setter may be asked for
                if not field.startswith("_") and isinstance(mode, str) and "w" in mode:
                    bad.append("%s: %s.%s asks for write access (%s)" % (label, iface, field, mode))
        app_json = json.loads((read(tf, prefix + "rhmiData/application.json") or b"{}").decode("utf-8")).get("application") or {}
        if app_json.get("name") != spec["id"] or app_json.get("version") != spec["version"]:
            bad.append("%s: rhmiData/application.json is for %r %r" % (label, app_json.get("name"), app_json.get("version")))
        if not any("ID7" in (u.get("hmi") or []) for u in app_json.get("uiDescriptions") or []):
            bad.append("%s: rhmiData has no iDrive 7 UI" % label)
        texts = json.loads((read(tf, prefix + "rhmiData/variantGroups/Common/texts/en_GB.json") or b"{}").decode("utf-8"))
        if spec["title"] not in texts.values():
            bad.append("%s: the title %r is not in the HMI texts" % (label, spec["title"]))

    with tarfile.open(tgz, "r:gz") as tf:
        if any(not n.startswith("package") for n in tf.getnames()):
            bad.append("tgz: a member outside package/")
        package(tf, "package/", "tgz")
    with tarfile.open(mgu, "r:gz") as tf:
        names = tf.getnames()
        meta = json.loads((read(tf, "meta.json") or b"{}").decode("utf-8"))
        if meta.get("id") != spec["id"] or meta.get("version") != spec["version"] or meta.get("title") != spec["title"]:
            bad.append("mgu: meta.json is %r" % meta)
        for need in ("rhmiData/application.json", "rhmiData/uiDescription/application.xml", "oapgen"):
            if not any(n == need or n.startswith(need + "/") for n in names):
                bad.append("mgu: %s is missing" % need)
        package(tf, "source/", "mgu")
    return bad


def catalogue_check(spec):
    """With the head unit's own interface catalogue at hand (never in the repository: it is BMW's file), check every
    signal app.json asks for against it: the interface, the instance, each field and the access asked (r getter,
    s notifier), each method and broadcast. Returns (problems, a line to print); skipped when there is no catalogue."""
    path = os.environ.get("MGU_CATALOGUE") or os.path.join(ROOT, "..", "research", "mgu_sdk_source", "someip-interfaces.json")
    if not os.path.isfile(path):
        return [], "interface catalogue: not checked (no someip-interfaces.json from the head unit at hand)"
    db = json.load(open(path, encoding="utf-8"))
    ifaces, instances = db.get("interfaces") or {}, db.get("instanceIDs") or {}
    bad, n = [], 0
    for iface, fields in spec["signals"].items():
        unit = ifaces.get(iface)
        if not isinstance(unit, dict):
            bad.append("catalogue: no interface %s" % iface)
            continue
        inst = fields.get("_instances", "1")
        known = instances.get(iface)
        if isinstance(known, dict) and str(inst) not in known:
            bad.append("catalogue: %s has no instance %s (has %s)" % (iface, inst, ", ".join(sorted(known))[:80]))
        for name, mode in fields.items():
            if name.startswith("_"):
                continue
            f = (unit.get("fields") or {}).get(name)
            if not isinstance(f, dict):
                bad.append("catalogue: %s has no field %s" % (iface, name))
                continue
            for c, part in (("r", "getter"), ("s", "notifier"), ("w", "setter")):
                if c in mode and part not in f:
                    bad.append("catalogue: %s.%s has no %s (asked %s)" % (iface, name, part, mode))
            n += 1
        for key, part in (("_methods", "methods"), ("_broadcasts", "events")):
            for name in fields.get(key) or []:
                if name not in (unit.get(part) or {}):
                    bad.append("catalogue: %s has no %s %s" % (iface, part[:-1], name))
                n += 1
    return bad, "interface catalogue (this head unit's): %d interfaces, %d fields / methods checked" % (len(spec["signals"]), n)


def load_check(tgz):
    """Unpack the .tgz and load its entry point in Node with a stand-in for the platform (scripts/check_package.js)."""
    out = os.path.join(WORK, "unpacked")
    shutil.rmtree(out, ignore_errors=True)
    with tarfile.open(tgz, "r:gz") as tf:
        try:
            tf.extractall(out, filter="data")
        except TypeError:                                       # Python < 3.12
            tf.extractall(out)
    r = subprocess.run(["node", os.path.join(ROOT, "scripts", "check_package.js"), os.path.join(out, "package")], capture_output=True, text=True)
    if r.returncode:
        return ["entry point: " + (r.stdout + r.stderr).strip()]
    print("  " + r.stdout.strip())
    return []


def store_files(tree, spec):
    """mgu-store.json and the icon: the Store's title, description and icon for a release without installing it."""
    icon_src = os.path.join(tree, "rhmiData", "resources", spec["id"] + "_icon.png")
    icon = os.path.join(DIST, spec["id"] + ".png")
    shutil.copy(icon_src, icon)
    if os.path.getsize(icon) > 128 * 1024:
        die("the icon is over 128 KiB: the Store would not show it")
    meta = {"apps": {spec["id"]: {"title": spec["title"], "description": spec["description"], "author": "Gavin Cunningham",
                                  "icon": os.path.basename(icon), "iconSha256": sha256(icon)}}}
    json.dump(meta, open(os.path.join(DIST, "mgu-store.json"), "w", encoding="utf-8", newline="\n"), indent=2)
    return [os.path.join(DIST, "mgu-store.json"), icon]


def main():
    ap = argparse.ArgumentParser(description="Build and check the MGU Store release packages.")
    ap.add_argument("--check", action="store_true", help="check the packages already in dist/, build nothing")
    ap.add_argument("--ci", action="store_true", help="a build machine without BMW's SDK (GitHub Actions): see the module text")
    args = ap.parse_args()
    spec = json.load(open(os.path.join(APP, "app.json"), encoding="utf-8"))
    ident = "%s@%s" % (spec["id"], spec["version"])
    tgz, mgu = os.path.join(DIST, ident + ".tgz"), os.path.join(DIST, ident + ".mgu")
    sdk_version = None
    extra = []
    if not args.check:
        stage, sdk_version = kit_build(spec, args.ci)
        tree = release_tree(stage, spec)
        tgz, mgu = pack(tree, spec)
        extra = store_files(tree, spec)
    elif not (os.path.isfile(tgz) and os.path.isfile(mgu)):
        die("no %s.tgz / .mgu in dist/: build first" % ident)
    print("checking %s" % ident)
    cat_bad, cat_line = catalogue_check(spec)
    print("  " + cat_line)
    bad = check(tgz, mgu, spec) + cat_bad + load_check(tgz)
    marker = os.path.join(DIST, "BUILD.json")
    if bad:
        # a package that failed its check is not left where it could be taken for a release
        for p in (tgz, mgu, marker):
            if os.path.exists(p) and not args.check:
                os.remove(p)
        die("the packages FAILED their check and were removed:\n  - " + "\n  - ".join(bad))
    info = {
        "id": spec["id"], "version": spec["version"], "title": spec["title"], "mguHmi": HMI, "startType": "autostart",
        "layout": "MGU Store Releases (docs/PUBLISHING.md): no oap-sdk inside, generated on the head unit",
        "sdkInPackages": False,
        "builtWith": {"kit": git(KIT, "rev-parse", "--short", "HEAD") or "unknown", "source": git(ROOT, "rev-parse", "--short", "HEAD") or "unknown",
                      "sourceDirty": bool(git(ROOT, "status", "--porcelain", "--", ".")), "sdkPresentForBuild": sdk_version or ("none (--ci stand-in, removed)" if args.ci else "not rebuilt")},
        "checked": True,
        "files": {os.path.basename(p): {"bytes": os.path.getsize(p), "sha256": sha256(p)} for p in [tgz, mgu] + extra},
    }
    if not args.check:
        json.dump(info, open(marker, "w", encoding="utf-8", newline="\n"), indent=2)
    for name, f in info["files"].items():
        print("  %-28s %8d bytes  sha256 %s" % (name, f["bytes"], f["sha256"]))
    print("OK: %s passed every check (iDrive 7, autostart, no SDK inside): ready for a GitHub release" % ident)


if __name__ == "__main__":
    main()
