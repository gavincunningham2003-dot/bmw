# UNVERIFIED.md: what 0.5.0 has NOT been seen doing on the car

Everything in 0.5.0 passes on the laptop: the simulated body controller, the kit's real runtime, the emulator.
**None of 0.5.0 has run on the G20.** The head unit's apps do not start until its coding is restored
(2026-11-05), so the list below is everything the car still has to confirm. Until an item is confirmed,
treat it as a claim about the design, not about the car.

What the car HAS confirmed (PROTOCOL_FINDINGS.md, laptop over ENET, 2026-11-04 and 2026-11-12): the write
`2E DA5E` / `2E E3D1` in the default session, R G B order, 0xFF = no change, ZEIT self-revert, the release
frame, the 19 modules and their locations on two buses, the read-back, and the whole-bus write (NAD 0) reaching
12 of 12 on bus 2 and 6 of 7, then 7 of 7, on bus 1.

## The app on the head unit at all

1. **The app has never started on this head unit.** 0.3.0 is installed and stopped; nothing newer was ever
   installed. First start, the tile, the settings screen, the renderer and the controller gate with the
   updated kit runtime (commit `64486c5`) are all unseen.
2. **MGU Store installing this package.** The package passes every check that can be made off the car, and
   its metadata follows the Store's `docs/PUBLISHING.md`. Not seen: the Store listing the release, generating
   `oap-sdk` from this unit's donor app (x_call, SDK 24.10.2), the manager installing it, and the update over
   the 0.3.0 that the kit's own installer put there.
3. **The GitHub Actions workflow** (`.github/workflows/release.yml`) has never run. The same steps run
   locally on Windows; the Linux runner is untried.
4. **The diagnostic link from inside the head unit** (TASU): every write so far went from the laptop over
   ENET. Latency, the one-request-at-a-time behaviour, "busy" verdicts and the reply matching are from the
   kit's code and its other apps, not measured here.

## Background running (section 2 of the brief)

5. **Autostart.** `mguAppStartType: autostart` is what the Store's deploy tool documents ("starts with the
   platform, the manager starts it again when it stops, never stopped for being inactive in the background")
   and what the kit's Ambient Config uses. Not seen on this unit: that the platform starts the app at boot,
   that the kit's background start runs without the screen, that closing the screen leaves the process up.
   With the kit's older installer (`mgu-app-install.sh`) the app is listed as `manually` and is NOT started
   by the platform: the lighting then runs only from the first time the app is opened until the platform stops
   it for inactivity.
6. **The platform's shutdown request.** The kit ends the process 200 ms after it. One release write a module
   is about 19 x 15 ms, so with single writes the release may not finish; what did not get out returns to
   the factory lighting when its ZEIT runs out (10 s by default, 30 s at most). With whole-bus writes it is
   two writes. Which signal the platform really sends (its shutdown event, SIGTERM, SIGKILL) is not known.
7. **The head unit going to sleep with the app running**, and that nothing the app does keeps the car awake
   after locking. By design nothing is written or polled on the body controller once the car is left; this
   needs a battery-drain check on the car (lock, wait, read the BDC's sleep state or current).

## Factory lighting shutdown (section 1)

8. **VehicleCondition reaching the app**, and that 1, 2 and 3 are what this G20 sends when it is locked and
   left (the values are the catalogue's and the kit's; the car's sequence on lock, unlock and walk-away is
   not recorded).
9. **The factory ambient ON / OFF signal.** The field (`statusModeAmbientePanoramicRoofInteriorLighting`,
   service 0xB512, event 0x8003, payload byte 7, AUS 0 / EIN 1) is IterioDev's and is confirmed in this head
   unit's interface catalogue. Not confirmed: that an installed app is given `ComfortFunctionIuK` and
   `AmbientLight`, which of the two this car fills, and what they say when the lighting is switched off in
   iDrive. If neither answers on the car, the app (correctly) refuses to drive the lights with the setting
   *Factory ambient lighting off* on its default; set it to *Keep custom lighting* to use the app without
   that check, and report what Diagnostics shows under "Factory light".
10. **A lapse** (writes stopped, no release sent) has been seen from the laptop only as ZEIT expiry.

## Effects (sections 3 and 4)

11. **Door switches**: that `DoorsWindowsRoofMirrors.CentralLockingSystemAndPanelStatus` reaches the app and
    that DRD / PSD / DRDR / PSDR are the driver / passenger front / rear doors on a right-hand-drive car.
12. **Door flash on the lights**: red at 400 ms on / 400 ms dark on one module. Whether the module follows
    that rate, and how it looks, is unseen. The four door contour lines are bus 1 NAD 3 and 6 (passenger) and
    bus 2 NAD 8 and 11 (driver) by the car's own location table.
13. **Indicators**: that `Light.StatusFunctionsIndicators` reaches the app, its values on this car, and the
    right-hand-drive mapping (left indicator = passenger side). If the glow shows on the wrong side, switch
    *Steering wheel side* in Settings and report it.
14. **Day / night**: that `Vehicle.statusDayNightChangeOver` reaches the app and switches when the car's
    lights do.
15. **Effects while driving.** The indicator glow writes while the car moves, which nothing else in the app
    does. Untried on the road.
16. **Sport pulse**: fires on a decoded driving-mode change. The mode table is the kit's and is not verified
    on this 330e (the Driving page shows what the car sends). **No redline or rpm pulse exists**: there is no
    verified signal for it, so it was not built.

## Command sending (section 5)

17. **Whole-bus writes from the app**, the read-back repair of a module that missed one, and the single
    writes for it afterwards: simulated only. From the laptop the miss happened once in two runs on bus 1.
18. **Two requests in flight** (setting *Writes in flight* = 2): NOT verified and not claimed to work. The
    default is one. The setting exists for an experiment on the car only.
19. **Busy and no-reply behaviour of the real gateway**: the retry count (setting, 0 to 5) and the rule that
    an unanswered write is never sent again are tested against a simulated transport.
20. **Brightness other than 100** on the real modules (night dimming sends 50): the brightness byte was only
    ever written as 100 or 0 on the car.

## Not part of 0.5.0

- The roof lamp unit does not follow these writes (it is not one of the 19 modules).
- Item 6 of the brief was skipped as asked.
