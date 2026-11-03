# ROLLBACK.md: backups, removal, recovery

## 1. What is a backup of what

| Backup | Covers | Does **not** cover | How |
|---|---|---|---|
| **Coding backup** (BimmerCode export, E-Sys "Read Coding" / NCD save, ISTA/E-Sys backup) | the FDL/VO coding (CAFD data) of the head unit and the BDC | firmware, Digital Key pairings, personal settings, the app platform's files | before the SSH `flash`, and before any coding; one per ECU |
| **FA / SVT** (E-Sys: read FA and SVT, save; `enetdiag scan` records the SVK versions) | which software and hardware versions each ECU carries | the contents of those images | `tools/laptop`: the report's `svk` blocks per unit |
| **Platform file backup** (`deploy-car.sh install` → `backups/<time>/` and `/var/opt/public/mgu_custom_backup/<time>/`; the Store's snapshots) | every file the installer touches: `uids.txt`, the app registry, the MainApp patch, systemd drop-ins | anything else on the unit | automatic at install; `deploy-car.sh backups` lists them |
| **App configuration** | `data/settings.json`, `data/favourites.json` in `/var/opt/public/oap/oap_<uid>/` | | `scp` them off |
| **Full firmware image** | | | **Not provided by any tool here.** Neither BimmerCode nor the SSH tool makes a firmware image; do not treat a coding export as one. |

## 2. Risks, ranked

1. **Flashing the head unit** (`idrive7-8-ssh-root flash` / `fix-key`): wipes the MGU's coding and the
   Digital Key pairings; worst case bricks the unit. This project never flashes anything and never
   automates that step. Do it once, by hand, with a coding backup in hand and stable power.
2. **Platform modifications** (provisioning hook, renderer service, controller gate): reversible with
   `deploy-car.sh restore` / the Store's Remove; after a firmware update the hook stands down by itself.
3. **The app's writes**: non-persistent by construction (ZEIT timeout; release on Restore OEM). The
   remaining risk is an unexpected BDC reaction to `2E DA5E` (a DTC, a module that stays in the
   diagnostic state until the next sleep cycle); hence the stationary, gated first test.

## 3. Removing the app

- Stop driving the lights first: *Restore OEM* in the app, or just close the app (the loop stops, the
  BDC falls back within ZEIT).
- Kit: `sh mgu-app-install.sh uninstall ambient_rgb`, then `apply`. Store: Remove.
- Everything of the platform back to stock: `sh deploy-car.sh restore` (asks for YES; `deploy-car.sh
  backups` to pick one). It stops the platform, removes hook and apps, copies every touched file back
  from the stock backup, verifies them, restarts the HMI and the platform.

## 4. Recovery

| Situation | Do |
|---|---|
| The tile shows "Loading app" forever | read `/var/opt/public/oap/oap_<uid>/data/ambient_rgb.log`; `deploy-car.sh status` |
| The app vanished | MainApp's crash handler removed it after two crashes: fix, reinstall |
| The lights stay in the custom colour after closing the app | wait ZEIT (≤ 30 s). If they do not return: lock the car and let it sleep (the diagnostic actuation is not persistent); if they still do not, read the BDC fault memory (Fault Scanner app or ISTA) before anything else |
| A BDC fault is stored after a test | note the code; a diagnostic actuation can leave an entry; clear only after reading |
| The BDC answered NRC 33 | security access needed: stop; this project does not unlock ECUs |
| Firmware update later | the custom apps are hidden, nothing breaks; re-run install or reinstall from the Store |
| Lost SSH after a firmware update | `ssh_enable.py enable` (no flash) first; `flash` only if the debug image is gone, with the backups above |

## 5. Never

Code, flash or write to any ECU other than the BDC body's two documented lighting identifiers; use the
Fault Scanner's "clear all" during tests; test while driving or with the engine off on a weak battery.
