# NEXT_STEPS.md: what stands between this project and the lights

## 0. Where it stands (2026-11-04)

| Done | Not done |
|---|---|
| The app 0.3.0 (preview/apply, dual colour, zones, modes, the write scheduler), the simulated BDC with the car's own 19-module layout, the gated TASU path, the read-only laptop tool, 87 Node + 24 Python tests, the package built by the kit's own build | root SSH on the MGU, the platform and app install, the real SDK, the catalog search, the app running on the head unit |
| **The car (§1, §1a): BDC_G05, 19 RGB modules on two LIN buses with locations and colour read-back; `2E DA5E` / `E3D1` accepted in the default session, visible, self-reverting, no fault stored** | TASU latency on the head unit, brightness levels other than 100, NAD 0 (not assumed broadcast) |

## 1. What the car has told us (read-only, done)

- BDC body `0x40` = `0F2680` BDC_G05: the variant whose description lists the RGB actuator. Carries `CAFD 000051DD`.
- 19 RGB LIN modules: bus 1 (`DA5F`) 7 on the passenger side; bus 2 (`E3D1`) the three dashboard contour
  lines, both front footwells and the driver side. Every module reads back the current colour (Violet,
  `78 3C FE`, brightness 100), white 0, no faults. The read-back is the verification channel for a write.
- A status read makes the BDC poll its LIN bus: it answers "pending" and the data follows seconds later;
  a request sent meanwhile gets "busy". The app's `kit/diag.js` already waits 10 s on pending; the
  laptop tool now does too.
- The MGU is bootloader `00003F36`, which the SSH tool supports.

Still worth reading (root SSH needed): `/etc/oap/someip/someip-interfaces.json` for
`catalog_search.py` (Approach 1), and `kit/tools/check_signals.py` against it for `app.json`.

## 1a. The write test: DONE and VERIFIED (2026-11-04, evening)

`2E DA 5E 03 01 64 00 FF 00 05` lit the passenger front door contour line green and read back
`0 255 0 @100`; `FE 00 00` read back red. Accepted in the default session, no security access. `0xFF`
in a colour byte means "no change" (now capped at `0xFE` everywhere). Full table: PROTOCOL_FINDINGS.md §0.1.
What remains on the car, one frame per step as before: (a) the same red write with the OEM ambient
lighting ON, because every earlier OEM-on attempt sent `FF 00 00` and proved nothing; (b) a `22 DA 5F`
after ZEIT to confirm the module returns to OEM by itself; (c) `19 02 0C` to see whether any fault was
stored; (d) one bus-2 module via `2E E3D1` (the dashboard centre line); (e) the release frame.

## 2. The first write test (as planned before it was run)

Kept for the record. It was run step by step on 2026-11-04 with the results above.

Preconditions: stationary, parking brake, ignition on, charger connected (≥ 12.5 V), BDC fault memory
read beforehand (the Fault Scanner app or ISTA; the laptop tool does not read DTCs on purpose), the
iDrive ambient lighting switched on and set to a colour far from the test colour (Violet is fine for a
red test), a stopwatch. The module to use first: **bus 1, NAD 1 = map pocket passenger door front** (small,
easy to see, no other function shares it).

Procedure (from the laptop, with a one-off script that will be written for exactly this and shown to you
byte by byte first; the read-only tool stays read-only):

1. `22 DA 5F` → confirm NAD 1 is the map pocket, note its current RGB.
2. `2E DA 5E 01 01 64 FF 00 00 05` (NAD 1, on, 100, pure red, 5 s). Expected `6E DA 5E`.
3. Watch the passenger front map pocket for about 5 s; expect red, then Violet again.
4. `22 DA 5F` → NAD 1 should read red while active and Violet afterwards.
5. Read the BDC fault memory again. Compare.

Outcomes:
- `6E DA 5E` and visible change: **the path is verified**. Then the same on one bus-2 module (`2E E3 D1 03 ...`,
  the dashboard driver line), then the app with keep-alive.
- `6E DA 5E` but no visible change and the read-back unchanged: `ZUSTAND`/brightness semantics or NAD
  numbering: try NAD 0 (possibly "all"), brightness 255 on bus 2, one at a time.
- `7F 2E 7E/7F`: open `10 03`, retry once; if still refused, stop (another session needed).
- `7F 2E 33`: security access: stop; this project does not unlock ECUs. Approach 1 (catalog) becomes
  the main line, Approach 3 (a coded fixed palette through the stock menu) the fallback.
- `7F 2E 13`: length: the ARG byte order assumption is wrong; re-read the table.
- `7F 2E 31`: NAD or DID out of range: the NAD numbering assumption.
- `7F 2E 22`: conditions not correct: try with ambient lighting on/off, engine off, doors closed.
- No reply: wait for pending (the write may poll LIN like the reads do).

## 2a. Done after the verification (app 0.2.0)

Fades (the controller interpolates between rounds), rainbow mode, zones from the real module map, the
keep-alive timed from the measured round, the mock on the car's 19-module layout, the variant `0F2680`
marked verified. `write_test.py cycle --fade 1 --all` shows a smooth fade across every module from the
laptop (19 writes per step, about 3 steps per second). An optional experiment for one frame on the car: **NAD 0** on each bus (`2E DA 5E 00 ...`). It is NOT
assumed to be a broadcast: the LIN broadcast address is 0x7F, and the BDC's NAD 0..31 argument range proves
nothing. If it did address every module of a bus, a frame would be two writes instead of nineteen.

## 2b. App 0.3.0 (feature branch): the full application

Preview/applied separation, the rotary editor, the circular brightness dial, Dual Colour (upper / lower with
their own brightness, handles configurable), independent zones, the six modes, saved configurations, the
write scheduler (coalescing, priorities, obsolete frames dropped, busy retried, honest restore), the parking
fail-closed rule. All verified in simulation (87 Node tests); on the car only the underlying actuator is
verified. Still to measure on the head unit: the TASU latency per write (the 14 ms is over ENET), which
sets the Colour Wave frame rate (3.8 frames/s at 14 ms in simulation; the Modes page says whether the
measured link is fast enough). Brightness values other than 100 have not been shown on the car.

## 3. Engineering actions after the test

| Result | Action |
|---|---|
| Verified | measure a round's duration on the car (19 writes) and set the keep-alive accordingly; add a per-zone selector from the real slave list (locations are known); use the `DA5F`/`E3D1` read-back for a "confirmed" indicator in the app; record the DTC behaviour |
| Semantics wrong | adjust `lighting_protocol.js` encoders (one place), rerun the tests, retest |
| Refused by session/security | Approach 1 (catalog) main line; Approach 3 fallback |
| Catalog shows a writable lighting field | implement `SomeIpLightingController._writeSlave` on that field with `"w"` in `app.json` |

## 4. The path to the app on the car (after a verified write)

1. Export the MGU coding (BimmerCode), then root SSH via idrive7-8-ssh-root (`flash` wipes MGU coding
   and Digital Key pairings: ROLLBACK.md).
2. Platform (Store or kit installer), real `oap-sdk` extracted from the unit, `python scripts/build_app.py`.
3. Install, open with *Lighting link: Car*, disarmed: the Diagnostics page should list the 19 modules.
4. Arm, keep-alive 10 s, parked: *Apply to lights*.

## 5. Known limits

- A cabin-wide frame is 19 writes, one at a time (266 ms at the 14 ms measured over ENET; the head unit's own latency is unmeasured). Animated modes are paced to that; Colour Wave needs a few frames a second.
- The BDC's own PWM channels (`LCI_0` at 89 %, `MSA_LED` 92 %) are not RGB modules; `DA5E`/`E3D1` do
  not reach them. Whether any visible zone is on them is unknown (all the obvious zones are LIN modules).
- The knob needs the controller gate; the ring's taps need the touch-routing renderer. The kit runtime carries one
  patch (`scripts/kit_patch.js`) so the knob reaches the app while it grabs; worth offering upstream.
- While custom control is on, the OEM "lighting off" and brightness are overridden for those modules.

## 6. Forum threads worth reading by hand (they refuse automated access)

- https://g20.bimmerpost.com/forums/showthread.php?t=1920746 (G20: 11 colours, S18A-22-03-545)
- https://g20.bimmerpost.com/forums/showthread.php?t=1708753 (G20: coding more ambient colours)
- https://g20.bimmerpost.com/forums/showthread.php?t=1789488 (G20 BimmerCode expert cheat sheet)
- https://g80.bimmerpost.com/forums/showthread.php?t=1922092 (G80: the definitive guide, byte 97)
