'use strict';
/** t.js - the smallest test runner: test(name, fn) collects, run() runs them in order and reports. Node 8+. */
const assert = require('assert');
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }
async function run(label) {
    let pass = 0, fail = 0;
    const mine = cases.splice(0, cases.length);            // this file's cases only
    for (const c of mine) {
        try {
            let watchdog;
            await Promise.race([c.fn(), new Promise((_, rej) => { watchdog = setTimeout(() => rej(new Error('TIMEOUT after 15 s (a promise never resolved: a fake timer not advanced?)')), 15000); })]);
            clearTimeout(watchdog);
            pass++; console.log('  ok   ' + c.name);
        } catch (e) { fail++; console.log('  FAIL ' + c.name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
    }
    console.log((label || 'tests') + ': ' + pass + ' passed, ' + fail + ' failed');
    return { pass, fail };
}
/** fake timers: setTimeout/clearTimeout/now driven by advance(ms) */
function fakeClock(start) {
    let now = start || 1000000, seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms), fn }); return id; },
        clearTimeout: (id) => { timers.delete(id); },
        pending: () => timers.size,
        async advance(ms) {
            const end = now + ms;
            const yield_ = () => new Promise((r) => setImmediate(r));
            const due = () => { let next = null; timers.forEach((t, id) => { if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t }; }); return next; };
            await yield_();                                   // work queued on microtasks (an apply() in flight) registers its timers first
            for (;;) {
                let next = due();
                if (!next) { await yield_(); next = due(); if (!next) break; }
                now = Math.max(now, next.t.at); timers.delete(next.id);
                await next.t.fn();
                await yield_();
            }
            now = end;
            await yield_();
            await yield_();
        },
    };
}
const tick = () => new Promise((r) => setImmediate(r));
module.exports = { test, run, assert, fakeClock, tick };
