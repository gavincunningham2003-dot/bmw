'use strict';
/**
 * someip.js - Approach 1: a native SOME/IP lighting service. NOT ESTABLISHED.
 *
 * No public source names a SOME/IP interface through which the MGU sets the ambient colour (the stock HMI's
 * setting most likely travels as a vehicle setting the BDC consumes, but which interface, field or method is
 * unknown). The only way to find out is the unit's own master catalog, /etc/oap/someip/someip-interfaces.json:
 * copy it off the car and run tools/laptop/catalog_search.py over it. This controller therefore only PROBES:
 * it asks the kit's signals.js whether any of the candidate interfaces exists in the app's generated
 * someipInterfaces/ (which the installer makes from app.json "signals" against that catalog) and reports.
 * It never writes: _writeSlave refuses until a field and its struct are known and tested.
 */
const { LightingController } = require('./lighting_controller');

const CANDIDATES = [
    // GUESSES to look for in the catalog: none of these is known to exist. catalog_search.py searches by substring.
    'de.bmw.infotainment.vehicle.AmbientLight', 'de.bmw.infotainment.vehicle.InteriorLight', 'de.bmw.infotainment.lightcontrol.AmbientLight',
    'de.bmw.body.interiorlight.InteriorLight', 'de.bmw.body.ambientlight.AmbientLight', 'de.bmw.infotainment.smartinterior.Lighting',
];

class SomeIpLightingController extends LightingController {
    constructor(opts) {
        super(Object.assign({ kind: 'someip' }, opts));
        this.signals = (opts && opts.signals) || null;
        this.candidates = (opts && opts.candidates) || CANDIDATES;
        this.found = [];
    }
    _available() { return !!(this.signals && this.signals.hasNative && this.signals.hasNative()); }
    async _probe() {
        this.found = [];
        if (!this.signals) return { available: false, reason: 'no signals module', transport: 'someip', slaves: [], rgbActuator: 'unknown' };
        for (const name of this.candidates) {
            try { const cfg = this.signals.loadConfig(name); this.found.push({ name, fields: Object.keys(cfg.fields || {}), methods: Object.keys(cfg.methods || {}) }); } catch (e) { /* not in this app's interfaces */ }
        }
        return {
            available: false, transport: 'someip', slaves: [], rgbActuator: 'unknown',
            reason: this.found.length ? 'interface(s) present but their lighting semantics are unverified: ' + this.found.map((f) => f.name).join(', ') : 'no lighting SOME/IP interface known; search the unit catalog with tools/laptop/catalog_search.py',
            candidates: this.candidates, found: this.found,
        };
    }
    async _writeSlave() { return { ok: false, reason: 'SOME/IP lighting control is not established (see PROTOCOL_FINDINGS.md)' }; }
}

module.exports = { SomeIpLightingController, CANDIDATES };
