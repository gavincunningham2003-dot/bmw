# PUBLISHING.md: building the release and getting it into MGU Store

Ambient RGB is published for [MGU Store](https://github.com/robertnisipeanu/mgu-store) in its **Releases**
layout (its `docs/PUBLISHING.md`, section 1): the built packages are assets of a GitHub release of this
repository, and the Store installs them as they are.

| Asset | What it is |
|---|---|
| `ambient_rgb@<version>.tgz` | the OAP package (files under `package/`, as `npm pack`); the Store prefers this one |
| `ambient_rgb@<version>.mgu` | the same package as `source/` with `meta.json`, `rhmiData/`, `oapgen/` beside it |
| `mgu-store.json` | the title, description and icon the Store shows before the app is installed |
| `ambient_rgb.png` | that icon |

Both packages say `"name": "ambient_rgb"`, the version of `app/ambient_rgb/app.json`, `"mguHmi": ["ID7"]`
(iDrive 7 only: the Store lists it on an iDrive 8 unit but does not install it) and
`"mguAppStartType": "autostart"` (the platform starts the app itself, so the lighting runs without the screen).

**No BMW code is in them.** BMW's `oap-sdk` is not redistributable. The Store's rule is that a release package
calls `require('oap-sdk')` and ships none: the head unit generates the module from a BMW app already on it.
`scripts/build_app.py` removes the SDK from the tree before packing and then checks that nothing of it is left.

## What the build needs

- Python 3.12 and Node.js 20 or later (`python --version`, `node --version`).
- The MGU App Kit beside this repository, recent enough to have a background start:
  `..\research\cauliflowermossgrape_idrive7-apps` (built and tested at commit `64486c5`), or any checkout named
  in the environment variable `IDRIVE7_APPS`.
- BMW's `oap-sdk` extracted from **your own head unit** into `<kit>\oap-sdk` (INSTALLATION.md part C). The kit's
  build copies it into its staged tree, so it insists on it. Without it `build_app.py` stops, builds nothing and
  prints the exact steps. It never substitutes anything and never labels a package it did not check.
- The GitHub CLI for publishing: `winget install GitHub.cli`, then `gh auth login` once.

## Build and check (PowerShell, from `bmw-g20-idrive-rgb`)

```powershell
npm test
```

```powershell
npm run test:py
```

```powershell
python scripts\build_app.py
```

The last command ends with `OK: ambient_rgb@<version> passed every check ...` or removes the packages and says
what failed. It writes into `dist\` (never committed):

```
ambient_rgb@0.5.1.tgz   ambient_rgb@0.5.1.mgu   mgu-store.json   ambient_rgb.png   BUILD.json
```

`BUILD.json` records what was built from what (kit commit, source commit, whether the tree was dirty) and each
file's size and SHA-256. What "checked" means, all of it on the archives themselves:

- named `<id>@<x.y.z>.tgz` / `.mgu`; `package.json` name, version, `main`, `mguHmi`, `mguAppStartType`;
- the entry point `javascript/app.js`, the manifest, permissions, config, the kit runtime, the generated
  `app-spec.json` and the RHMI resources (iDrive 7 uiDescription, texts with the title, the icon) are present;
- every module of `app/ambient_rgb` is in the package, byte for byte;
- no `node_modules`, nothing named `oap-sdk`; the runtime does call `require('oap-sdk')` (so the Store
  generates it) and has the background start;
- no interface is asked for write access;
- with the head unit's own interface catalogue at hand (`..\research\mgu_sdk_source\someip-interfaces.json`, or
  `MGU_CATALOGUE`), every interface, instance, field, getter and notifier the app asks for exists in it;
- the package is unpacked and its entry point loaded in Node (`scripts/check_package.js`): every module
  parses, the background and screen starts are there, a first start comes up on the simulated BDC, disarmed,
  with zero writes, and stops cleanly.

To check packages again later without building: `python scripts\build_app.py --check`.

## Publish a release (PowerShell)

Commit, tag the version in `app.json`, push, then run the release script. It runs the tests and the build
again and uploads the four assets with `gh release create`:

```powershell
git tag v0.5.1
```

```powershell
git push origin main v0.5.1
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release.ps1
```

`release.ps1` refuses to publish when the tag does not match `app.json`, when the working tree has uncommitted
changes, when a test fails or when the packages fail their check. `-Draft` creates a draft (the Store ignores
drafts and pre-releases) so you can look at it on GitHub first.

### Or let GitHub build it

`.github/workflows/release.yml` (repository root) does the same on GitHub when a tag `v<version>` is pushed:
it clones the kit at the commit above, runs both test suites, builds with `python scripts/build_app.py --ci`
and attaches the assets to the release.

`--ci` exists because a build machine can never hold BMW's SDK. It gives the kit's copy step an empty stand-in
and removes it again; since the SDK is taken out of every release anyway, the result is the same bytes as a
build with the real SDK present (checked on 2026-11-12 on one checkout: both gave the same SHA-256; a Linux
checkout has other line endings than a Windows one, so compare like with like). Use `--ci` nowhere else.

## The Store source

The car's owner adds the repository as a source and picks **Releases**:

- Store → Settings → **Add source** → `gavincunningham2003-dot/bmw` → **Releases**.
- The repository is private, so the car needs an account that can read it: Store → Settings → **Accounts** →
  **Add token** with a fine-grained GitHub token (this repository only, **Contents: Read-only**), or
  **Sign in with GitHub** with the mgu-store GitHub App installed on the repository. Typing the token is easier
  from the Store's phone page or with `node deploy\mgu-install.js token --identity <key>` on the laptop.
- Without internet in the car: copy `ambient_rgb@<version>.tgz` into a folder named `oap` on a USB stick; the
  Store's **USB** tab offers it.

Every release counts, newest first; the newest version of the id wins, and of one version the `.tgz` over the
`.mgu`. Drafts and pre-releases are ignored.

## Why there is no `mgu-repo.json` (branch source)

A branch or tag source makes the head unit build the app from source. This app's build is the MGU App Kit's
`kit/tools/build.py`, which is not in this repository, and an on-unit build has no network unless asked for
and is limited to ten minutes. A manifest pointing at a build this repository cannot run on the unit would be
a broken source, so none is published. The Releases source needs nothing built on the car.
