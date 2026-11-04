'use strict';
/**
 * emu.js - run the app in the MGU App Kit's live emulator (kit/tools/emu.js) from this repository, on Windows too.
 *
 *   node scripts/emu.js [--port 8077]      ->  http://localhost:8077
 *
 * The kit's emulator draws the app with the car's own draw engine (gfx.c as WebAssembly) and runs it on the real
 * kit runtime through a stubbed head unit: mouse = touch, mouse wheel / [ ] = the iDrive knob, Enter = press,
 * arrows = tilt, Backspace = BACK, H = HOME. Nothing here touches a car: the app runs on its simulated BDC.
 *
 * What this wrapper adds to `node kit/tools/emu.js ambient_rgb`:
 *   - copies app/ambient_rgb into the kit's apps/ folder first and keeps it in sync while you edit here
 *     (the emulator rebuilds and restarts the app about a second after each save);
 *   - applies this app's one kit runtime change (scripts/kit_patch.js: the knob goes to the app while it grabs);
 *   - on Windows, where Node has no Unix sockets, puts the renderer socket on a named pipe (and makes the
 *     runtime accept it: emu_win_shim.js) and runs the kit's build with `python` instead of `python3`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { KIT_REPO, APP } = require('./stage');
const ID = 'ambient_rgb';
const EMU = path.join(KIT_REPO, 'kit', 'tools', 'emu.js');
const TARGET = path.join(KIT_REPO, 'apps', ID);
if (!fs.existsSync(EMU)) { console.error('kit emulator not found at ' + EMU); process.exit(2); }
// the emulator builds from the kit's own runtime: this app's one runtime change goes in first (scripts/kit_patch.js)
console.log('kit_patch: ' + require('./kit_patch').patchRuntime(path.join(KIT_REPO, 'kit', 'runtime', 'display.js')));

function sync() {
    fs.mkdirSync(TARGET, { recursive: true });
    for (const f of fs.readdirSync(APP)) {
        const s = path.join(APP, f);
        if (fs.statSync(s).isDirectory()) continue;
        const d = path.join(TARGET, f);
        const a = fs.readFileSync(s);
        if (fs.existsSync(d) && a.equals(fs.readFileSync(d))) continue;
        fs.writeFileSync(d, a);
    }
    for (const f of fs.readdirSync(TARGET)) if (!fs.existsSync(path.join(APP, f))) fs.unlinkSync(path.join(TARGET, f));
}
sync();
let pending = null;
fs.watch(APP, () => { clearTimeout(pending); pending = setTimeout(() => { try { sync(); } catch (e) { console.error('sync: ' + e.message); } }, 150); });

if (process.platform === 'win32') {
    // the renderer "socket": emu.js builds its path with path.join(os.tmpdir(), 'mgu-emu-<pid>.sock')
    os.tmpdir = () => '\\\\.\\pipe';
    // the app child must see the pipe as a renderer socket (kit/runtime/renderd.js stats it): scripts/emu_win_shim.js
    const shim = path.join(__dirname, 'emu_win_shim.js');
    process.env.NODE_OPTIONS = ((process.env.NODE_OPTIONS || '') + ' --require ' + JSON.stringify(shim)).trim();
    require(shim);
    const spawn = cp.spawn;
    cp.spawn = function (cmd, args, opts) { return spawn.call(this, cmd === 'python3' ? 'python' : cmd, args, opts); };
}
process.argv = [process.argv[0], EMU, ID].concat(process.argv.slice(2));
process.chdir(KIT_REPO);
require(EMU);
