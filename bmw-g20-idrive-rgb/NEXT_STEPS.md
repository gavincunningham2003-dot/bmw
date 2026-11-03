# NEXT_STEPS.md: what stands between this project and the lights

## 0. Where it stands

| Done | Not done |
|---|---|
| The app (wheel, favourites, diagnostics, settings, knob), the controller with the keep-alive loop, the simulated BDC, the gated TASU path, the read-only laptop tool, 87 tests, the package built by the kit's own build | anything on the car: SSH, platform install, the real SDK, the catalog, the BDC's answers, one accepted `2E DA5E` |

## 1. Data needed from the car (read-only, no risk)

Run, with the ENET cable, ignition on, car parked:

```
cd tools\laptop
python -m enetdiag selftest
python -m enetdiag scan --out out
```

and send back `out\enetdiag-<time>.json` (redacted) and the `.log`. It answers:

1. **Is the BDC a documented variant?** `22 F1 50` to `0x40` → expect `0F2680` (BDC_G05). Anything
   else: stop and compare its SGBD page in the reference first.
2. **How many RGB LIN slaves, which locations, which NADs?** `22 DA 5F` (bus 1) and `22 E3 D1` (bus 2).
   This decides the NAD numbering question (ARG 0..31 vs RES 1..52) and whether the dashboard/door
   contour lines are LIN slaves at all.
3. **Does `E3D1` read back R/G/B per slave?** If so the first write can be verified without looking.
4. The MGU's SVK (`F101`) and IP configuration (`172A`), the gateway's SVK, every unit's SGBD index.

Also, once root SSH exists: `/etc/oap/someip/someip-interfaces.json` for `catalog_search.py`
(Approach 1), and `kit/tools/check_signals.py` against it to confirm `app.json`'s signal flags.

## 2. The first write test (the only risky step, and it is small)

Preconditions: stationary, parking brake, ignition on, charger connected (≥ 12.5 V), BDC fault memory
read beforehand, the laptop report from §1 says `readyForGatedWriteTest: true`, a second person is not
needed but a stopwatch is. Procedure, from the app (Diagnostics page shows every byte) or the laptop
(a one-off script to be written for exactly this, not the read-only tool):

1. Settings → *Lighting link: Car*, *Keep-alive: 4 s*, *Write to the car: Armed*. Pick a saturated
   colour far from the OEM one (pure red).
2. *Apply to lights* once, then *Custom off* within seconds. Observe: do the modules in the slave list
   turn red, for about 4 s, then return? Note which locations changed (expect the LIN-slave zones; the
   BDC's own PWM channels `LCI_0..8` are not touched by `DA5E`).
3. Read `22 E3D1` / `22 DA5F` (the app's *Probe again*; the laptop `read` command) and the BDC fault
   memory afterwards.
4. Outcomes and what they mean:
   - `6E DA 5E` and visible change: **the path is verified**; raise keep-alive to 10 s and use the app.
   - `6E DA 5E` but no visible change: ZUSTAND/brightness semantics or NAD numbering (PROTOCOL_FINDINGS §2.2
     ASSUMED items): try NAD = slave index − 1, brightness 255 (bus 2 form), one slave at a time.
   - `7F 2E 7E/7F`: the app already retried with `10 03`; if still refused, the BDC wants a different
     session (`10 02`? no: never) or security (`33`): stop.
   - `7F 2E 13`: wrong length: the byte order / count assumption is wrong; re-read the ARG table.
   - `7F 2E 31`: NAD or DID out of range: the NAD numbering assumption, or the variant has no bus-1 slaves.
   - `7F 2E 22`: conditions not correct: ambient lighting off in iDrive? engine running? try with the
     OEM lighting switched on and the car in the state ISTA would require (ignition on, engine off).
   - No reply: TASU did not route to `0x40`: check the Diagnostics page's "BDC LINKED" and that the Fault
     Scanner app sees `0x40` in a scan.

## 3. Engineering actions after the test

| Result | Action |
|---|---|
| Verified | measure a round's duration on the car (Diagnostics: "last round ms") and set `minGapMs`/keep-alive accordingly; add a per-zone selector (the slave list already carries locations); consider the `E3D1` read-back for a "confirmed" indicator; record the DTC behaviour |
| Semantics wrong | adjust `lighting_protocol.js` encoders (one place), rerun the tests, retest |
| Refused by session/security | Approach 1 (catalog) becomes the main line; Approach 3 (a fixed custom palette coded once into 360A/360D, selected through the stock menu) is the fallback for custom colours without a laptop per change |
| Catalog shows a writable lighting field | implement `SomeIpLightingController._writeSlave` on that field with `"w"` in `app.json`, exactly as `signals.set()` is used by the kit for `cBSReset` |

## 4. Known limits to keep in mind

- "Real time" is one round of 13 writes per change (0.5-2 s on the car); smooth per-frame fades are
  not possible over diagnostics.
- The knob needs the controller gate; the wheel's taps need the touch-routing renderer. Without them,
  the HMI buttons and the Hue/Saturation/Value settings remain.
- The BDC's own PWM channels (`LCI_0..8`, probably non-LIN strips) are not reached by `DA5E`; if some
  zones stay OEM-coloured, `2F 4800` (PWM %) could dim them but not colour them.
- While custom control is on, the OEM "lighting off" and brightness are overridden for those slaves;
  the app never changes the OEM settings themselves.

## 5. Forum threads worth reading by hand (they refuse automated access)

- https://g20.bimmerpost.com/forums/showthread.php?t=1920746 (G20: 11 colours, S18A-22-03-545)
- https://g20.bimmerpost.com/forums/showthread.php?t=1708753 (G20: coding more ambient colours)
- https://g20.bimmerpost.com/forums/showthread.php?t=1789488 (G20 BimmerCode expert cheat sheet)
- https://g80.bimmerpost.com/forums/showthread.php?t=1922092 (G80: the definitive guide, byte 97)
- https://g20.bimmerpost.com/forums/attachment.php?attachmentid=2573262 (PDF: Ambient Light Color Coding G2x/G3x, 2021)
