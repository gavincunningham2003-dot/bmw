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
2. Build this app with the real SDK: `python scripts/build_app.py` → `dist/ambient_rgb@<version>.mgu`
   (no `dist/PLACEHOLDER_SDK.txt` marker any more: the package is installable).
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
