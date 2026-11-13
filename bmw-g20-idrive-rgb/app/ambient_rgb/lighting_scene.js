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
 * zone assignments, later ones win) are this project's own and render the same scene whatever `now` is.
 *
 * THE ANIMATIONS ARE NOT WRITTEN HERE. Rainbow, Breathing, Smooth Fade, Colour Wave, Welcome Sweep and Sport Pulse
 * are computed by the MGU App Kit's Ambient Config, whose scenes.js is in this folder unchanged as
 * ambient_config_scenes.js (MIT; ambient_config_notice.js, THIRD_PARTY.md). render() only translates: a program
 * becomes that file's scene ({ kind, upper: { rgb, bright }, lower: { rgb, bright }, speed }), a module becomes its
 * light ({ part, y, bus }) and every colour and brightness on the car is what its lightAt(scene, light, t) returns
 * for that moment. Nothing is recomputed, rounded again or approximated here; tests/node/test_v051.js compares
 * render() with lightAt() module by module at many moments and at the three speeds.
 *
 *   program (a moving mode)  { mode: 'rainbow' | 'fade' | 'breathing' | 'wave', top: { colour, brightness },
 *                              bottom: { colour, brightness }, speed: 1 slow | 2 normal | 3 fast, handlesTo, zone }
 *     top / bottom are Ambient Config's upper / lower: breathing breathes each group in its own colour, the fade
 *     glides from the upper colour to the lower one and back on every light, the wave rolls around the upper
 *     colour's hue, the rainbow takes the upper brightness. The periods are that file's (breathing 4 s, wave 5 s,
 *     fade 8 s, rainbow 12 s at normal speed; x 1.6 slow, x 0.55 fast).
 *   light.part   'upper' for this project's top group, 'lower' for the bottom one (the door handles as the setting
 *                says; Ambient Config has them lower, which is the default here)
 *   light.y      where the module sits from the dash (0) to the boot (1): Ambient Config's own table
 *                (ambient_config_lin.js place(), by the body controller's installation location)
 *   light.bus    Ambient Config numbers the LIN buses 0 and 1, this project 1 and 2: bus - 1. The wave rolls bus
 *                by bus, so on this G20 from the passenger's doors (bus 1) to the dash and the driver's doors
 *                (bus 2). The locations are the car's own words (driver / passenger, not left / right), so a
 *                right-hand-drive car needs no mirroring: the driver's doors are the driver's doors.
 *
 * Groups come from the module locations (lighting_protocol LOCATION ids): the dashboard contour lines and the door
 * contour lines are "upper", the map pockets and footwells are "lower"; the door-opener (handle) lights are assigned
 * by the program (handlesTo: 'top' | 'bottom' | 'off'), never assumed.
 */
const P = require('./lighting_protocol');
const AC = require('./ambient_config_scenes');          // Ambient Config's scenes.js, unchanged
const LIN = require('./ambient_config_lin');            // Ambient Config's lin.js, unchanged (place(): where a light sits)

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

/** A module as Ambient Config's scenes.js wants a light: { part, y, bus } (see the header). */
function lightOf(m, handlesTo) {
    return { part: groupOf(m, handlesTo) === 'top' ? 'upper' : 'lower', y: LIN.place(Number(m.locationId) || 0).y, bus: m.bus - 1 };
}
/** One group's colour and brightness as scenes.js has it: { rgb: [r, g, b], bright }. */
const lookOf = (x) => ({ rgb: [x.colour.r, x.colour.g, x.colour.b], bright: x.brightness });
/** A moving program as a scenes.js scene. */
const referenceScene = (p) => ({ kind: p.mode, upper: lookOf(p.top), lower: lookOf(p.bottom), speed: p.speed });

/* ---------- programs ---------- */
const MODES = Object.freeze(['solid', 'dual', 'zones', 'rainbow', 'fade', 'breathing', 'wave', 'welcome', 'pulse']);
const MODE_LABELS = Object.freeze({ solid: 'Solid Colour', dual: 'Dual Colour', zones: 'Zones', rainbow: 'Rainbow', fade: 'Smooth Fade', breathing: 'Breathing', wave: 'Colour Wave', welcome: 'Welcome Sweep', pulse: 'Sport Pulse' });
const ANIMATED = Object.freeze({ rainbow: true, fade: true, breathing: true, wave: true, welcome: true, pulse: true });
/** The modes that run on (scenes.js KINDS without 'solid'); welcome and pulse run once. */
const RUNNING = Object.freeze({ rainbow: true, fade: true, breathing: true, wave: true });
/*
 * How long the one-time effects last is scenes.js's to say (welcome 2.6 s, pulse 2 s). A one-time program runs
 * once and then gives way to its `then` program (null: the car's own lighting), as Ambient Config's lights.js
 * show() does.
 */
const ONCE = Object.freeze({ welcome: AC.lasts({ kind: 'welcome' }), pulse: AC.lasts({ kind: 'pulse' }) });
const SPEED_LABELS = Object.freeze({ 1: 'Slow', 2: 'Normal', 3: 'Fast' });
/** How long a one-time program lasts (ms); 0 for one that runs on. */
const onceMs = (p) => (p && ONCE[p.mode]) || 0;

const LOOK = Object.freeze({ top: { colour: { r: 160, g: 60, b: 254 }, brightness: 100 }, bottom: { colour: { r: 90, g: 200, b: 254 }, brightness: 100 } });
const running = (mode) => Object.assign({ mode }, JSON.parse(JSON.stringify(LOOK)), { speed: 2, handlesTo: 'bottom', zone: 'all' });
const DEFAULTS = Object.freeze({
    solid: { mode: 'solid', colour: { r: 120, g: 60, b: 254 }, brightness: 100, zone: 'all' },
    dual: { mode: 'dual', top: { colour: { r: 160, g: 60, b: 254 }, brightness: 80 }, bottom: { colour: { r: 90, g: 200, b: 254 }, brightness: 45 }, handlesTo: 'bottom' },
    zones: { mode: 'zones', handlesTo: 'bottom', assignments: [{ zone: 'all', colour: { r: 120, g: 60, b: 254 }, brightness: 100 }] },
    rainbow: running('rainbow'), fade: running('fade'), breathing: running('breathing'), wave: running('wave'),
    welcome: { mode: 'welcome', colour: { r: 120, g: 60, b: 254 }, brightness: 100, then: null },
    pulse: { mode: 'pulse', colour: { r: 120, g: 60, b: 254 }, brightness: 100, then: null },
});

/** A complete program from a possibly partial one (deep enough for the fields the renderer reads). */
function normalise(p) {
    const mode = p && MODES.indexOf(p.mode) >= 0 ? p.mode : 'solid';
    if (RUNNING[mode]) return normaliseRunning(mode, p);
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
    if (!/^(top|bottom|off)$/.test(out.handlesTo || '')) out.handlesTo = 'bottom';
    // a one-time program's follow-on: a complete still or running program, never another one-time one
    if (ONCE[mode]) out.then = out.then && !ONCE[out.then.mode] ? normalise(out.then) : null;
    return out;
}
const rgb = (c) => ({ r: clampByte(c && c.r), g: clampByte(c && c.g), b: clampByte(c && c.b) });
/**
 * A moving program, complete: the two groups' colour and brightness, the speed step, the handles, the zone, and
 * nothing else (scenes.js has no other knob). A program saved by 0.5.0 or earlier (its own periods, palettes and
 * limits) is read for its colours and brightness and runs at normal speed with scenes.js's timing.
 */
function normaliseRunning(mode, p) {
    const d = DEFAULTS[mode], q = p || {};
    const old = { top: q.colour, bottom: q.colour, brightness: q.brightness != null ? q.brightness : q.maxBrightness };
    if (Array.isArray(q.colours) && q.colours.length) { old.top = q.colours[0]; old.bottom = q.colours[1] || q.colours[0]; }
    if (q.baseHue != null && !q.top) { old.top = hsvToRgb(q.baseHue, 1, 1); old.bottom = old.top; }
    const side = (s) => {
        const g = q[s] || {};
        return { colour: rgb(g.colour || old[s] || d[s].colour), brightness: clampPct(g.brightness != null ? g.brightness : old.brightness != null ? old.brightness : d[s].brightness) };
    };
    return { mode, top: side('top'), bottom: side('bottom'), speed: SPEED_LABELS[q.speed] ? Number(q.speed) : 2, handlesTo: /^(top|bottom|off)$/.test(q.handlesTo || '') ? q.handlesTo : 'bottom', zone: q.zone || 'all' };
}
/**
 * What each module ends a one-time program on, as scenes.js's `own` ({ rgb, bright }) by module key: the follow-on
 * program's colours (a moving follow-on: its two groups' colours, as Ambient Config runs the welcome over a look),
 * or this program's own colour everywhere. A module the follow-on leaves to the car has none.
 */
function ownTargets(p, modules, now, opts) {
    const own = {};
    if (!p.then) { modules.forEach((m) => { own[key(m)] = { rgb: [p.colour.r, p.colour.g, p.colour.b], bright: p.brightness }; }); return own; }
    if (RUNNING[p.then.mode]) {
        const f = zoneFilter(p.then.zone, { handlesTo: p.then.handlesTo });
        modules.forEach((m) => { const g = groupOf(m, p.then.handlesTo); if (g !== 'off' && f(m)) own[key(m)] = lookOf(p.then[g]); });
        return own;
    }
    const end = render(p.then, modules, now, opts);
    Object.keys(end).forEach((k) => { own[k] = { rgb: [end[k].r, end[k].g, end[k].b], bright: end[k].brightness }; });
    return own;
}
const isAnimated = (p) => !!(p && ANIMATED[p.mode]);

/**
 * The scene for a program at time `now` (ms). opts.phase0: time origin for animations (default 0).
 * Pure: the same inputs give the same scene.
 */
function render(program, modules, now, opts) {
    const p = normalise(program);
    const t0 = (opts && opts.phase0) || 0;
    const ms = (now || 0) - t0;
    const scene = {};
    const put = (m, colour, brightness) => { scene[key(m)] = { r: clampByte(colour.r), g: clampByte(colour.g), b: clampByte(colour.b), brightness: clampPct(brightness) }; };
    const show = (m, v) => put(m, { r: v.rgb[0], g: v.rgb[1], b: v.rgb[2] }, v.bright);      // what scenes.js lightAt() returned, as a target
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
        case 'rainbow':
        case 'fade':
        case 'breathing':
        case 'wave': {
            // Ambient Config's scenes.js says what every light shows at this moment (see the header)
            const ref = referenceScene(p);
            inZone(p.zone).forEach((m) => {
                if (groupOf(m, p.handlesTo) === 'off') return;           // handles left to the car, as in dual
                show(m, AC.lightAt(ref, lightOf(m, p.handlesTo), ms));
            });
            break;
        }
        case 'welcome':
        case 'pulse': {
            // scenes.js again, over what each module ends on (its `own`): the sweep from the dash to the rear, the red
            const own = ownTargets(p, modules, now, opts);
            modules.forEach((m) => {
                const o = own[key(m)];
                if (o) show(m, AC.lightAt({ kind: p.mode, upper: o, lower: o, speed: 2 }, lightOf(m, p.handlesTo), ms));
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
        case 'rainbow': return 'rainbow, ' + SPEED_LABELS[q.speed].toLowerCase() + ', ' + q.top.brightness + '%';
        case 'fade': return 'fade ' + hex(q.top.colour) + ' to ' + hex(q.bottom.colour) + ', ' + SPEED_LABELS[q.speed].toLowerCase();
        case 'breathing': return 'breathing ' + hex(q.top.colour) + (hex(q.top.colour) === hex(q.bottom.colour) ? '' : ' / ' + hex(q.bottom.colour)) + ', ' + SPEED_LABELS[q.speed].toLowerCase();
        case 'wave': return 'wave around ' + hex(q.top.colour) + ', ' + SPEED_LABELS[q.speed].toLowerCase() + ', ' + q.top.brightness + '%';
        case 'welcome': return 'welcome sweep' + (q.then ? ', then ' + describe(q.then, modules) : '');
        case 'pulse': return 'sport pulse' + (q.then ? ', then ' + describe(q.then, modules) : '');
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
    CATEGORY, category, isFront, isRear, isDriverSide, groupOf, lightOf, lookOf, referenceScene, RUNNING,
    ZONES, ZONE_NAMES, ZONE_LABELS, zoneFilter, zoneLabel,
    MODES, MODE_LABELS, ANIMATED, ONCE, SPEED_LABELS, onceMs, DEFAULTS, normalise, isAnimated, render, diff, describe,
    presetFrom, presetsToJson, presetsFromJson,
};
