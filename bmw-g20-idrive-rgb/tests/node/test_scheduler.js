'use strict';
const path = require('path');
const { test, run, assert, fakeClock, tick } = require('./t');
const { JS } = require('../../scripts/stage');
const { WriteScheduler } = require(path.join(JS, 'lighting_scheduler'));

const slave = (bus, nad) => ({ bus, nad });
const params = (r, b) => ({ active: true, r, g: 0, b: 0, brightness: b == null ? 100 : b, seconds: 10 });

/** A transport with a latency and a programmable verdict, on the fake clock. */
function transport(clock, opts) {
    const o = opts || {};
    const sent = [];
    const writer = (s, p) => new Promise((resolve) => {
        sent.push({ key: s.bus + ':' + s.nad, params: p, at: clock.now() });
        const verdict = o.verdict ? o.verdict(s, p, sent.length) : { ok: true };
        clock.setTimeout(() => resolve(verdict), o.latencyMs == null ? 14 : o.latencyMs);
    });
    return { writer, sent };
}
function make(opts, sopts) {
    const clock = fakeClock();
    const tr = transport(clock, opts);
    const s = new WriteScheduler(Object.assign({ writer: tr.writer, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }, sopts || {}));
    return { s, clock, sent: tr.sent };
}

test('one write at a time, in order, and the newest target per module wins while queued', async () => {
    const { s, clock, sent } = make();
    s.set('1:1', slave(1, 1), params(10), 'apply');
    s.set('1:2', slave(1, 2), params(20), 'apply');
    s.set('1:1', slave(1, 1), params(11), 'apply');         // 1:1 is in flight: this queues behind
    s.set('1:2', slave(1, 2), params(22), 'apply');         // 1:2 not yet sent: replaced
    assert.strictEqual(s.inFlight.size, 1);
    await clock.advance(100);
    assert.deepStrictEqual(sent.map((x) => x.key + '=' + x.params.r), ['1:1=10', '1:2=22', '1:1=11']);
    assert.strictEqual(s.stats.accepted, 3);
    await s.drain();
});
test('unchanged targets are skipped unless forced (the keep-alive)', async () => {
    const { s, clock, sent } = make();
    s.set('1:1', slave(1, 1), params(10), 'apply');
    await clock.advance(50);
    s.set('1:1', slave(1, 1), params(10), 'apply');
    await clock.advance(50);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(s.stats.skipped, 1);
    s.set('1:1', slave(1, 1), params(10), 'apply', true);
    await clock.advance(50);
    assert.strictEqual(sent.length, 2);
});
test('priorities: a release goes before an apply before a frame', async () => {
    const { s, clock, sent } = make();
    s.set('1:1', slave(1, 1), params(1), 'apply');          // in flight
    s.frame([{ key: '1:2', slave: slave(1, 2), params: params(2) }]);
    s.set('1:3', slave(1, 3), params(3), 'apply');
    s.release([slave(1, 4)]);
    await clock.advance(200);
    assert.deepStrictEqual(sent.map((x) => x.key), ['1:1', '1:4', '1:3', '1:2']);
});
test('obsolete animation frames are dropped whole; a frame never arrives late', async () => {
    const { s, clock, sent } = make({ latencyMs: 30 });
    const frame = (r) => s.frame([1, 2, 3].map((n) => ({ key: '1:' + n, slave: slave(1, n), params: params(r) })));
    frame(1);                                                // 1:1 in flight, 1:2 and 1:3 queued
    frame(2);                                                // replaces the queued ones
    const r3 = frame(3);
    assert.ok(r3.dropped >= 2, 'queued items of the older frame dropped');
    await clock.advance(500);
    const rs = sent.map((x) => x.params.r);
    assert.strictEqual(rs[0], 1);
    assert.ok(rs.slice(1).every((r) => r === 3), 'after the in-flight write only the newest frame was sent: ' + rs);
    assert.strictEqual(s.stats.dropped >= 2, true);
});
test('busy (NRC 21) is retried after a growing pause; a newer target meanwhile wins', async () => {
    let busyLeft = 2;
    const { s, clock, sent } = make({ verdict: (sl, p) => (busyLeft-- > 0 ? { ok: false, nrc: 0x21 } : { ok: true }) }, { busyBackoffMs: 100 });
    s.set('1:1', slave(1, 1), params(5), 'apply');
    await clock.advance(20);
    assert.strictEqual(s.stats.busy, 1);
    assert.strictEqual(s.queue.has('1:1'), true, 'back on the queue');
    await clock.advance(60);
    assert.strictEqual(sent.length, 1, 'not before the backoff');
    await clock.advance(60);
    assert.strictEqual(sent.length, 2);
    s.set('1:1', slave(1, 1), params(6), 'apply');          // newer target while the second busy retry waits
    await clock.advance(400);
    assert.strictEqual(s.stats.accepted, 1);
    assert.strictEqual(sent[sent.length - 1].params.r, 6, 'the newest target was the one accepted');
});
test('a reject is counted and reported, and does not block the rest', async () => {
    const { s, clock } = make({ verdict: (sl) => (sl.nad === 2 ? { ok: false, nrc: 0x31, reason: 'rejected' } : { ok: true }) });
    const failed = [];
    s.on('failed', (k, p, r) => failed.push(k + ':' + r.nrc));
    [1, 2, 3].forEach((n) => s.set('1:' + n, slave(1, n), params(n), 'apply'));
    await clock.advance(200);
    assert.deepStrictEqual(failed, ['1:2:49']);
    assert.strictEqual(s.stats.accepted, 2); assert.strictEqual(s.stats.rejected, 1);
    assert.strictEqual(s.last.get('1:2').ok, false);
});
test('drain resolves when everything is done; clear drops the queue; pause / resume', async () => {
    const { s, clock, sent } = make();
    [1, 2, 3, 4].forEach((n) => s.set('1:' + n, slave(1, n), params(n), 'apply'));
    let drained = false;
    s.drain().then(() => { drained = true; });
    await clock.advance(10);
    assert.strictEqual(drained, false);
    await clock.advance(100);
    assert.strictEqual(drained, true);
    s.pause();
    [5, 6].forEach((n) => s.set('1:' + n, slave(1, n), params(n), 'apply'));
    await clock.advance(100);
    assert.strictEqual(sent.length, 4, 'paused: nothing sent');
    assert.strictEqual(s.clear(), 2);
    s.resume();
    await clock.advance(50);
    assert.strictEqual(sent.length, 4);
    await s.drain();
});
test('stats: latency and writes per second', async () => {
    const { s, clock } = make({ latencyMs: 20 });
    for (let n = 1; n <= 10; n++) s.set('1:' + n, slave(1, n), params(n), 'apply');
    await clock.advance(400);
    assert.strictEqual(s.stats.latencyMs, 20);
    assert.ok(s.stats.avgLatencyMs >= 19 && s.stats.avgLatencyMs <= 21);
    assert.ok(s.stats.writesPerSec > 0);
});
test('benchmark (simulation): a full-cabin frame at the measured 14 ms per write, in flight 1 vs 2 per bus', async () => {
    const results = {};
    for (const inflight of [1, 2]) {
        const { s, clock, sent } = make({ latencyMs: 14 }, { maxInFlight: inflight });
        const t0 = clock.now();
        const targets = [];
        for (let n = 1; n <= 7; n++) targets.push({ key: '1:' + n, slave: slave(1, n), params: params(1) });
        for (let n = 1; n <= 12; n++) targets.push({ key: '2:' + n, slave: slave(2, n), params: params(1) });
        s.frame(targets);
        await clock.advance(2000);
        await s.drain();
        results[inflight] = { ms: sent[sent.length - 1].at + 14 - t0, writes: sent.length };
    }
    console.log('       benchmark: 19 modules at 14 ms/write: in flight 1 -> ' + results[1].ms + ' ms per frame (' + Math.round(1000 / results[1].ms * 10) / 10 + ' fps); in flight 2 (one per bus) -> ' + results[2].ms + ' ms (' + Math.round(1000 / results[2].ms * 10) / 10 + ' fps) IF the transport allowed it');
    assert.strictEqual(results[1].writes, 19);
    assert.ok(results[1].ms >= 19 * 14 && results[1].ms < 19 * 14 + 50, 'sequential: ' + results[1].ms);
    assert.ok(results[2].ms < results[1].ms, 'two buses in parallel would be faster in simulation');
});
test('maxInFlight 2 keeps the order within a bus (one in flight per bus)', async () => {
    const { s, clock, sent } = make({ latencyMs: 10 }, { maxInFlight: 2 });
    s.set('1:1', slave(1, 1), params(1), 'apply'); s.set('1:2', slave(1, 2), params(2), 'apply');
    s.set('2:1', slave(2, 1), params(3), 'apply');
    await tick();
    assert.strictEqual(s.inFlight.size, 2, 'one per bus');
    assert.ok(s.inFlight.has('1:1') && s.inFlight.has('2:1'));
    await clock.advance(100);
    assert.deepStrictEqual(sent.map((x) => x.key), ['1:1', '2:1', '1:2']);
});

module.exports = run('scheduler');
