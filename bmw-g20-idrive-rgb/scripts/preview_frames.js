'use strict';
/**
 * preview_frames.js - run the app against the UI harness (the kit's real drawing code, a simulated BDC, no head
 * unit) and save the pages as PNGs after a scripted session: preview/*.png
 *
 *   node scripts/stage.js && node scripts/preview_frames.js
 */
const fs = require('fs');
const path = require('path');
const { stage, JS, ROOT } = require('./stage');
const { harness } = require('../tests/node/ui_harness');

if (!fs.existsSync(path.join(JS, 'app.js'))) stage();
const out = path.join(ROOT, 'preview');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const h = await harness({ sets: { backend: 'mock', demo: 'off' } });
    const shot = async (name) => { await h.frame(); const f = path.join(out, name + '.png'); h.png(f); console.log('frame', f, 'targets', h.targets().length); };
    await shot('01-colours');
    h.tap(640, 98); h.tap(930, 116);                       // red, 50 %
    await shot('02-colours-preview');
    await h.press('wheel');                                 // editing with the knob
    await shot('03-colours-editing');
    h.app.editor.cancel();
    await h.press('apply');
    await sleep(60);
    await shot('04-colours-applied');
    h.tab(1);
    await shot('05-dual');
    await h.press('apply');
    await sleep(60);
    await shot('06-dual-applied');
    h.tab(2);
    await h.frame();
    await h.press('mode:wave');
    await h.press('apply');
    await sleep(400);
    await shot('07-modes-wave');
    await h.frame();
    await h.press('mode:breathing');
    await shot('08-modes-breathing');
    h.tab(1); await h.frame(); await h.press('savecombo');
    h.tab(3);
    await shot('09-favourites');
    h.tab(4);
    await shot('10-diagnostics');
    const ctl = h.app.ctl();
    const r = await ctl.restoreOem();
    h.tab(0);
    await shot('11-colours-oem');
    console.log('restore:', JSON.stringify(r), '| scheduler:', JSON.stringify(ctl.scheduler.status()));
    console.log('log warnings/errors:', h.log.filter((l) => l[0] !== 'info').map((l) => l.join(': ')).join('\n') || 'none');
    await ctl.shutdown();
    setTimeout(() => process.exit(0), 100);
})().catch((e) => { console.error(e); process.exit(1); });
