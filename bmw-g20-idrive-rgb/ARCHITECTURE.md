# ARCHITECTURE.md

## 1. The car side (verified on the G20 330e, 2026-11-04)

```
 ┌─────────────────────────────── MGU head unit (iDrive 7) ───────────────────────────────┐
 │  HMI (HmiMain3D)      OAP app platform (MainApp, Node 8, one process per app)           │
 │  BMW's menus,  ◄────► our app "Ambient RGB"  ──► kit/diag.js ──► InternalTasu (SOME/IP) │
 │  RHMI screens         (lighting_bdc_uds.js)        UDS request      diagnostic gateway   │
 └───────────────────────────────────────────────────────────────────────┬─────────────────┘
                                   vehicle Ethernet / diagnostic routing │  UDS to address 0x40
 ┌───────────────────────────────────────────────────────────────────────▼─────────────────┐
 │  BDC (body domain controller BDC_G05; gateway 0x10 and body 0x40 are the same box)      │
 │   2E DA5E / 2E E3D1: drive one RGB LIN module (NAD) with R, G, B and brightness for      │
 │   ZEIT seconds; ZUSTAND 0 hands it back at once (both verified, ~14 ms per write)       │
 │   22 DA5F / 22 E3D1: every module's location, live colour, brightness and faults         │
 └──────────────┬──────────────────────────────────────────────────────────────────────────┘
                │ LIN: FI-LIN-1 = 7 passenger-side modules, FI-LIN-2 = dashboard + front footwells + driver side
 ┌──────────────▼──────────────────────────────────────────────────────────────────────────┐
 │  19 ambient LED modules: 3 dashboard contour lines, 4 door contour lines, 4 door-opener  │
 │  (handle) lights, 4 map-pocket lights, 4 footwells                                       │
 └─────────────────────────────────────────────────────────────────────────────────────────┘
```

Established on the car: the actuator works in the default session with no unlock, overrides the OEM
lighting whether it is on or off, times out by itself and releases instantly; the BDC stores no fault.
Open: the head unit's own TASU latency (the ~14 ms is over ENET), and whether the OEM function ever
re-asserts a module mid-ZEIT. PROTOCOL_FINDINGS.md has every frame.

## 2. The app: preview, apply, keep alive

```
 UI (main.js)                        DRAFTS: colours / dual / modes      nothing leaves the screen
   ├─ ui_widgets.js  wheel, brightness ring, swatch, stepper, the rotary Editor (enter / turn / confirm / cancel)
   │
   │  apply(program)  ◄── Apply button, bar Apply, or the confirming press (setting "Press to confirm applies")
   ▼
 LightingController (lighting_controller.js)       APPLIED state only
   ├─ lighting_scene.js   program -> per-module targets { 'bus:nad': { r, g, b, brightness } }
   │                      groups (upper / lower), zones, modes (solid, dual, zones, rainbow, fade, breathing, wave), presets
   ├─ lighting_scheduler.js  one write at a time, newest target per module wins, release > apply > frame,
   │                      obsolete frames dropped whole, busy retried, drain() for restore
   └─ _writeSlave()      lighting_mock.js (simulated BDC, 19 modules, latency / busy / reject injection)
                         lighting_bdc_uds.js (kit/diag.js over TASU; armed, variant and allow-list gates)
```

### Preview vs applied

Every page edits a draft: turning the knob, tapping the wheel or the dial, pressing + / - changes the
screen only. The controller is called exactly twice: `apply(program)` with a confirmed configuration and
`restoreOem()`. An applied static configuration keeps receiving its keep-alives while a different draft
is browsed. Leaving a page, Cancel, or the hardware BACK drops the draft; the applied state is untouched.

### Programs and scenes

A program is what the user confirms (`lighting_scene.js`): `solid` (colour, brightness, zone), `dual`
(upper and lower colour and brightness, with the door-handle lights assigned by the setting *Door handle
lights belong to*), `zones` (a list of zone assignments, later ones win, so changing one zone keeps the
others), and the animations `rainbow`, `fade`, `breathing`, `wave`, `welcome`, `pulse`. From 0.5.1 the
animations are not computed here: they are the MGU App Kit Ambient Config's, whose `scenes.js` is in the app
unchanged, and `render()` only translates (section 3c).
`render(program, modules, now)` is pure: static programs render the same scene at any time; animated ones
render a frame. Groups come from the module locations: dashboard and door contour lines are upper; map
pockets and footwells are lower; handles go where the program says. Zones: all, dashboard, front doors,
rear doors, footwells, upper, lower, front, rear, driver side, passenger side, or one module.

### Keep-alive and animation

The actuator holds a module for ZEIT seconds (10 s default, 30 s cap on the car path). A static program is
written once; afterwards a module is rewritten only when its last accepted write is older than ZEIT/2
(checked every ZEIT/4). An animated program ticks: each tick renders a frame and hands it to the scheduler,
which writes only the modules whose target changed, plus those about to lapse; a tick arrives every
`max(frameMs, modules × measured latency × 1.1)`, so frames never queue up behind the transport, and a frame
the transport could not keep up with is dropped whole rather than sent late.

### The scheduler, and why there is no concurrency

The head unit's TASU gateway takes one diagnostic request at a time (kit/diag.js turns a second one away
with `APP_REQUEST_TEMPORARILY_NOT_ACCEPTED`), and the positive reply to a layering write (`6E DA 5E`) carries
no module address, so two writes to the same identifier in flight could not be told apart. The scheduler
therefore sends one write at a time; its gains come from coalescing (newest target per module, in queue
order, so one busy module cannot starve the rest), priorities (release > apply > frame), skipping unchanged
targets, dropping obsolete frames, and retrying `busy` with backoff. `maxInFlight 2` (one per LIN bus) exists
for experiments only: the simulation shows a full-cabin frame at 266 ms sequential (3.8 frames/s at the
measured 14 ms per write) against 168 ms if the transport allowed two in flight, which it is not expected to.

**NAD 0** reaches every module of a LIN bus: reported by the MGU App Kit's Ambient Config, then seen on this
car over ENET on 2026-11-12 (PROTOCOL_FINDINGS.md section 9: 12 of 12 on bus 2; 6 of 7, then 7 of 7 on bus 1).
From 0.5.1 it is the default way to write and the way to hand back (section 3c); a module seen to miss a
whole-bus write gets its own write after each.

### Restore OEM

`restoreOem()` stops the ticker and the keep-alive, drops every queued frame, releases every module this
controller has driven (`ZUSTAND 0, ZEIT 0`, verified instant), waits for the transport, and reports the
releases that were accepted and the keys that were not; it never claims success for a module whose release
was refused or unanswered (those lapse by themselves within ZEIT). `apply` and `restoreOem` are serialised,
so a restore issued during an apply wins and leaves every module OEM.

### Vehicle state

With the car link, lighting changes are **blocked unless the car is known to be parked** (speed from
`Vehicle2.statusCarSpeed2` ≤ 3 km/h). An unknown speed blocks too (fail closed); the setting *Lighting
changes while driving* can relax this. The simulated link is exempt.

## 3. Input and rendering

- Full-screen layout on the kit renderer (mgu-render/1 dialect with touch routing): the knob walks the
  header tabs, the page's controls (targets) and the bar buttons; a press on the ring's disc or a dial's centre
  ENTERS it: the app grabs the knob (`ctx.controller.grab`), turns adjust the draft, a press confirms (and
  applies, with the setting on), a tilt left (deflection 10/11) cancels, and the knob returns to the HMI. The
  hardware BACK is never intercepted.
- Touch: taps on the hue ring, the dial's arc and the buttons (the kit routes taps, not drags, to the page). A
  tap on a kit target is a press without coordinates, so the knob's targets are only the centres of the ring
  and the dials; the coloured surfaces stay free for `ctx.onTap`.
- **One kit runtime change** (`scripts/kit_patch.js`, applied to the copy of `kit/runtime/display.js` at
  staging, by `build_app.py` and by the emulator wrapper): where the kit runs the screen it handles every knob
  event itself and never calls `ctx.controller.onInput`, even after `grab(true)`. The patch hands the events to
  the app while it holds the grab, and back to the kit's focus on release. Nothing else changes.
- **The cabin view** (`ui_widgets.js carView`): the 19 modules drawn where they sit (dashboard lines, door
  lines, handles, pockets, footwells; right-hand drive) in the colours `lighting_scene.render` gives the draft,
  so the picture is exactly what Apply would send.
- **Live emulator on the laptop:** `npm run emu` runs the kit's emulator (`kit/tools/emu.js`: the car's draw
  engine as WebAssembly, the real runtime, a stubbed head unit) on Windows too: the renderer socket becomes a
  named pipe (`scripts/emu_win_shim.js` makes the runtime accept it) and the build runs with `python`.
- Without the controller gate the knob cannot be grabbed: every control has - / + buttons the kit's focus
  ring reaches, so the app stays usable from the knob alone.
- The wheel is 24 ramped arcs in a cached layer; the dial is three arcs (no pixel images: the Store renderer
  has none). Angles follow the kit: 0 at 12 o'clock, clockwise.

## 3b. 0.5.0: the service, the gate and the effects

```
 the platform starts the app (autostart)            the driver opens the app
            |                                                  |
   main.js  background(bg)  ------------------------  main.js  start(ctx)     the screen: drafts, pages, Apply
            |                      ctx.background.svc          |
            v                                                  v
   lighting_service.js  LightingService (one per process) <----+   apply() / restoreOem() / touch()
     |  gate(): release | lapse | open      asked on every signal, every 1.5 s, and by the controller
     |  syncEffects(): doors, turn, dim     from the settings and the car
     |  stop(): effects off, timers cleared, restoreOem(), subscriptions closed
     |
     +-- oem_lighting.js    factoryOn()  true | false | null      ComfortFunctionIuK, AmbientLight   (read)
     +-- driving_modes.js   away()       true | false | null      VehicleCondition, FES              (read)
     +-- car_signals.js     doors(), turn(), night()              DoorsWindowsRoofMirrors, Light, Vehicle (read)
     +-- kit/parked.js      speed                                 Vehicle2                            (read)
     |
     +-- lighting_controller.js   apply / restoreOem / lapse / setEffects
            _compose(now) = lighting_overlay.compose( lighting_scene.render(program), modules, effects, now )
            ticker (anything moving) | keep-alive (still)  -> lighting_plan -> lighting_scheduler -> transport
```

- **Release** (a reason to hand the modules back now): the car parked or in standby with nobody in it
  (VehicleCondition 1, 2, 3), the factory ambient lighting switched off, another controller on the unit.
  **Lapse** (stop writing, send nothing, let ZEIT run out): the car's state or the factory lighting's state
  is not known. A missing signal is never read as "in use" or "on". The header of `lighting_service.js` has
  the full rules.
- **Effects** never change the applied program or its time origin: the controller renders the program as
  before and lays the effect over the modules it concerns, so an animation carries on in step. A module the
  program leaves to the car is released the moment its effect ends. (0.5.1: an open door is no longer an
  effect of the app's: its line is handed back to BMW, section 3c.)
- **No reply is not a reason to write again**: `lighting_scheduler.js` records such a write as unanswered and
  the controller treats it as possibly taken (driven, keep-alive from now); a read-back decides where one is
  possible; three in a row stop control.
- **Lifecycle** (kit `64486c5`, `kit/runtime/mgu.js`): `impl.background(bg)` runs once per process, with or
  without screens; `impl.start(ctx)` when the app has screens, with `ctx.background`. `"autostart": true` in
  `app.json` becomes `"mguAppStartType": "autostart"` in the package, which MGU Store's deploy tool turns
  into the platform's start type. `autostart` alone does nothing without both of those: the kit's older
  installer lists every app as `manually`. UNVERIFIED.md items 5 to 7.

## 3c. 0.5.1: Ambient Config's animations and update method

```
 lighting_scene.render(program, modules, now)
     solid / dual / zones                     this project's own
     rainbow / fade / breathing / wave        scene = { kind, upper: { rgb, bright }, lower: { rgb, bright }, speed }
     welcome / pulse                          light = { part, y, bus }   per module
                                              ambient_config_scenes.js  lightAt(scene, light, t)   <- UNCHANGED file
                                              ambient_config_lin.js     place(location).y          <- UNCHANGED file
 lighting_overlay.compose(scene, modules, { doors, turn, dim }, now)
     an open door's contour line: removed from the scene (BMW's until the door closes)
 lighting_plan.plan(scene, modules, last)     per bus: NAD 0 for the colour most lights want, then the exceptions
 lighting_plan.planRelease(...)               per bus: one NAD 0 release, unless a module of it keeps a colour
 lighting_scheduler                           one request at a time; hold() while a read-back has the link
```

- **The translation.** `top` / `bottom` are that file's `upper` / `lower`; `light.part` is this project's
  group (handles by the setting); `light.y` comes from its own table by installation location; `light.bus`
  is this project's bus minus one. Nothing else is computed: what `lightAt()` returns is the target. The
  locations are the car's "driver" and "passenger", so right-hand drive needs no mirroring.
- **Frames** (`lighting_controller._startTicker`, after `lights.js` `_run` / `_next`): a frame is every light
  at one moment; it is planned, written out completely (awaited), and only then is the next one made from
  the time it is then. Nothing is queued ahead, so nothing can be sent late. Rainbow, Fade and Wave cost two
  writes a frame.
- **Read-back** (`_armVerify`, after `lights.js` `_check`): Apply resolves when the writes are out; one read
  of both buses follows 1.5 s later in the background and repairs a module that missed its colour.
- **A door** (`lighting_overlay.js`): its line has no target while it is open, so it is released once and
  then written by nothing: not singly, not by a keep-alive, and not by NAD 0, which `plan()` never uses on a
  bus with a module that has no target. Closing puts it back in the scene at the animation's current phase.
- **Handing back** (`restoreOem`): one NAD 0 release a bus, sequentially, for Restore OEM, the car left, the
  factory lighting off and the app's stop; single releases only for part of a bus.

What was copied, adapted and left: [THIRD_PARTY.md](THIRD_PARTY.md).

## 3d. 0.5.3: two write methods, one writer; active colours; the preview

```
 apply(program)                 stops the other method first (ticker + queued frames, or the keep-alive)
   still: solid / dual / zones  _writeTargeted()  one write per module, own NAD, only where the colour changes
                                keep-alive timer  targeted renewals                         writer() = 'targeted'
   animated: rainbow ... pulse  _writeWholeBus()  NAD 0 + exceptions, frame by frame (3c)   writer() = 'bus'
                         both -> lighting_scheduler (one request at a time)
 restoreOem()                   one NAD 0 release a bus (both methods)
 a door / a module left to BMW  one release per module, never NAD 0

 active_colours.activeLook()    applied program -> else the modules as last read (liveColours(): only a read
                                newer than our last write) -> else the last applied.   Never a draft.
 main.js syncModes()            Modes page opened / a mode picked / an Apply: modes without colours of their
                                own take the active look
 lighting_preview.ModePreview   draft program -> lighting_scene.render at the preview's clock -> carView
                                (requires lighting_scene only; no controller, no timer)
```

## 4. The control paths, as ranked by the brief

| # | Approach | Status |
|---|---|---|
| 1 | Native SOME/IP lighting service | Unknown: no public source; the unit's catalog (`tools/laptop/catalog_search.py`) would settle it |
| 2 | MGU → BDC diagnostics (`2E DA5E` / `E3D1`) | **Verified on the car over ENET**; the app's path; TASU latency not yet measured |
| 3 | Runtime preset override (coding 360A) | Not pursued: persistent, needs the coding session |
| 4 | Alternative | Not needed |

## 5. The laptop side

`tools/laptop/enetdiag`: read-only discovery (UDS 0x22 only). `tools/laptop/write_test.py`: the gated,
one-frame-per-step write test with the colour cycle and fades, which produced the verification.
