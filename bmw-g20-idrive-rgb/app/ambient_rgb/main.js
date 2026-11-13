'use strict';
/**
 * Ambient RGB - the G20's factory ambient lighting under your control, as a native iDrive 7 (MGU) app on the MGU App
 * Kit (cauliflowermossgrape/idrive7-apps). Five pages (header tabs):
 *
 *   COLOURS    a list of the ways to light the cabin, the hue ring with the colour in its middle, a brightness
 *              dial, saturation, the cabin from above lit as it would be, a zone picker, Apply / Cancel
 *   DUAL       upper and lower lighting with their own colour and brightness; swap, copy, save, Apply both
 *   MODES      Solid, Dual, and Ambient Config's animations (Rainbow, Smooth Fade, Breathing, Colour Wave, Welcome
 *              Sweep, Sport Pulse: lighting_scene.js) with their upper / lower colours and speed, and the cabin
 *              moving as the mode would move it (lighting_preview.js: a picture, never a write); Apply
 *              A mode's colours are the ones ACTIVE in the car (active_colours.js: what is applied, else what the
 *              body controller reported, else the last applied), never an unsent draft, until the driver picks
 *              others on the page; the next Apply makes those the active ones.
 *   FAVOURITES saved colours and saved complete configurations (colours, brightness, zones, mode, animation)
 *   DIAGNOSTICS link, body controller, transport performance, write controls
 *
 * PREVIEW vs APPLIED: every page edits a DRAFT. Turning the knob, tapping the wheel or the dial changes only the
 * screen. The car changes when Apply (a page button, the bar's Apply, or the confirming press when the setting
 * "Press to confirm applies" is on) hands the draft to the LightingController, which is the only thing that writes.
 * Leaving a page or pressing Cancel drops the draft. An applied static configuration keeps its keep-alives while
 * another draft is being browsed.
 *
 * BACKGROUND: the lighting itself (the link, the factory gate, the effects, the driving modes, the shutdown) lives
 * in lighting_service.js, started by the kit's background start (app.json "autostart", impl.background below)
 * before and without the screen. This file is the screen: it reads the service and asks it to apply; closing the
 * screen stops nothing.
 *
 * Input: the iDrive knob walks the page's controls (the kit's focus ring); a press on a wheel or a dial ENTERS it
 * (the knob is grabbed), turns adjust the draft, a press confirms, a tilt left cancels; BACK leaves the page.
 * Touch: taps on the wheel / dial / buttons. Without a controller gate every control also has - / + buttons.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const C = require('./colour');
const W = require('./ui_widgets');
const S = require('./lighting_scene');
const A = require('./active_colours');
const { ModePreview } = require('./lighting_preview');
const { service } = require('./lighting_service');

const PAGES = ['Colours', 'Dual', 'Modes', 'Favourites', 'Diagnostics', 'Driving'];
const ZONE_ORDER = ['all', 'dashboard', 'frontDoors', 'rearDoors', 'footwells', 'upper', 'lower'];
const MODE_ORDER = ['solid', 'dual', 'rainbow', 'fade', 'breathing', 'wave', 'welcome', 'pulse'];
const hsvOf = (c) => C.rgbToHsv(c);
const rgbOf = (hsv) => C.hsvToRgb(hsv.h, hsv.s, hsv.v);
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * The service for this process: the background start's (ctx.background), else made here (a kit without a
 * background start, the tests). service() hands out one per process, so the timers and listeners exist once.
 */
function serviceFor(o) { return service({ settings: o.settings, signals: o.signals, log: o.log, dataDir: o.dataDir }); }

mgu.run({
    /**
     * With or without the screen (kit/runtime/mgu.js: called once, right after the platform reports the app active).
     * The lighting service starts here; the platform's shutdown request and the process being told to end both
     * stop it (effects and animations off, restoreOem attempted).
     */
    async background(bg) {
        const svc = serviceFor(bg);
        await svc.start();
        const end = (why) => svc.stop(why).catch((e) => bg.log.warn('stop: ' + e));
        if (bg.app && bg.app.on) bg.app.on('shutdown', () => end('the platform asked the app to stop'));
        // (a plain kill: give the release its chance, then leave as the signal asked)
        process.once('SIGTERM', () => { const t = setTimeout(() => process.exit(0), 1500); end('SIGTERM').then(() => { clearTimeout(t); process.exit(0); }); });
        bg.log.info('lighting service running in the background (' + svc.ctl.kind + ', ' + svc.ctl.state + ')');
        return { svc };
    },

    async start(ctx) {
        const log = ctx.log, settings = ctx.settings;
        const svc = ctx.background && ctx.background.svc ? ctx.background.svc : serviceFor(ctx);
        if (!svc.started) {
            await svc.start();
            // (no background start: the screen's app object is the only one to hear the platform's shutdown)
            if (ctx.app && ctx.app.on) ctx.app.on('shutdown', () => svc.stop('the platform asked the app to stop').catch(() => {}));
        }
        const favs = svc.favs, oem = svc.oem, drive = svc.drive;
        const editor = new W.Editor(ctx, log);
        let page = 0, flash = null, deleteMode = false;
        let ctl = svc.ctl;
        svc.on('controller', (c) => { ctl = c; });
        const say = (text, ms) => { flash = { text, until: Date.now() + (ms || 2500) }; };
        svc.on('say', say);
        const still = (p) => (p && S.onceMs(p) ? p.then : p);

        /* ---------- drafts (previews): one per page, never sent anywhere by themselves ---------- */
        const draft = {
            // (saturation is always 1: the ring picks pure hues; only the BDC's library colours carry their own)
            colours: { hsv: { h: 262, s: 1, v: 1 }, brightness: 100, zone: 0 },                          // zone: index into ZONE_ORDER
            // (both selectors open at 100 %: openPage)
            dual: { top: { hsv: { h: 270, s: 1, v: 1 }, brightness: 100 }, bottom: { hsv: { h: 200, s: 1, v: 1 }, brightness: 100 }, focus: 'top' },
            // mode: index into MODE_ORDER; own[mode]: its colours were picked on the Modes page (else they follow the car's)
            modes: { mode: 0, params: clone(S.DEFAULTS), own: {} },
        };
        const preview = new ModePreview();                     // the Modes page's moving cabin: drawn, never written
        let dirty = { colours: false, dual: false, modes: false };
        const markDirty = (p) => { dirty[p] = true; };

        /* ---------- programs from drafts ---------- */
        const zoneName = () => ZONE_ORDER[draft.colours.zone];
        function coloursProgram() {
            const d = draft.colours, zone = zoneName();
            if (zone === 'all') return { mode: 'solid', colour: rgbOf(d.hsv), brightness: d.brightness, zone: 'all' };
            // a zone: merge into the applied zones program so other zones keep their colours
            const prev = ctl.program && ctl.program.mode === 'zones' ? ctl.program.assignments : ctl.program && ctl.program.mode === 'solid' ? [{ zone: ctl.program.zone, colour: ctl.program.colour, brightness: ctl.program.brightness }] : [];
            const assignments = prev.filter((a) => a.zone !== zone).concat([{ zone, colour: rgbOf(d.hsv), brightness: d.brightness }]);
            return { mode: 'zones', assignments, handlesTo: settings.get('handles') || 'bottom' };
        }
        function dualProgram() {
            const d = draft.dual;
            return { mode: 'dual', top: { colour: rgbOf(d.top.hsv), brightness: d.top.brightness }, bottom: { colour: rgbOf(d.bottom.hsv), brightness: d.bottom.brightness }, handlesTo: settings.get('handles') || 'bottom' };
        }
        function modesProgram() {
            const mode = MODE_ORDER[draft.modes.mode];
            if (mode === 'solid') return Object.assign({}, draft.modes.params.solid, { mode: 'solid' });
            if (mode === 'dual') return dualProgram();
            // the one-time effects end on what is applied now; with nothing applied they run in the car's active
            // colour and then hand the cabin back to it (an unsent draft is never taken for the car's colour)
            if (S.ONCE[mode]) {
                const on = still(ctl.program), l = on ? null : look();
                return Object.assign({ mode, then: on || null }, l ? { colour: clone(l.top.colour), brightness: l.top.brightness } : {});
            }
            return Object.assign({}, draft.modes.params[mode], { mode, handlesTo: settings.get('handles') || 'bottom' });
        }

        /* ---------- the car's active colours, and the modes that take them ---------- */
        /** { top, bottom, source } or null: what is applied, else what the car reported, else the last applied. */
        function look() {
            const last = favs.lastApplied();
            return A.activeLook({ program: ctl.program, modules: ctl.slaves, handlesTo: settings.get('handles') || 'bottom', live: ctl.liveColours ? ctl.liveColours() : null, last: last ? last.program : null });
        }
        /** Every mode whose colours were not picked on the Modes page takes the active ones (the draft only). */
        function syncModes() {
            const l = look(), d = draft.modes;
            if (!l) return null;
            Object.keys(S.RUNNING).forEach((m) => { if (!d.own[m]) { d.params[m].top = clone({ colour: l.top.colour, brightness: l.top.brightness }); d.params[m].bottom = clone({ colour: l.bottom.colour, brightness: l.bottom.brightness }); } });
            if (!d.own.solid) { d.params.solid.colour = clone(l.top.colour); d.params.solid.brightness = l.top.brightness; }
            return l;
        }
        /**
         * A page is opened. The Single and the Dual selector start at 100 % brightness each time (the selector's
         * draft: nothing is sent, nothing counts as changed, the car keeps the brightness it has until Apply); the
         * Modes page takes the car's active colours; leaving it stops its preview.
         */
        function openPage(i) {
            editor.cancel();
            if (page === 2 && i !== 2) preview.stop();
            page = i; deleteMode = false;
            if (i === 0) draft.colours.brightness = 100;
            if (i === 1) { draft.dual.top.brightness = 100; draft.dual.bottom.brightness = 100; }
            if (i === 2) syncModes();
        }
        const pageProgram = () => (page === 0 ? coloursProgram() : page === 1 ? dualProgram() : page === 2 ? modesProgram() : null);

        /* ---------- actions ---------- */
        async function applyProgram(program, what) {
            const r = await svc.apply(program);
            if (r.reason === 'busy') { say('Please wait'); return; }
            if (r.ok) {
                // what really happened: refused modules and writes nobody answered are said, not hidden
                const notes = [r.failed ? r.failed + ' module(s) refused' : '', r.unanswered ? r.unanswered + ' write(s) unanswered, not resent' : '', r.missed ? r.missed + ' missed, written again' : ''].filter(Boolean);
                say((what || 'Applied') + (notes.length ? ' (' + notes.join('; ') + ')' : '') + (ctl.kind === 'bdc-uds' && !ctl.armed ? ' [dry run]' : ''), notes.length ? 4500 : 2500);
                dirty = { colours: false, dual: false, modes: false };
                // what was applied is the car's colour now: every mode follows it again
                draft.modes.own = {};
                syncModes();
            } else say('Not applied: ' + (r.reason || 'refused'), 4500);
        }
        async function applyPage() { const p = pageProgram(); if (p) await applyProgram(p); }
        async function restoreOem() {
            // (the service: Restore OEM is the off switch, nothing comes back at the next start or when the car is unlocked)
            const r = await svc.restoreOem();
            if (r.reason === 'busy') return;
            say(r.ok ? 'OEM lighting restored' : 'Restore incomplete: ' + r.reason, r.ok ? 2500 : 6000);
        }
        function cancelPage() {
            editor.cancel();
            if (page === 0 && ctl.program && ctl.program.mode === 'solid') { draft.colours.hsv = hsvOf(ctl.program.colour); draft.colours.brightness = ctl.program.brightness; }
            if (page === 1 && ctl.program && ctl.program.mode === 'dual') { draft.dual.top = { hsv: hsvOf(ctl.program.top.colour), brightness: ctl.program.top.brightness }; draft.dual.bottom = { hsv: hsvOf(ctl.program.bottom.colour), brightness: ctl.program.bottom.brightness }; }
            dirty[['colours', 'dual', 'modes'][page]] = false;
            say('Changes discarded', 1500);
        }
        editor.onChange = () => markDirty(['colours', 'dual', 'modes'][page] || 'colours');
        editor.onDone = (key, confirmed) => {
            if (confirmed && settings.get('confirmApplies') === 'on' && page <= 2 && /^(wheel|ring)/.test(key)) applyPage();
        };

        /* ---------- input ---------- */
        if (ctx.controller && ctx.controller.onInput) ctx.controller.onInput((v) => { svc.touch(); editor.input(v); });
        let geometry = {};                                     // what the last frame drew, for taps: { wheel, ring, ... }
        ctx.onTap((x, y) => {
            svc.touch();
            const g = geometry;
            if (page === 0) {
                if (g.hue) { const h = W.hueRingHit(x, y, g.hue); if (h != null) { draft.colours.hsv = { h, s: 1, v: 1 }; markDirty('colours'); return; } }
                if (g.ring) { const v = W.ringHit(x, y, g.ring); if (v != null) { draft.colours.brightness = v; markDirty('colours'); } }
            } else if (page === 1) {
                for (const side of ['top', 'bottom']) {
                    const hr = g['hue_' + side], r = g['ring_' + side];
                    if (hr) { const h = W.hueRingHit(x, y, hr); if (h != null) { draft.dual[side].hsv = { h, s: 1, v: 1 }; draft.dual.focus = side; markDirty('dual'); return; } }
                    if (r) { const v = W.ringHit(x, y, r, 20); if (v != null) { draft.dual[side].brightness = v; draft.dual.focus = side; markDirty('dual'); return; } }
                }
            }
        });
        ctx.onTab((i) => { svc.touch(); openPage(i); });
        ctx.ui.onClick('BTN_APPLY', () => { if (page <= 2) applyPage(); else say('Nothing to apply on this page', 1500); });
        ctx.ui.onClick('BTN_OEM', restoreOem);
        ctx.ui.onClick('BTN_PAGE', () => openPage((page + 1) % PAGES.length));
        ctx.__ambient = { svc, ctl: () => ctl, oem, drive, car: svc.car, factoryGate: () => svc.factoryGate(), gateTick: () => svc.gateTick(), followMode: (m, was) => svc.followMode(m, was), suspended: () => svc.suspended, draft, editor, favs, page: () => page, setPage: openPage, look, syncModes, preview, dirty: () => dirty, applyPage, restoreOem, coloursProgram, dualProgram, modesProgram };

        /* ---------- drawing helpers ---------- */
        const linkPill = (cv, t, x, y, w) => {
            const st = ctl.state, kind = ctl.kind;
            const label = kind === 'mock' ? 'SIMULATED' : kind === 'bdc-uds' ? (st === 'connected' ? (ctl.armed ? 'BDC LINKED' : 'BDC (DRY RUN)') : st === 'connecting' ? 'PROBING' : 'NO LINK') : 'SOME/IP';
            const color = kind === 'mock' ? t.cold : st === 'connected' ? (ctl.armed ? t.ok : t.warn) : t.crit;
            return G.pill(cv, t, x, y, w || 170, 32, label, { color, size: 15 });
        };
        const statePill = (cv, t, x, y, w) => {
            const p = ctl.program;
            const label = !p ? 'OEM LIGHTING' : (S.MODE_LABELS[p.mode] || p.mode).toUpperCase() + (S.isAnimated(p) ? ' ' + ctl.fps() + ' FPS' : '');
            return G.pill(cv, t, x, y, w || 190, 32, label, { color: p ? t.accent : t.dim, size: 15 });
        };
        const applyRow = (cv, t, x, y, h, label, isDirty) => {
            let ax = x;
            ax += G.button(cv, t, ax, y, 0, h, label || 'Apply', applyPage, { primary: true, key: 'apply', busy: svc.busy }) + 10;
            ax += G.button(cv, t, ax, y, 0, h, 'Cancel', cancelPage, { key: 'cancel', busy: !isDirty }) + 10;
            ax += G.button(cv, t, ax, y, 0, h, 'Restore OEM', restoreOem, { key: 'oem', busy: svc.busy || !ctl.program }) + 10;
            return ax;
        };
        const wheelControl = (key, get, set) => editor.control({ key, get, set: (h) => set(h), step: 3, wrap: 360 });
        const ringControl = (key, get, set) => editor.control({ key, get, set, step: 2, min: 0, max: 100 });
        const enter = (key) => () => { if (!editor.enter(key)) return; if (!editor.available) say('Turn the knob: no controller gate, use + / -', 2000); };

        /* ---------- COLOURS: the mode list | the hue ring and the dial | the cabin ---------- */
        const HUE = { cx: 640, cy: 250, r: 180, w: 56 }, DIAL = { cx: 930, cy: 180, r: 64 };
        function drawColours(cv, t) {
            editor.reset();
            const d = draft.colours, c = rgbOf(d.hsv), hex = C.rgbToHex(c);
            wheelControl('wheel', () => d.hsv.h, (h) => { d.hsv = { h, s: 1, v: 1 }; });
            ringControl('ring', () => d.brightness, (v) => { d.brightness = v; });
            // the list on the left: this page, the other ways of lighting the cabin
            G.panel(cv, t, 20, 60, 400, 452, 'Colour');
            const rows = [
                ['Single colour', null], ['Dual colour', () => openPage(1)],
                ['ANIMATION'], ...MODE_ORDER.slice(2).map((m, i) => [S.MODE_LABELS[m], () => { draft.modes.mode = i + 2; openPage(2); }]),
                ['MORE'], ['Favourites', () => openPage(3)],
            ];
            // (nine rows and two headings in the panel: 34 px rows, so the last one, Favourites, ends inside it)
            let ly = 110;
            const RH = 33;
            rows.forEach(([label, go]) => {
                if (!go && label === label.toUpperCase()) { cv.text(label, 40, ly + 16, 12, t.dim, { font: 'bold', spacing: 2 }); ly += 23; return; }
                const sel = !go;
                cv.roundRect(36, ly, 368, RH, 9, sel ? withAlpha(t.sel || t.accent, 0.25) : withAlpha('#ffffff', 0.05));
                if (sel) cv.strokeRoundRect(36, ly, 368, RH, 9, 2, t.sel || t.accent);
                cv.text(label, 54, ly + 23, 18, t.text, { font: sel ? 'bold' : undefined });
                if (go) { cv.text('›', 384, ly + 24, 20, t.dim, { align: 'center' }); cv.target(36, ly, 368, RH, () => { editor.cancel(); go(); }, 'go:' + label); }
                ly += RH + 4;
            });
            // the hue ring: a tap on the ring picks the hue; the knob's target is the disc in the middle (a press enters it)
            cv.text('SINGLE COLOUR', HUE.cx, 56 + 14, 13, t.dim, { align: 'center', font: 'bold', spacing: 2 });
            geometry.hue = W.hueRing(cv, t, HUE.cx, HUE.cy, HUE.r, HUE.w, d.hsv, { editing: editor.isEditing('wheel'), caption: dirty.colours ? 'preview' : ctl.program ? 'applied' : 'not applied' });
            cv.target(HUE.cx - 75, HUE.cy - 75, 150, 150, enter('wheel'), 'wheel');
            cv.text('HUE ' + Math.round(d.hsv.h) + '°   ·   RGB ' + c.r + ' ' + c.g + ' ' + c.b, HUE.cx, HUE.cy + HUE.r + 24, 15, t.dim, { align: 'center', font: 'num' });
            // the brightness dial
            geometry.ring = W.ring(cv, t, DIAL.cx, DIAL.cy + 40, DIAL.r, d.brightness, 'Brightness', { editing: editor.isEditing('ring'), colour: hex, ramp: true, width: 14, size: 32 });
            cv.target(DIAL.cx - 50, DIAL.cy + 40 - 50, 100, 100, enter('ring'), 'ring');
            G.button(cv, t, DIAL.cx - 56, DIAL.cy + 122, 46, 36, '-', () => { d.brightness = Math.max(0, d.brightness - 5); markDirty('colours'); }, { key: 'ring-' });
            G.button(cv, t, DIAL.cx + 10, DIAL.cy + 122, 46, 36, '+', () => { d.brightness = Math.min(100, d.brightness + 5); markDirty('colours'); }, { key: 'ring+' });
            // actions under the ring
            const ax = applyRow(cv, t, 440, 462, 44, 'Apply', dirty.colours);
            G.button(cv, t, ax, 462, 0, 44, favs.has(hex) ? 'Saved' : 'Save colour', () => { if (favs.add(hex)) say('Saved ' + hex); }, { key: 'save', busy: favs.has(hex) });
            // the cabin on the right: the zone this applies to, the modules as they would be lit
            G.button(cv, t, 1100, 64, 460, 44, 'Applies to: ' + S.zoneLabel(zoneName(), ctl.slaves) + '  ›', () => { d.zone = (d.zone + 1) % ZONE_ORDER.length; markDirty('colours'); }, { key: 'zone' });
            let scene = null;
            try { scene = S.render(coloursProgram(), ctl.slaves, Date.now()); } catch (e) { scene = null; }
            W.carView(cv, t, 1080, 110, 500, 346, ctl.slaves, scene, {
                heading: 'front · right-hand drive',
                legend: [{ colour: hex, text: S.zoneLabel(zoneName(), ctl.slaves) + ' · solid' }],
                status: (ctl.kind === 'mock' ? 'simulated · ' : '') + (dirty.colours ? 'preview' : ctl.program ? 'applied' : 'factory'), statusColour: dirty.colours ? t.warn : ctl.program ? t.ok : t.dim,
            });
            // the BDC's library colours
            let cx = 1100;
            favs.oem().forEach((f) => {
                const rc = C.hexToRgb(f.hex);
                cv.roundRect(cx, 462, 70, 40, 10, f.hex);
                if (C.sameRgb(rc, c)) cv.strokeRoundRect(cx, 462, 70, 40, 10, 3, '#ffffff');
                cv.text(f.name.toUpperCase().slice(0, 6), cx + 35, 488, 11, C.luma(rc) > 0.55 ? '#000000' : '#ffffff', { align: 'center', font: 'bold', spacing: 1 });
                cv.target(cx, 462, 70, 40, () => { d.hsv = hsvOf(rc); markDirty('colours'); }, 'oem:' + f.hex);
                cx += 78;
            });
        }

        /* ---------- DUAL ---------- */
        function drawDual(cv, t) {
            editor.reset();
            const d = draft.dual;
            // two pickers as on the Colours page: the hue ring with the colour in its middle, the brightness dial beside it
            ['top', 'bottom'].forEach((side, i) => {
                const x0 = 40 + i * 540, s = d[side], col = rgbOf(s.hsv), hex = C.rgbToHex(col);
                wheelControl('wheel_' + side, () => s.hsv.h, (h) => { s.hsv = { h, s: 1, v: 1 }; d.focus = side; });
                ringControl('ring_' + side, () => s.brightness, (v) => { s.brightness = v; d.focus = side; });
                G.panel(cv, t, x0 - 20, 60, 520, 452, side === 'top' ? 'Upper lighting' : 'Lower lighting');
                const hc = { cx: x0 + 170, cy: 282, r: 150, w: 46 };
                geometry['hue_' + side] = W.hueRing(cv, t, hc.cx, hc.cy, hc.r, hc.w, s.hsv, { editing: editor.isEditing('wheel_' + side), caption: side === 'top' ? 'upper' : 'lower' });
                cv.target(hc.cx - 65, hc.cy - 65, 130, 130, enter('wheel_' + side), 'wheel_' + side);   // (the disc: the knob's target)
                geometry['ring_' + side] = W.ring(cv, t, x0 + 410, 262, 70, s.brightness, 'Bright', { editing: editor.isEditing('ring_' + side), colour: hex, width: 14, size: 34 });
                cv.target(x0 + 370, 222, 80, 80, enter('ring_' + side), 'ring_' + side);
                G.button(cv, t, x0 + 352, 362, 46, 36, '-', () => { s.brightness = Math.max(0, s.brightness - 5); markDirty('dual'); }, { key: 'ring_' + side + '-' });
                G.button(cv, t, x0 + 416, 362, 46, 36, '+', () => { s.brightness = Math.min(100, s.brightness + 5); markDirty('dual'); }, { key: 'ring_' + side + '+' });
                cv.text(col.r + ' ' + col.g + ' ' + col.b, x0 + 410, 170, 15, t.dim, { align: 'center', font: 'num' });
                const n = ctl.slaves.filter((m) => S.groupOf(m, settings.get('handles') || 'bottom') === side).length;
                cv.text(n + ' modules', x0 + 170, 462, 15, t.dim, { align: 'center' });
            });
            // the middle column: the cabin with both groups, swap / copy / save / handles, Apply both
            const mx = 1130, my = 60;
            G.panel(cv, t, mx, my, 450, 452, 'Dual Colour');
            let scene = null;
            try { scene = S.render(dualProgram(), ctl.slaves, Date.now()); } catch (e) { scene = null; }
            W.carView(cv, t, mx + 10, my + 52, 220, 288, ctl.slaves, scene, {
                legend: [{ colour: C.rgbToHex(rgbOf(d.top.hsv)), text: 'upper' }, { colour: C.rgbToHex(rgbOf(d.bottom.hsv)), text: 'lower' }],
            });
            let by = my + 50;
            const bw = 190, bx = mx + 244;
            G.button(cv, t, bx, by, bw, 44, 'Swap', () => { const a = clone(d.top); d.top = clone(d.bottom); d.bottom = a; markDirty('dual'); }, { key: 'swap' }); by += 54;
            G.button(cv, t, bx, by, bw, 44, 'Copy top down', () => { d.bottom = clone(d.top); markDirty('dual'); }, { key: 'copy' }); by += 54;
            G.button(cv, t, bx, by, bw, 44, 'Save combination', () => { const p = favs.addPreset('Dual ' + C.rgbToHex(rgbOf(d.top.hsv)) + '/' + C.rgbToHex(rgbOf(d.bottom.hsv)), dualProgram()); say('Saved ' + p.name); }, { key: 'savecombo' }); by += 54;
            G.button(cv, t, bx, by, bw, 44, 'Handles: ' + (settings.get('handles') || 'bottom'), () => { const o = ['top', 'bottom', 'off']; settings.set('handles', o[(o.indexOf(settings.get('handles') || 'bottom') + 1) % 3]); markDirty('dual'); }, { key: 'handles' });
            // the action row, each button after the previous one (auto widths)
            let ax = mx + 24;
            const ay = my + 346;
            ax += G.button(cv, t, ax, ay, 168, 46, 'Apply both', () => applyProgram(dualProgram(), 'Applied upper and lower'), { primary: true, key: 'apply' }) + 8;
            ax += G.button(cv, t, ax, ay, 112, 46, 'Cancel', cancelPage, { key: 'cancel', busy: !dirty.dual }) + 8;
            G.button(cv, t, ax, ay, 94, 46, 'OEM', restoreOem, { key: 'oem', busy: svc.busy || !ctl.program });
            linkPill(cv, t, mx + 24, my + 404, 140); statePill(cv, t, mx + 172, my + 404, 150);
            cv.text(dirty.dual ? 'Preview' : ctl.program && ctl.program.mode === 'dual' ? 'Applied' : 'Not applied', mx + 334, my + 426, 14, dirty.dual ? t.warn : t.dim);
        }

        /* ---------- MODES ---------- */
        // The moving modes are Ambient Config's (lighting_scene.js): their timing is that app's, and the only knobs it
        // has are the two groups' colours and brightness and the speed step (1 slow, 2 normal, 3 fast).
        const SPEED_ROW = ['speed', 'Speed', 1, 1, 3, (v) => S.SPEED_LABELS[v] || String(v)];
        const MODE_PARAMS = {
            rainbow: [SPEED_ROW], fade: [SPEED_ROW], breathing: [SPEED_ROW], wave: [SPEED_ROW],
            solid: [['brightness', 'Brightness %', 5, 0, 100]],
            dual: [], welcome: [], pulse: [],
        };
        const sideOf = (s) => ({ colour: rgbOf(s.hsv), brightness: s.brightness });
        const HELP = {
            solid: 'One colour on the whole cabin: the colour active in the car, or one picked here.',
            dual: 'Upper and lower lighting with their own colours (set them on the Dual page).',
            rainbow: 'The whole cabin through every colour, at the upper brightness.',
            fade: 'Every light glides from the upper colour to the lower one and back.',
            breathing: 'Upper and lower lighting breathe, each in its own colour.',
            wave: 'A band of colour around the upper colour, rolling from the passenger doors to the dash and the driver doors.',
            welcome: 'Once: the lights come on from the dashboard to the rear, then stay on what is applied now.',
            pulse: 'Once: red for a moment, then back to what is applied now (the Sport greeting).',
        };
        /** Text in lines no wider than maxW (the kit's canvas does not wrap). */
        const wrap = (cv, text, size, maxW) => {
            const lines = [];
            let line = '';
            String(text).split(' ').forEach((w) => { const next = line ? line + ' ' + w : w; if (line && cv.textWidth(next, size) > maxW) { lines.push(line); line = w; } else line = next; });
            if (line) lines.push(line);
            return lines;
        };
        function drawModes(cv, t) {
            editor.reset();
            const d = draft.modes, mode = MODE_ORDER[d.mode], params = d.params[mode];
            G.panel(cv, t, 20, 60, 440, 452, 'Lighting mode');
            MODE_ORDER.forEach((m, i) => {
                const y = 114 + i * 48, on = i === d.mode, applied = ctl.program && ctl.program.mode === m;
                cv.roundRect(36, y, 408, 43, 12, on ? withAlpha(t.sel || t.accent, 0.25) : withAlpha('#ffffff', 0.05));
                if (on) cv.strokeRoundRect(36, y, 408, 43, 12, 2, t.sel || t.accent);
                cv.text(S.MODE_LABELS[m], 56, y + 29, 21, t.text, { font: 'bold' });
                if (applied) G.pill(cv, t, 330, y + 8, 100, 28, 'ACTIVE', { color: t.accent, size: 13 });
                // (picking a mode gives it the car's active colours, unless its own were picked on this page)
                cv.target(36, y, 408, 43, () => { d.mode = i; syncModes(); markDirty('modes'); }, 'mode:' + m);
            });
            // the selected mode: its settings on the left, the cabin moving as the mode would move it on the right
            const P = { x: 480, y: 60, w: 1100, h: 452 }, CAR = { x: P.x + 746, y: P.y + 44, w: 344, h: 400 }, LEFT = CAR.x - P.x - 44;
            G.panel(cv, t, P.x, P.y, P.w, P.h, S.MODE_LABELS[mode]);
            wrap(cv, HELP[mode], 17, LEFT).slice(0, 2).forEach((line, i) => cv.text(line, P.x + 24, P.y + 70 + i * 22, 17, t.dim));
            let px = P.x + 80;
            const py = P.y + 134;
            (MODE_PARAMS[mode] || []).forEach((row) => {
                const [k, label, step, min, max, show] = row;
                const get = () => Number(params[k]), set = (v) => { params[k] = Math.max(min, Math.min(max, v)); if (mode === 'solid') d.own.solid = true; markDirty('modes'); };
                editor.control({ key: 'p:' + k, get, set, step, min, max });
                W.stepper(cv, t, px, py, 150, label, show ? show(get()) : get(), () => set(get() - step), () => set(get() + step), 'p:' + k, { editing: editor.isEditing('p:' + k) });
                cv.target(px, py, 150, 46, enter('p:' + k), 'p:' + k);
                px += 290;
            });
            const l = look();
            const from = d.own[mode] ? 'picked here' : l ? A.SOURCE_LABELS[l.source] : 'defaults (nothing applied or read yet)';
            const useActive = (x, y) => G.button(cv, t, x, y, 0, 40, 'Use active', () => { delete d.own[mode]; if (!syncModes()) say('No active colour known yet: apply one first', 2500); markDirty('modes'); }, { key: 'useactive', busy: !l || !d.own[mode] });
            let legend = null;
            if (S.RUNNING[mode]) {
                // the two groups' colours: Ambient Config's upper and lower, from the car unless picked here
                cv.text('COLOURS: ' + from.toUpperCase(), P.x + 24, P.y + 204, 12, t.dim, { font: 'bold', spacing: 2 });
                W.swatch(cv, t, P.x + 24, P.y + 212, 200, 58, params.top.colour, 'upper ' + params.top.brightness + '%', { size: 20, radius: 12 });
                W.swatch(cv, t, P.x + 240, P.y + 212, 200, 58, params.bottom.colour, 'lower ' + params.bottom.brightness + '%', { size: 20, radius: 12 });
                let ux = P.x + 24;
                ux += useActive(ux, P.y + 280) + 10;
                ux += G.button(cv, t, ux, P.y + 280, 0, 40, 'Use Colours page', () => { params.top = sideOf(draft.colours); params.bottom = sideOf(draft.colours); d.own[mode] = true; markDirty('modes'); }, { key: 'usecol' }) + 10;
                G.button(cv, t, ux, P.y + 280, 0, 40, 'Use Dual page', () => { params.top = sideOf(draft.dual.top); params.bottom = sideOf(draft.dual.bottom); d.own[mode] = true; markDirty('modes'); }, { key: 'usedual' });
                legend = [{ colour: C.rgbToHex(params.top.colour), text: 'upper' }, { colour: C.rgbToHex(params.bottom.colour), text: 'lower' }];
            }
            if (mode === 'solid') {
                cv.text('COLOUR: ' + from.toUpperCase(), P.x + 24, P.y + 204, 12, t.dim, { font: 'bold', spacing: 2 });
                W.swatch(cv, t, P.x + 24, P.y + 212, 200, 58, params.colour, params.brightness + '%', { size: 20, radius: 12 });
                let ux = P.x + 24;
                ux += useActive(ux, P.y + 280) + 10;
                G.button(cv, t, ux, P.y + 280, 0, 40, 'Use Colours page', () => { params.colour = rgbOf(draft.colours.hsv); params.brightness = draft.colours.brightness; d.own.solid = true; markDirty('modes'); }, { key: 'usecol' });
                legend = [{ colour: C.rgbToHex(params.colour), text: 'all lighting' }];
            }
            if (S.ONCE[mode]) cv.text('Ends on: ' + (still(ctl.program) ? S.describe(still(ctl.program), ctl.slaves).slice(0, 60) : 'the car\'s own lighting'), P.x + 24, P.y + 232, 17, t.text);
            // how this mode is written: an animation a whole LIN bus at a time, a still colour one module at a time
            const whole = ctl.txMode === 'broadcast' && ctl.broadcastOk;
            const how = S.isAnimated({ mode })
                ? (whole ? 'Whole-bus writes' + (S.RUNNING[mode] && mode !== 'breathing' ? ': 2 a frame' : '') : 'Single writes: ' + ctl.slaves.length + ' a frame') + (ctl.program && ctl.program.mode === mode ? '   ·   now ' + ctl.fps() + ' frames/s' : '')
                : 'Targeted writes: one per module, only where the colour changes';
            cv.text(how, P.x + 24, P.y + 340, 14, t.dim);
            applyRow(cv, t, P.x + 24, P.y + 352, 48, S.isAnimated({ mode }) ? (S.ONCE[mode] ? 'Run ' : 'Start ') + S.MODE_LABELS[mode] : 'Apply', dirty.modes);
            G.button(cv, t, P.x + 480, P.y + 406, 0, 40, 'Save preset', () => { const p = favs.addPreset(S.MODE_LABELS[mode] + ' ' + new Date().toISOString().slice(11, 16), modesProgram()); say('Saved ' + p.name); }, { key: 'savepreset' });
            linkPill(cv, t, P.x + 24, P.y + 410); statePill(cv, t, P.x + 204, P.y + 410, 260);
            // the preview: the same cabin as the Colours and the Dual page, lit by the same renderer the car's frames
            // come from, at this moment of the mode. Drawn only; nothing here reaches the controller.
            let scene = null;
            try { scene = preview.scene(modesProgram(), ctl.slaves, Date.now(), ctl.program ? { program: ctl.program, phase0: ctl.phase0 } : null); } catch (e) { scene = null; }
            W.carView(cv, t, CAR.x, CAR.y, CAR.w, CAR.h, ctl.slaves, scene, {
                heading: 'front · right-hand drive', deep: true, legend,
                status: preview.running ? 'on the car now' : 'preview', statusColour: preview.running ? t.ok : t.warn,
            });
        }

        /* ---------- FAVOURITES ---------- */
        function drawFavourites(cv, t) {
            editor.reset();
            G.panel(cv, t, 20, 60, 760, 452, 'Saved colours');
            const items = favs.list();
            if (!items.length) cv.text('Save a colour on the Colours page.', 44, 136, 18, t.dim);
            let x = 44, y = 114;
            items.forEach((f) => {
                const rc = C.hexToRgb(f.hex);
                cv.roundRect(x, y, 170, 60, 12, f.hex);
                cv.text(f.hex, x + 85, y + 36, 18, C.luma(rc) > 0.55 ? '#000000' : '#ffffff', { align: 'center', font: 'bold' });
                if (deleteMode) cv.text('TAP TO DELETE', x + 85, y + 53, 11, C.luma(rc) > 0.55 ? '#330000' : '#ffbbbb', { align: 'center', font: 'bold', spacing: 1.5 });
                cv.target(x, y, 170, 60, () => { if (deleteMode) { favs.remove(f.hex); say('Removed ' + f.hex); } else { draft.colours.hsv = hsvOf(rc); markDirty('colours'); openPage(0); say('Colour loaded: Apply to use it', 2000); } }, 'fav:' + f.hex);
                x += 180; if (x + 170 > 780) { x = 44; y += 70; }
            });
            G.panel(cv, t, 800, 60, 780, 452, 'Saved configurations');
            const cfg = favs.presets();
            if (!cfg.length) cv.text('Save a combination on the Dual page or a preset on the Modes page.', 824, 136, 17, t.dim);
            let cy = 114;
            cfg.slice(0, 5).forEach((p) => {
                cv.roundRect(824, cy, 730, 52, 12, withAlpha('#ffffff', 0.06));
                const prog = p.program;
                if (prog.mode === 'dual') { cv.roundRect(834, cy + 8, 36, 36, 8, C.rgbToHex(prog.top.colour)); cv.roundRect(874, cy + 8, 36, 36, 8, C.rgbToHex(prog.bottom.colour)); } else if (prog.colour) cv.roundRect(834, cy + 8, 76, 36, 8, C.rgbToHex(prog.colour)); else { cv.roundRect(834, cy + 8, 76, 36, 8, withAlpha(t.accent, 0.3)); }
                cv.text(p.name, 924, cy + 24, 18, t.text, { font: 'bold' });
                cv.text(S.describe(prog, ctl.slaves).slice(0, 70), 924, cy + 44, 13, t.dim);
                cv.target(824, cy, 560, 52, () => { if (deleteMode) { favs.removePreset(p.name); say('Removed ' + p.name); } else applyProgram(prog, 'Applied ' + p.name); }, 'cfg:' + p.name);
                G.button(cv, t, 1400, cy + 6, 0, 40, deleteMode ? 'Delete' : 'Apply', () => { if (deleteMode) { favs.removePreset(p.name); say('Removed ' + p.name); } else applyProgram(prog, 'Applied ' + p.name); }, { key: 'cfgbtn:' + p.name, color: deleteMode ? t.crit : undefined });
                cy += 60;
            });
            G.button(cv, t, 44, 456, 0, 44, deleteMode ? 'Done deleting' : 'Delete...', () => { deleteMode = !deleteMode; }, { key: 'del', color: deleteMode ? t.crit : undefined });
            G.button(cv, t, 824, 456, 0, 44, 'Save current as preset', () => { if (!ctl.program) { say('Nothing applied to save', 2000); return; } const p = favs.addPreset(S.MODE_LABELS[ctl.program.mode] + ' ' + new Date().toISOString().slice(11, 16), ctl.program); say('Saved ' + p.name); }, { key: 'savecur', busy: !ctl.program });
            G.button(cv, t, 1120, 456, 0, 44, 'Restore OEM', restoreOem, { key: 'oem', busy: svc.busy || !ctl.program });
        }

        /* ---------- DRIVING MODES ---------- */
        function drawDriving(cv, t) {
            editor.reset();
            const follow = settings.get('modeFollow') === 'on';
            G.panel(cv, t, 20, 60, 1560, 452, 'Lighting by driving mode');
            cv.text(follow ? 'On: the lighting changes with the driving mode, when the car is parked and the factory lighting allows it.' : 'Off: the choices below are kept but nothing changes with the driving mode.', 44, 126, 17, follow ? t.text : t.dim);
            const now = drive.mode();
            drive.modes().forEach((m, i) => {
                const y = 142 + i * 66, c = drive.choice(m), on = m === now;
                cv.roundRect(36, y, 1528, 58, 12, on ? withAlpha(t.sel || t.accent, 0.22) : withAlpha('#ffffff', 0.05));
                cv.text(drive.label(m), 56, y + 37, 23, t.text, { font: 'bold' });
                if (on) G.pill(cv, t, 190, y + 14, 90, 30, 'NOW', { color: t.accent, size: 13 });
                const what = c.type === 'custom' ? S.describe(c.program, ctl.slaves) : c.type === 'oem' ? 'BMW original lighting' : 'Your applied lighting (nothing special)';
                cv.text(what.slice(0, 62), 300, y + 36, 18, c.type === 'default' ? t.dim : t.text);
                let bx = 1010;
                bx += G.button(cv, t, bx, y + 7, 0, 44, 'Use applied', () => { const p = still(ctl.program); if (!p) { say('Apply a lighting first, then store it here', 2500); return; } drive.setChoice(m, { type: 'custom', program: p }); say(drive.label(m) + ': ' + S.describe(p, ctl.slaves)); }, { key: 'dm:use:' + m, busy: !ctl.program }) + 8;
                bx += G.button(cv, t, bx, y + 7, 0, 44, 'Default', () => { drive.setChoice(m, { type: 'default' }); }, { key: 'dm:def:' + m, color: c.type === 'default' ? t.accent : undefined }) + 8;
                G.button(cv, t, bx, y + 7, 0, 44, 'BMW', () => { drive.setChoice(m, { type: 'oem' }); }, { key: 'dm:oem:' + m, color: c.type === 'oem' ? t.accent : undefined });
            });
            const sw = (key) => settings.get(key) === 'on';
            const toggle = (key, label, tkey) => G.button(cv, t, bx, 456, 0, 44, label + ': ' + (sw(key) ? 'ON' : 'OFF'), () => { settings.set(key, sw(key) ? 'off' : 'on'); say(label + (sw(key) ? ' on' : ' off'), 1500); }, { key: tkey, color: sw(key) ? t.accent : undefined }) + 10;
            let bx = 36;
            bx += toggle('modeFollow', 'Follow driving mode', 'dm:follow');
            bx += toggle('sportPulse', 'Sport pulse', 'dm:pulse');
            // what the car's signals do to the lighting, each with its switch (an open door's line goes back to BMW: on from the start)
            bx += toggle('doorRelease', 'Open door: BMW light', 'fx:door');
            bx += toggle('turnGlow', 'Indicator glow', 'fx:turn');
            bx += toggle('nightDim', 'Night dimming', 'fx:night');
            cv.text('The car says: ' + drive.summary()[1] + (drive.seen.length ? '   seen: ' + drive.seen.join(', ') : '') + '   ·   ' + svc.car.summary(), 44, 436, 14, t.dim);
        }

        /* ---------- DIAGNOSTICS ---------- */
        function drawDiagnostics(cv, t) {
            editor.reset();
            const s = ctl.status(), caps = s.capabilities || {}, sc = s.scheduler || {};
            G.panel(cv, t, 20, 60, 760, 452, 'Lighting link');
            const rows = [
                ['Link', s.kind === 'mock' ? 'simulated BDC' + (ctl.latencyMs ? ' (' + ctl.latencyMs + ' ms per write)' : '') : s.kind === 'bdc-uds' ? 'BDC over TASU (UDS)' : 'SOME/IP probe'],
                ['State', s.state + (s.lastError ? ' - ' + s.lastError : '')],
                ['Armed', s.kind === 'bdc-uds' ? (ctl.armed ? 'YES: writes go to the car' : 'no: dry runs (' + (ctl.dryRuns || 0) + ')') : 'n/a'],
                ['BDC variant', caps.variant ? caps.variant.index + ' ' + (caps.variant.sgbd || '?') + ' (' + caps.rgbActuator + ')' : '-'],
                ['Modules', s.slaves.length + ' (' + s.slaves.filter((m) => m.bus === 1).length + ' on bus 1, ' + s.slaves.filter((m) => m.bus === 2).length + ' on bus 2), ' + s.driven + ' driven'],
                ['Applied', s.description],
                ['Writer', s.writer === 'bus' ? 'animation: ' + (s.writeMode === 'broadcast' ? 'whole-bus writes (NAD 0)' : 'single writes (whole-bus off or refused)') : s.writer === 'targeted' ? 'still colour: targeted, one write per module' : 'none (nothing applied)'],
                ['Writes', (sc.writes || 0) + ' sent, ' + (sc.accepted || 0) + ' ok, ' + (sc.rejected || 0) + ' refused, ' + (sc.busy || 0) + ' busy (' + (sc.maxBusyRetries == null ? '?' : sc.maxBusyRetries) + ' retries), ' + (sc.timeouts || 0) + ' unanswered (never resent), ' + (sc.skipped || 0) + ' skipped'],
                ['Transport', (s.txMode === 'broadcast' ? (s.broadcastOk ? 'whole-bus writes for animations (' + (s.stats.broadcasts || 0) + (s.deaf && s.deaf.length ? ', single for ' + s.deaf.join(' ') : '') + '), ' : 'whole-bus refused: single writes, ') : '') + (s.stats.busReleases ? s.stats.busReleases + ' whole-bus releases, ' : '') + (sc.avgLatencyMs == null ? '-' : sc.avgLatencyMs + ' ms per write') + ', ' + (sc.writesPerSec || 0) + ' writes/s, ' + (sc.queued || 0) + ' queued, in flight ' + (sc.inFlight || 0) + '/' + (sc.maxInFlight || 1)],
                ['Keep-alive', 'ZEIT ' + s.holdSeconds + ' s, renewed after ' + Math.round(s.renewMs / 100) / 10 + ' s; ' + (s.stats.verified ? (s.stats.confirmed || 0) + ' read back ok, ' + (s.stats.missed || 0) + ' missed' + (s.verifying ? ' (reading)' : '') + '; ' : '') + (s.stats.keepAlives || 0) + ' refreshes, last apply ' + (s.stats.lastApplyMs == null ? '-' : s.stats.lastApplyMs + ' ms')],
                ['Animation', s.moving ? s.fps + ' frames/s, ' + (s.stats.framesWritten || 0) + ' frames written, none queued' : 'none'],
                ['Parking', s.parkedPolicy + (svc.parked ? ', speed ' + (svc.parked.speed() == null ? 'unknown' : Math.round(svc.parked.speed()) + ' km/h') : ', no speed signal')],
                ['Factory light', oem.summary()[0]],
                ['Factory colour', oem.summary()[1]],
                ['Car', drive.summary()[0] + '; mode ' + drive.summary()[1]],
                ['Signals', svc.car.summary() + (s.released && s.released.length ? '; with BMW: ' + s.released.join(' ') : '')],
                ['Gate', s.gate || 'open'],
            ];
            G.table(cv, t, 36, 92, 730, [{ w: 150, title: '' }, { w: 580, title: '' }], rows, { rowH: 20, size: 14 });
            G.panel(cv, t, 800, 60, 780, 452, 'Modules' + (s.slaves.length ? ' (' + s.slaves.length + ')' : ''));
            const sl = s.slaves.slice(0, 15).map((x) => { const tg = s.scene[x.bus + ':' + x.nad]; return [x.bus + ':' + x.nad, (x.location || '').slice(0, 40), tg ? C.rgbToHex(tg) + ' ' + tg.brightness + '%' : (x.driven ? 'releasing' : 'OEM') + (x.failures ? ' NRC' : '')]; });
            if (!sl.length) sl.push(['-', s.kind === 'bdc-uds' ? 'read 22 DA 5F / E3 D1 failed or no link' : 'none', '']);
            G.table(cv, t, 816, 100, 750, [{ w: 60, title: '' }, { w: 440, title: '' }, { w: 250, title: '' }], sl, { rowH: 22, size: 14 });
            if (s.slaves.length > 15) cv.text('+ ' + (s.slaves.length - 15) + ' more modules', 876, 490, 14, t.dim);
            let bx = 36;
            bx += G.button(cv, t, bx, 464, 0, 42, svc.probing ? 'Probing...' : 'Probe again', async () => { if (svc.probing) return; svc.probing = true; try { await ctl.probe(); } finally { svc.probing = false; } say('Probe done: ' + ctl.state); }, { key: 'probe', busy: svc.probing }) + 10;
            bx += G.button(cv, t, bx, 464, 0, 42, 'Restore OEM', restoreOem, { key: 'oem', busy: svc.busy || !ctl.program }) + 10;
            linkPill(cv, t, bx, 469, 150); statePill(cv, t, bx + 158, 469, 190);
        }

        /* ---------- the frame ---------- */
        ctx.loop('MAIN', 10, () => {
            const t = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            geometry = {};
            const badges = [];
            if (ctl.kind === 'mock') badges.push({ text: 'SIM' });
            if (ctl.kind === 'bdc-uds' && !ctl.armed) badges.push({ text: 'DRY RUN' });
            if (ctl.program) badges.push({ text: (S.MODE_LABELS[ctl.program.mode] || 'CUSTOM').toUpperCase() });
            if (editor.editing) badges.push({ text: 'EDITING' });
            G.frame(cv, t, PAGES, page, badges);
            try { [drawColours, drawDual, drawModes, drawFavourites, drawDiagnostics, drawDriving][page](cv, t); } catch (e) { log.error('draw page ' + page, e); }
            if (flash && Date.now() < flash.until) {
                const w = Math.min(1500, cv.textWidth(flash.text, 20, { font: 'bold' }) + 60);
                // over the page's title line, clear of the action rows at the bottom
                cv.roundRect(800 - w / 2, 50, w, 40, 20, withAlpha('#000000', 0.82));
                cv.strokeRoundRect(800 - w / 2, 50, w, 40, 20, 1, withAlpha('#ffffff', 0.25));
                cv.text(flash.text, 800, 77, 20, '#ffffff', { align: 'center', font: 'bold' });
            } else flash = null;
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
