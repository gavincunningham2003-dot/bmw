'use strict';
/**
 * active_colours.js - the colours that are ACTIVE in the car now, for the modes that take colours. Pure.
 *
 * A mode's colours are not its own: Rainbow, Smooth Fade, Breathing and Colour Wave start from the upper and the
 * lower colour the cabin shows, Solid from the primary (upper) one. "Shows" is decided here, in this order:
 *
 *   1. applied   what this app is driving now (the controller's applied program: written and answered, and with
 *                the read-back on, read back). A one-time effect counts as what it ends on.
 *   2. car       nothing applied: what the body controller last reported for every module (22 DA5F / 22 E3D1, read
 *                at the probe and by the read-backs), as long as nothing was written since that read. That is the
 *                factory lighting's colour. No request is made for it here: reading takes the diagnostic link for
 *                seconds on the car, so only what was read anyway is used.
 *   3. last      neither: the last lighting an Apply put on (favourites "last"; Restore OEM clears it).
 *
 * A DRAFT is never active: a colour picked on the Colours or the Dual page and not applied is not in the car.
 *
 *   activeLook({ program, modules, handlesTo, live, last }) -> { top, bottom, source } | null
 *     top / bottom   { colour: { r, g, b }, brightness }   the upper / lower group (lighting_scene.groupOf)
 *     source         'applied' | 'car' | 'last'
 *     live           [{ bus, nad, r, g, b, brightness }] or null      (LightingController.liveColours())
 *     last           a program or null                                (Favourites.lastApplied().program)
 */
const S = require('./lighting_scene');

const still = (p) => (p && S.onceMs(p) ? p.then : p);
const copy = (x) => ({ colour: { r: x.colour.r, g: x.colour.g, b: x.colour.b }, brightness: x.brightness });

/** The colour most modules of each group show in a scene: { top, bottom } (a group with no lit module: null). */
function groupsOf(scene, modules, handlesTo) {
    const count = { top: new Map(), bottom: new Map() };
    (modules || []).forEach((m) => {
        const g = S.groupOf(m, handlesTo), t = scene[S.key(m)];
        if (!count[g] || !t || !(t.brightness > 0) || !(t.r || t.g || t.b)) return;
        const k = [t.r, t.g, t.b, t.brightness].join('/');
        const e = count[g].get(k) || { n: 0, t };
        e.n++; count[g].set(k, e);
    });
    const best = (map) => { let b = null; map.forEach((e) => { if (!b || e.n > b.n) b = e; }); return b ? { colour: S.rgb(b.t), brightness: S.clampPct(b.t.brightness) } : null; };
    return { top: best(count.top), bottom: best(count.bottom) };
}
/** Both groups from what one of them may lack: a zone that lights only the upper lines still gives two colours. */
function both(g, source) {
    const top = g.top || g.bottom, bottom = g.bottom || g.top;
    return top ? { top: copy(top), bottom: copy(bottom), source } : null;
}
/** The upper and lower colour a program puts on (a running mode: its own two; a still one: what it renders). */
function lookOfProgram(program, modules, handlesTo, source) {
    const p = still(program);
    if (!p) return null;
    const q = S.normalise(p);
    if (S.RUNNING[q.mode]) return { top: copy(q.top), bottom: copy(q.bottom), source };
    return both(groupsOf(S.render(q, modules, 0), modules, q.handlesTo || handlesTo), source);
}

function activeLook(o) {
    const a = o || {}, modules = a.modules || [], handlesTo = a.handlesTo || 'bottom';
    const applied = lookOfProgram(a.program, modules, handlesTo, 'applied');
    if (applied) return applied;
    if (!a.program && Array.isArray(a.live) && a.live.length) {
        const scene = {};
        a.live.forEach((m) => { if (m && m.r != null) scene[S.key(m)] = { r: m.r, g: m.g, b: m.b, brightness: Math.min(100, Number(m.brightness) || 0) }; });
        const car = both(groupsOf(scene, modules, handlesTo), 'car');
        if (car) return car;
    }
    return a.program ? null : lookOfProgram(a.last, modules, handlesTo, 'last');
}

const SOURCE_LABELS = Object.freeze({ applied: 'applied by this app', car: 'read from the car', last: 'last applied' });

module.exports = { activeLook, lookOfProgram, groupsOf, SOURCE_LABELS };
