'use strict';
/**
 * Ambient RGB - a colour wheel for the G20's factory ambient lighting, as a native iDrive 7 (MGU) app on the
 * MGU App Kit (cauliflowermossgrape/idrive7-apps). Three pages (header tabs): COLOUR (the wheel, value slider,
 * HSV nudges, preview, link status), FAVOURITES (saved colours and the BDC's own six), DIAGNOSTICS (what the
 * body controller answered, what is verified, every exchange).
 *
 * The UI only talks to a LightingController (lighting_controller.js): the simulated BDC by default
 * (lighting_mock.js), the car's BDC over the head unit's diagnostic link when the setting "Lighting link" is
 * "Car" AND "Write to the car" is armed (lighting_bdc_uds.js; unarmed it dry-runs and logs the bytes).
 *
 * Input: touch on the wheel / slider / buttons where the kit runs the screen (GPU renderer, full-screen
 * layout); the HMI's bar buttons everywhere (Custom on/off, Restore OEM, Next page, Settings); the iDrive knob
 * turns hue / saturation / value on the COLOUR page when the controller gate is installed (setting "knob");
 * and, for a unit without touch routing, the Hue / Saturation / Value settings in the Settings screen.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const C = require('./colour');
const { Favourites } = require('./favourites');
const { MockLightingController } = require('./lighting_mock');
const { BdcUdsLightingController } = require('./lighting_bdc_uds');
const { SomeIpLightingController } = require('./lighting_someip');

const PAGES = ['Colour', 'Favourites', 'Diagnostics'];
const WHEEL = { size: 400, x: 70, y: 70 };                   // page px; ramped arcs in a cached layer (no pixel images: those need one renderer dialect only)
const SLIDER = { x: 520, y: 72, w: 44, h: 396 };
const RIGHT = { x: 610, y: 60, w: 970, h: 452 };

/** hue / sat / val from the FrontCCU knob (counter wrapping at 16 bits), as apps/doom/controls.js reads it. */
class Knob {
    constructor() { this.pos = null; this.pressed = false; }
    /** returns { turn, press } for one statusRotaryEncoderState event */
    read(v) {
        const out = { turn: 0, press: false };
        if (!v) return out;
        const pos = v.frontRotaryEncoderOperation;
        if (typeof pos === 'number' && pos !== 65535) {
            if (this.pos !== null) { const d = ((pos - this.pos + 32768) & 0xffff) - 32768; if (Math.abs(d) <= 64) out.turn = d; }
            this.pos = pos;
        }
        const pb = v.frontRotaryEncoderPushButton;
        const p = pb === 1 || pb === 2 || (typeof pb === 'string' && /GEDRUECKT/.test(pb));
        if (p && !this.pressed) out.press = true;
        this.pressed = p;
        return out;
    }
}

mgu.run({
    async start(ctx) {
        const log = ctx.log, settings = ctx.settings;
        const favs = new Favourites(ctx.dataDir, log);
        let page = 0, hsv = { h: 210, s: 1, v: 1 }, channel = 'h', deleteMode = false, flash = null, probing = false;
        let ctl = null, parked = null, knobGrabbed = false;
        const knob = new Knob();
        const wheelLayer = () => G.layer('ambient_rgb:wheel', WHEEL.size + 2, WHEEL.size + 2, (c) => C.drawWheel(c, WHEEL.size / 2 + 1, WHEEL.size / 2 + 1, WHEEL.size / 2));

        const say = (text, ms) => { flash = { text, until: Date.now() + (ms || 2500) }; };
        const colour = () => C.hsvToRgb(hsv);

        /* ---------- the lighting controller for the chosen link ---------- */
        async function makeController() {
            if (ctl) { try { await ctl.shutdown(); } catch (e) { /* */ } ctl.removeAllListeners(); }
            const common = { log, refreshSeconds: Number(settings.get('refresh')) || 10, brightness: Number(settings.get('brightness')) || 100 };
            const backend = settings.get('backend');
            if (backend === 'bdc') {
                ctl = new BdcUdsLightingController(Object.assign(common, { signals: ctx.signals, armed: settings.get('arm') === 'on', allowUnknownVariant: settings.get('unknownVariant') === 'on' }));
                try { await ctl.init(); } catch (e) { log.warn('diagnostic link: ' + e); }
            } else if (backend === 'someip') {
                ctl = new SomeIpLightingController(Object.assign(common, { signals: ctx.signals }));
            } else {
                ctl = new MockLightingController(common);
            }
            ctl.on('failure', (why) => say('Custom control off: ' + why, 5000));
            ctl.on('refused', (why) => say('Cannot enable: ' + why, 4000));
            ctl.on('state', (s, err) => { if (s === 'disconnected' && err) say('Link: ' + err, 4000); });
            ctl.setColour(colour());
            probing = true;
            await ctl.connect();
            probing = false;
            log.info('lighting link ' + ctl.kind + ': ' + ctl.state + (ctl.lastError ? ' (' + ctl.lastError + ')' : ''));
        }
        await makeController();
        try { parked = require('./kit/parked').watch(ctx, log); } catch (e) { log.warn('parked: ' + e); }

        /* ---------- colour changes ---------- */
        function setHsv(next, why) {
            hsv = { h: C.wrapHue(next.h), s: C.clamp01(next.s), v: C.clamp01(next.v) };
            ctl.setColour(colour());
            if (why) log.info('colour ' + C.rgbToHex(colour()) + ' (' + why + ')');
        }
        function setRgb(c, why) { setHsv(C.rgbToHsv(c), why); }

        async function toggleCustom() {
            if (ctl.custom) { await ctl.disableCustom(); say('Custom control off: OEM lighting'); return; }
            if (parked && parked.moving()) { say('Park the car to switch to a custom colour', 4000); return; }
            const r = await ctl.enableCustom();
            if (r.ok) say('Custom control on' + (ctl.armed === false ? ' (dry run: not armed)' : ''));
        }
        async function restoreOem() { await ctl.restoreOem(); say('OEM lighting restored'); }

        /* ---------- settings ---------- */
        let lastBackend = settings.get('backend') + '|' + settings.get('arm') + '|' + settings.get('unknownVariant');
        settings.onChange(async (key) => {
            const now = settings.get('backend') + '|' + settings.get('arm') + '|' + settings.get('unknownVariant');
            if (now !== lastBackend) { lastBackend = now; await makeController(); say('Lighting link: ' + ctl.kind); }
            if (key === 'refresh' || !key) ctl.refreshSeconds = Math.max(2, Math.min(254, Number(settings.get('refresh')) || 10));
            if (key === 'brightness' || !key) ctl.setColour(colour(), { brightness: Number(settings.get('brightness')) || 100 });
            if (key === 'hue' || key === 'sat' || key === 'val') {
                setHsv({ h: Number(settings.get('hue')), s: Number(settings.get('sat')) / 100, v: Number(settings.get('val')) / 100 }, 'settings');
            }
            grabKnob();
        });

        /* ---------- the iDrive knob ---------- */
        function grabKnob() {
            const want = page === 0 && settings.get('knob') !== 'off' && !!ctx.controller;
            if (want === knobGrabbed) return;
            knobGrabbed = want;
            try { ctx.controller.grab(want); } catch (e) { /* no gate */ }
        }
        if (ctx.controller && ctx.controller.onInput) {
            ctx.controller.onInput((v) => {
                const k = knob.read(v);
                if (k.press) { channel = channel === 'h' ? 's' : channel === 's' ? 'v' : 'h'; say('Knob: ' + ({ h: 'hue', s: 'saturation', v: 'value' })[channel], 1500); }
                if (k.turn) {
                    const mode = settings.get('knob');
                    const ch = mode === 'sat' ? 's' : mode === 'val' ? 'v' : mode === 'hue' ? 'h' : channel;
                    setHsv(C.nudge(hsv, ch, ch === 'h' ? k.turn * 3 : k.turn * 0.02), 'knob');
                }
            });
        }

        /* ---------- touch on the page ---------- */
        ctx.onTap((x, y) => {
            if (page !== 0) return;
            const cx = WHEEL.x + WHEEL.size / 2, cy = WHEEL.y + WHEEL.size / 2;
            const hit = C.wheelHit(x, y, cx, cy, WHEEL.size / 2, { slack: 12 });
            if (hit) { setHsv({ h: hit.h, s: hit.s, v: hsv.v }, 'wheel'); return; }
            if (x >= SLIDER.x - 16 && x < SLIDER.x + SLIDER.w + 16 && y >= SLIDER.y && y < SLIDER.y + SLIDER.h) {
                setHsv({ h: hsv.h, s: hsv.s, v: 1 - (y - SLIDER.y) / SLIDER.h }, 'slider');
            }
        });
        ctx.onTab((i) => { page = i; deleteMode = false; grabKnob(); });
        ctx.ui.onClick('BTN_CUSTOM', toggleCustom);
        ctx.ui.onClick('BTN_OEM', restoreOem);
        ctx.ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; deleteMode = false; grabKnob(); });
        ctx.app && ctx.app.on && ctx.app.on('shutdown', () => { ctl.shutdown(); });
        grabKnob();
        // for the tests and the preview script (tests/node/ui_harness.js): a look inside
        ctx.__ambient = { ctl: () => ctl, hsv: () => hsv, page: () => page, favs, setHsv, channel: () => channel };

        /* ---------- drawing ---------- */
        const linkPill = (cv, t, x, y) => {
            const st = ctl.state, kind = ctl.kind;
            const label = kind === 'mock' ? 'SIMULATED BDC' : kind === 'bdc-uds' ? (st === 'connected' ? 'BDC LINKED' : st === 'connecting' ? 'BDC PROBING' : 'BDC NO LINK') : 'SOME/IP PROBE';
            const color = kind === 'mock' ? t.cold : st === 'connected' ? t.ok : st === 'connecting' ? t.warn : t.crit;
            return G.pill(cv, t, x, y, 210, 34, label, { color, size: 17 });
        };
        const customPill = (cv, t, x, y) => {
            const armed = ctl.kind !== 'bdc-uds' || ctl.armed;
            const label = ctl.custom ? (armed ? 'CUSTOM ON' : 'CUSTOM (DRY RUN)') : 'OEM LIGHTING';
            return G.pill(cv, t, x, y, 210, 34, label, { color: ctl.custom ? (armed ? t.accent : t.warn) : t.dim, size: 17 });
        };

        function drawColour(cv, t) {
            const c = colour(), hex = C.rgbToHex(c);
            // the wheel and its marker
            cv.circle(WHEEL.x + WHEEL.size / 2, WHEEL.y + WHEEL.size / 2, WHEEL.size / 2 + 6, withAlpha('#ffffff', 0.08));
            cv.blit(wheelLayer(), WHEEL.x - 1, WHEEL.y - 1);
            const m = C.wheelPos(hsv.h, hsv.s, WHEEL.x + WHEEL.size / 2, WHEEL.y + WHEEL.size / 2, WHEEL.size / 2);
            cv.circle(m.x, m.y, 15, '#000000'); cv.circle(m.x, m.y, 12, '#ffffff'); cv.circle(m.x, m.y, 9, C.rgbToHex(C.hsvToRgb(hsv.h, hsv.s, 1)));
            // value slider
            cv.gradientRect(SLIDER.x, SLIDER.y, SLIDER.w, SLIDER.h, [[0, C.rgbToHex(C.hsvToRgb(hsv.h, hsv.s, 1))], [1, '#000000']]);
            cv.strokeRoundRect(SLIDER.x, SLIDER.y, SLIDER.w, SLIDER.h, 4, 1.5, withAlpha('#ffffff', 0.3));
            const sy = SLIDER.y + (1 - hsv.v) * SLIDER.h;
            cv.roundRect(SLIDER.x - 8, sy - 4, SLIDER.w + 16, 8, 4, '#ffffff');
            cv.text('VALUE', SLIDER.x + SLIDER.w / 2, SLIDER.y + SLIDER.h + 26, 16, t.dim, { align: 'center', font: 'bold', spacing: 2 });
            // right panel: preview, numbers, status, buttons
            const P = RIGHT;
            G.panel(cv, t, P.x, P.y, P.w, P.h);
            cv.roundRect(P.x + 24, P.y + 24, 300, 190, 18, hex);
            cv.strokeRoundRect(P.x + 24, P.y + 24, 300, 190, 18, 2, withAlpha('#ffffff', 0.25));
            cv.text(hex, P.x + 174, P.y + 130, 44, C.luma(c) > 0.55 ? '#000000' : '#ffffff', { align: 'center', font: 'num' });
            cv.text('SELECTED', P.x + 174, P.y + 190, 15, C.luma(c) > 0.55 ? '#333333' : '#dddddd', { align: 'center', font: 'bold', spacing: 2 });
            // what the lights show (the mock knows; the car's BDC only through the last accepted write)
            const phys = ctl.physicalColour ? ctl.physicalColour() : (ctl.custom && ctl.stats.accepted ? Object.assign({ source: 'custom' }, ctl.colour) : { r: 0, g: 0, b: 0, source: 'oem' });
            const ph = C.rgbToHex(phys);
            cv.roundRect(P.x + 344, P.y + 24, 140, 90, 14, phys.source === 'oem' ? withAlpha('#ffffff', 0.08) : ph);
            cv.strokeRoundRect(P.x + 344, P.y + 24, 140, 90, 14, 1.5, withAlpha('#ffffff', 0.25));
            cv.text(phys.source === 'oem' ? 'OEM' : phys.source === 'off' ? 'OFF' : ph, P.x + 414, P.y + 76, 20, phys.source === 'oem' || C.luma(phys) <= 0.55 ? '#ffffff' : '#000000', { align: 'center', font: 'bold' });
            cv.text('LIGHTS NOW', P.x + 414, P.y + 136, 14, t.dim, { align: 'center', font: 'bold', spacing: 2 });
            G.readout(cv, t, P.x + 344, P.y + 150, { label: 'RGB', text: c.r + ' ' + c.g + ' ' + c.b, size: 30 });
            G.readout(cv, t, P.x + 520, P.y + 24, { label: 'HUE', text: Math.round(hsv.h) + '°', size: 36, color: channel === 'h' ? 'accent' : 'text' });
            G.readout(cv, t, P.x + 680, P.y + 24, { label: 'SAT', text: Math.round(hsv.s * 100) + '%', size: 36, color: channel === 's' ? 'accent' : 'text' });
            G.readout(cv, t, P.x + 830, P.y + 24, { label: 'VAL', text: Math.round(hsv.v * 100) + '%', size: 36, color: channel === 'v' ? 'accent' : 'text' });
            // nudge buttons (targets: a tap, or the controller turned onto them and pressed)
            let bx = P.x + 520;
            const by = P.y + 112;
            [['H-', 'h', -5], ['H+', 'h', 5], ['S-', 's', -0.05], ['S+', 's', 0.05], ['V-', 'v', -0.05], ['V+', 'v', 0.05]].forEach((n) => {
                bx += G.button(cv, t, bx, by, 66, 44, n[0], () => setHsv(C.nudge(hsv, n[1], n[2]), 'button'), { key: 'nudge' + n[0] }) + 8;
            });
            linkPill(cv, t, P.x + 520, P.y + 172);
            customPill(cv, t, P.x + 740, P.y + 172);
            // OEM library colours as chips
            cv.text('BDC LIBRARY', P.x + 24, P.y + 250, 15, t.dim, { font: 'bold', spacing: 2 });
            let cx = P.x + 24;
            favs.oem().forEach((f) => {
                const rc = C.hexToRgb(f.hex);
                cv.roundRect(cx, P.y + 262, 120, 44, 10, f.hex);
                if (C.sameRgb(rc, c)) cv.strokeRoundRect(cx, P.y + 262, 120, 44, 10, 3, '#ffffff');
                cv.text(f.name.toUpperCase(), cx + 60, P.y + 290, 14, C.luma(rc) > 0.55 ? '#000000' : '#ffffff', { align: 'center', font: 'bold', spacing: 1.5 });
                cv.target(cx, P.y + 262, 120, 44, () => setRgb(rc, 'library ' + f.name), 'oem:' + f.hex);
                cx += 128;
            });
            // actions
            const ay = P.y + 330;
            let ax = P.x + 24;
            ax += G.button(cv, t, ax, ay, 0, 52, ctl.custom ? 'Custom off' : 'Apply to lights', toggleCustom, { primary: !ctl.custom, key: 'custom' }) + 12;
            ax += G.button(cv, t, ax, ay, 0, 52, 'Restore OEM', restoreOem, { key: 'oem' }) + 12;
            ax += G.button(cv, t, ax, ay, 0, 52, favs.has(hex) ? 'Saved' : 'Save favourite', () => { if (favs.add(hex)) say('Saved ' + hex); }, { key: 'save', busy: favs.has(hex) }) + 12;
            const note = ctl.kind === 'bdc-uds' && !ctl.armed ? 'Disarmed: writes are logged, not sent (Settings > Write to the car)' : ctl.kind === 'mock' ? 'Simulated body controller: nothing reaches the car (Settings > Lighting link)' : ctl.lastError ? String(ctl.lastError) : 'Keep-alive every ' + Math.round(ctl.refreshSeconds * ctl.keepAliveFactor) + ' s, ZEIT ' + ctl.refreshSeconds + ' s';
            cv.text(note, P.x + 24, P.y + 420, 17, t.dim);
            if (parked && parked.moving()) G.pill(cv, t, P.x + P.w - 150, P.y + 400, 126, 30, 'DRIVING', { color: t.warn, size: 15 });
        }

        function drawFavourites(cv, t) {
            G.panel(cv, t, 20, 60, 1560, 452, 'Favourites');
            const items = favs.list();
            const c = colour(), hex = C.rgbToHex(c);
            if (!items.length) cv.text('No favourites yet: pick a colour on the Colour page and press Save favourite.', 44, 130, 22, t.dim);
            let x = 44, y = 110;
            items.forEach((f) => {
                const rc = C.hexToRgb(f.hex);
                cv.roundRect(x, y, 180, 72, 12, f.hex);
                if (f.hex === hex) cv.strokeRoundRect(x, y, 180, 72, 12, 3, '#ffffff');
                cv.text(f.hex, x + 90, y + 44, 20, C.luma(rc) > 0.55 ? '#000000' : '#ffffff', { align: 'center', font: 'bold' });
                if (deleteMode) cv.text('TAP TO DELETE', x + 90, y + 64, 12, C.luma(rc) > 0.55 ? '#330000' : '#ffbbbb', { align: 'center', font: 'bold', spacing: 1.5 });
                cv.target(x, y, 180, 72, () => { if (deleteMode) { favs.remove(f.hex); say('Removed ' + f.hex); } else setRgb(rc, 'favourite'); }, 'fav:' + f.hex);
                x += 192; if (x + 180 > 1560) { x = 44; y += 84; }
            });
            let ax = 44;
            const ay = 440;
            ax += G.button(cv, t, ax, ay, 0, 48, favs.has(hex) ? 'Current saved' : 'Save current ' + hex, () => { if (favs.add(hex)) say('Saved ' + hex); }, { primary: !favs.has(hex), key: 'save2', busy: favs.has(hex) }) + 12;
            ax += G.button(cv, t, ax, ay, 0, 48, deleteMode ? 'Done deleting' : 'Delete...', () => { deleteMode = !deleteMode; }, { key: 'del', color: deleteMode ? t.crit : undefined }) + 12;
            ax += G.button(cv, t, ax, ay, 0, 48, ctl.custom ? 'Custom off' : 'Apply to lights', toggleCustom, { key: 'custom2' }) + 12;
        }

        function drawDiagnostics(cv, t) {
            const s = ctl.status(), caps = s.capabilities || {};
            G.panel(cv, t, 20, 60, 760, 452, 'Lighting link');
            const rows = [
                ['Link', s.kind === 'mock' ? 'simulated BDC' : s.kind === 'bdc-uds' ? 'BDC over TASU (UDS)' : 'SOME/IP probe'],
                ['State', s.state + (s.lastError ? ' - ' + s.lastError : '')],
                ['Armed', s.kind === 'bdc-uds' ? (s.armed ? 'YES: writes go to the car' : 'no: dry runs (' + (s.dryRuns || 0) + ')') : 'n/a'],
                ['BDC variant', caps.variant ? caps.variant.index + ' ' + (caps.variant.sgbd || '?') : (caps.bdcReachable === false ? 'no answer to 22 F1 50' : '-')],
                ['RGB actuator', caps.rgbActuator || '-'],
                ['LIN slaves', String(s.slaves.length) + (caps.verified && caps.verified.lin1Status ? ' (from the car)' : s.kind === 'mock' ? ' (simulated)' : '')],
                ['Writes', s.stats.writes + ' sent, ' + s.stats.accepted + ' accepted, ' + s.stats.rejected + ' rejected, ' + s.stats.timeouts + ' timeouts'],
                ['Keep-alive', 'ZEIT ' + s.refreshSeconds + ' s, resend every ' + Math.round(s.refreshSeconds * ctl.keepAliveFactor) + ' s, last round ' + (s.stats.lastRoundMs == null ? '-' : s.stats.lastRoundMs + ' ms')],
                ['Last request', s.lastRequest || (s.history.length ? s.history[s.history.length - 1].bytes || '-' : '-')],
                ['Last reply', s.lastReply || '-'],
            ];
            G.table(cv, t, 36, 100, 730, [{ w: 170, title: '' }, { w: 560, title: '' }], rows, { rowH: 31, size: 18 });
            G.panel(cv, t, 800, 60, 780, 220, 'Control paths');
            const approaches = [
                ['SOME/IP lighting service', 'unknown: not in any public source; search the unit catalog'],
                ['BDC actuator 2E DA5E (TASU)', caps.rgbActuator === 'documented' ? (s.stats.accepted && s.kind === 'bdc-uds' && s.armed ? 'ACCEPTED by this car' : 'documented for BDC_G05; unverified on this car') : s.kind === 'mock' ? 'simulated' : 'variant ' + (caps.rgbActuator || 'unknown')],
                ['BDC coding 360A (persistent)', 'not used: needs recoding per change'],
            ];
            G.table(cv, t, 816, 100, 750, [{ w: 300, title: '' }, { w: 450, title: '' }], approaches, { rowH: 34, size: 18 });
            G.panel(cv, t, 800, 292, 780, 220, 'LIN slaves' + (s.slaves.length ? ' (' + s.slaves.length + ')' : ''));
            const sl = s.slaves.slice(0, 7).map((x) => ['NAD ' + x.nad + (x.bus === 2 ? ' (bus 2)' : ''), (x.location || '') + (x.lastNrc != null ? '  NRC ' + x.lastNrc : x.lastOk ? '  ok' : '')]);
            if (!sl.length) sl.push(['-', s.kind === 'bdc-uds' ? 'read 22 DA 5F failed or no link' : 'none']);
            G.table(cv, t, 816, 330, 750, [{ w: 150, title: '' }, { w: 600, title: '' }], sl, { rowH: 23, size: 15 });
            if (s.slaves.length > 7) cv.text('+ ' + (s.slaves.length - 7) + ' more', 1400, 500, 15, t.dim);
            if (cv.own) G.button(cv, t, 36, 456, 0, 44, probing ? 'Probing...' : 'Probe again', async () => { if (probing) return; probing = true; await ctl.probe(); probing = false; say('Probe done: ' + ctl.state); }, { key: 'probe', busy: probing });
        }

        ctx.loop('MAIN', 10, () => {
            const t = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            const badges = [];
            if (ctl.kind === 'mock') badges.push({ text: 'SIM' });
            if (ctl.custom) badges.push({ text: ctl.kind === 'bdc-uds' && !ctl.armed ? 'DRY RUN' : 'CUSTOM' });
            G.frame(cv, t, PAGES, page, badges);
            if (page === 0) drawColour(cv, t); else if (page === 1) drawFavourites(cv, t); else drawDiagnostics(cv, t);
            if (flash && Date.now() < flash.until) {
                const w = Math.min(1500, cv.textWidth(flash.text, 20, { font: 'bold' }) + 60);
                cv.roundRect(800 - w / 2, 470, w, 40, 20, withAlpha('#000000', 0.75));
                cv.text(flash.text, 800, 497, 20, '#ffffff', { align: 'center', font: 'bold' });
            } else flash = null;
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
