'use strict';
/**
 * ui_harness.js - run the app's main.js against a hand-made ctx: the kit's real Recorder / gauges / themes /
 * sheet modules (from the staged kit), but no head unit, no renderer, no SDK. The recorder is handed out with
 * own = true (the kit runs the screen), so the page's buttons become targets a test can press by key, and
 * ctx.onTap / ctx.onTab are plain callbacks. Frames can be rasterised to PNG with the kit's software canvas.
 *
 *   const { harness } = require('./ui_harness');
 *   const h = await harness({ sets: { backend: 'mock' } });
 *   const cv = await h.frame();             // the Recorder the app drew (cv.targets: the page's buttons)
 *   await h.press('custom');                // a target by key
 *   h.tap(270, 150);                        // the page tapped (ctx.onTap)
 *   h.png('out.png');                       // the last frame as a PNG (software path)
 *   h.app.ctl()                             // the app's LightingController (ctx.__ambient)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { STAGE, JS } = require('../../scripts/stage');

async function harness(opts) {
    const o = opts || {};
    if (!fs.existsSync(path.join(JS, 'app.js'))) throw new Error('run node scripts/stage.js first');
    const kit = (m) => require(path.join(JS, 'kit', m));
    const { Recorder, play } = kit('record');
    const { Canvas } = kit('canvas');
    const themes = kit('themes');
    const spec = JSON.parse(fs.readFileSync(path.join(STAGE, 'app.json'), 'utf8'));
    const dataDir = o.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-rgb-'));
    const logLines = [];
    const log = { info: (m) => logLines.push(['info', String(m)]), warn: (m) => logLines.push(['warn', String(m)]), error: (m, e) => logLines.push(['error', String(m) + (e ? ' ' + (e.stack || e) : '')]) };
    const values = {};
    (spec.settings || []).forEach((s) => { values[s.key] = s.default; });
    Object.assign(values, o.sets || {});
    const changeHandlers = [];
    const settings = o.settings || { get: (k) => values[k], set(k, v) { values[k] = v; changeHandlers.forEach((fn) => fn(k)); }, onChange: (fn) => changeHandlers.push(fn) };
    const clicks = {}, loops = {};
    let onTap = null, onTab = null, ccu = null, grabbed = null, last = null;
    const ui = {
        image: async (name, cv) => { last = cv; },
        text: async () => {}, visible: async () => {}, enabled: async () => {}, checked: async () => {}, rows: async () => {}, cells: async () => {},
        onClick: (n, fn) => { clicks[n] = fn; }, open: async () => {}, close: async () => {}, isVisible: () => true, onVisible: () => {},
    };
    const ctx = {
        ui, settings, log, spec, dataDir, app: { on() {} }, background: o.background || null,
        theme: () => themes.theme(values.theme),
        canvas: (w, h) => { const r = new Recorder(w, h); r.own = true; r.extra = 0; r.chrome = { tabs: null }; return r; },
        loop: (name, fps, fn) => { loops[name] = fn; return { stop() {}, kick() {} }; },
        onTap: (fn) => { onTap = fn; }, onTab: (fn) => { onTab = fn; }, onScroll() {}, onLayout() {}, sheet: () => false, hideButton() {},
        controller: { grab: (on) => { grabbed = on; }, onInput: (fn) => { ccu = fn; } },
        signals: o.signals || { watch: async (iface) => ({ iface, error: 'harness', available: false }), proxy: async () => { throw new Error('harness: no SOME/IP'); }, hasNative: () => false, loadConfig: () => { throw new Error('no catalog'); } },
    };
    // load the app with ./kit/mgu replaced, as hu-stub.js does
    const realLoad = Module._load;
    let impl = null;
    Module._load = function (req) {
        if (/kit[\\/]mgu$/.test(req) || req === './kit/mgu') return { run: (i) => { impl = i; } };
        return realLoad.apply(this, arguments);
    };
    const appFile = path.join(JS, 'app.js');
    delete require.cache[appFile];
    try { require(appFile); } finally { Module._load = realLoad; }
    await impl.start(ctx);
    const h = {
        ctx, settings, log: logLines, dataDir, impl,
        get app() { return ctx.__ambient; },
        async frame() { await loops.MAIN(); return last; },
        targets() { return (last && last.targets) || []; },
        async press(key) { const t = (last && last.targets || []).find((x) => x.key === key); if (!t) throw new Error('no target ' + key + ' (have: ' + (last && last.targets || []).map((x) => x.key).join(', ') + ')'); return t.run(); },
        tap(x, y) { if (onTap) onTap(x, y); },
        tab(i) { if (onTab) onTab(i); },
        knob(v) { if (ccu) ccu(v); },
        grabbed: () => grabbed,
        async click(btn) { if (!clicks[btn]) throw new Error('no button ' + btn); return clicks[btn]({}); },
        png(file) { const c = new Canvas(last.w, last.h); play(last.words(), c); const b = c.png(); if (file) fs.writeFileSync(file, b); return b; },
    };
    return h;
}

module.exports = { harness };
