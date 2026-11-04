'use strict';
/**
 * lighting_scene.js - what the lights should show, module by module, and the programs that produce it. Pure.
 *
 *   module  = { bus, nad, locationId, location }           (from the BDC's DA5F / E3D1 status: 19 on the G20 330e)
 *   target  = { r, g, b, brightness }                       (one module's command; brightness 0..100)
 *   scene   = { 'bus:nad': target, ... }                    (modules absent from a scene are left to / released to OEM)
 *   program = { mode, ... }                                 (what the user applies; render(program, modules, now) -> scene)
 *
 * Modes: solid (one colour, a zone), dual (top / bottom groups with their own colour and brightness), zones (a list of
 * zone assignments, later ones win), rainbow, fade (a palette with transitions), breathing, wave (a hue travelling
 * along the cabin). Static programs render the same scene whatever `now` is; animated ones depend on it.
 *
 * Groups come from the module locations (lighting_protocol LOCATION ids): the dashboard contour lines and the door
 * contour lines are "upper", the map pockets and footwells are "lower"; the door-opener (handle) lights are assigned
 * by the program (handlesTo: 'top' | 'bottom' | 'off'), never assumed.
 */
const P = require('./lighting_protocol');

const key = (m) => m.bus + ':' + m.nad;
const clampByte = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const wrapHue = (h) => { h = Number(h) || 0; h %= 360; return h < 0 ? h + 360 : h; };
function hsvToRgb(h, s, v) {
    h = wrapHue(h); s = Math.max(0, Math.min(1, s)); v = Math.max(0, Math.min(1, v));
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255) };
}
function rgbToHsv(c) {
    const r = clampByte(c.r) / 255, g = clampByte(c.g) / 255, b = clampByte(c.b) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) { if (max === r) h = 60 * (((g - b) / d) % 6); else if (max === g) h = 60 * ((b - r) / d + 2); else h = 60 * ((r - g) / d + 4); }
    return { h: wrapHue(h), s: max === 0 ? 0 : d / max, v: max };
}
const mix = (a, b, t) => ({ r: clampByte(a.r + (b.r - a.r) * t), g: clampByte(a.g + (b.g - a.g) * t), b: clampByte(a.b + (b.b - a.b) * t) });

/* ---------- what each location is ---------- */
const CATEGORY = Object.freeze({
    0x13: 'dashLine', 0x15: 'dashLine', 0x17: 'dashLine', 0x14: 'dashTrim', 0x16: 'dashTrim', 0x18: 'dashTrim',
    0x05: 'doorLine', 0x09: 'doorLine', 0x0C: 'doorLine', 0x10: 'doorLine', 0x27: 'doorLine', 0x28: 'doorLine',
    0x06: 'doorTrim', 0x0A: 'doorTrim', 0x0D: 'doorTrim', 0x11: 'doorTrim', 0x29: 'doorTrim', 0x2A: 'doorTrim',
    0x07: 'handle', 0x0E: 'handle', 0x21: 'handle', 0x22: 'handle',
    0x08: 'pocket', 0x0B: 'pocket', 0x0F: 'pocket', 0x12: 'pocket', 0x25: 'pocket', 0x26: 'pocket',
    0x01: 'footwell', 0x02: 'footwell', 0x03: 'footwell', 0x04: 'footwell', 0x23: 'footwell', 0x24: 'footwell',
    0x19: 'pillar', 0x1A: 'pillar', 0x1B: 'seatBack', 0x1C: 'seatBack', 0x33: 'seatBack', 0x34: 'seatBack',
    0x1D: 'console', 0x1E: 'console', 0x1F: 'console', 0x20: 'console',
    0x2B: 'consoleLine', 0x2C: 'consoleLine', 0x2D: 'consoleLine', 0x2E: 'consoleLine', 0x2F: 'consoleTrim', 0x30: 'consoleTrim', 0x31: 'consoleTrim', 0x32: 'consoleTrim',
    0x4B: 'cupholder', 0x4C: 'cupholder', 0x3D: 'lightSword', 0x3E: 'lightSword',
});
const FRONT = new Set([0x01, 0x03, 0x05, 0x06, 0x07, 0x08, 0x0C, 0x0D, 0x0E, 0x0F, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x1D, 0x2B, 0x2D, 0x2F, 0x31, 0x4B]);
const REAR = new Set([0x02, 0x04, 0x09, 0x0A, 0x0B, 0x10, 0x11, 0x12, 0x21, 0x22, 0x1B, 0x1C, 0x2C, 0x2E, 0x30, 0x32, 0x33, 0x34, 0x4C]);
const DRIVER = new Set([0x01, 0x02, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x13, 0x14, 0x19, 0x1B, 0x21, 0x2B, 0x2C, 0x2F, 0x30, 0x33]);
const UPPER = new Set(['dashLine', 'dashTrim', 'doorLine', 'doorTrim', 'pillar', 'lightSword', 'consoleLine', 'consoleTrim']);
const LOWER = new Set(['pocket', 'footwell', 'console', 'cupholder', 'seatBack']);

const category = (m) => CATEGORY[m.locationId] || 'other';
const isFront = (m) => FRONT.has(m.locationId);
const isRear = (m) => REAR.has(m.locationId);
const isDriverSide = (m) => DRIVER.has(m.locationId);

/** upper / lower for a module under a given handle assignment ('top' | 'bottom' | 'off'). */
function groupOf(m, handlesTo) {
    const c = category(m);
    if (c === 'handle') return handlesTo === 'top' ? 'top' : handlesTo === 'bottom' ? 'bottom' : 'off';
    if (UPPER.has(c)) return 'top';
    if (LOWER.has(c)) return 'bottom';
    return 'top';
}

/** Zones: name -> filter(module, opts). opts.handlesTo for upper / lower. 'module:<bus>:<nad>' picks one module. */
const ZONES = Object.freeze({
    all: () => true,
    dashboard: (m) => category(m) === 'dashLine' || category(m) === 'dashTrim',
    frontDoors: (m) => isFront(m) && /^(doorLine|doorTrim|handle|pocket)$/.test(category(m)),
    rearDoors: (m) => isRear(m) && /^(doorLine|doorTrim|handle|pocket)$/.test(category(m)),
    doors: (m) => /^(doorLine|doorTrim|handle|pocket)$/.test(category(m)),
    footwells: (m) => category(m) === 'footwell',
    upper: (m, o) => groupOf(m, (o && o.handlesTo) || 'top') === 'top',
    lower: (m, o) => groupOf(m, (o && o.handlesTo) || 'top') === 'bottom',
    front: (m) => isFront(m),
    rear: (m) => isRear(m),
    driverSide: (m) => isDriverSide(m),
    passengerSide: (m) => !isDriverSide(m),
});
const ZONE_NAMES = Object.freeze(Object.keys(ZONES));
const ZONE_LABELS = Object.freeze({
    all: 'All lighting', dashboard: 'Dashboard', frontDoors: 'Front doors', rearDoors: 'Rear doors', doors: 'All doors', footwells: 'Footwells',
    upper: 'Upper lighting', lower: 'Lower lighting', front: 'Front', rear: 'Rear', driverSide: 'Driver side', passengerSide: 'Passenger side',
});
function zoneFilter(name, opts) {
    if (typeof name === 'function') return name;
    const mm = /^module:(\d+):(\d+)$/.exec(name || '');
    if (mm) { const bus = +mm[1], nad = +mm[2]; return (m) => m.bus === bus && m.nad === nad; }
    const f = ZONES[name] || ZONES.all;
    return (m) => f(m, opts);
}
function zoneLabel(name, modules) {
    const mm = /^module:(\d+):(\d+)$/.exec(name || '');
    if (mm) { const m = (modules || []).find((x) => x.bus === +mm[1] && x.nad === +mm[2]); return m ? m.location : name; }
    return ZONE_LABELS[name] || name;
}

/**
 * Wave order: where each module sits along the cabin, 0 (front) .. 1 (rear), so a wave travels front to back; the
 * side gives a small offset so the two sides are not exactly in step. Dashboard first, then front doors / footwells,
 * then the rear.
 */
function wavePosition(m) {
    const c = category(m);
    let x = c === 'dashLine' || c === 'dashTrim' ? 0.0 : isFront(m) ? 0.35 : isRear(m) ? 0.75 : 0.5;
    if (c === 'footwell') x += 0.1;
    if (c === 'pocket') x += 0.05;
    if (m.locationId === 0x15) x -= 0.03;                       // dashboard centre leads
    return Math.max(0, Math.min(1, x + (isDriverSide(m) ? 0.02 : 0)));
}

/* ---------- programs ---------- */
const MODES = Object.freeze(['solid', 'dual', 'zones', 'rainbow', 'fade', 'breathing', 'wave']);
const MODE_LABELS = Object.freeze({ solid: 'Solid Colour', dual: 'Dual Colour', zones: 'Zones', rainbow: 'Rainbow', fade: 'Smooth Fade', breathing: 'Breathing', wave: 'Colour Wave' });
const ANIMATED = Object.freeze({ rainbow: true, fade: true, breathing: true, wave: true });

const DEFAULTS = Object.freeze({
    solid: { mode: 'solid', colour: { r: 120, g: 60, b: 254 }, brightness: 100, zone: 'all' },
    dual: { mode: 'dual', top: { colour: { r: 160, g: 60, b: 254 }, brightness: 80 }, bottom: { colour: { r: 90, g: 200, b: 254 }, brightness: 45 }, handlesTo: 'bottom' },
    zones: { mode: 'zones', handlesTo: 'bottom', assignments: [{ zone: 'all', colour: { r: 120, g: 60, b: 254 }, brightness: 100 }] },
    rainbow: { mode: 'rainbow', periodS: 20, brightness: 100, zone: 'all', saturation: 1 },
    fade: { mode: 'fade', colours: [{ r: 254, g: 0, b: 0 }, { r: 0, g: 254, b: 0 }, { r: 0, g: 0, b: 254 }], transitionMs: 2000, holdMs: 1000, brightness: 100, zone: 'all' },
    breathing: { mode: 'breathing', colour: { r: 120, g: 60, b: 254 }, minBrightness: 10, maxBrightness: 100, periodS: 6, zone: 'all' },
    wave: { mode: 'wave', hueSpan: 120, baseHue: 240, periodS: 8, brightness: 100, zone: 'all', saturation: 1 },
});

/** A complete program from a possibly partial one (deep enough for the fields the renderer reads). */
function normalise(p) {
    const mode = p && MODES.indexOf(p.mode) >= 0 ? p.mode : 'solid';
    const d = DEFAULTS[mode];
    const out = JSON.parse(JSON.stringify(d));
    Object.keys(p || {}).forEach((k) => { if (p[k] !== undefined) out[k] = JSON.parse(JSON.stringify(p[k])); });
    out.mode = mode;
    if (out.colour) out.colour = rgb(out.colour);
    if (out.top) { out.top.colour = rgb(out.top.colour); out.top.brightness = clampPct(out.top.brightness); }
    if (out.bottom) { out.bottom.colour = rgb(out.bottom.colour); out.bottom.brightness = clampPct(out.bottom.brightness); }
    if (out.brightness != null) out.brightness = clampPct(out.brightness);
    if (out.assignments) out.assignments = out.assignments.map((a) => ({ zone: a.zone || 'all', colour: rgb(a.colour), brightness: clampPct(a.brightness == null ? 100 : a.brightness) }));
    if (out.colours) out.colours = out.colours.map(rgb);
    if (out.minBrightness != null) { out.minBrightness = clampPct(out.minBrightness); out.maxBrightness = clampPct(out.maxBrightness); if (out.minBrightness > out.maxBrightness) { const t = out.minBrightness; out.minBrightness = out.maxBrightness; out.maxBrightness = t; } }
    if (!/^(top|bottom|off)$/.test(out.handlesTo || '')) out.handlesTo = 'bottom';
    return out;
}
const rgb = (c) => ({ r: clampByte(c && c.r), g: clampByte(c && c.g), b: clampByte(c && c.b) });
const isAnimated = (p) => !!(p && ANIMATED[p.mode]);

/**
 * The scene for a program at time `now` (ms). opts.phase0: time origin for animations (default 0).
 * Pure: the same inputs give the same scene.
 */
function render(program, modules, now, opts) {
    const p = normalise(program);
    const t0 = (opts && opts.phase0) || 0;
    const t = ((now || 0) - t0) / 1000;
    const scene = {};
    const put = (m, colour, brightness) => { scene[key(m)] = { r: clampByte(colour.r), g: clampByte(colour.g), b: clampByte(colour.b), brightness: clampPct(brightness) }; };
    const inZone = (zone) => { const f = zoneFilter(zone, { handlesTo: p.handlesTo }); return modules.filter((m) => f(m)); };
    switch (p.mode) {
        case 'solid':
            inZone(p.zone).forEach((m) => put(m, p.colour, p.brightness));
            break;
        case 'dual':
            modules.forEach((m) => {
                const g = groupOf(m, p.handlesTo);
                if (g === 'top') put(m, p.top.colour, p.top.brightness);
                else if (g === 'bottom') put(m, p.bottom.colour, p.bottom.brightness);
            });
            break;
        case 'zones':
            p.assignments.forEach((a) => inZone(a.zone).forEach((m) => put(m, a.colour, a.brightness)));
            break;
        case 'rainbow': {
            const h = (t / Math.max(2, p.periodS)) * 360;
            const c = hsvToRgb(h, p.saturation == null ? 1 : p.saturation, 1);
            inZone(p.zone).forEach((m) => put(m, c, p.brightness));
            break;
        }
        case 'fade': {
            const cols = p.colours.length ? p.colours : DEFAULTS.fade.colours;
            const step = Math.max(50, p.transitionMs) + Math.max(0, p.holdMs);
            const total = step * cols.length;
            const u = ((t * 1000) % total + total) % total;
            const i = Math.floor(u / step), within = u - i * step;
            const from = cols[i], to = cols[(i + 1) % cols.length];
            const c = within < p.holdMs ? from : mix(from, to, (within - p.holdMs) / Math.max(50, p.transitionMs));
            inZone(p.zone).forEach((m) => put(m, c, p.brightness));
            break;
        }
        case 'breathing': {
            const phase = (t / Math.max(1, p.periodS)) * 2 * Math.PI;
            const k = (1 - Math.cos(phase)) / 2;                           // 0 .. 1 .. 0, smooth
            const b = p.minBrightness + (p.maxBrightness - p.minBrightness) * k;
            inZone(p.zone).forEach((m) => put(m, p.colour, b));
            break;
        }
        case 'wave': {
            const span = p.hueSpan == null ? 120 : p.hueSpan;
            inZone(p.zone).forEach((m) => {
                const pos = wavePosition(m);
                const h = p.baseHue + span * Math.sin(2 * Math.PI * (t / Math.max(2, p.periodS) - pos));
                put(m, hsvToRgb(h, p.saturation == null ? 1 : p.saturation, 1), p.brightness);
            });
            break;
        }
        default: break;
    }
    return scene;
}

/** Keys whose target differs between two scenes (or exists in only one). */
function diff(a, b) {
    const out = [];
    const keys = new Set(Object.keys(a || {}).concat(Object.keys(b || {})));
    keys.forEach((k) => {
        const x = a && a[k], y = b && b[k];
        if (!x || !y || x.r !== y.r || x.g !== y.g || x.b !== y.b || x.brightness !== y.brightness) out.push(k);
    });
    return out;
}

/** A readable one-line description of a program for lists and favourites. */
function describe(p, modules) {
    const q = normalise(p);
    const hex = (c) => '#' + [c.r, c.g, c.b].map((n) => (n < 16 ? '0' : '') + n.toString(16).toUpperCase()).join('');
    switch (q.mode) {
        case 'solid': return hex(q.colour) + ' ' + q.brightness + '% ' + zoneLabel(q.zone, modules);
        case 'dual': return 'top ' + hex(q.top.colour) + ' ' + q.top.brightness + '%, bottom ' + hex(q.bottom.colour) + ' ' + q.bottom.brightness + '%';
        case 'zones': return q.assignments.map((a) => zoneLabel(a.zone, modules) + ' ' + hex(a.colour)).join(', ');
        case 'rainbow': return 'rainbow ' + q.periodS + ' s, ' + q.brightness + '%';
        case 'fade': return 'fade ' + q.colours.map(hex).join(' ') + ' ' + (q.transitionMs / 1000) + ' s';
        case 'breathing': return 'breathing ' + hex(q.colour) + ' ' + q.minBrightness + '-' + q.maxBrightness + '% ' + q.periodS + ' s';
        case 'wave': return 'wave hue ' + q.baseHue + ' ±' + q.hueSpan + ', ' + q.periodS + ' s';
        default: return q.mode;
    }
}

/* ---------- presets (complete configurations) ---------- */
function presetFrom(name, program) { return { name: String(name || MODE_LABELS[normalise(program).mode]).slice(0, 28), program: normalise(program), saved: Date.now() }; }
function presetsToJson(list) { return JSON.stringify({ presets: (list || []).map((p) => ({ name: p.name, program: normalise(p.program), saved: p.saved })) }, null, 1); }
function presetsFromJson(text) {
    try { const j = JSON.parse(text); return Array.isArray(j.presets) ? j.presets.filter((p) => p && p.program).map((p) => presetFrom(p.name, p.program)) : []; } catch (e) { return []; }
}

module.exports = {
    key, clampByte, clampPct, wrapHue, hsvToRgb, rgbToHsv, mix, rgb,
    CATEGORY, category, isFront, isRear, isDriverSide, groupOf, wavePosition,
    ZONES, ZONE_NAMES, ZONE_LABELS, zoneFilter, zoneLabel,
    MODES, MODE_LABELS, ANIMATED, DEFAULTS, normalise, isAnimated, render, diff, describe,
    presetFrom, presetsToJson, presetsFromJson,
};
