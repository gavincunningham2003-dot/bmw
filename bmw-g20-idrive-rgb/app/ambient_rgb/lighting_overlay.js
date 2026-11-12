'use strict';
/**
 * lighting_overlay.js - temporary effects laid OVER the applied lighting, module by module. Pure.
 *
 *   doors   an open door: that door's contour line blinks RED until the door closes
 *   turn    a turn indicator: that side's door contour lines blink GREEN with it (hazards: both sides)
 *   dim     night: the applied lighting at a fraction of its brightness (the effects above stay at full)
 *
 * The idea and the look (door line only, fully on and fully dark, red over green) are those of the MGU App Kit's
 * Ambient Config (apps/ambient_config/control.js, MIT, (c) its authors; THIRD_PARTY.md); the code here is this
 * project's own and works on its scene model:
 *
 *   compose(base, modules, state, now) -> scene
 *     base     { 'bus:nad': { r, g, b, brightness } }   the applied program's scene at `now` ({} = the car's own lighting)
 *     modules  the modules the body controller reported ({ bus, nad, locationId }): the door a module belongs to
 *              comes from its installation LOCATION, never from a fixed LIN address
 *     state    { doors: [door...], doorsSince, turn: [side...], turnSince, dim }
 *
 * The base scene is rendered by the controller with its own time origin and is not touched: when an effect ends,
 * the module simply shows what the base says at that moment, so a running animation keeps its phase. A module
 * the base leaves to the car (no target) is absent from the result once its effect ends, and the controller hands
 * it back.
 *
 * Only interior FI-LIN modules can appear in a scene at all (the write gate in lighting_protocol.js allows
 * nothing else), and of those only category 'doorLine': no exterior light, no other lamp.
 */
const S = require('./lighting_scene');

const RED = Object.freeze({ r: 254, g: 0, b: 0 });                 // (0xFF is "no change" on this BDC: 254 is full)
const GREEN = Object.freeze({ r: 0, g: 230, b: 60 });
const DARK = Object.freeze({ r: 0, g: 0, b: 0, brightness: 0 });
const BLINK_MS = 400;                                              // on for this long, dark for this long
const DOOR_LOCATIONS = Object.freeze({ driverFront: [0x05], driverRear: [0x09], passengerFront: [0x0C], passengerRear: [0x10] });
const DOORS = Object.freeze(Object.keys(DOOR_LOCATIONS));

/** The door a module's contour line belongs to, or null (not a door contour line). */
function doorOf(m) {
    if (S.category(m) !== 'doorLine') return null;
    for (const d of DOORS) if (DOOR_LOCATIONS[d].indexOf(m.locationId) >= 0) return d;
    return null;
}
/** 'driver' | 'passenger' for a door contour line, else null. */
function sideOf(m) { const d = doorOf(m); return d ? (/^driver/.test(d) ? 'driver' : 'passenger') : null; }
/** The contour-line modules of a door / of a side, as the body controller reported them. */
const doorModules = (modules, door) => modules.filter((m) => doorOf(m) === door);
const sideModules = (modules, side) => modules.filter((m) => sideOf(m) === side);

const on = (since, now, blinkMs) => Math.floor(Math.max(0, now - (since || 0)) / (blinkMs || BLINK_MS)) % 2 === 0;
const active = (st) => !!st && ((st.doors && st.doors.length > 0) || (st.turn && st.turn.length > 0));
/** Does the scene change with time because of the state (an effect is blinking)? */
const moving = (st, modules) => active(st) && keysOf(st, modules).length > 0;

/** The module keys the state's effects reach. */
function keysOf(st, modules) {
    const keys = new Set();
    if (!st) return [];
    (st.turn || []).forEach((side) => sideModules(modules, side).forEach((m) => keys.add(S.key(m))));
    (st.doors || []).forEach((d) => doorModules(modules, d).forEach((m) => keys.add(S.key(m))));
    return Array.from(keys);
}

function compose(base, modules, state, now) {
    const st = state || {};
    const dim = st.dim == null ? 1 : Math.max(0, Math.min(1, st.dim));
    const scene = {};
    Object.keys(base || {}).forEach((k) => { const t = base[k]; scene[k] = dim === 1 ? t : { r: t.r, g: t.g, b: t.b, brightness: Math.round(t.brightness * dim) }; });
    const blink = st.blinkMs || BLINK_MS;
    const put = (m, colour, lit) => { scene[S.key(m)] = lit ? { r: colour.r, g: colour.g, b: colour.b, brightness: 100 } : Object.assign({}, DARK); };
    // green first, red after it: an open door's red wins over the indicator on the same line
    if (st.turn && st.turn.length) { const lit = on(st.turnSince, now, blink); st.turn.forEach((side) => sideModules(modules, side).forEach((m) => put(m, GREEN, lit))); }
    if (st.doors && st.doors.length) { const lit = on(st.doorsSince, now, blink); st.doors.forEach((d) => doorModules(modules, d).forEach((m) => put(m, RED, lit))); }
    return scene;
}

module.exports = { compose, active, moving, keysOf, doorOf, sideOf, doorModules, sideModules, RED, GREEN, DARK, BLINK_MS, DOORS, DOOR_LOCATIONS };
