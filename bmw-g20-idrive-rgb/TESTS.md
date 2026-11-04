# TESTS.md

Everything runs on the laptop; no car, no SDK, no renderer. The Node tests use the MGU App Kit's real
runtime (recorder, gauges, themes, sheet, diag) staged from `../research/cauliflowermossgrape_idrive7-apps`.

```
npm test                 # node scripts/stage.js && node tests/node/run_all.js
npm run test:py          # python -m unittest discover -s tests/python -p "test_*.py" -v
npm run preview          # PNGs of the pages in preview/ (docs/screens/ holds a copy)
```

## Node (87 tests, all passing)

| File | Covers |
|---|---|
| `test_colour.js` (10) | RGB↔HSV, hex, the FF→FE coding rule, the wheel's angle convention (0 at 12 o'clock, clockwise), `wheelPos` ↔ `wheelHit`, the vector wheel rasterising, nudging, luma |
| `test_protocol.js` (10) | the exact `2E DA5E` bytes and order, 0xFF never in a colour byte, bus 1/2 caps, every decoder (the car's 10-byte records), the allow list |
| `test_scene.js` (12) | module categories, groups and sides from the real locations; zones (upper/lower with the handle setting, front/rear doors, one module); solid, dual (handles top/bottom/off), zones (later wins), rainbow, fade (holds and glides), breathing (limits, smooth), wave (per-module phase, dashboard leads); normalise, describe, diff, presets round-trip |
| `test_scheduler.js` (10) | one write at a time in order, newest target wins keeping its place, unchanged skipped unless forced, priorities release > apply > frame, **obsolete frames dropped whole**, busy backoff with a newer target winning, rejects reported, drain / clear / pause / resume, latency and writes-per-second stats, **the benchmark** (19 modules at 14 ms: 266 ms per frame sequential; 168 ms if one per bus could overlap), per-bus ordering with maxInFlight 2 |
| `test_controller.js` (17) | on the simulated BDC with fake timers: probe; **nothing written before apply**; solid writes all 19 once then only keep-alives at the right times, never lapsing; dual on the right modules with the handle setting (and the release of the handles when set to off); zones keeping other zones; **restore releases every module and reports exactly** (a refused release is reported, a dead transport is reported); **apply / restore never interleave**, a second apply supersedes; **parking fail-closed** (unknown and moving both refused, nothing written); animated programs tick, pace to the transport, skip unchanged and force stale; breathing then a static apply stops the ticker; busy absorbed, lost link stops control and reconnects on availability without re-applying; every module refusing turns control off; status; every byte allowed and never 0xFF |
| `test_bdc_uds.js` (12) | the real `kit/diag.js` on a faked TASU bus: probe reads; **disarmed = dry runs only**; armed bytes; ZEIT cap; unknown variant refused; no modules refused; `10 03` retry; transport away / back; lost mid-animation; timeout; the gate against forged services; every byte of a session allowed |
| `test_favourites.js` (5) | colours and complete configurations (replace by name, persist, remove) |
| `test_ui.js` (11) | `main.js` through the harness: every page draws; **preview only** (taps on the hue ring and the dial change the draft, zero writes, Apply writes); **the rotary flow** (enter the ring, 10 clicks = 30°, press confirms and applies, enter the dial, turn, tilt left cancels back to the entered value with the car unchanged); the setting off (only Apply applies); Dual (taps, swap, copy, Apply both drives upper and lower differently, handle follows the lower group, save combination); Modes (Rainbow with its speed, Start, Breathing, Restore stops cleanly); zones from the Colours page keep other zones; Favourites (colours and configurations, apply, delete); Cancel discards; Diagnostics; switching the link to the car without a transport refuses Apply |

## Python (24 tests, all passing)

Unchanged by this upgrade: HSFZ framing, UDS decoders (the car's records), the read-only policy and
redaction, scans against the loopback simulated car (pending, busy, two buses), the catalog search.

## Results (last run on the development laptop, 2026-11-05)

```
TOTAL: 87 passed, 0 failed            (node tests/node/run_all.js)
Ran 24 tests ... OK                   (python -m unittest discover -s tests/python)
```

## Verified in simulation vs on the car

| | Simulation | Car |
|---|---|---|
| `2E DA5E` / `E3D1` per-module colour and brightness, release, timeout, no faults | yes | **yes (2026-11-04, over ENET)** |
| Dual colour (upper / lower at once), zones, modes, fades, keep-alive timing, scheduler behaviour, preview/applied separation, rotary flow | yes | not yet: the app has not been installed on the head unit |
| TASU latency and whether it accepts overlapping requests | assumed one at a time (kit evidence) | not measured |
| Brightness values other than 100 | simulated | only 100 (and 0 by the OEM function) seen; the dial's other levels are untested on the car |
| Colour Wave at an acceptable rate | 3.8 frames/s at 14 ms per write in simulation | depends on the head unit's TASU latency |

## Manual checks done

- `python scripts/build_app.py`: the kit's own `build.py` builds `dist/ambient_rgb@0.3.0.mgu` from `app.json`
  (placeholder SDK, not installable).
- `npm run preview`: the eleven PNGs in `docs/screens/` were inspected.
- `npm run emu` (the kit's live emulator, 2026-11-05, on Windows): the app drawn by the car's draw engine with
  the real runtime; taps on the hue ring, the dial's arc, the library chips, the header tabs and Apply; the knob
  entered on the ring's disc, 20 clicks = 60°, press = confirm + apply; tilt left = cancel; the Dual page's two
  wheels and Apply both; the cabin view following the draft. Found and fixed there: the kit never passing knob
  events to the app while it runs the screen (`scripts/kit_patch.js`), the tilt-left code (10/11, not 4/8), the
  whole wheel being a kit target (taps were presses), a held press counting as a confirm.
