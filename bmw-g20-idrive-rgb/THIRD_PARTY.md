# Third-party code and ideas

## MGU App Kit, Ambient Config (MIT)

Source: https://github.com/cauliflowermossgrape/idrive7-apps, `apps/ambient_config`.

### 0.5.1: files copied unchanged (commit `89de8c0444294ec8a5020b2f870952660de2819d`, read 2026-11-13)

| In this repository | From Ambient Config | State |
|---|---|---|
| `app/ambient_rgb/ambient_config_scenes.js` | `scenes.js` | **copied, unchanged** (byte for byte; only the file name differs, because the kit's build copies an app's `.js` files flat). Every animation the app shows is computed by its `lightAt()` |
| `app/ambient_rgb/ambient_config_lin.js` | `lin.js` | **copied, unchanged**. Used for `place()` (where each light sits front to back), and in the tests for `sample()`, `writeFrame()` and `releaseFrame()`, against which this project's own bytes are compared |
| `app/ambient_rgb/ambient_config_notice.js` | `LICENSE` | this project's file: the MIT licence text, the commit and the SHA-256 of the two files above. It is a `.js` file so that the notice is inside every package |

`tests/node/test_v051.js` fails if either copied file is edited. To take a newer version: copy the files again
and update the commit and the hashes in `ambient_config_notice.js`.

### 0.5.1: adapted (this project's code, following that app's method)

| In this repository | From Ambient Config | What was taken, and what was changed |
|---|---|---|
| `lighting_scene.js` (`lightOf`, `referenceScene`, `ownTargets`, the animated cases of `render`) | `scenes.js` (called), `control.js` (`start`, `mode`, `away`: how the welcome and pulse scenes are made from a look) | an adapter only: a program becomes a `scenes.js` scene, a module its light, and `lightAt()` is called. Changed: bus numbers (theirs 0 and 1, ours 1 and 2), the handle lights follow this app's setting, a zone can limit an animation |
| `lighting_controller.js` (`_startTicker`, `renewMs`, `_armVerify`, `verifyApplied`, `_armReleaseCheck`, `_readBack`) | `lights.js` (`_run`, `_next`, `_check`, `_giveBack`, `hold`; `MOVE_HOLD_S`, `MOVE_RENEW_MS`, `CHECK_MS`) | frame by frame (a frame fully written before the next is made, from the time it is then), 5 s hold and 3 s renewal for a moving scene, the read-back 1.5 s after a still colour and after a give-back, writes held during a read. Changed: built on this project's scheduler and gates; an unanswered write is never sent again (there it is); no 10 s pause after failures (control stops instead); a still colour holds the driver's setting, not 60 s; the second read-back only confirms a repair |
| `lighting_plan.js` (`plan`, `planRelease`) | `lights.js` (`_plan`, `_giveBack`) | the colour most lights of a bus want as one NAD 0 write, then the lights that differ, front to back; one NAD 0 release a bus. Changed: NAD 0 only when it is cheaper; a module seen to miss whole-bus writes gets its own write; a bus is not released whole while one of its modules keeps a colour |
| `lighting_scheduler.js` (`hold`, `unhold`, `idle`) | `lights.js` (`hold`) | nothing is sent while something else has the diagnostic link |

### Not copied

| From Ambient Config | Why |
|---|---|
| `lights.js` as a file | it is tied to its own app (its `diag`, its `Lights` object) and would have replaced this project's controller, gates and the rule that an unanswered write is never resent. Its method is ported, as listed above |
| `control.js` as a file | it is that app's settings and signal handling. Its `doorRed` (an open door's line blinking red) is the behaviour 0.5.1 removes; its `turnGlow` look is kept in `lighting_overlay.js` (this project's code) |
| `main.js`, `ambient.js`, `cabin.js`, `strobe.js`, `others.js`, `app.json`, `icon.png` | the screen, the factory-colour handling, the strobe: this app keeps its own |

### Earlier versions (read at `7fe7402` and `64486c5`, 2026-11-12)

| In this repository | From Ambient Config | What |
|---|---|---|
| `app/ambient_rgb/driving_modes.js` (`BY_NAME`, `BY_NUMBER`, `PHEV`, `modeOf`, `KIND_MODES`) | `ambient.js` | the driving-mode names, wire numbers and the plug-in hybrid detection |
| `app/ambient_rgb/driving_modes.js` (`CONDITIONS`, `conditionOf`) | `kit/runtime/car.js` | the vehicle-condition numbers |
| `app/ambient_rgb/lighting_service.js` (`COMFORT_SOCK`) | `others.js` | the check for IterioDev's Comfort service |
| `app/ambient_rgb/car_signals.js` (0.5.0) | `main.js` (`TURN`, `TURN_NO`, `DOOR_FIELDS`, `DAY_NIGHT`) | which interfaces and fields carry the doors, the turn indicators and day / night, and which indicator values are a turn signal; each checked against this car's head-unit catalogue |
| `app/ambient_rgb/lighting_overlay.js` (0.5.0) | `control.js` (`signals`, `blink`, `linesOf`) | the look of the indicator glow: door line only, fully on and fully dark, half brightness at night. The code is this project's own |
| `app/ambient_rgb/main.js` (`background`), `lighting_service.js` (0.5.0) | `main.js` (`background`), `app.json` (`autostart`) | running from the platform's start without the screen; the 15 minutes without use for a car that does not say its state |

Its licence, which applies to the copied files and to those parts:

```
MIT License

Copyright (c) 2026 cauliflowermossgrape
Copyright (c) 2026 小白151 (GitHub: JackieZ123430), Chinese translation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The kit's runtime (`kit/runtime`) is used unmodified apart from the one-line patch in `scripts/kit_patch.js`, and
is not part of this repository.

## IterioDev, Ambient Light and the Comfort service (PolyForm Strict 1.0.0)

Source: https://github.com/IterioDev/car-apps. Read for behaviour only (zones by what the car has, factory
priority, the lock-and-leave problem its issue 17 describes). **None of its source is in this repository**; its
licence does not allow that.

0.5.0 uses one fact read from `tools/iteriodev-comfort/comfort.js`: the factory ambient lighting's on / off
state is byte 7 of the event 0x8003 of service 0xB512, on when it is 1. That is a fact about BMW's interface,
not code; `app/ambient_rgb/oem_lighting.js` reads the same field by its catalogue name through the kit's
signals module, and its implementation is this project's own.

## MGU Store (publishing rules only)

Source: https://github.com/robertnisipeanu/mgu-store, `docs/PUBLISHING.md` and `deploy/README.md` (read at
`181a936` and its current `main`, 2026-11-12). Only its documented package rules are followed (asset names,
`mguHmi`, `mguAppStartType`, no SDK in a release); none of its code is in this repository.

## BMW

BMW's application SDK and the head unit's interface catalogue are never part of this repository.
