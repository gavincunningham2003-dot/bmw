# ARCHITECTURE.md

## 1. The car side (what is established, what is hypothesis)

```
 ┌─────────────────────────────── MGU head unit (iDrive 7) ───────────────────────────────┐
 │  HMI (HmiMain3D)      OAP app platform (MainApp, Node 8, one process per app)           │
 │  BMW's menus,  ◄────► our app "Ambient RGB"  ──► kit/diag.js ──► InternalTasu (SOME/IP) │
 │  RHMI screens         (lighting_bdc_uds.js)        UDS request      diagnostic gateway   │
 └───────────────────────────────────────────────────────────────────────┬─────────────────┘
                                   vehicle Ethernet / diagnostic routing │  UDS to address 0x40
 ┌───────────────────────────────────────────────────────────────────────▼─────────────────┐
 │  BDC (body domain controller; gateway 0x10 and body 0x40 are the same box)              │
 │   coding 360A LIC_LCI_COLOR_LIBRARY_DATA (persistent RGB library, 10 colours)           │
 │   coding 360D LIC_LCI_COLOR_PROFILES_DATA (which library colour each iDrive entry uses) │
 │   diagnostic functions (SGBD BDC_G05): 2E DA5E "drive LIN layering slave NAD with       │
 │   R,G,B, brightness for ZEIT seconds", 22 DA5F / 22 E3D1 slave status, 22 4800 PWM ...  │
 └──────────────┬──────────────────────────────────────────────────────────────────────────┘
                │ LIN ("FI-LIN-1", "FI-LIN-2"): up to 26 RGB slaves per bus, one per fitting
 ┌──────────────▼──────────────────────────────────────────────────────────────────────────┐
 │  ambient LED modules: dashboard contour lines, door contour / indirect trim, footwells, │
 │  centre console, cupholders ... (TAB_INNENLICHT_VERBAUORT_LIN locations)                │
 └─────────────────────────────────────────────────────────────────────────────────────────┘
```

**Established (High):**
- The MGU's app platform lets an app send UDS to any ECU through TASU; writes (`2E`, `2F`) to the DME
  and DSC are already done that way by shipped apps (RESEARCH.md, idrive7-apps `live_adjustments`).
- The BDC body is diagnostic address `0x40` on a G20 330e; the ambient modules are LIN slaves of the BDC.
- The BDC_G05 SGBD documents the per-slave RGB actuator with a timeout (PROTOCOL_FINDINGS.md §2).

**Hypothesis (how stock iDrive changes the colour), refined by the evidence:**
The user's hypothesis holds at the BDC end: the BDC owns the colour library (360A) and the profiles
(360D); the stock menu offers a *selection* among profiles, so the HMI must transmit a selection, not
an RGB value. How the MGU transmits it (a SOME/IP field of a body/vehicle-settings service, a CAN
signal gatewayed by the BDC, or a personalisation setting the BDC subscribes to) is **not established**;
no public source names it and the master catalog has not been read. It does not matter for the
diagnostic path, which bypasses the selection entirely.

## 2. The app side

```
 main.js (UI: pages, wheel, favourites, diagnostics)            Favourites (data/favourites.json)
     │ setColour / enableCustom / disableCustom / restoreOem / probe / status
     ▼
 LightingController (lighting_controller.js)
   state machine: disconnected → connecting → connected (→ error)
   custom-control loop: coalesced writes, keep-alive at ZEIT/2, auto-off after N refusals / link loss
   ├── MockLightingController   (lighting_mock.js)     MockBdc: answers the documented bytes, times out ZEIT
   ├── BdcUdsLightingController (lighting_bdc_uds.js)  kit/diag.js → TASU → BDC 0x40; gates: armed, variant, slaves, allow list
   └── SomeIpLightingController (lighting_someip.js)   probe for a catalog interface; never writes
 lighting_protocol.js: DIDs, encoders/decoders, variant table, checkRequest() allow list
```

The UI only ever sees the controller; the three implementations share the byte layer, so what the mock
accepts is exactly what the car will be asked.

### Custom control as a loop, not a setting

The actuator holds a module for `ZEIT` seconds and then releases it (verified: PROTOCOL_FINDINGS §0.1).
The app therefore does not "set" a colour; it **keeps driving** every selected module with the colour
to show now, in rounds. Consequences, with the numbers measured on the car (14 ms per write over ENET,
19 modules, so a round is about 0.3 s):

- **a colour change is a transition**: the rounds run back to back and each writes the colour
  interpolated between where the lights are and the target (setting *Fade between colours*, 600 ms by
  default, 0 = jump). A fade therefore has about three steps per second across the whole cabin, more
  on a single zone; the old "jump" was one write per colour;
- **rainbow mode** is a transition that never ends: the hue turns once per *Rainbow: seconds per turn*;
- **zones** (*Modules to drive*: all, dashboard lines, doors, footwells, front, rear) limit the rounds
  to those modules; modules that leave the zone are released once (`ZUSTAND 0`) and stay OEM;
- between transitions the loop sleeps until the **keep-alive**, due at `ZEIT × 0.5` minus the time the
  last round took, so a slow transport can never let a module lapse (default ZEIT 10 s);
- if the app crashes, the head unit restarts, or the link drops, the lights return to OEM within ZEIT;
- *Custom off* / *Restore OEM* writes `ZUSTAND 0, ZEIT 0` to every driven module (instant, verified)
  and stops the loop;
- nothing persistent is touched: no coding, no settings in the BDC, no flash.

### Factory controls stay authoritative

- The app starts in OEM control after every start; custom control is never remembered across restarts.
- The OEM brightness and on/off are left alone (no `D519`, no `4804` writes). While the actuator is
  active the BDC is being told what to show by diagnostics, so the OEM state is overridden *for those
  slaves, for ZEIT*; whether a "lighting off" in iDrive wins over the actuator is **unknown** and is one
  of the first things to observe (NEXT_STEPS.md). Disabling custom control hands everything back.
- Custom control can only be switched on while parked (speed signal ≤ 3 km/h via the kit's `parked.js`);
  once on, driving does not switch it off (no change of lighting while driving).

## 3. The control paths, as ranked by the brief

| # | Approach | Status | Evidence |
|---|---|---|---|
| 1 | Native SOME/IP lighting service | **Unknown** | No public source; `lighting_someip.js` probes candidate names; `tools/laptop/catalog_search.py` over the unit's `someip-interfaces.json` will settle it. If a writable colour field exists it would be the preferred path (no diagnostics, no timeout). |
| 2 | MGU → BDC diagnostics (`2E DA5E` over TASU) | **Documented, unverified on a car; implemented and gated** | SGBD BDC_G05 `INNENLICHT_FI_LIN_1_LAYERING_STEUERN`; TASU precedent for `2E` writes; address 0x40. |
| 3 | Runtime preset override (rewrite a library colour) | **Not pursued** | 360A is coding data: writing it needs the coding session and security access, and it is persistent; it cannot be "temporary" and would be a recode per colour change. It remains the fallback for a *fixed* custom palette through the stock menu (10 slots). |
| 4 | Alternative | **Available if 2 fails** | `2E 4804` (function modes: Ambient Light - On for a time) and `2F 4800` (PWM % per channel) give on/off and brightness, not colour. A fixed palette via Approach 3 plus the stock menu is the colour fallback. |

## 4. Input and rendering on the head unit

- Full-screen layout on the kit renderer (mgu-render/1 dialect with touch routing): taps land on the
  page (`ctx.onTap`, the wheel and the value slider), on-page buttons are targets the touchscreen and
  the iDrive knob reach; the knob can also be grabbed to turn hue / saturation / value directly
  (setting *iDrive knob turns*; needs the controller gate `mgu-inputgate.so`).
- Standard layout / software renderer: the HMI's four bar buttons (Custom on/off, Restore OEM, Next
  page, Settings) and the Hue/Saturation/Value settings still control everything, without the wheel's taps.
- The wheel is 24 ramped arcs in a cached layer (no pixel images: the Store renderer has none).

## 5. The laptop side

`tools/laptop/enetdiag`: ENET cable → UDP 6811 discovery → TCP 6801 HSFZ → UDS `0x22` only. It
identifies the gateway, MGU and BDC (`F150`, `F101`, ...), reads the BDC's interior-light identifiers
(`DA5F`, `E3D1`, `4800`, `2300`) and writes a redacted JSON report whose `analysis` block states whether
the car is a documented variant with RGB slaves, i.e. whether a gated write test is justified.
