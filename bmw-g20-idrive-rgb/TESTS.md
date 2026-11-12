# TESTS.md

Everything runs on the laptop; no car, no SDK, no renderer. The Node tests use the MGU App Kit's real
runtime (recorder, gauges, themes, sheet, diag) staged from `../research/cauliflowermossgrape_idrive7-apps`.

```
npm test                 # node scripts/stage.js && node tests/node/run_all.js
npm run test:py          # python -m unittest discover -s tests/python -p "test_*.py" -v
npm run preview          # PNGs of the pages in preview/ (docs/screens/ holds a copy)
```

## Results, 0.5.0 (2026-11-12, Windows 11, Node 24, Python 3.12, kit `64486c5`)

```
npm test          TOTAL: 166 passed, 0 failed
npm run test:py   Ran 37 tests ... OK
python scripts/build_app.py
                  OK: ambient_rgb@0.5.0 passed every check (iDrive 7, autostart, no SDK inside)
```

New in 0.5.0:

| File | Covers |
|---|---|
| `tests/node/test_v050.js` (45) | **Factory ambient OFF**: `factoryOn()` on the catalogue field and values (off wins; unfilled, never received and a lost provider are unknown, never on), the wire layout IterioDev reads, an immediate release with the screen closed, nothing re-applied when it comes back on unless the setting is on, the *Keep custom lighting* setting. **Parked / locked**: states 1, 2 and 3 each release and 5, 7, 8, 10, 12 do not; an animation and the keep-alives stop and nothing at all is written afterwards; unlock with and without *resume*; Restore OEM as the off switch. **Signal loss**: no vehicle state (15 minutes after the last sign of use, then a lapse with no write, not even a release), the state's provider going away, the factory state missing or lost, the keep-alive asking the gate itself, the simulator's exemption. **Background and shutdown**: first-install defaults; the service running with no screen (last lighting at start, animation, door flash, gate); `main.js` background start, the screen reusing the one service, the platform's shutdown (released, timers cleared, subscriptions closed, nothing written after); shutdown mid-effect and with a dead transport; a link setting replacing the controller cleanly. **Door flash**: decoding of the four switches; off by default; each door flashes its own line and only that, stops at once, colour back; several doors; over an animation without touching its phase or re-applying it; over the factory lighting with the module handed back; the module from the location table on another layout; only interior door contour lines through the allow-listed write; stops when the car is left, when switched off, and after five minutes; released with the factory switch. **Indicators**: decoding (lock and alarm flashes are not a turn signal), right-hand-drive mapping, hazards, left-hand drive mirrored, off by default and off again, red over green, a lost provider. **Night dimming.** **Command sending**: an unanswered write is sent once (scheduler, repeated set, frame, planner); busy retries 0 / 1 / 3 and a refused transport as busy; the maximum command duration; the controller's unanswered accounting and keep-alive; a read-back leaving a module that did take it alone; a whole-bus write without a reply not fanned out; three unanswered in a row stop control; whole-bus preferred, never over a module left to BMW, repaired by read-back; the real `kit/diag.js` path with one request in flight and the kit's hidden retries off. **Screen**: the three effect switches on and off again; every page's controls on the screen and not overlapping; every mode a knob target with its speed step. |
| `tests/python/test_build_app.py` (13) | what counts as a real SDK (a placeholder, an empty stub and a few bytes do not); a build without it stops with the steps and leaves nothing behind; an old kit is refused; the built packages pass; identity and metadata (`ambient_rgb`, version, `mguHmi ["ID7"]`, `autostart`, entry point, the new modules, no SDK, `oapgen`); tampered copies are refused (an SDK inside either archive, a missing or changed module, wrong version, missing or wrong `mguHmi`, missing start type, missing entry point, a setter asked for); no interface is asked for write access; the packed entry point loads and starts safe. The package tests are skipped when `dist/` is empty. |

Also run by hand for 0.5.0: every page rendered at 1600 x 520 from the harness and looked at (the overlaps
found are in the changelog), and in the kit's live emulator (`npm run emu`) the knob walked the Modes list to
its last row (Sport Pulse) and selected it.

## Node (166 tests, all passing; the table below is the 121 from 0.4.0)

| File | Covers |
|---|---|
| `test_colour.js` (10) | RGB↔HSV, hex, the FF→FE coding rule, the wheel's angle convention (0 at 12 o'clock, clockwise), `wheelPos` ↔ `wheelHit`, the vector wheel rasterising, nudging, luma |
| `test_protocol.js` (10) | the exact `2E DA5E` bytes and order, 0xFF never in a colour byte, bus 1/2 caps, every decoder (the car's 10-byte records), the allow list |
| `test_scene.js` (12) | module categories, groups and sides from the real locations; zones (upper/lower with the handle setting, front/rear doors, one module); solid, dual (handles top/bottom/off), zones (later wins), rainbow, fade (holds and glides), breathing (limits, smooth), wave (per-module phase, dashboard leads); normalise, describe, diff, presets round-trip |
| `test_scheduler.js` (10) | one write at a time in order, newest target wins keeping its place, unchanged skipped unless forced, priorities release > apply > frame, **obsolete frames dropped whole**, busy backoff with a newer target winning, rejects reported, drain / clear / pause / resume, latency and writes-per-second stats, **the benchmark** (19 modules at 14 ms: 266 ms per frame sequential; 168 ms if one per bus could overlap), per-bus ordering with maxInFlight 2 |
| `test_controller.js` (17) | on the simulated BDC with fake timers: probe; **nothing written before apply**; solid writes all 19 once then only keep-alives at the right times, never lapsing; dual on the right modules with the handle setting (and the release of the handles when set to off); zones keeping other zones; **restore releases every module and reports exactly** (a refused release is reported, a dead transport is reported); **apply / restore never interleave**, a second apply supersedes; **parking fail-closed** (unknown and moving both refused, nothing written); animated programs tick, pace to the transport, skip unchanged and force stale; breathing then a static apply stops the ticker; busy absorbed, lost link stops control and reconnects on availability without re-applying; every module refusing turns control off; status; every byte allowed and never 0xFF |
| `test_bdc_uds.js` (12) | the real `kit/diag.js` on a faked TASU bus: probe reads; **disarmed = dry runs only**; armed bytes; ZEIT cap; unknown variant refused; no modules refused; `10 03` retry; transport away / back; lost mid-animation; timeout; the gate against forged services; every byte of a session allowed |
| `test_favourites.js` (5) | colours and complete configurations (replace by name, persist, remove) |
| `test_oem_lighting.js` (6) | the read-only factory lighting read-out: profile names, both interfaces on instance 1, decoding, **only `watch` is ever called (no set, no method)**, unreachable interfaces reported, `app.json` asks for the fields without a write flag and as optional, the Diagnostics rows |
| `test_v040.js` (27) | **the planner** (uniform cabin = 2 writes, mixed colours = whole bus then the exceptions, never NAD 0 on a bus with a module left to the car, never when it saves nothing, releases); **the controller with whole-bus writes** (solid in 2 writes with all 19 showing it, dual correct with fewer writes, zones untouched, a car that refuses NAD 0 falls back for good, rainbow frames of 2 writes); **Welcome Sweep and Sport Pulse** (shape, run once, follow-on or the car's lighting), the speed steps, hold times, read-back; **the gate** (no apply, no renewals); **both buses on a refresh** with either failing; 13 modules on one bus; **driving modes** (names, wire numbers, plug-in hybrid, choices kept, the car's state); **the app** (following off by default, the mode's program, BMW original, the pulse; locked or left releases and blocks; factory lighting off; another controller; the Driving page) |
| `test_ui.js` (12) | `main.js` through the harness: every page draws; **preview only** (taps on the hue ring and the dial change the draft, zero writes, Apply writes); **the rotary flow** (enter the ring, 10 clicks = 30°, press confirms and applies, enter the dial, turn, tilt left cancels back to the entered value with the car unchanged); the setting off (only Apply applies); Dual (taps, swap, copy, Apply both drives upper and lower differently, handle follows the lower group, save combination); Modes (Rainbow with its speed, Start, Breathing, Restore stops cleanly); zones from the Colours page keep other zones; Favourites (colours and configurations, apply, delete); Cancel discards; Diagnostics; switching the link to the car without a transport refuses Apply; **apply at start** (off by default, the last applied lighting comes back with the setting on, Restore OEM clears it) |

## Python (37 tests, all passing: these 24 and the 13 of `test_build_app.py` above)

Unchanged by this upgrade: HSFZ framing, UDS decoders (the car's records), the read-only policy and
redaction, scans against the loopback simulated car (pending, busy, two buses), the catalog search.

## Results (last run on the development laptop, 2026-11-12)

```
TOTAL: 121 passed, 0 failed            (node tests/node/run_all.js)
Ran 24 tests ... OK                   (python -m unittest discover -s tests/python)
```

## Verified in simulation vs on the car

| | Simulation | Car |
|---|---|---|
| `2E DA5E` / `E3D1` per-module colour and brightness, release, timeout, no faults | yes | **yes (2026-11-04, over ENET)** |
| Dual colour (upper / lower at once), zones, modes, fades, keep-alive timing, scheduler behaviour, preview/applied separation, rotary flow | yes | not yet: the app has not been installed on the head unit |
| Whole-bus writes (NAD 0), Welcome Sweep, Sport Pulse, speed steps, read-back, hold times above 10 s | yes | **NAD 0: yes, with a catch (2026-11-12, over ENET)**: bus 2 took it on 12 of 12 modules; bus 1 on 6 of 7 (NAD 1, the passenger front map pocket, kept the car's colour). The rest: not yet |
| Driving-mode values, the car's state (locked / in use), the factory lighting read-out, the gate | yes (fed by hand) | **no**: the app has not run on the head unit; the mode table is Ambient Config's |
| The roof lamp unit's status routine `31 01 A621`, writes to unlisted addresses | - | yes (2026-11-12): the routine answers; all 43 unlisted addresses answer positive, which proves nothing about a lamp |
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
