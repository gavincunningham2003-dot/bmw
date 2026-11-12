'use strict';
/**
 * oem_lighting.js - a READ-ONLY view of the factory ambient lighting as the head unit itself knows it.
 *
 * The unit's master catalog (/etc/oap/someip/someip-interfaces.json, read off a G20's MGU on 2026-11-12) lists
 *   de.bmw.body.interiorillumination.AmbientLight (service 45214, instance 1): ambientLightActive,
 *     brightnessAmbientLight, brightnessAmbientContourLine, currentInteriorLightProfile { currentLightProfileId }
 *   de.bmw.infotainment.misc.ComfortFunctionIuK (service 46354, instance 1): statusAmbientLightInteriorColour
 *     { statusHueInteriorLighting, statusMenuAmbientePanoramicRoofInteriorLighting, ... }
 * These are what the factory lighting menu uses, and the factory lighting is what lamps outside the 19 RGB
 * modules follow (the roof lamp unit on this car). Whether an installed app may reach them, and which of the
 * two this car fills, is NOT verified: this module only subscribes and reads, and reports what came back.
 *
 * It never writes. app.json lists these fields with "rs" only (no "w"), so the installer leaves the setters out
 * of the app's interface configs: a write is not possible from this app as built.
 */
const AMBIENT = 'de.bmw.body.interiorillumination.AmbientLight';
const COMFORT = 'de.bmw.infotainment.misc.ComfortFunctionIuK';
const AMBIENT_FIELDS = ['ambientLightActive', 'brightnessAmbientLight', 'brightnessAmbientContourLine', 'currentInteriorLightProfile'];
const COMFORT_FIELDS = ['statusAmbientLightInteriorColour'];

/** CurrentLightProfileId, from the catalog. */
const PROFILES = {
    0: 'None', 1: 'Bronze', 2: 'Mint', 3: 'Rose', 4: 'Warm White', 5: 'Cold White', 6: 'Sky Blue', 7: 'Toxic Yellow', 8: 'Orange',
    9: 'Colour 1', 10: 'Colour 2', 11: 'Colour 3', 12: 'Colour 4', 80: 'Fire', 81: 'Wave', 82: 'Reduced', 83: 'Sunshine and Sea Wave',
    84: 'Colorful', 85: 'Reduced (rear)', 86: 'Bright White', 87: 'Warm Colors', 88: 'Green Shimmering',
};

/** An enum arrives as a number or as its catalog name, depending on the binding. */
function profileName(v) {
    if (v == null) return null;
    if (typeof v === 'number') return (PROFILES[v] || 'profile') + ' (' + v + ')';
    const s = String(v);
    return /^\d+$/.test(s) ? profileName(Number(s)) : s;
}
const unwrap = (v, key) => (v && typeof v === 'object' && key in v ? v[key] : v);
const onOff = (v) => (v === true || v === 1 || v === 'EIN' ? 'on' : v === false || v === 0 || v === 'AUS' ? 'off' : String(v));

class OemLighting {
    constructor(signals, log, opts) {
        this.signals = signals;
        this.log = log;
        this.now = (opts && opts.now) || Date.now;
        this.values = {};                 // field -> { value, at }
        this.subs = { ambient: null, comfort: null };
        this.started = false;
    }

    /** Subscribe and read; resolves when both attempts have settled. Safe to call without SOME/IP (a laptop). */
    async start() {
        if (this.started) return this;
        this.started = true;
        const take = (f) => (v) => { this.values[f] = { value: v, at: this.now() }; };
        const handlers = (fields) => fields.reduce((h, f) => { h[f] = take(f); return h; }, {});
        const one = async (iface, fields) => {
            if (!this.signals || !this.signals.watch) return { iface, available: false, error: 'no signals module' };
            try { return await this.signals.watch(iface, '1', handlers(fields), this.log, { pollMs: 5000 }); } catch (e) { return { iface, available: false, error: String(e) }; }
        };
        this.subs.ambient = await one(AMBIENT, AMBIENT_FIELDS);
        this.subs.comfort = await one(COMFORT, COMFORT_FIELDS);
        if (this.log) this.log.info('factory lighting read-out: ' + this.summary().join('; '));
        return this;
    }

    async shutdown() {
        for (const k of ['ambient', 'comfort']) { const s = this.subs[k]; if (s && s.shutdown) { try { await s.shutdown(); } catch (e) { /* */ } } }
    }

    _v(f) { return this.values[f] ? this.values[f].value : undefined; }
    _link(sub) {
        if (!sub) return 'not started';
        if (sub.error) return 'not reachable (' + String(sub.error).replace(/^Error:\s*/, '').slice(0, 60) + ')';
        return sub.available ? 'no value yet' : 'provider not available';
    }

    /** What the interfaces said, decoded; undefined members were never received. */
    state() {
        const colour = this._v('statusAmbientLightInteriorColour');
        const c = colour && typeof colour === 'object' ? colour : {};
        return {
            active: this._v('ambientLightActive'),
            brightness: this._v('brightnessAmbientLight'),
            contourBrightness: this._v('brightnessAmbientContourLine'),
            profile: unwrap(this._v('currentInteriorLightProfile'), 'currentLightProfileId'),
            hue: c.statusHueInteriorLighting,
            selection: c.statusMenuAmbientePanoramicRoofInteriorLighting,
            mode: c.statusModeAmbientePanoramicRoofInteriorLighting,
            received: Object.keys(this.values).length,
        };
    }

    /** Two short lines for the Diagnostics page: [light, colour]. */
    summary() {
        const s = this.state();
        const light = [];
        if (s.active !== undefined) light.push(onOff(s.active));
        if (s.brightness !== undefined) light.push('brightness ' + s.brightness);
        if (s.contourBrightness !== undefined) light.push('contour ' + s.contourBrightness);
        const colour = [];
        if (s.profile !== undefined) colour.push(profileName(s.profile));
        if (s.selection !== undefined) colour.push('selection ' + s.selection);
        if (s.hue !== undefined) colour.push('hue ' + s.hue);
        if (s.mode !== undefined) colour.push('mode ' + onOff(s.mode));
        return [
            light.length ? light.join(', ') + ' (read-only)' : this._link(this.subs.ambient),
            colour.length ? colour.join(', ') : (s.profile === undefined && this.subs.ambient && !this.subs.ambient.error && this.subs.comfort && this.subs.comfort.error ? this._link(this.subs.ambient) : this._link(this.subs.comfort)),
        ];
    }
}

module.exports = { OemLighting, PROFILES, profileName, AMBIENT, COMFORT, AMBIENT_FIELDS, COMFORT_FIELDS };
