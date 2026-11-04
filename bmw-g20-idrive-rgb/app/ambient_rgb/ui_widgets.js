'use strict';
/**
 * ui_widgets.js - the circular controls and the rotary editing model.
 *
 * Input on the head unit (idrive7-apps kit, display.js): when the kit runs the screen, the iDrive knob walks the header
 * tabs, the page's targets (cv.target) and the bar buttons, and a press runs the focused target. The app takes the knob
 * for itself only while a control is being EDITED (ctx.controller.grab(true), events via ctx.controller.onInput);
 * then turns adjust the draft value, a press confirms, a tilt to the left cancels, and the knob goes back to the HMI.
 * The hardware BACK button is never intercepted: it leaves the screen, and an unconfirmed draft is simply dropped.
 * Touch: a tap on a wheel or a ring sets the draft directly (the kit routes taps, not drags, to the page).
 * Where there is no controller gate (no grab possible), every control also has small +/- targets, so the knob can
 * still adjust everything through the kit's own focus ring.
 *
 * Angles follow the kit's arc convention: 0 at 12 o'clock, clockwise (colour.js wheelHit / wheelPos).
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const C = require('./colour');

const RING_START = 210, RING_SWEEP = 300;         // the brightness dial: from 7 o'clock clockwise round to 5 o'clock

/* ---------- drawing ---------- */
/** The hue/saturation wheel at (x, y) size px, with its marker; focused = the knob is on it, editing = turns adjust it. */
function wheel(cv, t, x, y, size, hsv, opts) {
    const o = opts || {}, cx = x + size / 2, cy = y + size / 2, R = size / 2;
    const S = t.sel || t.accent;
    if (o.editing) cv.circle(cx, cy, R + 10, withAlpha(S, 0.9));
    else if (o.focused) cv.circle(cx, cy, R + 8, withAlpha(S, 0.5));
    cv.circle(cx, cy, R + 5, withAlpha('#ffffff', 0.08));
    cv.blit(G.layer('ambient_rgb:wheel:' + size, size + 2, size + 2, (c) => C.drawWheel(c, R + 1, R + 1, R)), x - 1, y - 1);
    if (o.dim) cv.circle(cx, cy, R + 1, withAlpha('#000000', 0.45));
    const m = C.wheelPos(hsv.h, hsv.s, cx, cy, R);
    cv.circle(m.x, m.y, size > 300 ? 15 : 11, '#000000');
    cv.circle(m.x, m.y, size > 300 ? 12 : 8, '#ffffff');
    cv.circle(m.x, m.y, size > 300 ? 9 : 5, C.rgbToHex(C.hsvToRgb(hsv.h, hsv.s, 1)));
    return { cx, cy, r: R };
}

/** A circular dial: ring with a progress arc, the value in the centre. value 0..100. Returns its geometry. */
function ring(cv, t, cx, cy, r, value, label, opts) {
    const o = opts || {}, S = t.sel || t.accent, v = Math.max(0, Math.min(100, value));
    const w = o.width || Math.max(14, r * 0.18);
    if (o.editing) cv.arc(cx, cy, r + w / 2 + 4, r + w / 2 + 8, 0, 360, withAlpha(S, 0.9));
    else if (o.focused) cv.arc(cx, cy, r + w / 2 + 4, r + w / 2 + 7, 0, 360, withAlpha(S, 0.5));
    cv.arc(cx, cy, r - w / 2, r + w / 2, RING_START, RING_START + RING_SWEEP, withAlpha('#ffffff', 0.12), { round: true });
    if (v > 0) {
        const col = o.colour || S;
        cv.arc(cx, cy, r - w / 2, r + w / 2, RING_START, RING_START + RING_SWEEP * v / 100, col, { round: true, ramp: o.ramp ? [withAlpha(col, 0.35), col] : undefined, rampFrom: RING_START, rampTo: RING_START + RING_SWEEP });
    }
    const size = o.size || Math.round(r * 0.62);
    cv.text(Math.round(v) + '%', cx, cy + size * 0.36, size, o.textColor || t.text, { align: 'center', font: 'num' });
    if (label) cv.text(String(label).toUpperCase(), cx, cy + r * 0.95 + 8, Math.max(13, Math.round(r * 0.17)), t.dim, { align: 'center', font: 'bold', spacing: 2 });
    return { cx, cy, r, w };
}
/** A tap on the ring: value 0..100 by angle, or null when off the ring (slack px inside / outside). */
function ringHit(x, y, geom, slack) {
    const dx = x - geom.cx, dy = y - geom.cy, d = Math.sqrt(dx * dx + dy * dy);
    const s = slack == null ? 30 : slack;
    if (d < geom.r - geom.w / 2 - s || d > geom.r + geom.w / 2 + s) return null;
    let a = C.wrapHue(Math.atan2(dx, -dy) * 180 / Math.PI) - RING_START;
    a = ((a % 360) + 360) % 360;
    if (a > RING_SWEEP) return a - RING_SWEEP < (360 - RING_SWEEP) / 2 ? 100 : 0;      // in the gap: nearest end
    return Math.round(a / RING_SWEEP * 100);
}

/** A big colour swatch with its hex and a caption; dark text on light colours. */
function swatch(cv, t, x, y, w, h, colour, caption, opts) {
    const o = opts || {}, hex = C.rgbToHex(colour), dark = C.luma(colour) > 0.55;
    cv.roundRect(x, y, w, h, o.radius || 18, hex);
    cv.strokeRoundRect(x, y, w, h, o.radius || 18, o.editing ? 3 : 2, o.editing ? (t.sel || t.accent) : withAlpha('#ffffff', 0.25));
    if (o.big !== false) cv.text(hex, x + w / 2, y + h / 2 + (o.size || 34) * 0.36, o.size || 34, dark ? '#000000' : '#ffffff', { align: 'center', font: 'num' });
    if (caption) cv.text(String(caption).toUpperCase(), x + w / 2, y + h - 12, 13, dark ? '#333333' : '#dddddd', { align: 'center', font: 'bold', spacing: 2 });
}

/** A labelled value box with - / + targets beside it (the fallback adjustment and a touch convenience). */
function stepper(cv, t, x, y, w, label, text, dec, inc, keyBase, opts) {
    const o = opts || {}, h = o.h || 46, S = t.sel || t.accent;
    cv.text(String(label).toUpperCase(), x, y - 6, 13, t.dim, { font: 'bold', spacing: 2 });
    cv.roundRect(x, y, w, h, 10, withAlpha('#ffffff', o.editing ? 0.16 : 0.07));
    if (o.editing) cv.strokeRoundRect(x, y, w, h, 10, 2, S);
    cv.text(String(text), x + w / 2, y + h / 2 + 8, 22, t.text, { align: 'center', font: 'num' });
    G.button(cv, t, x - 54, y, 46, h, '-', dec, { key: keyBase + '-' });
    G.button(cv, t, x + w + 8, y, 46, h, '+', inc, { key: keyBase + '+' });
}

/**
 * The rotary editing model. Controls are registered per frame (the page is redrawn each frame):
 *   editor.control({ key, get, set, step, wrap, min, max, label })
 * enter(key) grabs the knob; turn(d) adjusts the entered control's draft; confirm() keeps it and releases the knob;
 * cancel() restores the value from when it was entered and releases. The page draws the entered control highlighted.
 */
class Editor {
    constructor(ctx, log) {
        this.ctx = ctx; this.log = log || { info() {} };
        this.controls = new Map();
        this.editing = null;             // key
        this.entered = null;             // value when entered (for cancel)
        this.grabbed = false;
        this.available = !!(ctx && ctx.controller && ctx.controller.grab);
        this.onChange = null;            // fn(key, value) while editing
        this.onDone = null;              // fn(key, confirmed)
    }
    control(c) { this.controls.set(c.key, c); return c; }
    reset() { this.controls.clear(); }
    isEditing(key) { return this.editing === key; }
    enter(key) {
        const c = this.controls.get(key);
        if (!c) return false;
        if (this.editing && this.editing !== key) this.confirm();
        this.editing = key; this.entered = c.get();
        this._grab(true);
        this.log.info('edit ' + key + ' = ' + JSON.stringify(this.entered));
        return true;
    }
    turn(d) {
        const c = this.editing && this.controls.get(this.editing);
        if (!c || !d) return false;
        const v = c.get();
        let next = v + d * (c.step || 1);
        if (c.wrap) next = ((next % c.wrap) + c.wrap) % c.wrap;
        if (c.min != null) next = Math.max(c.min, next);
        if (c.max != null) next = Math.min(c.max, next);
        c.set(next);
        if (this.onChange) this.onChange(this.editing, next);
        return true;
    }
    confirm() {
        if (!this.editing) return false;
        const key = this.editing;
        this.editing = null; this.entered = null;
        this._grab(false);
        if (this.onDone) this.onDone(key, true);
        return true;
    }
    cancel() {
        if (!this.editing) return false;
        const key = this.editing, c = this.controls.get(key);
        if (c && this.entered != null) c.set(this.entered);
        this.editing = null; this.entered = null;
        this._grab(false);
        if (this.onDone) this.onDone(key, false);
        return true;
    }
    /** Feed a FrontCCU statusRotaryEncoderState event (as ctx.controller.onInput delivers it). */
    input(v) {
        const k = this._knob.read(v);
        if (k.tiltW) { this.cancel(); return; }
        if (k.press) { this.confirm(); return; }
        if (k.turn) this.turn(k.turn);
    }
    _grab(on) {
        if (!this.available) return;
        if (on === this.grabbed) return;
        this.grabbed = on;
        try { this.ctx.controller.grab(on); } catch (e) { /* no gate */ }
    }
    get _knob() { if (!this.__knob) this.__knob = new Knob(); return this.__knob; }
}

/** FrontCCU statusRotaryEncoderState -> { turn, press, tiltW } (as apps/doom/controls.js reads the counter). */
class Knob {
    constructor() { this.pos = null; this.pressed = false; this.tilt = null; }
    read(v) {
        const out = { turn: 0, press: false, tiltW: false };
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
        const df = v.frontRotaryEncoderDeflection;
        const w = df === 4 || df === 8 || (typeof df === 'string' && /WEST/.test(df));
        if (w && !this.tilt) out.tiltW = true;
        this.tilt = w ? 'W' : null;
        return out;
    }
}

module.exports = { wheel, ring, ringHit, swatch, stepper, Editor, Knob, RING_START, RING_SWEEP };
