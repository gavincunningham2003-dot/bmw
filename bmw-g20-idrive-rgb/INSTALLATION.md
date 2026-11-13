# INSTALLATION.md: every step from the laptop to the lights

The app runs on the laptop today (`npm run emu`). Getting it onto the car is six parts; only parts B, D
and E touch the car, and each of those is a deliberate step taken with the car parked, ignition on, a
battery charger connected and the ENET cable in. Nothing here is done without the owner's explicit go.

## A. Before the car (laptop, once)

1. **Back up the head unit's coding.** Rooting the MGU (part B) flashes a debug image that **wipes the
   head unit's coding (CAFD) and the BMW Digital Key pairings**. Read and save the HU/MGU coding with
   BimmerCode (it keeps a backup of every module it writes) or E-Sys/ISTA. Expect to set up every phone
   Digital Key again afterwards. ROLLBACK.md has the full list.
2. **The tools are in place:** this repository, the MGU App Kit at
   `../research/cauliflowermossgrape_idrive7-apps`, the root-SSH tool at
   `../research/cauliflowermossgrape_idrive7-8-ssh-root` (`pip install -r requirements.txt`: one
   dependency, `cryptography`), Python 3 and Node.js, Windows' built-in OpenSSH (`ssh`, `scp`, `tar`).
3. **Run the laptop checks once more:** `npm test`, `npm run test:py`, `npm run emu`.

## B. Root SSH on the head unit (car, ENET cable, one time)

From `../research/cauliflowermossgrape_idrive7-8-ssh-root`:

1. `python ssh_enable.py status`: read-only; shows the software version, the unit's IP and the
   debug/SSH state. (Our MGU: `0F25B0`, bootloader `00003F36`, which the tool supports.)
2. `python ssh_enable.py flash --vin <VIN>`: **once per head unit.** Writes the small debug package,
   reboots the unit, enrols the SSH key and opens SSH. This is the step that wipes the coding and the
   Digital Keys. The key is saved at `data\enrollments\<VIN>\id_rsa`, the unit's IP in `connect.txt`
   beside it. (The GUI, `python gui.py`, does the same with the *Flash + Enable* button.)
3. `python ssh_enable.py persist`: SSH survives debug mode being switched off (and avoids the B7F8E5
   fault entry). Later sessions need only `python ssh_enable.py enable`.
4. Check: `ssh -i data\enrollments\<VIN>\id_rsa root@<unit-ip>` logs in.
5. If any function misbehaves or the coding looks reset, restore the saved coding to the head unit
   with the tool from A1, then re-pair the Digital Keys.

## C. BMW's app SDK and the package (laptop)

The build needs BMW's `oap-sdk`, which is inside every BMW app on the unit and must never be shared.

1. Copy the stock x_call app off the unit and extract the SDK into the kit:
   ```
   scp -i <key> root@<unit-ip>:"/usr/lib/oap-mainapp/preinstalled_apps/x_call@*.tgz" .
   mkdir x_call && tar xzf x_call@<version>.tgz -C x_call
   node ..\research\cauliflowermossgrape_idrive7-apps\kit\tools\extract_sdk.js x_call\javascript\app.js ..\research\cauliflowermossgrape_idrive7-apps\oap-sdk
   ```
   `oap-sdk/` is gitignored in the kit. Never commit it, never publish a `.mgu` that contains it.
2. Build this app: `python scripts/build_app.py` → `dist/ambient_rgb@<version>.tgz` and `.mgu`, checked. These
   are the **MGU Store release packages** (part H): the SDK is used for the build and is NOT inside them (the
   Store generates it on the head unit). Without the SDK the script stops and builds nothing. The kit's own
   `dist\ambient_rgb@<version>.mgu` in the kit checkout is the copy WITH your SDK inside, for the kit's
   installer in part D only: never publish or share that one.
3. Optional but worth it: `scp` the unit's `/etc/oap/someip/someip-interfaces.json` and run the kit's
   `kit/tools/check_signals.py` against it, so `app.json`'s signal flags are validated before the
   installer sees them (the app's FrontCCU and Vehicle2 entries are marked optional, so a unit without
   them still installs it, with the knob grab or the parking check missing and said so in the log).

## D. Install on the car (SSH, from Windows)

From `../research/cauliflowermossgrape_idrive7-apps`:

1. Pack the car kit with just this app (the installer, the GPU renderer with touch routing, the
   controller gate and the app): `python kit/tools/make_kit.py ambient_rgb` → `dist\mgu-custom-apps.tar.gz`.
2. Read-only check first, it lists every file the install would touch and stops if the firmware does
   not match:
   ```
   powershell -ExecutionPolicy Bypass -File deploy\push-to-car.ps1 check -Key <path>\id_rsa -Ip <unit-ip>
   ```
3. Install (backs up every file first, installs, restarts the app platform):
   ```
   powershell -ExecutionPolicy Bypass -File deploy\push-to-car.ps1 install -Key <path>\id_rsa -Ip <unit-ip>
   ```
   After 1-2 minutes the **Ambient RGB** tile appears under Apps. The controller gate (the knob for the
   wheel and dials) loads into the HMI at the next reboot or drive; until then the - / + buttons work.
4. On the unit, `sh /var/opt/mgu-custom-apps/deploy-car.sh status` shows the app running and
   `controller gate: loaded`.

## E. First use on the car

The app starts with **Lighting link = Simulated BDC** and **Write to the car = Disarmed**.

1. Settings → **Lighting link** → **Car: BDC over diagnostic link**. Leave Write to the car **Disarmed**.
2. Open **Diagnostics**: it must show the body controller variant `0F2680 BDC_G05` and the 19 modules
   with their locations. If it does not, the diagnostic gateway is not reaching the body controller:
   stop here and read the app log (`data/ambient_rgb.log`).
3. Press **Apply** once while disarmed: the log shows the exact bytes without sending them.
4. Settings → **Write to the car** → **Armed**. Car parked. Apply changes the lights; Restore OEM returns
   them at once; every write times out by itself within ten seconds if the app ever stops.

## F. Back out

- The app only: on the unit `sh mgu-app-install.sh uninstall ambient_rgb`.
- Everything the kit installed, back to stock from the first backup: `push-to-car.ps1 restore` (or
  `sh deploy-car.sh restore` on the unit, it asks for YES).
- SSH: `python ssh_enable.py close` (stop the service) or `disable` (revert persistence too). The debug
  flash itself stays; nothing in this project reverses it.
- The lights: nothing persists in the body controller; they revert within ZEIT by themselves.

## G. 0.4.0: what to switch on, and in which order

Everything new in 0.4.0 is off or on its safe value after an install. Switch things on one at a time, parked:

1. **First use as in part E.** (0.5.3: the setting is now *How animations are written*; still colours are
   always written one module at a time.) From 0.5.1 *Writes to the car* starts on *Whole bus where it saves writes*
   (seen on this car from the laptop on 2026-11-12); *One per module* is the setting to fall back on.
2. **The whole-bus write**, from the laptop if you want to see it first: `python write_test.py --gateway <ip> broadcast --bus 1 --rgb 00FE00`
   and the same with `--bus 2`. In the app the Diagnostics page counts the whole-bus writes and lists a
   module that needed its own write ("single for"); if the car ever refuses one, the app goes back to single
   writes by itself and says so there.
3. **Read-back**: apply a colour, wait two seconds, and check Diagnostics reports 19 read back ok (with
   whole-bus writes the read-back runs by itself, in the background; Apply does not wait for it).
4. **Factory lighting off** and **lock and leave**: with a colour applied, switch the factory ambient lighting
   off, then lock the car and walk away. Each must release the lighting (Diagnostics, "Gate"). Only after this
   raise the hold time (ZEIT) above 10 s.
5. **Driving modes**: open the Driving page, change the driving mode in the car and read what "The car says"
   shows for each mode. Only when the names match what you picked, set choices and switch *Follow driving mode* on.
   The parked rule still applies: while driving, a mode change is noted and not applied.

Build, test and install commands are unchanged: `npm test`, `npm run test:py`, `python scripts/build_app.py`,
then part D.

## H. 0.5.2: install through MGU Store (the preferred way)

[MGU Store](https://github.com/robertnisipeanu/mgu-store) is an app on the head unit that installs other apps
from GitHub releases. This is the way that gives the app its **background start** (the Store's installer lists
it with `appStartType: autostart`; the kit's installer in part D lists every app as `manually`).

Before any of this: the head unit must be coded again (its apps do not start otherwise) and the Store must be
installed (its own README, `node deploy\mgu-install.js first-install`). Both are your own steps on the car;
nothing in this repository does them.

### H1. Publish the release (laptop, PowerShell, from `bmw-g20-idrive-rgb`)

[PUBLISHING.md](PUBLISHING.md) has the detail. In short, with the version in `app/ambient_rgb/app.json`
committed on `main`:

```powershell
git tag v0.5.2
```

```powershell
git push origin main v0.5.2
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release.ps1
```

### H2. Add the source on the car (once)

1. The repository is private: give the Store an account that can read it. Store → Settings → **Accounts** →
   **Add token** (a fine-grained GitHub token for this repository only, **Contents: Read-only**), or
   **Sign in with GitHub**. Typing is easier from the Store's phone page (Settings → **Phone access**).
2. Store → Settings → **Add source** → `gavincunningham2003-dot/bmw` → **Releases**.
3. Store → Settings → **Check now**. **Ambient RGB 0.5.2** appears in the list.

No internet in the car: copy `dist\ambient_rgb@0.5.2.tgz` into a folder named `oap` on a USB stick, plug it in,
and use the Store's **USB** tab instead of steps 1 to 3.

### H3. Install

1. Car parked, ignition on. Store → **Ambient RGB** → **Install** (or **Update**: the Store recognises the
   0.3.0 the kit's installer put there and updates it in place, keeping its data folder).
2. Wait for the Store to say it is installed (the app platform restarts once; a minute or two).
3. The app starts by itself from now on. It is on **Simulated BDC** and **Disarmed**, with every effect off:
   nothing is written to the car until you change that. Open it and go through part E, then part G, then:
4. **0.5.0 and 0.5.1 checks, one at a time, parked** (each is an item of [UNVERIFIED.md](UNVERIFIED.md)):
   - Diagnostics → **Factory light** and **Car**: they must show values (`on`, `in use (5)`), not
     "not reachable". If Factory light stays unknown, the app will refuse to apply: that is the safe
     behaviour; note what it shows before switching *Factory ambient lighting off* to *Keep custom lighting*.
   - Apply a colour, close the app (HOME): the colour must stay. Switch the factory ambient lighting off in
     iDrive: it must release at once. Switch it on again: the factory colour must stay.
   - Apply again, lock the car and walk away: released within seconds. Check the car goes to sleep as usual.
   - With a colour applied, open each door in turn (Driving page → **Open door: BMW light** is ON from the
     start): that door's contour line must leave the custom colour for whatever BMW shows on it, every other
     light must keep its colour, and the line must take the colour again when the door closes. Then the same
     during **Rainbow** and **Colour Wave**: the animation must run on around the open door.
   - **Restore OEM**, and locking the car, with an animation running: all 19 lights back at once.
   - **Indicator glow: ON** (parked, ignition on, indicate left and right): the side must match; if it is
     mirrored, set *Steering wheel side* in Settings.
   - Switch any of them off again on the same page: the effect must stop at once.

### H4. Uninstall, or go back to the previous version

- **Stop the lights now:** the app's **Restore OEM** button. Nothing persists in the body controller; even
  with the app killed, every module returns to the factory lighting within the hold time (10 s by default).
- **Remove the app:** Store → **Ambient RGB** → **Remove**. Its settings and saved colours go with it.
- **Back to the previous version**, on the unit as root (over SSH), with the Store's deploy tool:
  ```
  mgu-deploy.sh status --json
  ```
  shows the app's `previous` (the older package the Store kept when it updated; it keeps the installed
  version and the newest older one only). If there is one:
  ```
  mgu-deploy.sh rollback ambient_rgb --yes
  ```
  uninstalls the app and installs that kept package, carrying the data folder over. These two commands are
  the Store's documented ones (its `deploy/README.md`, "Rollback"); they have not been run on this car.
- **Back to a version of your choice:** remove the app (above), then install that version's package: from a
  GitHub release of it (delete or draft the newer releases first: the newest version of an id always wins), or
  from a USB stick's `oap` folder. The Store never installs a lower version over a higher one.
- **Everything back to stock:** part F (the kit's `restore`) and the Store's own README ("Uninstall").
