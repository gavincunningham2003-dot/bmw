# Changelog

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
