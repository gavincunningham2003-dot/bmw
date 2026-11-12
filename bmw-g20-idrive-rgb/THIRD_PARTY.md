# Third-party code and ideas

## MGU App Kit, Ambient Config (MIT)

Source: https://github.com/cauliflowermossgrape/idrive7-apps, `apps/ambient_config` (read at commit `7fe7402`,
2026-11-12).

Parts of Ambient RGB 0.4.0 follow that app's design, and some tables and formulas are taken from it:

| In this repository | From Ambient Config | What |
|---|---|---|
| `app/ambient_rgb/lighting_scene.js` (`ONCE`, `SPEED`, the `welcome` and `pulse` cases) | `scenes.js` | the one-time effects' timing and shape, the speed multipliers 1.6 / 1 / 0.55 |
| `app/ambient_rgb/lighting_plan.js` | `lights.js` (`_plan`, `_giveBack`) | the whole-bus (NAD 0) planning rule: the colour most modules of a bus want as one write, then the modules that differ |
| `app/ambient_rgb/lighting_controller.js` (`verifyApplied`) | `lights.js` (`_check`) | reading the buses back after a still colour and rewriting a module that missed it |
| `app/ambient_rgb/driving_modes.js` (`BY_NAME`, `BY_NUMBER`, `PHEV`, `modeOf`, `KIND_MODES`) | `ambient.js` | the driving-mode names, wire numbers and the plug-in hybrid detection |
| `app/ambient_rgb/driving_modes.js` (`CONDITIONS`, `conditionOf`) | `kit/runtime/car.js` | the vehicle-condition numbers |
| `app/ambient_rgb/main.js` (`COMFORT_SOCK`) | `others.js` | the check for IterioDev's Comfort service |

Its licence, which applies to those parts:

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

## BMW

BMW's application SDK and the head unit's interface catalogue are never part of this repository.
