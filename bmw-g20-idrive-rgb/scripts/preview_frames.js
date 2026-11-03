'use strict';
/**
 * preview_frames.js - run the app against the UI harness (the kit's real drawing code, a simulated BDC, no
 * head unit) and save the pages as PNGs after a scripted session: preview/*.png
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
    await shot('01-colour-initial');
    h.tap(270, 120);                                 // on the wheel, above the centre: around hue 0 (red), half saturation
    await shot('02-colour-tapped-wheel');
    await h.press('custom');                         // Apply to lights (simulated BDC)
    await sleep(50);
    await shot('03-colour-custom-on');
    await h.press('oem:#D76E14');                    // library Bronze
    await sleep(50);
    await shot('04-colour-bronze');
    await h.press('save');
    h.tab(1);
    await shot('05-favourites');
    h.tab(2);
    await shot('06-diagnostics');
    h.tab(0);
    await h.frame();
    await h.press('oem');
    await sleep(50);
    await shot('07-colour-oem-restored');
    const ctl = h.app.ctl();
    await ctl.shutdown();
    console.log('lighting:', ctl.state, 'custom', ctl.custom, 'writes', ctl.stats.writes, 'accepted', ctl.stats.accepted);
    console.log('log warnings/errors:', h.log.filter((l) => l[0] !== 'info').map((l) => l.join(': ')).join('\n') || 'none');
    setTimeout(() => process.exit(0), 100);
})().catch((e) => { console.error(e); process.exit(1); });
