# PROTOCOL_FINDINGS.md: the register

Status words: **VERIFIED** (seen on a car, by this project or a cited one), **DOCUMENTED** (in a
public description, not yet seen on this car), **ASSUMED** (an inference this project makes and marks),
**UNKNOWN**.

## 1. Transport: MGU diagnostic gateway (TASU)

| Item | Value | Status | Source |
|---|---|---|---|
| SOME/IP service | `com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu`, instance `SystemFunctionsInternalTasuInst1` | VERIFIED (shipped apps) | idrive7-apps `kit/runtime/diag.js` |
| Request | method `sendTasuRequest { sourceAddress: 0xF2, targetAddress, serviceID, subroutineID: 0, udsDataLength, udsData, deadlockTime: 0 }` | VERIFIED | same |
| Reply | event `sendTasuResponse { udsResponse, errorCode }`; frame `[2]==0x7F` transport reject (code `[4]`), `[6]` ECU address, UDS from `[9]` | VERIFIED | same |
| Functional address | `0xDF` (one reply per ECU) | VERIFIED | same |
| Services known to pass | `0x19`, `0x14`, `0x22`, `0x2E`, `0x2F`, `0x10 03` (to DME `0x12`, DSC `0x29`, VIP `0x39`, LMV `0x19`) | VERIFIED | `apps/dtc_scanner`, `apps/live_adjustments` |
| Busy verdict | `APP_REQUEST_TEMPORARILY_NOT_ACCEPTED` → retry with growing pause | VERIFIED | `diag.js` |
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

`ARG_0xE3D1_D` (bus 2) is identical except `HELLIGKEIT` 0..255. `RES_0xE3D1_D` returns, per slave:
`STAT_SLAVE_VERBAUORT_NADn`, `STAT_LED_BLUE_NADn_WERT`, `STAT_LED_GREEN_NADn_WERT`, `STAT_LED_RED_NADn_WERT`,
`STAT_BRIGHTNESS_NADn_WERT` (so a read-back of what each slave shows). `RES_0xDA5F_D`:
`STAT_SLAVE_VERBAUORT_NAD1 .. NAD52`, each from `TAB_INNENLICHT_VERBAUORT_LIN` (location names, see
`lighting_protocol.js LOCATION`). `RES_0x4800_D`: PWM % of `INNENLICHT_WBL_LED`, `INNENLICHT_LCI_0..8`,
`SPECIAL_FUNCTION_LED`, `SST_LED`, `MSA_LED`. `TAB_INNENLICHT_FUNKTIONSMODI` includes `0x1C Ambient Light -
On`, `0x1D Light Sword - On`, `0x20 Welcome Approaching Light - On`, `0x21 Welcome Unlock - On`, `0x22 Goodbye`.

### 2.2 The request this project sends (Approach 2)

```
target 0x40, service 0x2E:  DA 5E <NAD> <ZUSTAND> <HELLIGKEIT> <ROT> <GRUEN> <BLAU> <ZEIT>
e.g.                        2E DA 5E 01 01 64 D7 6E 14 0A     (slave 1, on, 100 %, bronze, 10 s)
expected positive reply:    6E DA 5E
release:                    2E DA 5E <NAD> 00 00 00 00 00 00  (ZUSTAND 0, ZEIT 0)
```

| Aspect | Status | Note |
|---|---|---|
| DID and service | DOCUMENTED | row above |
| Byte order = ARG table order, one byte each | ASSUMED | the same assumption `kit/tools/sgbd_catalog.py` makes for RES tables (fields "in byte order"); verify with the `6E` reply and a `22 E3D1`/visual check |
| NAD numbering = slave position in `DA5F` (NAD1 = first byte) | ASSUMED | the RES names say `NADn`; ARG allows 0..31 while RES lists up to 52: to be reconciled on the car |
| `NAD 0` = broadcast / all slaves? | UNKNOWN | the G11 description ("all slaves ... full brightness") suggests an all-slaves form exists in older variants; test last, if at all |
| Session: default or `10 03` | UNKNOWN | the controller retries once after NRC `7E`/`7F` with `10 03` (as `live_adjustments` does for the DSC) |
| Security access (`27`) required? | UNKNOWN | an NRC `33` would say so; this project does **not** implement `27` |
| Effect on the OEM state (lighting off, brightness, "reduced while driving") | UNKNOWN | observe during the first test |
| Brightness semantics (`HELLIGKEIT` 0..100 vs RGB 0..255) | DOCUMENTED | the app sends 100 % and puts the colour into R/G/B |
| `ZEIT 0` with `ZUSTAND 0` releases the slave | ASSUMED | plausibly "deactivate"; also the timeout path exists regardless |

### 2.3 Other variants (for the variant gate)

| SGBD index | SGBD | `DA5E` | Verdict |
|---|---|---|---|
| `0F2680` | BDC_G05 (BDC-03, SP18) | `INNENLICHT_FI_LIN_1_LAYERING_STEUERN` with R/G/B | documented RGB actuator |
| `0F2050` | BDC_G11 | `LAYERING_LIN_EIN`: `ID` 0..31 + `HELLIGKEIT` 0..100, "all slaves at full brightness for the time" | legacy: no colour |
| `0F19C0` | bdc | `DA62 LAYERING_LIN_EIN`, same idea | legacy |
| this car | **UNKNOWN** until `22 F1 50` to `0x40` | | the app refuses writes unless `documented` (setting *Allow unknown BDC variant* overrides, not recommended) |

## 3. Identification and read-only identifiers (laptop tool and app probe)

| DID | Meaning | Status |
|---|---|---|
| `F150` | SGBD index (3 bytes) | VERIFIED (kit, all units) |
| `F101` | SVK (8-byte records: type 1 HWEL, 5 CAFD, 6 BTLD, 8 SWFL, 13 SWFK) | VERIFIED (ssh-root on the MGU) |
| `F190`, `F18C`, `F191`, `F195` | VIN, serial, HW, SW numbers | ISO standard; VIN/serial redacted in reports |
| `172A` (MGU) | IP configuration (four IPv4, the second is the gateway) | VERIFIED (ssh-root) |
| `DA5F`, `E3D1`, `4800`, `2300` (BDC) | see §2 | DOCUMENTED |
| `D5D3` (BDC_G11 `AMBIENTE_BELEUCHTUNG`: on/off + %) | | DOCUMENTED for G11; read as a harmless probe (NRC 31 expected on G05) |

## 4. Coding path (Approach 3, not used at runtime)

| Item | Value | Status |
|---|---|---|
| ECU / section | `BDC_BODY3` → `360A` `LIC_LCI_COLOR_LIBRARY_DATA`, `360D` `LIC_LCI_COLOR_PROFILES_DATA`; BimmerCode entry `G20G21G26G28G80_Lichpaket_code1` | DOCUMENTED (community) |
| Colour bytes | triplets at 18-20 (doors/dash), 23-25 (footwells), 28-30 (map light) in one G20/G8X layout; `FF` folded to `FE` by the community tool | Low/Medium: differs by model and software; read before writing |
| Profiles | pairs of bytes per iDrive menu entry (e.g. bytes 2/3, 16/17 in a G20 example); "byte 97 must be 01" (G80 guide) | Low |
| Library values | White `90E090`, Bronze `D76E14`, Orange `931A01`, Blue `0020FE`, Green `10FE32`, Violet `783CFE` | Medium |
| Runtime use | needs the coding session + security access, persistent, not reversible by timeout: **not** a runtime path | |

## 5. SOME/IP (Approach 1)

| Item | Status |
|---|---|
| Any lighting interface / field / method on the MGU | UNKNOWN: none in idrive7-apps, mgu-store, idrive-apps, the web; the master catalog `/etc/oap/someip/someip-interfaces.json` must be searched (`tools/laptop/catalog_search.py`) |
| Candidate names probed by `lighting_someip.js` | guesses only (`de.bmw.infotainment.vehicle.AmbientLight`, `...InteriorLight`, `de.bmw.body.ambientlight.AmbientLight`, ...): their absence proves nothing |

## 6. ENET / HSFZ (laptop)

| Item | Value | Status |
|---|---|---|
| Discovery | UDP 6811, probe `00 00 00 00 00 11`, reply `...BMWVIN<17>` | VERIFIED (ssh-root, klartext) |
| Diagnostics | TCP 6801, frame `u32 len, u16 type, src, dst, payload`; type 1 diag, 2 ack, 0xFF reject; tester `0xF4` | VERIFIED (ssh-root on MGU cars, klartext on F cars) |
| DoIP (13400) on this gateway | UNKNOWN; not needed while 6801 answers |

## 7. NRCs this project interprets

`21 busy` (counted, continue), `22 conditionsNotCorrect`, `31 requestOutOfRange` (bad DID/NAD), `33
securityAccessDenied` (stop: unlock not implemented), `7E`/`7F` (open `10 03` once, retry), `78` pending
(wait), `13` length (byte-order or count wrong: stop and reconsider the ASSUMED items).
