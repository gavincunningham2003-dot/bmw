#!/usr/bin/env python3
"""build_app.py - build the installable package with the MGU App Kit's own build (kit/tools/build.py).

    python scripts/build_app.py            # -> dist/ambient_rgb@<version>.mgu and .tgz

It copies app/ambient_rgb into the kit checkout (research/cauliflowermossgrape_idrive7-apps/apps/ambient_rgb),
runs the kit's build.py there and copies the result back to dist/. The build needs BMW's oap-sdk, which is
not redistributable: extract it from your own head unit (INSTALLATION.md, kit/tools/extract_sdk.js) into
<kit>/oap-sdk/. Without it this script drops in a PLACEHOLDER so the RHMI layout, manifest and permissions
can still be generated and checked; such a package is marked dist/PLACEHOLDER_SDK.txt and must not be
installed on a car (the Store's "Releases" layout wants no SDK inside anyway: it generates one on the unit).
"""
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIT = os.environ.get("IDRIVE7_APPS") or os.path.join(ROOT, "..", "research", "cauliflowermossgrape_idrive7-apps")
APP = os.path.join(ROOT, "app", "ambient_rgb")
DIST = os.path.join(ROOT, "dist")


def main():
    if not os.path.isdir(os.path.join(KIT, "kit", "tools")):
        sys.exit("kit not found at %s (clone cauliflowermossgrape/idrive7-apps into research/ or set IDRIVE7_APPS)" % KIT)
    spec = json.load(open(os.path.join(APP, "app.json"), encoding="utf-8"))
    target = os.path.join(KIT, "apps", spec["id"])
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(APP, target)
    sdk = os.path.join(KIT, "oap-sdk")
    placeholder = False
    if not os.path.isfile(os.path.join(sdk, "index.js")):
        placeholder = True
        os.makedirs(sdk, exist_ok=True)
        with open(os.path.join(sdk, "index.js"), "w", encoding="utf-8") as f:
            f.write("throw new Error('PLACEHOLDER oap-sdk: extract the real SDK from your head unit (INSTALLATION.md)');\n")
        with open(os.path.join(sdk, "package.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "oap-sdk", "version": "0.0.0-placeholder", "main": "index.js"}, f)
        print("WARNING: no oap-sdk in the kit: building with a placeholder (not installable)")
    # the kit's build copies kit/runtime into the package: apply this app's one runtime change there first (scripts/kit_patch.js)
    r = subprocess.run(["node", os.path.join(ROOT, "scripts", "kit_patch.js"), os.path.join(KIT, "kit", "runtime", "display.js")])
    if r.returncode:
        sys.exit("kit patch failed")
    r = subprocess.run([sys.executable, os.path.join("kit", "tools", "build.py"), spec["id"]], cwd=KIT)
    if r.returncode:
        sys.exit("build failed")
    os.makedirs(DIST, exist_ok=True)
    out = []
    for f in os.listdir(os.path.join(KIT, "dist")):
        if f.startswith(spec["id"] + "@") and (f.endswith(".mgu") or f.endswith(".tgz")):
            shutil.copy(os.path.join(KIT, "dist", f), os.path.join(DIST, f))
            out.append(f)
    stage = os.path.join(KIT, "dist", spec["id"])
    if os.path.isdir(stage):
        shutil.rmtree(os.path.join(DIST, spec["id"]), ignore_errors=True)
        shutil.copytree(stage, os.path.join(DIST, spec["id"]))
    marker = os.path.join(DIST, "PLACEHOLDER_SDK.txt")
    if placeholder:
        with open(marker, "w", encoding="utf-8") as f:
            f.write("These packages were built with a placeholder oap-sdk. Do not install them on a car.\n")
    elif os.path.exists(marker):
        os.remove(marker)
    print("built: " + ", ".join(out) + (" (PLACEHOLDER SDK, not installable)" if placeholder else ""))


if __name__ == "__main__":
    main()
