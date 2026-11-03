import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "..", "tools", "laptop"))
import catalog_search  # noqa: E402

CATALOG = {
    "interfaces": {
        "de.bmw.infotainment.vehicle.CDS": {"serviceId": 1, "fields": {"statusEngineSpeed2": {"getter": {"id": 1}, "notifier": {"id": 2}, "dataRef": "T_Rpm"}}},
        "de.bmw.body.fake.InteriorLightTest": {"serviceId": 2, "fields": {"ambientColour": {"getter": {"id": 3}, "setter": {"id": 4}, "dataRef": "T_Colour"}},
                                                "methods": {"setBrightness": {"inArgs": [{"dataRef": "T_U8"}]}}},
    },
    "instanceIDs": {"de.bmw.body.fake.InteriorLightTest": "1"},
    "datatypes": {
        "T_Rpm": {"type": "uint16"}, "T_U8": {"type": "uint8"},
        "T_Colour": {"type": "struct", "members": [{"name": "red", "dataRef": "T_U8"}, {"name": "green", "dataRef": "T_U8"}, {"name": "blue", "dataRef": "T_U8"}]},
        "E_LightMode": {"type": "enum", "items": {"OFF": 0, "AMBIENT": 1}},
    },
}


class CatalogSearchTests(unittest.TestCase):
    def test_finds_interfaces_members_and_datatypes(self):
        hits = catalog_search.search(CATALOG, catalog_search.DEFAULT_TERMS)
        self.assertEqual([h["interface"] for h in hits["interfaces"]], ["de.bmw.body.fake.InteriorLightTest"])
        names = [(m["name"], m["kind"]) for m in hits["members"]]
        self.assertIn(("ambientColour", "fields"), names)
        self.assertIn(("setBrightness", "methods"), names)
        field = [m for m in hits["members"] if m["name"] == "ambientColour"][0]
        self.assertTrue(field["setter"])
        self.assertEqual(field["type"], "{red:uint8, green:uint8, blue:uint8}")
        self.assertIn("E_LightMode", [d["name"] for d in hits["datatypes"]])
        self.assertIn("T_Colour", [d["name"] for d in hits["datatypes"]])

    def test_cli_writes_extract(self):
        with tempfile.TemporaryDirectory() as d:
            cat = os.path.join(d, "someip-interfaces.json")
            with open(cat, "w", encoding="utf-8") as f:
                json.dump(CATALOG, f)
            out = os.path.join(d, "hits.json")
            self.assertEqual(catalog_search.main([cat, "--out", out]), 0)
            with open(out, encoding="utf-8") as f:
                j = json.load(f)
            self.assertEqual(len(j["hits"]["interfaces"]), 1)


if __name__ == "__main__":
    unittest.main()
