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
others), `rainbow`, `fade` (a palette with transition and hold times), `breathing` (brightness between two
limits), `wave` (a hue travelling from the dashboard to the rear, ordered by each module's real location).
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

**NAD 0** is NOT assumed to be a broadcast. The LIN broadcast address is `0x7F`; the BDC's `NAD 0..31`
argument range says nothing about group control. It stays an untested, optional experiment (NEXT_STEPS.md).

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
  header tabs, the page's controls (targets) and the bar buttons; a press on a wheel or dial ENTERS it: the
  app grabs the knob (`ctx.controller.grab`), turns adjust the draft, a press confirms (and applies, with the
  setting on), a tilt left cancels, and the knob returns to the HMI. The hardware BACK is never intercepted.
- Touch: taps on the wheel, the dial and the buttons (the kit routes taps, not drags, to the page).
- Without the controller gate the knob cannot be grabbed: every control has - / + buttons the kit's focus
  ring reaches, so the app stays usable from the knob alone.
- The wheel is 24 ramped arcs in a cached layer; the dial is three arcs (no pixel images: the Store renderer
  has none). Angles follow the kit: 0 at 12 o'clock, clockwise.

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
