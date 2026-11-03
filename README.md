# bmw

Workspace for the **BMW Ambient RGB Controller**: a native iDrive 7 (MGU) app that gives a 2020 G20
330e's factory ambient lighting a full colour wheel, driven through the body controller's own
documented light actuator, with a simulated BDC for development and a read-only ENET discovery
tool for the laptop.

- **[bmw-g20-idrive-rgb/](bmw-g20-idrive-rgb/)**: the project (app, controller, tests, laptop tool, documentation).
  Start with its [README](bmw-g20-idrive-rgb/README.md), then [NEXT_STEPS.md](bmw-g20-idrive-rgb/NEXT_STEPS.md).
- **research/** (not in git): the public repositories the project was built from. `clone_research.ps1`
  clones them at the exact commits that were analysed; [RESEARCH.md](bmw-g20-idrive-rgb/RESEARCH.md) says what each one contributed.

```powershell
.\clone_research.ps1                 # 15 repositories into research\ at the recorded commits
cd bmw-g20-idrive-rgb
npm test                             # 66 Node tests (needs research\cauliflowermossgrape_idrive7-apps)
npm run test:py                      # 21 Python tests
```

Status: everything is built and tested on the laptop; **nothing has been run on the car**. The
control path (UDS `2E DA5E` to the BDC over the head unit's TASU gateway) is documented in BMW's
own BDC_G05 description but not yet verified on this vehicle. Not affiliated with BMW.
