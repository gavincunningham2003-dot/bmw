'use strict';
/**
 * lighting_plan.js - which writes put a scene on the car. Pure: a scene and what was last written in, a list of
 * writes out.
 *
 * Two ways to reach a module: its own NAD, or NAD 0, which the body controller takes for EVERY module of that LIN
 * bus. The whole-bus write is the idea of the MGU App Kit's Ambient Config (apps/ambient_config/lights.js, MIT, (c)
 * its authors; see THIRD_PARTY.md), which reports it car-tested on a G20 BDC_G05: "a bus gets one write for the
 * colour most of its lights want, then single writes only for the lights that differ". It is NOT verified on this
 * project's car, so the default mode is 'individual' and 'broadcast' is a setting.
 *
 *   plan(scene, modules, last, opts) -> [{ key, slave, params, force, covers }]
 *     scene     { 'bus:nad': { r, g, b, brightness } }           the targets (lighting_scene.render)
 *     modules   every known module [{ bus, nad }]
 *     last      Map 'bus:nad' -> { params, ok }                    what the transport last took (scheduler.last)
 *     opts      mode 'individual' | 'broadcast'; params(target) -> write params; force: Set of keys due a refresh;
 *               all: true = every target counts as due (a confirmed Apply); deaf: Set of module keys that have
 *               been seen to miss a whole-bus write (on this project's G20, 2026-11-12, bus 1 NAD 1 kept the
 *               car's colour while the other six took it): they get their own write after every whole-bus one
 *
 * A bus is written with NAD 0 only when (a) every module of it has a target (a module left to the car must not be
 * touched), (b) at least two modules share the most common target and (c) it is cheaper: 1 + the modules that
 * differ, against the modules that are due. The modules that differ are then written after it, always (the
 * whole-bus write has just overwritten them). covers lists the module keys a write reaches.
 */
const key = (m) => m.bus + ':' + m.nad;
const same = (a, b) => !!a && !!b && a.active === b.active && a.r === b.r && a.g === b.g && a.b === b.b && a.brightness === b.brightness;
const sig = (p) => [p.r, p.g, p.b, p.brightness].join('/');
const busKey = (bus) => bus + ':0';
const isBusKey = (k) => /:0$/.test(k);

function plan(scene, modules, last, opts) {
    const o = opts || {};
    const params = o.params || ((t) => Object.assign({ active: true }, t));
    const force = o.force || new Set();
    const deaf = o.deaf || new Set();
    const due = (k, p) => { const l = last && last.get(k); return !!o.all || force.has(k) || !l || !l.ok || !same(l.params, p); };
    const out = [];
    const buses = Array.from(new Set(modules.map((m) => m.bus))).sort();
    buses.forEach((bus) => {
        const mods = modules.filter((m) => m.bus === bus);
        const targeted = mods.filter((m) => scene[key(m)]);
        if (!targeted.length) return;
        const want = new Map(targeted.map((m) => [key(m), params(scene[key(m)])]));
        const single = (m, forced) => out.push({ key: key(m), slave: m, params: want.get(key(m)), force: !!forced || force.has(key(m)), covers: [key(m)] });
        let top = null;
        if (o.mode === 'broadcast' && targeted.length === mods.length && mods.length > 1) {
            const count = new Map();
            want.forEach((p) => count.set(sig(p), (count.get(sig(p)) || 0) + 1));
            const best = Array.from(count.entries()).sort((a, b) => b[1] - a[1])[0];
            if (best[1] > 1) top = best[0];
        }
        if (top) {
            const others = mods.filter((m) => sig(want.get(key(m))) !== top || deaf.has(key(m)));
            const dueCount = mods.filter((m) => due(key(m), want.get(key(m)))).length;
            const majorityDue = mods.some((m) => sig(want.get(key(m))) === top && due(key(m), want.get(key(m))));
            if (majorityDue && 1 + others.length < dueCount) {
                const first = mods.find((m) => sig(want.get(key(m))) === top);
                out.push({ key: busKey(bus), slave: { bus, nad: 0 }, params: want.get(key(first)), force: true, covers: mods.map(key) });
                others.forEach((m) => single(m, true));
                return;
            }
        }
        targeted.forEach((m) => { if (due(key(m), want.get(key(m)))) single(m, false); });
    });
    return out;
}

/** Hand modules back: per bus one NAD 0 release when the mode allows it and it saves writes, else one each. */
function planRelease(slaves, modules, opts) {
    const o = opts || {};
    const off = { active: false, r: 0, g: 0, b: 0, brightness: 0, seconds: 0 };
    const out = [];
    Array.from(new Set(slaves.map((s) => s.bus))).sort().forEach((bus) => {
        const mine = slaves.filter((s) => s.bus === bus);
        const all = modules.filter((m) => m.bus === bus);
        // a release of a module the car already owns changes nothing, so the whole bus may always be released
        if (o.mode === 'broadcast' && mine.length > 1) out.push({ key: busKey(bus), slave: { bus, nad: 0 }, params: off, force: true, covers: all.map(key) });
        else mine.forEach((s) => out.push({ key: key(s), slave: s, params: off, force: true, covers: [key(s)] }));
    });
    return out;
}

module.exports = { plan, planRelease, busKey, isBusKey, same, key };
