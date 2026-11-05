'use strict';
/**
 * Ambient RGB - the G20's factory ambient lighting under your control, as a native iDrive 7 (MGU) app on the MGU App
 * Kit (cauliflowermossgrape/idrive7-apps). Five pages (header tabs):
 *
 *   COLOURS    a list of the ways to light the cabin, the hue ring with the colour in its middle, a brightness
 *              dial, saturation, the cabin from above lit as it would be, a zone picker, Apply / Cancel
 *   DUAL       upper and lower lighting with their own colour and brightness; swap, copy, save, Apply both
 *   MODES      Solid, Dual, Rainbow, Smooth Fade, Breathing, Colour Wave with their settings; Apply
 *   FAVOURITES saved colours and saved complete configurations (colours, brightness, zones, mode, animation)
 *   DIAGNOSTICS link, body controller, transport performance, write controls
 *
 * PREVIEW vs APPLIED: every page edits a DRAFT. Turning the knob, tapping the wheel or the dial changes only the
 * screen. The car changes when Apply (a page button, the bar's Apply, or the confirming press when the setting
 * "Press to confirm applies" is on) hands the draft to the LightingController, which is the only thing that writes.
 * Leaving a page or pressing Cancel drops the draft. An applied static configuration keeps its keep-alives while
 * another draft is being browsed.
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
const { Favourites } = require('./favourites');
const { MockLightingController } = require('./lighting_mock');
const { BdcUdsLightingController } = require('./lighting_bdc_uds');
const { SomeIpLightingController } = require('./lighting_someip');

const PAGES = ['Colours', 'Dual', 'Modes', 'Favourites', 'Diagnostics'];
const ZONE_ORDER = ['all', 'dashboard', 'frontDoors', 'rearDoors', 'footwells', 'upper', 'lower'];
const MODE_ORDER = ['solid', 'dual', 'rainbow', 'fade', 'breathing', 'wave'];
const hsvOf = (c) => C.rgbToHsv(c);
const rgbOf = (hsv) => C.hsvToRgb(hsv.h, hsv.s, hsv.v);
const clone = (o) => JSON.parse(JSON.stringify(o));

mgu.run({
    async start(ctx) {
        const log = ctx.log, settings = ctx.settings;
        const favs = new Favourites(ctx.dataDir, log);
        const editor = new W.Editor(ctx, log);
        let page = 0, flash = null, probing = false, busy = false, deleteMode = false;
        let ctl = null, parked = null;
        const say = (text, ms) => { flash = { text, until: Date.now() + (ms || 2500) }; };

        /* ---------- drafts (previews): one per page, never sent anywhere by themselves ---------- */
        const draft = {
            // (saturation is always 1: the ring picks pure hues; only the BDC's library colours carry their own)
            colours: { hsv: { h: 262, s: 1, v: 1 }, brightness: 100, zone: 0 },                          // zone: index into ZONE_ORDER
            dual: { top: { hsv: { h: 270, s: 1, v: 1 }, brightness: 80 }, bottom: { hsv: { h: 200, s: 1, v: 1 }, brightness: 45 }, focus: 'top' },
            modes: { mode: 0, params: clone(S.DEFAULTS) },                                                 // mode: index into MODE_ORDER
        };
        let dirty = { colours: false, dual: false, modes: false };
        const markDirty = (p) => { dirty[p] = true; };

        /* ---------- the lighting link ---------- */
        async function makeController() {
            if (ctl) { try { await ctl.shutdown(); } catch (e) { /* */ } ctl.removeAllListeners(); }
            const common = {
                log, refreshSeconds: Number(settings.get('refresh')) || 10, frameMs: Number(settings.get('frame')) || 80,
                maxInFlight: settings.get('inflight') === '2' ? 2 : 1, parkedPolicy: settings.get('parked') === 'lenient' ? 'lenient' : 'strict',
                parked: () => (parked ? (parked.speed() === null ? null : !parked.moving()) : null),
            };
            const backend = settings.get('backend');
            if (backend === 'bdc') {
                ctl = new BdcUdsLightingController(Object.assign(common, { signals: ctx.signals, armed: settings.get('arm') === 'on', allowUnknownVariant: settings.get('unknownVariant') === 'on' }));
                try { await ctl.init(); } catch (e) { log.warn('diagnostic link: ' + e); }
            } else if (backend === 'someip') {
                ctl = new SomeIpLightingController(Object.assign(common, { signals: ctx.signals }));
            } else {
                ctl = new MockLightingController(Object.assign(common, { latencyMs: Number(settings.get('simLatency')) || 0 }));
            }
            ctl.on('failure', (why) => say('Lighting control stopped: ' + why, 5000));
            ctl.on('refused', (why) => say('Cannot apply: ' + why, 4000));
            ctl.on('state', (s, err) => { if (s === 'disconnected' && err) say('Link: ' + err, 4000); });
            probing = true;
            await ctl.connect();
            probing = false;
            log.info('lighting link ' + ctl.kind + ': ' + ctl.state + (ctl.lastError ? ' (' + ctl.lastError + ')' : ''));
        }
        await makeController();
        try { parked = require('./kit/parked').watch(ctx, log); } catch (e) { log.warn('parked: ' + e); }

        /* ---------- apply the last lighting at start (setting, off by default) ----------
         * The last configuration Apply sent is kept (favourites.json "last"); Restore OEM clears it. With the setting on,
         * it is applied once the link is up, retrying for a while when the parking state is not yet known (the speed
         * signal arrives a moment after start) and giving up quietly on any other refusal. */
        let autoApplyTimer = null;
        function autoApplyAtStart() {
            const last = favs.lastApplied();
            if (settings.get('autoApply') !== 'on' || !last) return;
            let tries = 0;
            const attempt = async () => {
                autoApplyTimer = null;
                if (ctl.program || busy) return;                   // the user got there first
                if (ctl.state !== 'connected') { if (++tries < 20) autoApplyTimer = setTimeout(attempt, 1500); return; }
                const can = ctl.canControl();
                if (!can.ok && /parking state unknown/.test(can.reason || '') && ++tries < 20) { autoApplyTimer = setTimeout(attempt, 1500); return; }
                if (!can.ok) { log.info('apply at start skipped: ' + can.reason); return; }
                busy = true;
                try {
                    const r = await ctl.apply(last.program);
                    if (r.ok) say('Last lighting applied: ' + S.describe(last.program, ctl.slaves), 3000); else log.info('apply at start refused: ' + (r.reason || 'refused'));
                } finally { busy = false; }
            };
            autoApplyTimer = setTimeout(attempt, 50);
        }
        autoApplyAtStart();

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
            return Object.assign({}, draft.modes.params[mode], { mode });
        }
        const pageProgram = () => (page === 0 ? coloursProgram() : page === 1 ? dualProgram() : page === 2 ? modesProgram() : null);

        /* ---------- actions ---------- */
        async function applyProgram(program, what) {
            if (busy) { say('Please wait'); return; }
            busy = true;
            try {
                const r = await ctl.apply(program);
                if (r.ok) { say((what || 'Applied') + (r.failed ? ' (' + r.failed + ' module(s) refused)' : '') + (ctl.kind === 'bdc-uds' && !ctl.armed ? ' [dry run]' : '')); dirty = { colours: false, dual: false, modes: false }; favs.setLast(program); }
                else say('Not applied: ' + (r.reason || 'refused'), 4500);
            } finally { busy = false; }
        }
        async function applyPage() { const p = pageProgram(); if (p) await applyProgram(p); }
        async function restoreOem() {
            if (busy) return;
            busy = true;
            try {
                const r = await ctl.restoreOem();
                say(r.ok ? 'OEM lighting restored' : 'Restore incomplete: ' + r.reason, r.ok ? 2500 : 6000);
                favs.clearLast();                                   // Restore OEM is the off switch: nothing comes back at the next start
            } finally { busy = false; }
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

        /* ---------- settings ---------- */
        let linkKey = [settings.get('backend'), settings.get('arm'), settings.get('unknownVariant'), settings.get('inflight'), settings.get('parked'), settings.get('simLatency')].join('|');
        settings.onChange(async (key) => {
            const now = [settings.get('backend'), settings.get('arm'), settings.get('unknownVariant'), settings.get('inflight'), settings.get('parked'), settings.get('simLatency')].join('|');
            if (now !== linkKey) { linkKey = now; await makeController(); say('Lighting link: ' + ctl.kind); }
            if (key === 'refresh' || !key) ctl.refreshSeconds = Math.max(2, Math.min(254, Number(settings.get('refresh')) || 10));
            if (key === 'frame' || !key) ctl.frameMs = Number(settings.get('frame')) || 80;
        });

        /* ---------- input ---------- */
        if (ctx.controller && ctx.controller.onInput) ctx.controller.onInput((v) => editor.input(v));
        let geometry = {};                                     // what the last frame drew, for taps: { wheel, ring, ... }
        ctx.onTap((x, y) => {
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
        ctx.onTab((i) => { editor.cancel(); page = i; deleteMode = false; });
        ctx.ui.onClick('BTN_APPLY', () => { if (page <= 2) applyPage(); else say('Nothing to apply on this page', 1500); });
        ctx.ui.onClick('BTN_OEM', restoreOem);
        ctx.ui.onClick('BTN_PAGE', () => { editor.cancel(); page = (page + 1) % PAGES.length; deleteMode = false; });
        if (ctx.app && ctx.app.on) ctx.app.on('shutdown', () => { if (autoApplyTimer) clearTimeout(autoApplyTimer); ctl.shutdown(); });
        ctx.__ambient = { ctl: () => ctl, draft, editor, favs, page: () => page, setPage: (i) => { page = i; }, dirty: () => dirty, applyPage, restoreOem, coloursProgram, dualProgram, modesProgram };

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
            ax += G.button(cv, t, ax, y, 0, h, label || 'Apply', applyPage, { primary: true, key: 'apply', busy }) + 10;
            ax += G.button(cv, t, ax, y, 0, h, 'Cancel', cancelPage, { key: 'cancel', busy: !isDirty }) + 10;
            ax += G.button(cv, t, ax, y, 0, h, 'Restore OEM', restoreOem, { key: 'oem', busy: busy || !ctl.program }) + 10;
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
                ['Single colour', null], ['Dual colour', () => { page = 1; }],
                ['ANIMATION'], ...MODE_ORDER.slice(2).map((m, i) => [S.MODE_LABELS[m], () => { draft.modes.mode = i + 2; page = 2; }]),
                ['MORE'], ['Favourites', () => { page = 3; }],
            ];
            let ly = 104;
            rows.forEach(([label, go]) => {
                if (!go && label === label.toUpperCase()) { cv.text(label, 40, ly + 20, 12, t.dim, { font: 'bold', spacing: 2 }); ly += 30; return; }
                const sel = !go;
                cv.roundRect(36, ly, 368, 42, 10, sel ? withAlpha(t.sel || t.accent, 0.25) : withAlpha('#ffffff', 0.05));
                if (sel) cv.strokeRoundRect(36, ly, 368, 42, 10, 2, t.sel || t.accent);
                cv.text(label, 54, ly + 28, 20, t.text, { font: sel ? 'bold' : undefined });
                if (go) { cv.text('›', 384, ly + 29, 22, t.dim, { align: 'center' }); cv.target(36, ly, 368, 42, () => { editor.cancel(); go(); }, 'go:' + label); }
                ly += 48;
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
            const ax = applyRow(cv, t, 460, 462, 44, 'Apply', dirty.colours);
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
            W.carView(cv, t, mx + 10, my + 40, 220, 300, ctl.slaves, scene, {
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
            G.button(cv, t, ax, ay, 94, 46, 'OEM', restoreOem, { key: 'oem', busy: busy || !ctl.program });
            linkPill(cv, t, mx + 24, my + 404, 150); statePill(cv, t, mx + 184, my + 404, 150);
            cv.text(dirty.dual ? 'Preview only until Apply both' : ctl.program && ctl.program.mode === 'dual' ? 'Applied' : 'Not applied', mx + 344, my + 426, 14, t.dim);
        }

        /* ---------- MODES ---------- */
        const MODE_PARAMS = {
            rainbow: [['periodS', 'Seconds per turn', 1, 2, 120], ['brightness', 'Brightness %', 5, 0, 100]],
            fade: [['transitionMs', 'Transition ms', 250, 250, 10000], ['holdMs', 'Hold ms', 250, 0, 10000], ['brightness', 'Brightness %', 5, 0, 100]],
            breathing: [['minBrightness', 'Min %', 5, 0, 100], ['maxBrightness', 'Max %', 5, 0, 100], ['periodS', 'Seconds per breath', 1, 1, 30]],
            wave: [['periodS', 'Seconds per wave', 1, 2, 60], ['hueSpan', 'Hue span', 10, 10, 180], ['baseHue', 'Base hue', 10, 0, 350], ['brightness', 'Brightness %', 5, 0, 100]],
            solid: [['brightness', 'Brightness %', 5, 0, 100]],
            dual: [],
        };
        function drawModes(cv, t) {
            editor.reset();
            const d = draft.modes, mode = MODE_ORDER[d.mode], params = d.params[mode];
            G.panel(cv, t, 20, 60, 440, 452, 'Lighting mode');
            MODE_ORDER.forEach((m, i) => {
                const y = 108 + i * 60, on = i === d.mode, applied = ctl.program && ctl.program.mode === m;
                cv.roundRect(36, y, 408, 50, 12, on ? withAlpha(t.sel || t.accent, 0.25) : withAlpha('#ffffff', 0.05));
                if (on) cv.strokeRoundRect(36, y, 408, 50, 12, 2, t.sel || t.accent);
                cv.text(S.MODE_LABELS[m], 56, y + 32, 22, t.text, { font: 'bold' });
                if (applied) G.pill(cv, t, 330, y + 10, 100, 30, 'ACTIVE', { color: t.accent, size: 13 });
                cv.target(36, y, 408, 50, () => { d.mode = i; markDirty('modes'); }, 'mode:' + m);
            });
            // the selected mode's settings
            const P = { x: 480, y: 60, w: 1100, h: 452 };
            G.panel(cv, t, P.x, P.y, P.w, P.h, S.MODE_LABELS[mode]);
            const help = { solid: 'One colour on the chosen zone (set it on the Colours page).', dual: 'Upper and lower lighting with their own colours (set them on the Dual page).', rainbow: 'All colours in turn, slowly.', fade: 'Glides from colour to colour through the palette, holding each.', breathing: 'The brightness rises and falls between the limits.', wave: 'A hue wave travelling from the dashboard to the rear.' }[mode];
            cv.text(help, P.x + 24, P.y + 60, 17, t.dim);
            let px = P.x + 80, py = P.y + 120;
            (MODE_PARAMS[mode] || []).forEach((row) => {
                const [k, label, step, min, max] = row;
                const get = () => Number(params[k]), set = (v) => { params[k] = Math.max(min, Math.min(max, v)); markDirty('modes'); };
                editor.control({ key: 'p:' + k, get, set, step, min, max });
                W.stepper(cv, t, px, py, 150, label, get(), () => set(get() - step), () => set(get() + step), 'p:' + k, { editing: editor.isEditing('p:' + k) });
                cv.target(px, py, 150, 46, enter('p:' + k), 'p:' + k);
                px += 290;
                if (px > P.x + P.w - 220) { px = P.x + 80; py += 90; }
            });
            if (mode === 'fade') {
                cv.text('PALETTE', P.x + 24, P.y + 300, 13, t.dim, { font: 'bold', spacing: 2 });
                let cx = P.x + 24;
                params.colours.forEach((col, i) => {
                    cv.roundRect(cx, P.y + 310, 70, 40, 8, C.rgbToHex(col));
                    cv.target(cx, P.y + 310, 70, 40, () => { params.colours.splice(i, 1); if (!params.colours.length) params.colours.push({ r: 254, g: 0, b: 0 }); markDirty('modes'); }, 'pal:' + i);
                    cx += 78;
                });
                G.button(cv, t, cx + 10, P.y + 308, 0, 44, 'Add current colour', () => { if (params.colours.length < 8) { params.colours.push(rgbOf(draft.colours.hsv)); markDirty('modes'); } }, { key: 'addcol' });
            }
            if (mode === 'breathing' || mode === 'solid') {
                const col = mode === 'breathing' ? params.colour : rgbOf(draft.colours.hsv);
                W.swatch(cv, t, P.x + 24, P.y + 300, 200, 60, col, 'colour', { size: 20, radius: 12 });
                G.button(cv, t, P.x + 240, P.y + 308, 0, 44, 'Use Colours page colour', () => { if (mode === 'breathing') params.colour = rgbOf(draft.colours.hsv); else { params.colour = rgbOf(draft.colours.hsv); } markDirty('modes'); }, { key: 'usecol' });
            }
            if (mode === 'wave') {
                const rps = ctl.scheduler.stats.avgLatencyMs ? Math.round(1000 / (ctl.scheduler.stats.avgLatencyMs * Math.max(1, ctl.slaves.length))) : null;
                cv.text('Needs a few frames a second across the cabin: ' + (rps == null ? 'throughput not measured yet' : 'about ' + rps + ' frames/s with this link') + (rps != null && rps < 2 ? ' (too slow for a smooth wave)' : ''), P.x + 24, P.y + 300, 15, rps != null && rps < 2 ? t.warn : t.dim);
            }
            const sx = applyRow(cv, t, P.x + 24, P.y + 372, 50, S.isAnimated({ mode }) ? 'Start ' + S.MODE_LABELS[mode] : 'Apply', dirty.modes);
            G.button(cv, t, sx, P.y + 372, 0, 50, 'Save as preset', () => { const p = favs.addPreset(S.MODE_LABELS[mode] + ' ' + new Date().toISOString().slice(11, 16), modesProgram()); say('Saved ' + p.name); }, { key: 'savepreset' });
            linkPill(cv, t, P.x + 24, P.y + 432); statePill(cv, t, P.x + 204, P.y + 432, 260);
        }

        /* ---------- FAVOURITES ---------- */
        function drawFavourites(cv, t) {
            editor.reset();
            G.panel(cv, t, 20, 60, 760, 452, 'Saved colours');
            const items = favs.list();
            if (!items.length) cv.text('Save a colour on the Colours page.', 44, 120, 18, t.dim);
            let x = 44, y = 106;
            items.forEach((f) => {
                const rc = C.hexToRgb(f.hex);
                cv.roundRect(x, y, 170, 60, 12, f.hex);
                cv.text(f.hex, x + 85, y + 36, 18, C.luma(rc) > 0.55 ? '#000000' : '#ffffff', { align: 'center', font: 'bold' });
                if (deleteMode) cv.text('TAP TO DELETE', x + 85, y + 53, 11, C.luma(rc) > 0.55 ? '#330000' : '#ffbbbb', { align: 'center', font: 'bold', spacing: 1.5 });
                cv.target(x, y, 170, 60, () => { if (deleteMode) { favs.remove(f.hex); say('Removed ' + f.hex); } else { draft.colours.hsv = hsvOf(rc); markDirty('colours'); page = 0; say('Colour loaded: Apply to use it', 2000); } }, 'fav:' + f.hex);
                x += 180; if (x + 170 > 780) { x = 44; y += 70; }
            });
            G.panel(cv, t, 800, 60, 780, 452, 'Saved configurations');
            const cfg = favs.presets();
            if (!cfg.length) cv.text('Save a combination on the Dual page or a preset on the Modes page.', 824, 120, 17, t.dim);
            let cy = 106;
            cfg.slice(0, 6).forEach((p) => {
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
            G.button(cv, t, 1120, 456, 0, 44, 'Restore OEM', restoreOem, { key: 'oem', busy: busy || !ctl.program });
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
                ['Writes', (sc.writes || 0) + ' sent, ' + (sc.accepted || 0) + ' ok, ' + (sc.rejected || 0) + ' refused, ' + (sc.busy || 0) + ' busy, ' + (sc.timeouts || 0) + ' timeouts, ' + (sc.skipped || 0) + ' skipped'],
                ['Transport', (sc.avgLatencyMs == null ? '-' : sc.avgLatencyMs + ' ms per write') + ', ' + (sc.writesPerSec || 0) + ' writes/s, ' + (sc.queued || 0) + ' queued, in flight ' + (sc.inFlight || 0) + '/' + (sc.maxInFlight || 1)],
                ['Keep-alive', 'ZEIT ' + s.refreshSeconds + ' s, refresh at ' + Math.round(s.refreshSeconds * ctl.keepAliveFactor) + ' s; ' + (s.stats.keepAlives || 0) + ' refreshes, last apply ' + (s.stats.lastApplyMs == null ? '-' : s.stats.lastApplyMs + ' ms')],
                ['Animation', s.animated ? s.fps + ' frames/s, ' + s.stats.frames + ' frames, ' + s.stats.framesDropped + ' dropped' : 'none'],
                ['Parking', s.parkedPolicy + (parked ? ', speed ' + (parked.speed() == null ? 'unknown' : Math.round(parked.speed()) + ' km/h') : ', no speed signal')],
            ];
            G.table(cv, t, 36, 100, 730, [{ w: 150, title: '' }, { w: 580, title: '' }], rows, { rowH: 30, size: 17 });
            G.panel(cv, t, 800, 60, 780, 452, 'Modules' + (s.slaves.length ? ' (' + s.slaves.length + ')' : ''));
            const sl = s.slaves.slice(0, 16).map((x) => { const tg = s.scene[x.bus + ':' + x.nad]; return [x.bus + ':' + x.nad, (x.location || '').slice(0, 40), tg ? C.rgbToHex(tg) + ' ' + tg.brightness + '%' : (x.driven ? 'releasing' : 'OEM') + (x.failures ? ' NRC' : '')]; });
            if (!sl.length) sl.push(['-', s.kind === 'bdc-uds' ? 'read 22 DA 5F / E3 D1 failed or no link' : 'none', '']);
            G.table(cv, t, 816, 100, 750, [{ w: 60, title: '' }, { w: 440, title: '' }, { w: 250, title: '' }], sl, { rowH: 22, size: 14 });
            if (s.slaves.length > 16) cv.text('+ ' + (s.slaves.length - 16) + ' more', 1400, 472, 14, t.dim);
            let bx = 36;
            bx += G.button(cv, t, bx, 460, 0, 44, probing ? 'Probing...' : 'Probe again', async () => { if (probing) return; probing = true; await ctl.probe(); probing = false; say('Probe done: ' + ctl.state); }, { key: 'probe', busy: probing }) + 10;
            bx += G.button(cv, t, bx, 460, 0, 44, 'Restore OEM', restoreOem, { key: 'oem', busy: busy || !ctl.program }) + 10;
            linkPill(cv, t, bx, 466); statePill(cv, t, bx + 180, 466, 240);
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
            try { [drawColours, drawDual, drawModes, drawFavourites, drawDiagnostics][page](cv, t); } catch (e) { log.error('draw page ' + page, e); }
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
