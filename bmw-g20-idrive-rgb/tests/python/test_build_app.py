"""The release build's own checks: what scripts/build_app.py refuses, and that it refuses it.

The archive checks run on small synthetic packages (no kit, no SDK needed). When real packages are in dist/
(python scripts/build_app.py was run), they are checked too, and tampered copies of them must fail.
"""
import gzip
import importlib.util
import io
import json
import os
import shutil
import sys
import tarfile
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec_ = importlib.util.spec_from_file_location("build_app", os.path.join(ROOT, "scripts", "build_app.py"))
build_app = importlib.util.module_from_spec(spec_)
spec_.loader.exec_module(build_app)

SPEC = json.load(open(os.path.join(ROOT, "app", "ambient_rgb", "app.json"), encoding="utf-8"))
IDENT = "%s@%s" % (SPEC["id"], SPEC["version"])
TGZ = os.path.join(ROOT, "dist", IDENT + ".tgz")
MGU = os.path.join(ROOT, "dist", IDENT + ".mgu")
HAVE = os.path.isfile(TGZ) and os.path.isfile(MGU)


def rewrite(src, dst, change):
    """Copy a .tgz / .mgu member by member; change(name, data) -> data, or None to drop; extra members via change('+')."""
    with tarfile.open(src, "r:gz") as tin, gzip.GzipFile(dst, "wb", mtime=0) as gz, tarfile.open(fileobj=gz, mode="w") as tout:
        for m in tin.getmembers():
            data = tin.extractfile(m).read() if m.isfile() else None
            if data is not None:
                data = change(m.name, data)
                if data is None:
                    continue
                m.size = len(data)
            tout.addfile(m, io.BytesIO(data) if data is not None else None)
        for name, data in (change("+", b"") or {}).items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tout.addfile(info, io.BytesIO(data))


class RealSdk(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ambient-kit-")
        self.kit = build_app.KIT
        build_app.KIT = self.tmp

    def tearDown(self):
        build_app.KIT = self.kit
        shutil.rmtree(self.tmp, ignore_errors=True)

    def sdk(self, index, version):
        d = os.path.join(self.tmp, "oap-sdk")
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, "index.js"), "w", encoding="utf-8").write(index)
        json.dump({"name": "oap-sdk", "version": version}, open(os.path.join(d, "package.json"), "w", encoding="utf-8"))

    def test_no_sdk_is_not_a_real_sdk(self):
        self.assertIsNone(build_app.real_sdk())

    def test_a_placeholder_or_stub_is_not_a_real_sdk(self):
        self.sdk("throw new Error('PLACEHOLDER oap-sdk');\n", "0.0.0-placeholder")
        self.assertIsNone(build_app.real_sdk())
        self.sdk("", "0.0.0")
        self.assertIsNone(build_app.real_sdk())
        self.sdk("// OnlineApp\n", "24.10.2")                       # right words, a few bytes
        self.assertIsNone(build_app.real_sdk())

    def test_a_bundle_sized_sdk_with_the_app_class_counts(self):
        self.sdk("exports.OnlineApp = 1;\n" + "/* x */\n" * 20000, "24.10.2")
        self.assertEqual(build_app.real_sdk(), "24.10.2")

    def test_a_build_without_the_sdk_stops_with_the_steps_and_builds_nothing(self):
        os.makedirs(os.path.join(self.tmp, "kit", "tools"))
        open(os.path.join(self.tmp, "kit", "tools", "build.py"), "w", encoding="utf-8").write("# mguAppStartType\n")
        with self.assertRaises(SystemExit) as cm:
            build_app.kit_build(SPEC, ci=False)
        msg = str(cm.exception)
        self.assertIn("oap-sdk is missing", msg)
        self.assertIn("nothing was built", msg)
        self.assertIn("extract_sdk.js", msg)
        self.assertIn("YOUR OWN head unit", msg)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "oap-sdk")), "no stand-in is left behind")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "apps")))

    def test_an_old_kit_without_background_start_is_refused(self):
        os.makedirs(os.path.join(self.tmp, "kit", "tools"))
        open(os.path.join(self.tmp, "kit", "tools", "build.py"), "w", encoding="utf-8").write("# old\n")
        with self.assertRaises(SystemExit) as cm:
            build_app.kit_build(SPEC, ci=True)
        self.assertIn("too old", str(cm.exception))


@unittest.skipUnless(HAVE, "no packages in dist/: run python scripts/build_app.py first")
class Packages(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ambient-pkg-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def bad(self, change_tgz=None, change_mgu=None):
        t, m = os.path.join(self.tmp, IDENT + ".tgz"), os.path.join(self.tmp, IDENT + ".mgu")
        rewrite(TGZ, t, change_tgz or (lambda n, d: d))
        rewrite(MGU, m, change_mgu or (lambda n, d: d))
        return build_app.check(t, m, SPEC)

    def test_the_built_packages_pass(self):
        self.assertEqual(build_app.check(TGZ, MGU, SPEC), [])
        self.assertEqual(self.bad(), [], "a plain copy passes too")

    def test_identity_and_metadata(self):
        with tarfile.open(TGZ, "r:gz") as tf:
            pkg = json.loads(tf.extractfile("package/package.json").read())
            names = tf.getnames()
        self.assertEqual(pkg["name"], "ambient_rgb")
        self.assertEqual(pkg["version"], SPEC["version"])
        self.assertEqual(pkg["mguHmi"], ["ID7"])
        self.assertEqual(pkg["mguAppStartType"], "autostart")
        self.assertEqual(pkg["main"], "javascript/app.js")
        self.assertIn("package/javascript/app.js", names)
        self.assertIn("package/javascript/lighting_service.js", names)
        self.assertIn("package/javascript/lighting_overlay.js", names)
        self.assertIn("package/javascript/car_signals.js", names)
        self.assertFalse([n for n in names if "oap-sdk" in n or "node_modules" in n])
        with tarfile.open(MGU, "r:gz") as tf:
            names = tf.getnames()
            meta = json.loads(tf.extractfile("meta.json").read())
        self.assertEqual((meta["id"], meta["version"], meta["title"]), ("ambient_rgb", SPEC["version"], "Ambient RGB"))
        self.assertFalse([n for n in names if "oap-sdk" in n or "node_modules" in n])
        self.assertTrue(any(n.startswith("oapgen/") for n in names))

    def test_an_sdk_inside_is_refused(self):
        add = lambda n, d: ({"package/node_modules/oap-sdk/index.js": b"x"} if n == "+" else d)
        self.assertTrue(any("SDK must not be in a release" in b for b in self.bad(change_tgz=add)))
        add = lambda n, d: ({"source/node_modules/oap-sdk/index.js": b"x"} if n == "+" else d)
        self.assertTrue(any("SDK must not be in a release" in b for b in self.bad(change_mgu=add)))

    def test_a_missing_or_changed_app_module_is_refused(self):
        drop = lambda n, d: (None if n == "package/javascript/lighting_service.js" else d)
        self.assertTrue(any("lighting_service.js is missing" in b for b in self.bad(change_tgz=drop)))
        edit = lambda n, d: (d + b"\n// changed\n" if n == "package/javascript/oem_lighting.js" else d)
        self.assertTrue(any("oem_lighting.js differs" in b for b in self.bad(change_tgz=edit)))

    def test_wrong_version_hmi_start_type_or_entry_point_is_refused(self):
        def pkg(edit):
            def change(n, d):
                if n != "package/package.json":
                    return d
                j = json.loads(d)
                edit(j)
                return json.dumps(j).encode()
            return change
        self.assertTrue(any("version" in b for b in self.bad(change_tgz=pkg(lambda j: j.update(version="9.9.9")))))
        self.assertTrue(any("mguHmi" in b for b in self.bad(change_tgz=pkg(lambda j: j.pop("mguHmi")))))
        self.assertTrue(any("mguHmi" in b for b in self.bad(change_tgz=pkg(lambda j: j.update(mguHmi=["ID8"])))))
        self.assertTrue(any("mguAppStartType" in b for b in self.bad(change_tgz=pkg(lambda j: j.pop("mguAppStartType")))))
        drop = lambda n, d: (None if n == "package/javascript/app.js" else d)
        self.assertTrue(any("javascript/app.js is missing" in b for b in self.bad(change_tgz=drop)))

    def test_a_setter_in_the_manifest_request_is_refused(self):
        spec = json.loads(json.dumps(SPEC))
        spec["signals"]["de.bmw.body.interiorillumination.AmbientLight"]["ambientLightActive"] = "rsw"
        self.assertTrue(any("asks for write access" in b for b in build_app.check(TGZ, MGU, spec)))

    def test_no_lighting_or_car_interface_is_asked_for_write_access(self):
        for iface, fields in SPEC["signals"].items():
            for name, mode in fields.items():
                if not name.startswith("_") and isinstance(mode, str):
                    self.assertNotIn("w", mode, "%s.%s" % (iface, name))

    def test_the_packed_entry_point_loads_and_starts_safe(self):
        self.assertEqual(build_app.load_check(TGZ), [])


if __name__ == "__main__":
    unittest.main()
