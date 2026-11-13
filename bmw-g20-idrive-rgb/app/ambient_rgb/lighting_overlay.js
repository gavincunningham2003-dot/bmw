'use strict';
/**
 * lighting_overlay.js - what the car's signals change about the applied lighting, module by module. Pure.
 *
 *   doors   an open door: that door's contour line is HANDED BACK TO BMW until the door closes. Nothing is shown
 *           on it by this app (no red, no black, no blink): the module simply has no target, so the controller
 *           releases it with the factory handback (ZUSTAND 0) and writes nothing to it, and BMW shows its own
 *           door-warning light. Every other light keeps its colour or its animation.
 *   turn    a turn indicator: that side's door contour lines blink GREEN with it (hazards: both sides)
 *   dim     night: the applied lighting at a fraction of its brightness (the indicator's green stays at full)
 *
 * 0.5.0 blinked an open door's line red itself (the look of Ambient Config's control.js `doorRed`). 0.5.1 removed
 * that: the factory lighting has priority, and the car's own warning is the car's to show. The indicator glow keeps
 * the look of Ambient Config's control.js `turnGlow` (door line only, fully on and fully dark; MIT, (c) its
 * authors; THIRD_PARTY.md); the code is this project's own and works on its scene model:
 *
 *   compose(base, modules, state, now) -> scene
 *     base     { 'bus:nad': { r, g, b, brightness } }   the applied program's scene at `now` ({} = the car's own lighting)
 *     modules  the modules the body controller reported ({ bus, nad, locationId }): the door a module belongs to
 *              comes from its installation LOCATION, never from a fixed LIN address
 *     state    { doors: [door...], turn: [side...], turnSince, dim }
 *
 * The base scene is rendered by the controller with its own time origin and is not touched: when a door closes,
 * its module is back in the scene with what the base says AT THAT MOMENT, so a running animation carries on in
 * step (its phase was never stopped). A module absent from the result is one the controller must not write: not
 * singly, not in a keep-alive, and not through a whole-bus (NAD 0) write, which lighting_plan.js refuses for a bus
 * with such a module.
 *
 * Only interior FI-LIN modules can appear in a scene at all (the write gate in lighting_protocol.js allows
 * nothing else), and of those only category 'doorLine' is touched here: no exterior light, no other lamp.
 */
const S = require('./lighting_scene');

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
/** The module keys handed back to BMW because their door is open. */
function releasedKeys(st, modules) {
    const keys = new Set();
    ((st && st.doors) || []).forEach((d) => doorModules(modules, d).forEach((m) => keys.add(S.key(m))));
    return Array.from(keys);
}
/** The module keys the indicator glow blinks (a line whose door is open is BMW's, not ours). */
function glowKeys(st, modules) {
    const keys = new Set(), gone = new Set(releasedKeys(st, modules));
    ((st && st.turn) || []).forEach((side) => sideModules(modules, side).forEach((m) => { if (!gone.has(S.key(m))) keys.add(S.key(m)); }));
    return Array.from(keys);
}
/** Is any signal changing the lighting now? */
const active = (st) => !!st && ((st.doors && st.doors.length > 0) || (st.turn && st.turn.length > 0));
/** Does the scene change with time because of the state (the indicator glow is blinking)? An open door does not. */
const moving = (st, modules) => glowKeys(st, modules).length > 0;
/** The module keys the state's signals reach: the glow's and the released ones. */
const keysOf = (st, modules) => Array.from(new Set(glowKeys(st, modules).concat(releasedKeys(st, modules))));

function compose(base, modules, state, now) {
    const st = state || {};
    const dim = st.dim == null ? 1 : Math.max(0, Math.min(1, st.dim));
    const scene = {};
    Object.keys(base || {}).forEach((k) => { const t = base[k]; scene[k] = dim === 1 ? t : { r: t.r, g: t.g, b: t.b, brightness: Math.round(t.brightness * dim) }; });
    const blink = st.blinkMs || BLINK_MS;
    if (st.turn && st.turn.length) {
        const lit = on(st.turnSince, now, blink);
        st.turn.forEach((side) => sideModules(modules, side).forEach((m) => { scene[S.key(m)] = lit ? { r: GREEN.r, g: GREEN.g, b: GREEN.b, brightness: 100 } : Object.assign({}, DARK); }));
    }
    // last, so it wins over everything: an open door's line has NO target (BMW's, until the door closes)
    releasedKeys(st, modules).forEach((k) => { delete scene[k]; });
    return scene;
}

module.exports = { compose, active, moving, keysOf, releasedKeys, glowKeys, doorOf, sideOf, doorModules, sideModules, GREEN, DARK, BLINK_MS, DOORS, DOOR_LOCATIONS };
