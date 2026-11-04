# PROTOCOL_FINDINGS.md: the register

Status words: **VERIFIED** (seen on a car, by this project or a cited one), **DOCUMENTED** (in a
public description, not yet seen on this car), **ASSUMED** (an inference this project makes and marks),
**UNKNOWN**.

## 0. Verified on this car (read-only scans, 2026-11-04)

Two sessions over ENET with `tools/laptop/enetdiag` (UDS 0x22 only; redacted reports in
`tools/laptop/out/`, not in git).

| Item | Result | Status |
|---|---|---|
| Gateway | UDP 6811 identification answered; HSFZ on TCP 6801 at 169.254.49.66; works without Administrator | VERIFIED |
| Units answering `22 F1 50` (functional) | 0x10 BDC gateway `0F25F0`, 0x37 RAM `0F2590`, **0x40 BDC body `0F2680`**, 0x60 KOMBI `0F2710`, 0x61 ATM `0F2760`, 0x63 MGU `0F25B0`, 0x67 ZBE `0F2690`, 0x78 IHKA `0F2830` | VERIFIED |
| **BDC body variant** | `0F2680` = **BDC_G05**, the SGBD that documents the RGB layering actuator; SVK includes `CAFD 000051DD` (the coding file the forums name for `360A LicLciColorLibrary`), `BTLD 00005F9E`, `SWFL 00005F9F` | VERIFIED |
| MGU | `0F25B0` (HU_MGU); `BTLD 00003F36` (the bootloader the SSH tool lists as a supported MGU); `22 17 2A` → own IP 169.254.170.184 | VERIFIED |
| `22 DA 5F` (FI-LIN-1 layering status) | answers **pending (7F 22 78) first**, the reply follows after a few seconds (the BDC polls its LIN slaves); 26 ten-byte records + 1 trailing byte (`02`); **7 slaves**: NAD 1 map pocket passenger door front (0x0F), 2 door opener passenger front (0x0E), 3 contour line passenger door front (0x0C), 4 map pocket passenger rear (0x12), 5 door opener passenger rear (0x22), 6 contour line passenger door rear (0x10), 7 footwell passenger rear (0x04) | VERIFIED |
| `22 E3 D1` (FI-LIN-2 layering status) | same layout; **12 slaves**: NAD 1 contour line dashboard centre (0x15), 2 dashboard passenger (0x17), 3 dashboard driver (0x13), 4 footwell driver front (0x01), 5 footwell passenger front (0x03), 6 map pocket driver door front (0x08), 7 door opener driver front (0x07), 8 contour line driver door front (0x05), 9 map pocket driver rear (0x0B), 10 door opener driver rear (0x21), 11 contour line driver door rear (0x09), 12 footwell driver rear (0x02) | VERIFIED |
| Record layout `RES_0xDA5F_D` / `RES_0xE3D1_D` | per NAD: Verbauort, **LED blue, LED green, LED red**, brightness, white (footwell) LED, short-circuit, over-temperature, open-load, internal fault; empty slot `FF FF FF FF 7F 03 07 07 07 07` | VERIFIED (matches the reference row for row) |
| Colour read-back | every one of the 19 modules: **blue 254, green 60, red 120, brightness 100**, white 0, no faults = the library "Violet" (`78 3C FE`) byte for byte; the iDrive menu was on Violet | VERIFIED: the read-back works and the published library values are what the BDC drives |
| `22 48 00` (interior-light PWM %) | WBL_LED 4, LCI_0 89, LCI_1..8 0, SPECIAL 0, **MSA_LED 92**, SST 0 (13 bytes, as RES_0x4800_D) | VERIFIED (the meaning of LCI_0/MSA at these values is not) |
| `22 23 00` (FASTA) | ~290-byte record; its **last 52 bytes are the 26 + 26 slave locations** in NAD order (agrees with DA5F/E3D1); the leading counters are longer than the rows parsed so far: decode TENTATIVE | VERIFIED (slave list) / TENTATIVE (counters) |
| `22 D5 D3` | NRC 31 (not on BDC_G05, as expected) | VERIFIED |
| Busy behaviour | a read sent while the BDC is still polling LIN for a previous DA5F/E3D1 gets **NRC 21 busy**: serialise and wait for pending | VERIFIED |

What follows from this for the app: 19 RGB modules; bus 1 written with `2E DA5E`, bus 2 with
`2E E3D1` (NAD 1..7 and 1..12 respectively); a status read takes seconds and must not be issued
while another is pending; the `HELLIGKEIT` value the BDC reports is 100 on both buses even though the
ARG table caps bus 1 at 100 and bus 2 at 255.

### 0.1 The write, verified (2026-11-04, `tools/laptop/write_test.py`, one frame per step, each approved)

| Frame to 0x40 | Reply | Read-back `22 DA 5F` ~1 s later | Seen |
|---|---|---|---|
| `2E DA 5E 01 01 64 FF 00 00 05` (OEM lighting on) | `6E DA 5E`, 421 ms, **default session** | NAD 1 unchanged, Violet @100 | no change |
| same again; `2E DA 5E 03 01 64 FF 00 00 05` (OEM on) | `6E DA 5E` | unchanged | no change |
| OEM ambient lighting switched **off** in iDrive: `22 DA 5F` | | every module brightness **0**, colour bytes still `FE 3C 78` | dark |
| `2E DA 5E 03 01 64 FF 00 00 05` (OEM off) | `6E DA 5E` | NAD 3 **brightness 100**, others 0, colour unchanged | **lit, Violet** |
| `2E DA 5E 03 01 64 00 FF 00 05` (OEM off) | `6E DA 5E` | NAD 3 **rgb 0 255 0 @100** | **lit green** |
| `2E DA 5E 03 01 64 FE 00 00 05` (OEM off) | `6E DA 5E` | NAD 3 **rgb 254 0 0 @100** | (red) |

Established by this:
- **`2E DA5E` is accepted in the default session; no `10 03`, no security access.**
- **The argument order is the ARG table order**: NAD, ZUSTAND, HELLIGKEIT, ROT, GRUEN, BLAU, ZEIT, one byte each. The module lit at the brightness sent; the colour bytes are applied and the status read reports the live LEDs.
- **A colour byte of `0xFF` is "no change"**: `FF 00 00` left the colour as it was; `FE 00 00` gave red. Colour bytes are capped at `0xFE` in `lighting_protocol.js`, the mock and `write_test.py` (the community coding tools fold FF to FE for the same reason).
- NAD n in the write = record n of `22 DA 5F` (NAD 3 = the passenger front door contour line, as listed).
- The module lit ~1 s after the request and the status showed it still driven a second later; the ZEIT timeout itself (return to OEM after 5 s) was not read back and should be confirmed with one `22 DA 5F` after the time.
- **The actuator overrides the OEM function while it is on**: with the ambient lighting switched back on (library White `90 E0 90` on every module), `2E DA 5E 03 01 64 FE 00 00 05` read back NAD 3 at `254 0 0 @100` while the other modules stayed White. The three earlier "no change" results with OEM on had sent `FF 00 00` (no colour change) and were inconclusive. **The app needs no OEM precondition.**
- **Colour cycle seen by eye**: seven writes to NAD 3 three seconds apart (red `FE0000`, orange `FE6000`, yellow `FEFE00`, green `00FE00`, cyan `00FEFE`, blue `0000FE`, magenta `FE00FE`, ZEIT 5), all `6E DA 5E`, the contour line stepped through every colour and returned to white by itself. **The control path of this project is verified on the car.**
- The ~430 ms per exchange in the first logs was the tool's 400 ms quiet window; `write_test.py` now returns as soon as the BDC's reply is in, so later logs show the real latency.
- **Bus 2 verified**: `2E E3 D1 01 01 64 FE 00 00 05` (dashboard centre line) → `6E E3 D1` in **14 ms**, read-back `254 0 0 @100` with the other modules White. Brightness 100 works on bus 2 as on bus 1 (the OEM function also drives bus 2 at 100, so the ARG table's 0..255 is not the practical range).
- **Latency: 14 ms per write** once the tool stops waiting for a quiet window. A round over all 19 modules is therefore ~0.3 s over ENET; the head unit's TASU path is expected to be of the same order.
- **Release frame verified**: `2E E3 D1 01 01 64 FE 00 00 0A` (red, 10 s) then after 3 s `2E E3 D1 01 00 00 00 00 00 00` → `6E E3 D1` in 15 ms and the read-back showed the module back at the OEM White `144 224 144 @100` at once, long before the 10 s would have lapsed. **ZUSTAND 0 / ZEIT 0 hands the module straight back to the OEM function**: the app's Custom off / Restore OEM is immediate.
- **The dashboard line is three modules** (bus 2 NAD 1 centre, 2 passenger, 3 driver): a write to NAD 1 alone changed only the centre segment; writes to all three (`2E E3 D1 0n 01 64 FE 00 00 05`, accepted in 0 ms each) changed the whole strip. The same split applies to every door (contour line, door opener, map pocket): the app writes all 19 modules per round.
- **BDC fault memory after 16 writes: empty** (`59 02 4F`, same as the baseline). The actuator leaves no stored fault.
- Not yet tried: brightness other than 100, NAD 0, a `22 DA 5F` after ZEIT to see the timeout return in the data (seen by eye only).

## 1. Transport: MGU diagnostic gateway (TASU)

| Item | Value | Status | Source |
|---|---|---|---|
| SOME/IP service | `com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu`, instance `SystemFunctionsInternalTasuInst1` | VERIFIED (shipped apps) | idrive7-apps `kit/runtime/diag.js` |
| Request | method `sendTasuRequest { sourceAddress: 0xF2, targetAddress, serviceID, subroutineID: 0, udsDataLength, udsData, deadlockTime: 0 }` | VERIFIED | same |
| Reply | event `sendTasuResponse { udsResponse, errorCode }`; frame `[2]==0x7F` transport reject (code `[4]`), `[6]` ECU address, UDS from `[9]` | VERIFIED | same |
| Functional address | `0xDF` (one reply per ECU) | VERIFIED | same |
| Services known to pass | `0x19`, `0x14`, `0x22`, `0x2E`, `0x2F`, `0x10 03` (to DME `0x12`, DSC `0x29`, VIP `0x39`, LMV `0x19`) | VERIFIED | `apps/dtc_scanner`, `apps/live_adjustments` |
| Pending | `diag.js physical()` waits 10 s after a `7F xx 78`, which the BDC's DA5F/E3D1 reads need | VERIFIED (kit) | `diag.js` |
| `0x2E` to the BDC `0x40` | | UNKNOWN on this car (nothing in principle stops it) | |

## 2. BDC_G05 interior-light functions (SG_FUNKTIONEN, verbatim rows)

Source: https://emdzej.github.io/ediabasx-docs-sgbd/sgbd/BDC_G05/ (parsed locally; the page is 2.2 MB).
Columns: ARG | ID | RESULTNAME | INFO | ... | SERVICE | ARG_TABELLE | RES_TABELLE.

```
INNENLICHT_ILE                        | 0xA621 | Routine job für ILE (Innenlichteinheit).                       | 31    | ARG_0xA621_R | RES_0xA621_R
INNENLICHT_HELLIGKEIT                 | 0xD519 | Offset der Helligkeit des Ambientlicht                          | 2E    | ARG_0xD519_D | -
INNENLICHT_FI_LIN_1_LAYERING_STEUERN  | 0xDA5E | Ansteuerung der FI_LIN-Layering Slaves.                         | 2E    | ARG_0xDA5E_D | -
INNENLICHT_FI_LIN_1_LAYERING          | 0xDA5F | Es wird der Status der LIN Slaves im Layering System abgefragt  | 22    | -            | RES_0xDA5F_D
INNENLICHT_FI_LIN_2_LAYERING          | 0xE3D1 | Innenlicht Andere Bus Layering                                  | 22;2E | ARG_0xE3D1_D | RES_0xE3D1_D
INNENLICHT_FASTA_DATEN                | 0x2300 | FASTA Daten des Lichtschwerts, der Panoramadachbeleuchtung und der ambienten Beleuchtung | 22 | - | RES_0x2300_D
_INNENBELEUCHTUNG_PWM                 | 0x4800 | Ansteuerung und Auslesen den Innenlicht (PWM in %).             | 22;2F | ARG_0x4800_D | RES_0x4800_D
_INNENLICHT_FUNKTIONSMODI             | 0x4804 | Steuerung der Funktions-Modi für Innenlicht.                    | 2E    | ARG_0x4804_D | -
```

### 2.1 `ARG_0xDA5E_D` (the RGB actuator, bus 1), verbatim

```
ARG              | EINHEIT | DATENTYP      | MIN | MAX   | INFO
NAD              | -       | unsigned char | 0   | 31    | NAD des RGB-LIN-Slaves
ZUSTAND          | 0/1     | unsigned char |     |       | 0: deaktivieren 1: aktivieren
HELLIGKEIT       | -       | unsigned char | 0   | 100   | elektrische Helligkeit aller Grundfarben
HELLIGKEIT_ROT   | -       | unsigned char | 0   | 255   | Helligkeit Rot
HELLIGKEIT_GRUEN | -       | unsigned char | 0   | 255   | Helligkeit Grün
HELLIGKEIT_BLAU  | -       | unsigned char | 0   | 255   | Helligkeit Blau
ZEIT             | s       | unsigned char | 0   | 254   | Aktivierungszeit in Sekunden 0...254s
```

`ARG_0xE3D1_D` (bus 2) is identical except `HELLIGKEIT` 0..255. The RES tables (§0) are now verified.

### 2.2 The request this project sends (Approach 2)

```
target 0x40, service 0x2E:  DA 5E <NAD> <ZUSTAND> <HELLIGKEIT> <ROT> <GRUEN> <BLAU> <ZEIT>     (bus 1, NAD 1..7)
                            E3 D1 <NAD> <ZUSTAND> <HELLIGKEIT> <ROT> <GRUEN> <BLAU> <ZEIT>     (bus 2, NAD 1..12)
e.g.                        2E DA 5E 01 01 64 D7 6E 14 0A     (bus 1 slave 1 = map pocket passenger front, on, 100, bronze, 10 s)
expected positive reply:    6E DA 5E
release:                    2E DA 5E <NAD> 00 00 00 00 00 00  (ZUSTAND 0, ZEIT 0)
```

| Aspect | Status | Note |
|---|---|---|
| DID and service | DOCUMENTED | row above |
| Byte order = ARG table order, one byte each | ASSUMED, strengthened | the RES tables decoded byte for byte in table order on the car; the ARG side has not been exercised |
| NAD numbering = record position in `DA5F` / `E3D1` (NAD1 = first record) | ASSUMED, strengthened | the FASTA tail lists the same 26 + 26 positions |
| Which DID for which module | VERIFIED (status side) | bus 1 = 7 passenger-side modules; bus 2 = dashboard + front footwells + driver side |
| Session: default or `10 03` | UNKNOWN | the controller retries once after NRC `7E`/`7F` with `10 03` |
| Security access (`27`) required? | UNKNOWN | an NRC `33` would say so; not implemented |
| Effect on the OEM state (lighting off, brightness, "reduced while driving") | UNKNOWN | observe during the first test |
| `ZEIT 0` with `ZUSTAND 0` releases the slave | ASSUMED | the timeout path exists regardless |

### 2.3 Other variants (for the variant gate)

| SGBD index | SGBD | `DA5E` | Verdict |
|---|---|---|---|
| **`0F2680`** | **BDC_G05 (this car)** | `INNENLICHT_FI_LIN_1_LAYERING_STEUERN` with R/G/B | documented RGB actuator |
| `0F2050` | BDC_G11 | `LAYERING_LIN_EIN`: `ID` 0..31 + `HELLIGKEIT` 0..100, all slaves full brightness | legacy: no colour |
| `0F19C0` | bdc | `DA62 LAYERING_LIN_EIN`, same idea | legacy |

## 3. Identification and read-only identifiers

| DID | Meaning | Status |
|---|---|---|
| `F150` | SGBD index (3 bytes) | VERIFIED on this car (8 units) |
| `F101` | SVK (8-byte records: 1 HWEL, 2 ?, 5 CAFD, 6 BTLD, 8 SWFL, 13 SWFK) | VERIFIED on this car (type 2 records also present, not decoded) |
| `F190`, `F18C` | VIN, serial: answered; **always redacted** in reports and logs (also as hex) | VERIFIED |
| `F191`, `F195` | NRC 31 on gateway, MGU and BDC | VERIFIED |
| `172A` (MGU) | IP configuration | VERIFIED |
| `DA5F`, `E3D1`, `4800`, `2300` (BDC) | §0 | VERIFIED |

## 4. Coding path (Approach 3, not used at runtime)

| Item | Value | Status |
|---|---|---|
| ECU / section | `BDC_BODY3` → `360A` `LIC_LCI_COLOR_LIBRARY_DATA`, `360D` `LIC_LCI_COLOR_PROFILES_DATA`; BimmerCode entry `G20G21G26G28G80_Lichpaket_code1`; this BDC carries `CAFD 000051DD` | DOCUMENTED (community) + the file's presence VERIFIED |
| Colour bytes | triplets at 18-20 (doors/dash), 23-25 (footwells), 28-30 (map light) in one G20/G8X layout; `FF` folded to `FE` by the community tool | Low/Medium |
| Library values | White `90E090`, Bronze `D76E14`, Orange `931A01`, Blue `0020FE`, Green `10FE32`, **Violet `783CFE` (seen live on all 19 modules)** | Violet VERIFIED, the rest Medium |
| Runtime use | needs the coding session + security access, persistent, not reversible by timeout: **not** a runtime path | |

## 5. SOME/IP (Approach 1)

| Item | Status |
|---|---|
| Any lighting interface / field / method on the MGU | UNKNOWN: the master catalog `/etc/oap/someip/someip-interfaces.json` must be searched (`tools/laptop/catalog_search.py`) |

## 6. ENET / HSFZ (laptop)

| Item | Value | Status |
|---|---|---|
| Discovery | UDP 6811, probe `00 00 00 00 00 11`, reply `...BMWVIN<17>` | VERIFIED on this car |
| Diagnostics | TCP 6801, frame `u32 len, u16 type, src, dst, payload`; type 1 diag, 2 ack, 0xFF reject; tester `0xF4`; the gateway acks each request with a type-2 frame | VERIFIED on this car |
| Pending | `7F 22 78` then the reply seconds later (BDC LIN polls) | VERIFIED on this car |

## 7. NRCs this project interprets

`21 busy` (retry after a second; seen while a LIN poll was pending), `22 conditionsNotCorrect`, `31
requestOutOfRange` (bad DID/NAD; seen for F191/F195/D5D3), `33 securityAccessDenied` (stop), `7E`/`7F`
(open `10 03` once, retry), `78` pending (wait, seen), `13` length (byte order or count wrong: stop).
