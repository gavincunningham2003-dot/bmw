'use strict';
/**
 * stage.js - lay the app out the way the idrive7-apps build does, for tests and previews on the PC:
 *
 *   build/stage/            app/ambient_rgb/* (main.js, lighting/, colour.js, ...)
 *   build/stage/kit/        the MGU App Kit runtime (research/cauliflowermossgrape_idrive7-apps/kit/runtime)
 *   build/stage/kit/app-spec.json, locale.json   what build.py would generate from app.json
 *
 * No BMW SDK is needed: the tests and previews use the kit's own stub head unit (hu-stub.js) or
 * drive the modules directly. Nothing here touches a car.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KIT_REPO = process.env.IDRIVE7_APPS || path.join(ROOT, '..', 'research', 'cauliflowermossgrape_idrive7-apps');
const RUNTIME = path.join(KIT_REPO, 'kit', 'runtime');
const APP = path.join(ROOT, 'app', 'ambient_rgb');
const STAGE = path.join(ROOT, 'build', 'stage');

function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
        const s = path.join(src, f), d = path.join(dst, f);
        if (fs.statSync(s).isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

function stage() {
    if (!fs.existsSync(RUNTIME)) {
        throw new Error('kit runtime not found at ' + RUNTIME + ' (clone cauliflowermossgrape/idrive7-apps into research/ or set IDRIVE7_APPS)');
    }
    fs.rmSync(STAGE, { recursive: true, force: true });
    // the layout build.py makes and hu-stub.js loads: <stage>/source/javascript/app.js (+ the app's other flat .js
    // files, as build.py copies them: no subfolders) and <stage>/source/javascript/kit/
    const js = path.join(STAGE, 'source', 'javascript');
    fs.mkdirSync(js, { recursive: true });
    for (const f of fs.readdirSync(APP)) {
        const s = path.join(APP, f);
        if (fs.statSync(s).isDirectory()) continue;
        if (f.endsWith('.js')) fs.copyFileSync(s, path.join(js, f === 'main.js' ? 'app.js' : f));
        else if (f === 'app.json') fs.copyFileSync(s, path.join(STAGE, 'app.json'));
    }
    copyDir(RUNTIME, path.join(js, 'kit'));
    require('./kit_patch').patchRuntime(path.join(js, 'kit', 'display.js'));     // the knob to the app while it grabs
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    // what kit/tools/build.py writes next to the runtime (the parts mgu.js and hu-stub.js read)
    const rt = { id: spec.id, title: spec.title, version: spec.version, screens: spec.screens, settings: spec.settings, startWidget: spec.startWidget || null, stateIds: {} };
    fs.writeFileSync(path.join(js, 'kit', 'app-spec.json'), JSON.stringify(rt, null, 1));
    if (!fs.existsSync(path.join(js, 'kit', 'locale.json'))) fs.writeFileSync(path.join(js, 'kit', 'locale.json'), JSON.stringify({ language: 'en', strings: {} }));
    return STAGE;
}

module.exports = { stage, STAGE, JS: path.join(STAGE, 'source', 'javascript'), KIT_REPO, RUNTIME, APP, ROOT };
if (require.main === module) { console.log('staged ' + stage()); }
