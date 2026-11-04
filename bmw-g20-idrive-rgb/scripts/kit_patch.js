'use strict';
/**
 * kit_patch.js - one change to the MGU App Kit runtime this app needs, applied to a copy of kit/runtime/display.js
 * (idempotent: a marker comment says it is done).
 *
 *   node scripts/kit_patch.js <path to kit/runtime/display.js>
 *
 * Where the kit runs the screen (the Store renderer, full layout, touch routing) its Display handles every
 * iDrive controller event itself (tabs, targets, bar buttons) and never hands one to ctx.controller.onInput,
 * even after the app called ctx.controller.grab(true). The patch: while the app holds the grab, the events go
 * to the app (its colour wheel and dials are turned with the knob); release gives them back to the kit's focus.
 * Everything else (no grab: the kit walks its ring; other layouts: unchanged) stays as it is.
 */
const fs = require('fs');

const MARK = '/* ambient_rgb: grab -> onInput */';
const FROM = "if (this.onCcu && !this.own()) this.onCcu(v); else this._ccu(v);";
const TO = MARK + " if (this.onCcu && (this.grabbing || !this.own())) this.onCcu(v); else this._ccu(v);";

function patchRuntime(file) {
    const s = fs.readFileSync(file, 'utf8');
    if (s.indexOf(MARK) >= 0) return 'already';
    if (s.indexOf(FROM) < 0) throw new Error('kit_patch: display.js does not match (kit changed?): ' + file);
    fs.writeFileSync(file, s.replace(FROM, TO));
    return 'patched';
}

module.exports = { patchRuntime, MARK };
if (require.main === module) {
    const f = process.argv[2];
    if (!f) { console.error('usage: node scripts/kit_patch.js <kit/runtime/display.js>'); process.exit(2); }
    console.log('kit_patch: ' + patchRuntime(f) + ' ' + f);
}
