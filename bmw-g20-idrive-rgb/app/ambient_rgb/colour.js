'use strict';
/**
 * colour.js - colour maths for the Ambient RGB Controller. Pure functions, no I/O, Node 8 safe.
 *
 *   rgb  = { r, g, b }        integers 0..255
 *   hsv  = { h, s, v }        h in degrees 0..360 (360 excluded), s and v 0..1
 *   hex  = '#RRGGBB'
 *
 * The wheel's angle convention is the kit's arc convention (kit/runtime/canvas.js, kit/renderd/src/gfx.c):
 * 0 degrees at 12 o'clock, clockwise, i.e. x = cx + sin(a) * r, y = cy - cos(a) * r. Hue = that angle.
 * wheelPixels(size) renders a hue/saturation disc (hue by angle, saturation by radius) as RGBA bytes;
 * wheelHit() is the inverse for taps; wheelPos() places the marker. The app draws the wheel as ramped arcs
 * (vector, cached in a layer) with the same convention, so a tap lands on the colour it shows.
 */

const clampByte = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
const wrapHue = (h) => { h = Number(h) || 0; h %= 360; return h < 0 ? h + 360 : h; };

function rgb(r, g, b) { return { r: clampByte(r), g: clampByte(g), b: clampByte(b) }; }

function rgbToHsv(c) {
    const r = clampByte(c.r) / 255, g = clampByte(c.g) / 255, b = clampByte(c.b) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
    }
    return { h: wrapHue(h), s: max === 0 ? 0 : d / max, v: max };
}

function hsvToRgb(h, s, v) {
    if (typeof h === 'object') { s = h.s; v = h.v; h = h.h; }
    h = wrapHue(h); s = clamp01(s); v = clamp01(v);
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return rgb((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

const hex2 = (n) => (clampByte(n) < 16 ? '0' : '') + clampByte(n).toString(16).toUpperCase();
function rgbToHex(c) { return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b); }
function hexToRgb(s) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return rgb(n >> 16, (n >> 8) & 255, n & 255);
}
function sameRgb(a, b) { return !!a && !!b && clampByte(a.r) === clampByte(b.r) && clampByte(a.g) === clampByte(b.g) && clampByte(a.b) === clampByte(b.b); }

/**
 * The BDC's colour library coding (360A LIC_LCI_COLOR_LIBRARY_DATA) is written by community tools with
 * 0xFF folded to 0xFE (aremmell/g8x-colors). The diagnostic actuator (DID DA5E/E3D1) is documented 0..255.
 * codingByte() applies the community rule for the coding path only.
 */
function codingByte(n) { const b = clampByte(n); return b === 255 ? 254 : b; }

/** Perceived brightness 0..1 (Rec. 601 luma), for choosing text colour over a swatch. */
function luma(c) { return (0.299 * clampByte(c.r) + 0.587 * clampByte(c.g) + 0.114 * clampByte(c.b)) / 255; }

/**
 * Hue/saturation disc as RGBA. Full value (v = 1); the app draws value separately. The edge is
 * anti-aliased over ~1.5 px so it sits cleanly on a dark panel. Returns { w, h, data: Uint8Array }.
 */
function wheelPixels(size, opts) {
    size = Math.max(8, size | 0);
    const o = opts || {}, inner = clamp01(o.innerRatio == null ? 0 : o.innerRatio);
    const data = new Uint8Array(size * size * 4);
    const cx = (size - 1) / 2, cy = (size - 1) / 2, R = size / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x - cx, dy = y - cy, d = Math.sqrt(dx * dx + dy * dy);
            const i = (y * size + x) * 4;
            let a = R - d + 0.5;                       // edge coverage
            if (a <= 0) continue;
            if (a > 1) a = 1;
            if (inner > 0) { const ia = d - inner * R + 0.5; if (ia <= 0) continue; if (ia < a) a = ia; }
            const h = wrapHue(Math.atan2(dx, -dy) * 180 / Math.PI);
            const s = Math.min(1, d / R);
            const c = hsvToRgb(h, s, 1);
            data[i] = c.r; data[i + 1] = c.g; data[i + 2] = c.b; data[i + 3] = Math.round(a * 255);
        }
    }
    return { w: size, h: size, data };
}

/** Where on the disc (cx, cy, radius r) a tap at x, y lands: { h, s } or null outside it. */
function wheelHit(x, y, cx, cy, r, opts) {
    const dx = x - cx, dy = y - cy, d = Math.sqrt(dx * dx + dy * dy);
    const slack = (opts && opts.slack) || 0;
    if (d > r + slack + 1e-9) return null;
    return { h: wrapHue(Math.atan2(dx, -dy) * 180 / Math.PI), s: Math.min(1, d / r) };
}

/** The marker position for h, s on that disc. */
function wheelPos(h, s, cx, cy, r) {
    const a = wrapHue(h) * Math.PI / 180, d = clamp01(s) * r;
    return { x: cx + Math.sin(a) * d, y: cy - Math.cos(a) * d };
}

/**
 * The hue/saturation disc as ramped arcs for a kit Recorder (or Canvas): rings from the centre out, each a full
 * circle whose colour ramp runs through the hues at that ring's saturation. 24 rings x 37 stops; cache it in a
 * layer (G.layer) and blit it each frame.
 */
function drawWheel(c, cx, cy, R, opts) {
    const rings = (opts && opts.rings) || 24, stops = (opts && opts.stops) || 37;
    for (let k = rings; k >= 1; k--) {
        const r1 = R * k / rings, r0 = R * (k - 1) / rings, s = (k - 0.5) / rings;
        const ramp = [];
        for (let i = 0; i < stops; i++) ramp.push(rgbToHex(hsvToRgb(i * 360 / (stops - 1), s, 1)));
        c.arc(cx, cy, r0, r1 + 0.7, 0, 360, '#ffffff', { ramp, rampFrom: 0, rampTo: 360 });
    }
}

/** Nudge one HSV channel by a step; hue wraps, s and v clamp. */
function nudge(hsv, channel, delta) {
    const out = { h: hsv.h, s: hsv.s, v: hsv.v };
    if (channel === 'h') out.h = wrapHue(out.h + delta);
    else if (channel === 's') out.s = clamp01(out.s + delta);
    else if (channel === 'v') out.v = clamp01(out.v + delta);
    return out;
}

module.exports = { clampByte, clamp01, wrapHue, rgb, rgbToHsv, hsvToRgb, rgbToHex, hexToRgb, sameRgb, codingByte, luma, wheelPixels, wheelHit, wheelPos, drawWheel, nudge };
