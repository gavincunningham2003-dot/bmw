# TESTS.md

Everything runs on the laptop; no car, no SDK, no renderer. The Node tests use the MGU App Kit's real
runtime (recorder, gauges, themes, sheet, diag) staged from `../research/cauliflowermossgrape_idrive7-apps`.

```
npm test                 # node scripts/stage.js && node tests/node/run_all.js
npm run test:py          # python -m unittest discover -s tests/python -p "test_*.py" -v
npm run preview          # PNGs of the pages in preview/ (docs/screens/ holds a copy)
```

## Node (68 tests, all passing)

| File | Covers |
|---|---|
| `test_colour.js` (10) | RGB↔HSV round trips, primaries, hex parsing, the FF→FE coding rule, the wheel's angle convention (hue 0 at 12 o'clock, clockwise: the kit's arc convention), `wheelPos` ↔ `wheelHit`, the RGBA wheel, the vector wheel rasterising, nudging, luma |
| `test_protocol.js` (10) | the exact `2E DA5E` bytes and their order, bus 1/2 brightness caps, NAD range, every decoder (reply, SGBD index, LIN 1/2 status, PWM, FASTA, SVK), and the **allow list** (`checkRequest`): what may leave and what may not |
| `test_controller.js` (23) | on the mock BDC with fake timers: probing, no writes before Apply, every slave written with ZEIT, **keep-alive before ZEIT lapses**, **fall-back to OEM after ZEIT without the app (reversibility)**, coalescing of bursts, Restore OEM, auto-off after N refusals, skipping a refusing slave, extended-session retry and S3 lapse, busy, **timeouts**, **offline BDC**, **link loss mid-session and reconnection**, **restart behaviour**, variant gates, status snapshot, shutdown, allow list on every byte |
| `test_bdc_uds.js` (12) | the real `kit/diag.js` on a faked TASU bus routed into the mock BDC with another app's DME frames mixed in: probe, **disarmed = dry runs only**, armed bytes, ZEIT cap, **unknown variant refused**, no slaves refused, `10 03` retry, transport away/back, loss mid-session, timeout, the gate against forged `14/2E coding/31/2F/10 02`, every byte of a session allowed |
| `test_favourites.js` (4) | add/has/remove/persist/reload, MAX, damaged file, in-memory |
| `test_ui.js` (9) | `main.js` through the harness: pages and targets, wheel and slider taps, Apply/Restore through on-page buttons and HMI bar buttons, live nudge while custom is on, favourites save/pick/delete, diagnostics page and probe, the iDrive knob (turn, press, grab follows page and setting), switching the link to the car without a transport, settings feeding the controller |

## Python (24 tests, all passing)

| File | Covers |
|---|---|
| `test_hsfz.py` | HSFZ framing round trip, bad lengths, partial buffers, discovery reply parsing |
| `test_uds.py` | request building, replies, multi-DID split, every decoder, the DID/location tables matching the app |
| `test_policy_redact.py` | the read-only policy (0x22 only, functional only `22 F1 50`), VIN/serial/key/token redaction |
| `test_scan_sim.py` | a full scan against the loopback simulated car (TCP + UDP): units, BDC identification, light reads (the car's 10-byte records, the two-bus layout), the `analysis` verdict, **the simulated car saw nothing but 0x22**, the written report is redacted (VIN/serial not even as hex), a legacy variant is "not ready", a "pending" reply is waited for and late frames are not misattributed, busy is retried, unreachable gateway reported not raised, the CLI self-test |
| `test_catalog_search.py` | the SOME/IP catalog search on a synthetic catalog, writable-field detection, the CLI extract |

## Results (last run on the development laptop, 2026-11-04)

```
TOTAL: 68 passed, 0 failed            (node tests/node/run_all.js)
Ran 24 tests ... OK                   (python -m unittest discover -s tests/python)
```

## On the car (read-only, 2026-11-04)

Two read-only sessions over ENET (PROTOCOL_FINDINGS.md §0): the BDC variant, the 19-module layout and
the colour read-back are **verified**; the decoders now carry the car's own record formats, and the mock
BDC and the loopback simulator can be started with that layout (`G20_SLAVES`, `G20_BUS1/2`). The first
session also exposed two tool bugs (pending not waited for, late reply misattributed) that are fixed and
covered by tests.

## What the tests do not cover

- The real TASU service and the real BDC: the byte order inside `DA5E`, the NAD numbering, session or
  security needs, and the visual effect are ASSUMED/UNKNOWN (PROTOCOL_FINDINGS.md) until the car tests
  in NEXT_STEPS.md.
- The kit's GPU renderer and the HMI: the harness fakes the head unit (the kit's `hu-stub.js` and the
  live emulator `kit/tools/emu.js` can run the staged app for a visual check; the emulator answers no
  diagnostics, so the mock link is what it shows).
- Real ENET hardware: the simulator speaks the same framing on loopback.

## Manual checks done

- `python scripts/build_app.py`: the kit's own `build.py` built `dist/ambient_rgb@0.1.0.mgu` (827 KiB,
  screens MAIN + SETTINGS with 11 states) from `app.json`, with a placeholder SDK (not installable).
- `npm run preview`: the seven PNGs in `docs/screens/` were inspected (wheel, slider, swatch, status
  pills, library chips, favourites, diagnostics).
