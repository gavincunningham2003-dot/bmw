# Changelog

## 0.5.0 (2026-11-12)

Factory lighting shutdown, background running, door and indicator effects, command-sending rules, and a real
MGU Store release. Everything below runs in simulation and in the emulator. **Nothing in 0.5.0 has run on the
car**: [UNVERIFIED.md](UNVERIFIED.md) lists what the car still has to confirm.

### Factory lighting shutdown (fixed)

- **The factory ambient ON / OFF switch is now read properly.** `oem_lighting.js` gained `factoryOn()`: the
  field IterioDev's Comfort service reads (service 0xB512, event 0x8003, payload byte 7), checked against this
  head unit's catalogue as `statusModeAmbientePanoramicRoofInteriorLighting` (AUS 0, EIN 1, unfilled 3), plus
  the menu value `AMBIENTEBELEUCHTUNG_AUS` and `AmbientLight.ambientLightActive`. Off from any of them is off.
  Switching the factory lighting off releases every module at once (on the signal, not at the next 1.5 s look).
- **Unknown is no longer treated as "on".** Before, a signal that never arrived left the lighting running.
  Now a missing, unfilled or disconnected signal stops the renewals and animations and sends nothing more (not
  even a release): the modules return to the factory lighting when their time runs out. New controller call
  `lapse()`.
- **Parked and left (VehicleCondition 1, 2, 3)** releases as before; the animation ticker now asks the gate
  before every frame as well (before, only the keep-alive and the 1.5 s look did).
- **No vehicle state at all:** the car counts as in use only while something shows it (it moved, or the
  screen was used) and for 15 minutes after; then the lights are left to lapse.
- **A state heard before its provider went away is not believed afterwards.**
- **Factory lighting back on / car unlocked:** nothing is re-applied unless the setting *Lighting back when
  the car or the factory lighting returns* is on (renamed; off by default as before).
- On the simulated BDC unknown signals do not stop the lighting (there is no car to keep awake); known ones do.

### Background running (new)

- **`lighting_service.js`**: the link, the factory gate, the effects, the driving modes, the last lighting at
  start and the shutdown moved out of the screen code into one service per process. `main.js` is now the
  screen only.
- **`"autostart": true`** in `app.json` and a background start in `main.js` (`impl.background`, MGU App Kit
  `64486c5` or later): the platform starts the app itself and the lighting runs with the screen closed.
  Opening the screen reuses the running service (one controller, one set of timers and listeners).
- **Shutdown:** the platform's shutdown request and SIGTERM stop the effects and animations, clear the timers,
  attempt `restoreOem()` and close every subscription.
- First-install defaults are unchanged: Simulated BDC, Disarmed, nothing applied at start.

### Effects over the lighting (new, each off until switched on)

- **Open door red flash** (setting of that name): the open door's interior contour line blinks red, all four
  doors separately and together, stops the moment the door closes, and the applied colour or animation carries
  on in step. The module comes from the body controller's location table. Stops when the car is left, and by
  itself after five minutes of one door state. `car_signals.js`, `lighting_overlay.js`.
- **Turn indicator green glow**: that side's door contour lines blink green; hazards light both sides.
  Right-hand drive by default (left indicator = passenger side); setting *Steering wheel side*.
- **Dim at night**: half brightness while the car reports night.
- All three have switches on the Driving page as well as in Settings, and can be switched off again there.
- Sport pulse is unchanged (off by default, on a decoded driving-mode change). No redline pulse: there is no
  verified signal for it.

### Command sending

- **A write that gets no reply is never sent again for that reason.** It is recorded as unanswered and counted
  as written; the module is next written when its target changes or its keep-alive is due. Before, the next
  keep-alive look (and a whole-bus write's fallback) resent it.
- **A whole-bus write without a reply** no longer switches whole-bus mode off and no longer fans out into
  single writes. Only a refusal (a negative reply) does. A read-back, where possible, settles it.
- **Three writes in a row without a reply** stop custom control with a message.
- **Busy retries are a setting** (*Retries when the car says busy*: 0, 1, 2, 3, 5; default 3). The kit's own
  hidden transport retries (four, 1 to 4 s apart) are switched off so the count is the real one.
- **A maximum duration for one command** (5 s) in the scheduler and on the transport call.
- The apply result and the screen message now say how many writes were refused, unanswered or repaired.
- Effect frames are paced by the writes they need (two, not nineteen), so a door line blinks on time.
- One request in flight stays the default; the two-in-flight setting is labelled as not verified.

### MGU Store release

- **`scripts/build_app.py` rewritten.** It builds with the kit's own build, removes BMW's SDK from the tree,
  adds `"mguHmi": ["ID7"]`, packs `ambient_rgb@<version>.tgz` and `.mgu` reproducibly, and checks both archives
  (structure, identity, entry point, every module byte for byte, no SDK, no write access asked, the head
  unit's interface catalogue when present, and a load of the packed entry point). Packages that fail are
  removed. **The placeholder-SDK build is gone**: without the real SDK it stops with the steps to extract it.
- `scripts/check_package.js`, `scripts/release.ps1`, `.github/workflows/release.yml`, [PUBLISHING.md](PUBLISHING.md).

### Screen fixes found by the new overlap test

- Colours: the mode list ran off the bottom of its panel (Favourites was cut off) and its first row sat on the
  panel title; *Save colour* touched the first library colour.
- Modes: the status pills were cut off at the bottom edge; the colour swatch's caption overlapped its value.
- Dual: the status text ran off the right edge. Diagnostics: the pills crossed into the Modules panel and the
  last module row sat on the "more" note. Favourites: the first row sat on the panel titles.

### Tests

166 Node tests (45 new in `tests/node/test_v050.js`) and 37 Python tests (13 new in
`tests/python/test_build_app.py`), all passing. See [TESTS.md](TESTS.md).

## 0.4.0 (2026-11-12)

Built against the 0.4.0 specification. Everything below runs in simulation and in the emulator; the column
"On the car" in [TESTS.md](TESTS.md) says what has been seen on the G20 and what has not. Nothing in this
version has been installed on the car yet.

### Added

- **Whole-bus writes (NAD 0).** A new planner (`lighting_plan.js`) can put one colour on every module of a LIN
  bus with a single write, then write only the modules that differ. A uniform colour is 2 writes instead of 19;
  Restore OEM likewise. It never uses NAD 0 on a bus where a module is left to the car, and it falls back to
  single writes for good the first time the car refuses a whole-bus write. Setting **Writes to the car**:
  *One per module* (default) or *Whole bus where it saves writes*. The idea and the claim that it works on a G20
  BDC_G05 come from the MGU App Kit's Ambient Config. On this car (2026-11-12) it reached 12 of 12 modules on bus 2 and
  6 of 7 on bus 1, so in this mode the app always reads back after a still Apply, repairs a module that missed
  and gives it its own write from then on. `write_test.py broadcast`
  tests it with one short write and a read-back.
- **Welcome Sweep and Sport Pulse**, the two one-time effects, and the **speed steps** (slow x1.6, normal, fast
  x0.55) on Rainbow, Smooth Fade, Breathing and Colour Wave, following Ambient Config's `scenes.js`. A one-time
  effect runs once and then gives way to the lighting that was applied, or to the car's own.
- **Lighting by driving mode** (new Driving page). Each of the car's modes (Sport, Hybrid, Electric, Adaptive on
  a plug-in hybrid; Sport, Comfort, Eco Pro, Adaptive otherwise) can use a stored lighting, the driver's applied
  lighting, or BMW's original. Off by default; the raw values the car sends are logged and shown so the mode
  table can be checked on the car first. Optional red pulse when Sport is picked.
- **The factory lighting keeps priority.** Custom lighting is released, and nothing is renewed, when the car is
  locked or left, when the factory ambient lighting is switched off (setting, on by default), or when another
  ambient-light controller is found on the head unit (IterioDev's Comfort service). It comes back by itself only
  with the setting **Lighting back when the car is unlocked** on.
- **Read back after Apply** (setting, off by default): both buses are read after a still colour and a module that
  did not take it is written once more.
- **Hold times** up to 254 s for still colours (the existing ZEIT setting now goes that far on the car link);
  moving programs keep a short hold of at most 10 s.
- **Factory lighting read-out** on Diagnostics (the head unit's own ambient light interface, read only), the
  car's state and driving mode, the gate, and whole-bus write counts.
- `write_test.py`: `broadcast` (one NAD 0 write and a read-back), `roof` (the roof lamp unit's status routine) and
  `sweep` (the verified write to the addresses the car did not report).

### Fixed

- **A refresh of the module list read only LIN bus 1** (`_readSlaves` in `lighting_bdc_uds.js`), so `readState()`
  could shrink the 19 modules to the 7 on bus 1. Both buses are now read and merged; a bus whose read fails keeps
  the modules last known for it.

### Changed

- Apply at start waits for the car to say it is in use where that signal exists, and can begin with the welcome
  sweep (setting).
- The Modes list has eight entries; the page count is six.

### Not done, and why

- **Busy retries default to zero** (specification 4): left at the existing bounded policy (3 retries with a growing
  pause), which the transport tests rely on and the reference app also uses. Unanswered writes were never resent
  and still are not.
- **Per-zone "BMW original" and separate line / decor colours** (specification 10): zones already keep each
  other's colours and a zone can be left to the car by not assigning it; a per-zone picker was not added.
- **Roof lighting** (specification 8): set aside at the owner's request. What is known is in
  [PROTOCOL_FINDINGS.md](PROTOCOL_FINDINGS.md) section 8.
- IterioDev's app is under the PolyForm Strict licence: it was read for behaviour only and none of its source is
  in this repository.
