'use strict';
/**
 * check_package.js - load an UNPACKED release package the way the head unit does, as far as a PC can:
 *
 *   node scripts/check_package.js <dir with package.json>
 *
 *   1. every .js file in it parses (node --check, in this Node);
 *   2. package.json "main" exists and is loaded with the platform stood in for: require('oap-sdk') and the
 *      native 'someip' module resolve to empty stand-ins that live only in this process (nothing is written into
 *      the package), and ./kit/mgu's run() is caught, as the kit's own stub head unit does;
 *   3. the entry point hands the kit a background start and a screen start (the background lifecycle);
 *   4. the background start is run once against fake settings and no car: the lighting service must come up on the
 *      simulated BDC, disarmed, with nothing written, and stop cleanly.
 *
 * Exit 0 and one line on success; exit 1 and the reason otherwise. Used by scripts/build_app.py.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const dir = path.resolve(process.argv[2] || '');
const fail = (m) => { console.error('check_package: ' + m); process.exit(1); };
if (!fs.existsSync(path.join(dir, 'package.json'))) fail('no package.json in ' + dir);
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const main = path.join(dir, pkg.main || '');
if (!pkg.main || !fs.existsSync(main)) fail('package.json main ' + pkg.main + ' does not exist');
if (fs.existsSync(path.join(dir, 'node_modules'))) fail('the package carries node_modules');

// 1. syntax
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) files.push(p); } })(path.join(dir, 'javascript'));
for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) fail('syntax: ' + path.relative(dir, f) + '\n' + r.stderr);
}

// 2. load the entry point
let impl = null;
const realLoad = Module._load;
const needed = new Set();
Module._load = function (req, parent) {
    if (req === 'oap-sdk' || req === 'someip') { needed.add(req); return {}; }
    if (req === './kit/mgu' && parent && parent.filename === main) return { run: (i) => { impl = i; } };
    return realLoad.apply(this, arguments);
};
try { require(main); } catch (e) { fail('the entry point does not load: ' + (e && e.stack || e)); }
if (!impl) fail('the entry point never called the kit\'s run()');
// 3. the lifecycle
if (typeof impl.start !== 'function') fail('no screen start');
if (typeof impl.background !== 'function') fail('no background start: the lighting would stop with the screen');

// 4. the background start, with no car
const spec = JSON.parse(fs.readFileSync(path.join(dir, 'javascript', 'kit', 'app-spec.json'), 'utf8'));
const values = {};
(spec.settings || []).forEach((s) => { values[s.key] = s.default; });
const settings = { get: (k) => values[k], set(k, v) { values[k] = v; }, onChange() {} };
const signals = { watch: async (iface) => ({ iface, available: false, error: 'check_package: no car' }) };
const log = { info() {}, warn() {}, error() {} };
const os = require('os');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-rgb-check-'));
let shutdown = null;
(async () => {
    const bg = await impl.background({ app: { on: (ev, fn) => { if (ev === 'shutdown') shutdown = fn; } }, log, settings, signals, spec, dataDir });
    const svc = bg && bg.svc;
    if (!svc || !svc.ctl) fail('the background start made no lighting service');
    if (svc.ctl.kind !== 'mock') fail('first start is not on the simulated BDC: ' + svc.ctl.kind);
    if (values.arm !== 'off') fail('first start is armed');
    if (svc.ctl.program) fail('something was applied at first start');
    const writes = svc.ctl.bdc.requests.filter((r) => r.sid === 0x2E).length;
    if (writes) fail(writes + ' write(s) at first start');
    if (!shutdown) fail('the platform\'s shutdown is not listened for');
    shutdown();
    await svc._stopping;
    if (!svc.stopped) fail('the service did not stop');
    process.removeAllListeners('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(pkg.name + '@' + pkg.version + ': ' + files.length + ' modules parse, entry point loads (' + (Array.from(needed).sort().join(', ') || 'kit/mgu, which requires oap-sdk, stood in') +
        '), background + screen start present, first start: simulated BDC, disarmed, 0 writes, stops cleanly');
    process.exit(0);
})().catch((e) => fail('the background start failed: ' + (e && e.stack || e)));
