# INSTALLATION.md

## 1. Laptop: build and test (done, no car)

Requirements: Git, Python 3.9+, Node.js 18+ (the app itself targets the head unit's Node 8).

```
git clone https://github.com/cauliflowermossgrape/idrive7-apps ../research/cauliflowermossgrape_idrive7-apps
npm test
npm run test:py
npm run preview
```

## 2. Prerequisites on the car side (not done; each is a deliberate step)

1. **Root SSH on the MGU**: `idrive7-8-ssh-root` (`python gui.py` or `ssh_enable.py`). Its one-time
   `flash` reprograms the head unit: **it wipes the head unit's coding (CAFD) and the BMW Digital Key
   pairings** (its README, issue #13). Before it: export the MGU coding with BimmerCode (or E-Sys),
   and expect to re-pair digital keys. `status`, `enable`, `persist`, `close` do not reprogram.
   ROLLBACK.md has the backup list.
2. **The MGU App Kit's platform pieces**: either the Store (`mgu-store`, `first-install` over SSH:
   Store app, updater, deploy tool, renderer) or the kit's `deploy-car.sh install` (provisioning hook,
   `mgu-renderd`, controller gate). The app needs the **renderer with touch routing** for the wheel's
   taps (mgu-render/1 dialect: the Store's `mgu-render` or the kit's `idrive7-renderd` 2.x) and the
   **controller gate** (`mgu-inputgate`) for the knob; without them the app still works through the
   HMI's bar buttons and the Settings sliders.
3. **The real `oap-sdk`**: extracted from your own unit, never shared:
   ```
   scp root@<mgu>:/var/opt/public/oap/oap_12204/source/javascript/app.js x_call-app.js
   node ../research/cauliflowermossgrape_idrive7-apps/kit/tools/extract_sdk.js x_call-app.js ../research/cauliflowermossgrape_idrive7-apps/oap-sdk
   ```
   (`/usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz` works too.) The Store's "Releases" layout
   does not need it at all: a `.tgz` **without** `node_modules/oap-sdk` gets one generated on the unit.
4. **The catalog** (optional, for Approach 1): `scp root@<mgu>:/etc/oap/someip/someip-interfaces.json .`
   then `python tools/laptop/catalog_search.py someip-interfaces.json`. Also `kit/tools/check_signals.py`
   with it at `reference/someip-interfaces.json` to validate `app.json`'s signal flags (the installer
   refuses an `r` flag on a field without a getter; the app's FrontCCU/Vehicle2 entries are marked
   `_optional`, so a unit lacking them still installs it).

## 3. Build the package

```
python scripts/build_app.py          # -> dist/ambient_rgb@0.1.0.mgu and .tgz
```

With the real SDK in `../research/cauliflowermossgrape_idrive7-apps/oap-sdk/` the `.mgu` is installable;
with the placeholder it is not (a `dist/PLACEHOLDER_SDK.txt` marker says so).

## 4. Install (choose one)

**A. The kit's installer (SSH, from Windows):**
```
cd ../research/cauliflowermossgrape_idrive7-apps
deploy\make-car-kit.cmd ambient_rgb
powershell -File deploy\push-to-car.ps1 check      # HU=root@<unit> KEY=<key>
powershell -File deploy\push-to-car.ps1 install    # backs up, installs, restarts the app platform
```
(`sh deploy-car.sh check` on the unit lists every file it would touch before anything changes.)

**B. The Store:** publish `ambient_rgb@0.1.0.tgz` (SDK removed) as a GitHub release of your own
repository, add that repository as a source in the Store, install from the car's screen. The Store
snapshots before every install and offers Remove.

The tile appears under Apps as **Ambient RGB** after the platform restart (1-2 min).

## 5. First start on the car

The app starts with **Lighting link = Simulated BDC** and **Write to the car = Disarmed**. Open
Settings:
1. *Lighting link* → *Car: BDC over diagnostic link*. The Diagnostics page then shows what the BDC
   answered: variant (`0F2680 BDC_G05` expected), the LIN slaves with locations, "not armed: dry runs".
2. Leave *Write to the car* disarmed until the car tests in NEXT_STEPS.md are done. Pressing *Apply to
   lights* while disarmed logs the exact bytes it would send (`data/ambient_rgb.log`) without sending.

## 6. Uninstall

Kit: `sh mgu-app-install.sh uninstall ambient_rgb` (or `deploy-car.sh restore` for everything back to
stock). Store: *Installed → Ambient RGB → Remove*. Nothing in the car outside the app's own folder
(`/var/opt/public/oap/oap_<uid>/`) is changed by the app; the lights revert within ZEIT by themselves.
