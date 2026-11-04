'use strict';
/**
 * run_all.js - every Node test, in order, in one process; exit 1 if any failed.
 *   node scripts/stage.js && node tests/node/run_all.js
 */
const path = require('path');
const files = ['test_colour', 'test_protocol', 'test_controller', 'test_transitions', 'test_bdc_uds', 'test_favourites', 'test_ui'];
(async () => {
    let fail = 0, pass = 0;
    for (const f of files) {
        console.log('== ' + f);
        const r = await require(path.join(__dirname, f));
        fail += r.fail; pass += r.pass;
    }
    console.log('\nTOTAL: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
