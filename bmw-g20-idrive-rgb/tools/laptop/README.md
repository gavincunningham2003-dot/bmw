# enetdiag: read-only ENET discovery for the laptop

Finds the car's diagnostic gateway over the ENET cable, lists the control units, identifies the MGU
and the body controller (BDC), reads the BDC's documented interior-light identifiers, and writes a
**redacted JSON report + a log** for analysis. It sends **UDS 0x22 ReadDataByIdentifier only**; the
policy (`enetdiag/policy.py`) refuses any other service before it reaches the socket, and the self-test
asserts that the simulated car saw nothing but 0x22.

Standard library only (Python 3.9+). Windows: run the terminal **as Administrator** so the link-local
`169.254.x.x` address of the USB-C Ethernet adapter is used (the ENET gateway sits on 169.254.x.x).

```
cd tools\laptop
python -m enetdiag selftest                 # the whole scan against a simulated car on 127.0.0.1
python -m enetdiag discover                 # cable in, ignition on: finds the gateway (UDP 6811)
python -m enetdiag scan --out out           # the discovery; writes out\enetdiag-<time>.json and .log
python -m enetdiag lights --gateway 169.254.x.y --out out              # only the BDC's five light identifiers, decoded
python -m enetdiag read --gateway 169.254.x.y --target 40 --did DA5F    # one identifier
python catalog_search.py someip-interfaces.json                         # the MGU's SOME/IP catalog, copied off the unit
```

`run_discovery.ps1` does `selftest` then `scan` and opens the output folder.

What the scan reads (all 0x22):

| Unit | Identifiers |
|---|---|
| all (0xDF, functional) | F150 SGBD index: which units exist and what type they are |
| gateway 0x10, MGU 0x63, BDC body 0x40 | F150, F101 (SVK: HWEL/BTLD/SWFL/CAFD versions), F190 (VIN, redacted), F18C (serial, hashed), F191, F195 |
| MGU 0x63 | 172A (its IP configuration, as idrive7-8-ssh-root reads it) |
| BDC 0x40 | DA5F (LIN layering slaves, bus 1), E3D1 (bus 2), both with per-module RGB / brightness / fault read-back, 4800 (interior-light PWM), 2300 (FASTA ambient statistics), D5D3 (ambient status, G11 variant). The LIN reads answer "pending" first and take seconds; the tool waits and retries "busy". |

The report's `analysis` block says whether the BDC is a variant whose SGBD documents the RGB layering
actuator (`2E DA5E`) and how many RGB LIN slaves answered, and names the next step. The VIN and serial
numbers are redacted in the JSON and the log, including inside the raw hex of the exchanges. Review
the log before sharing it anyway.
