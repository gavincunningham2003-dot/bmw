'use strict';
/**
 * lighting_plan.js - which writes put a scene on the car. Pure: a scene and what was last written in, a list of
 * writes out.
 *
 * Two ways to reach a module: its own NAD, or NAD 0, which the body controller takes for EVERY module of that LIN
 * bus. This is the method of the MGU App Kit's Ambient Config (apps/ambient_config/lights.js _plan, MIT, (c) its
 * authors; see THIRD_PARTY.md), ported to this project's scene model: "a bus gets one write for the colour most of
 * its lights want, then single writes only for the lights that differ - a whole-car colour is 2 writes instead of
 * 19". Seen on this project's car over ENET on 2026-11-12 (PROTOCOL_FINDINGS.md section 9: 12 of 12 modules on
 * bus 2, 6 of 7 then 7 of 7 on bus 1), so 'broadcast' is the default from 0.5.1 and 'individual' is the setting to
 * fall back on. Lights are planned front to back (opts.order), as lights.js sorts them.
 *
 * Differences from lights.js, each on the side of fewer writes or of the driver's rules, never of more traffic:
 *   - a whole-bus write is used only when it is cheaper than writing the due modules singly (lights.js sends it
 *     whenever a light of the majority is due, which costs the same or more);
 *   - `deaf` modules (this car's bus 1 NAD 1 once kept the car's colour through a NAD 0 write) get their own write
 *     after every whole-bus one; lights.js would write the whole bus again;
 *   - a write nobody answered counts as written (last.unanswered) and is not planned again for that reason.
 *
 *   plan(scene, modules, last, opts) -> [{ key, slave, params, force, covers }]
 *     scene     { 'bus:nad': { r, g, b, brightness } }           the targets (lighting_scene.render)
 *     modules   every known module [{ bus, nad }]
 *     last      Map 'bus:nad' -> { params, ok }                    what the transport last took (scheduler.last)
 *     opts      mode 'individual' | 'broadcast'; params(target) -> write params; force: Set of keys due a refresh;
 *               all: true = every target counts as due (a confirmed Apply); deaf: Set of module keys that have
 *               been seen to miss a whole-bus write (on this project's G20, 2026-11-12, bus 1 NAD 1 kept the
 *               car's colour while the other six took it): they get their own write after every whole-bus one;
 *               order(module) -> where it sits front to back (lighting_scene.lightOf().y)
 *
 * A bus is written with NAD 0 only when (a) every module of it has a target (a module left to the car, or handed
 * back to BMW while its door is open, must not be touched: such a bus gets single writes only), (b) at least two modules share the most common target and (c) it is cheaper: 1 + the modules that
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
    const due = (k, p) => { const l = last && last.get(k); return !!o.all || force.has(k) || !l || !(l.ok || l.unanswered) || !same(l.params, p); };
    const out = [];
    const buses = Array.from(new Set(modules.map((m) => m.bus))).sort();
    const order = typeof o.order === 'function' ? o.order : null;
    buses.forEach((bus) => {
        let mods = modules.filter((m) => m.bus === bus);
        if (order) mods = mods.map((m, i) => ({ m, i, y: order(m) })).sort((a, b) => a.y - b.y || a.i - b.i).map((x) => x.m);   // front to back (stable)
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

/**
 * Hand modules back to the car (ZUSTAND 0: the factory handback, at once).
 *
 *   planRelease(slaves, modules, opts) -> [{ key, slave, params, force, covers }]
 *     slaves    the modules to hand back
 *     modules   every known module
 *     opts      whole: the car takes NAD 0 (false once it refused one); keep: Set of module keys that must go on
 *               showing a colour of ours; deaf: Set of module keys seen to miss a whole-bus write
 *
 * Ambient Config's give-back (lights.js _giveBack: "every bus with a light of ours on it given back, one write
 * each"): a bus is released with ONE write to NAD 0 whenever none of its modules has to keep a colour, so the
 * whole cabin goes back to BMW in two writes (one a bus, one after the other) instead of 19. This does not depend
 * on how colours are written: a full handback uses it also with single colour writes. Releasing a module the car
 * already owns changes nothing, so the modules of that bus this controller never drove may be covered.
 *
 * A bus where some module keeps its colour (one door opened, a zone changed) is NEVER released whole: only the
 * modules asked for are, one write each, and the others are not touched. A module known to miss whole-bus writes
 * gets its own release after the bus's.
 */
function planRelease(slaves, modules, opts) {
    const o = opts || {};
    const keep = o.keep || new Set(), deaf = o.deaf || new Set();
    const off = { active: false, r: 0, g: 0, b: 0, brightness: 0, seconds: 0 };
    const out = [];
    const single = (s) => out.push({ key: key(s), slave: s, params: off, force: true, covers: [key(s)] });
    Array.from(new Set(slaves.map((s) => s.bus))).sort().forEach((bus) => {
        const mine = slaves.filter((s) => s.bus === bus);
        const all = modules.filter((m) => m.bus === bus);
        if (o.whole && mine.length > 1 && !all.some((m) => keep.has(key(m)))) {
            out.push({ key: busKey(bus), slave: { bus, nad: 0 }, params: off, force: true, covers: all.map(key) });
            mine.filter((s) => deaf.has(key(s))).forEach(single);
        } else mine.forEach(single);
    });
    return out;
}

module.exports = { plan, planRelease, busKey, isBusKey, same, key };
