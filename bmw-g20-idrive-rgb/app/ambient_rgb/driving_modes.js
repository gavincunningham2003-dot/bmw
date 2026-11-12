'use strict';
/**
 * driving_modes.js - the car's driving mode and its state (in use / locked and left), and a lighting choice per mode.
 *
 * The mode table and its decoding follow the MGU App Kit's Ambient Config (apps/ambient_config/ambient.js, MIT,
 * (c) its authors; see THIRD_PARTY.md): FES.statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience by
 * name or wire number; a plug-in hybrid is known from the first PHEV mode the car reports (kept), and has Sport,
 * Hybrid, Electric and Adaptive where a petrol or diesel car has Sport, Comfort, Eco Pro and Adaptive. Every raw
 * value the car sends is logged once and kept for the Diagnostics page: the table is NOT verified on this
 * project's G20 330e, so nothing follows the mode until the setting is switched on.
 *
 * The car's state is de.bmw.infrastructure.VehicleCondition (kit/car.js numbers): parked or standby with nobody in
 * it (1..3) = away; living, ignition, driving = in use; nothing received = unknown (null).
 *
 * Each mode has one choice, kept in modes.json in the app's data folder:
 *   { type: 'default' }           the lighting the driver applied (nothing special for this mode)
 *   { type: 'oem' }               the car's own lighting in this mode
 *   { type: 'custom', program }   a complete program (lighting_scene.js)
 *
 * This module only reads the car and keeps the choices; main.js decides what to apply and when.
 */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const CONDITION = 'de.bmw.infrastructure.VehicleCondition';
const MODES = ['sport', 'comfort', 'eco', 'hybrid', 'electric', 'adaptive'];
const LABELS = { sport: 'Sport', comfort: 'Comfort', eco: 'Eco Pro', hybrid: 'Hybrid', electric: 'Electric', adaptive: 'Adaptive' };
const KIND_MODES = { ice: ['sport', 'comfort', 'eco', 'adaptive'], hybrid: ['sport', 'hybrid', 'electric', 'adaptive'] };

// actualValueModeDrivingExperience's names and wire numbers (Ambient Config)
const BY_NAME = {
    SPORT_DYNAMIC: 1, SPORT_EXPERT: 2, SPORT_INDIVIDUAL: 3, COMFORT: 4, COMFORT_PLUS: 5, COMFORT_INDIVIDUAL: 6,
    ECO_PRO_EFFICIENT: 7, ECO_PRO_PLUS: 8, ECO_PRO_INDIVIDUAL: 9, ADAPTIVE: 10, PHEV_SPORT_STANDARD: 15, PHEV_SPORT_INDIVIDUAL: 16,
    PHEV_HYBRID_STANDARD: 17, PHEV_HYBRID_ECO: 18, PHEV_HYBRID_COMFORT: 19, PHEV_ELECTRIC_STANDARD: 20, PHEV_ELECTRIC_INDIVIDUAL: 21,
    PHEV_SPORT_PLUS: 23, BOOST: 28,
};
const BY_NUMBER = { 1: 'sport', 2: 'sport', 3: 'sport', 4: 'comfort', 5: 'comfort', 6: 'comfort', 7: 'eco', 8: 'eco', 9: 'eco', 10: 'adaptive',
    15: 'sport', 16: 'sport', 23: 'sport', 28: 'sport', 17: 'hybrid', 18: 'hybrid', 19: 'hybrid', 20: 'electric', 21: 'electric' };
const PHEV = [15, 16, 17, 18, 19, 20, 21, 22, 23];

/** A raw mode (name or wire number) -> { mode (one of MODES or null), phev }, or null when it says nothing. */
function modeOf(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = typeof raw === 'number' || /^\d+$/.test(String(raw)) ? Number(raw) : BY_NAME[String(raw).toUpperCase()];
    if (n === undefined) {
        // a name not in the table (another software level): by its words
        const w = String(raw).toUpperCase();
        const mode = /ADAPTIV/.test(w) ? 'adaptive' : /ELECTRIC|ELEKTR/.test(w) ? 'electric' : /HYBRID/.test(w) ? 'hybrid' : /SPORT|BOOST/.test(w) ? 'sport'
            : /COMFORT/.test(w) ? 'comfort' : /ECO/.test(w) ? 'eco' : null;
        return mode ? { mode, phev: /PHEV|HYBRID|ELECTRIC/.test(w) } : null;
    }
    return { mode: BY_NUMBER[n] || null, phev: PHEV.indexOf(n) >= 0 };
}

// VehicleCondition.statusConditionVehicle (kit/car.js)
const CONDITIONS = { PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3, WOHNEN: 5,
    PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12 };
const conditionOf = (x) => { const n = typeof x === 'number' ? x : CONDITIONS[x]; return n >= 1 && n <= 12 ? n : undefined; };

const valid = (a) => !!a && (a.type === 'default' || a.type === 'oem' || (a.type === 'custom' && !!a.program && typeof a.program === 'object'));

class DrivingModes extends EventEmitter {
    constructor(o) {
        super();
        this.signals = o.signals; this.log = o.log || { info() {}, warn() {} };
        this.file = o.dataDir ? path.join(o.dataDir, 'modes.json') : null;
        this.kind = 'ice';
        this.choices = {};
        this._mode = null; this._raw = null; this.seen = [];
        this._condition = null;                  // 1..12 once the car has said it
        this.subs = { fes: null, condition: null };
        this._load();
    }

    _load() {
        if (!this.file) return;
        try {
            const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (j.kind === 'hybrid') this.kind = 'hybrid';
            MODES.forEach((m) => { if (valid(j.choices && j.choices[m])) this.choices[m] = j.choices[m]; });
        } catch (e) { /* none yet */ }
    }
    _save() {
        if (!this.file) return;
        try { fs.writeFileSync(this.file, JSON.stringify({ kind: this.kind, choices: this.choices }, null, 1)); } catch (e) { this.log.warn('driving modes: ' + e); }
    }

    async start() {
        const one = async (iface, handlers) => {
            if (!this.signals || !this.signals.watch) return { error: 'no signals module' };
            try { return await this.signals.watch(iface, '1', handlers, this.log); } catch (e) { return { error: String(e) }; }
        };
        this.subs.fes = await one(FES, { statusFESVehicleDynamicSwitchHMI: (v) => this.drive(v) });
        this.subs.condition = await one(CONDITION, { VehicleCondition: (v) => this.condition(v) });
        return this;
    }
    async shutdown() { for (const k of ['fes', 'condition']) { const s = this.subs[k]; if (s && s.shutdown) { try { await s.shutdown(); } catch (e) { /* */ } } } }

    /** A driving-mode status from the car. */
    drive(v) {
        const raw = v && typeof v === 'object' ? v.actualValueModeDrivingExperience : v;
        this._raw = raw === undefined ? null : raw;
        if (this.seen.length < 20 && raw != null && this.seen.indexOf(String(raw)) < 0) { this.seen.push(String(raw)); this.log.info('driving mode: the car sends ' + raw); }
        const got = modeOf(raw);
        if (!got) return;
        if (got.phev && this.kind !== 'hybrid') { this.kind = 'hybrid'; this.log.info('driving mode: a plug-in hybrid\'s modes'); this._save(); }
        if (got.mode === null || got.mode === this._mode) return;
        const was = this._mode;
        this._mode = got.mode;
        this.log.info('driving mode: ' + got.mode);
        this.emit('mode', got.mode, was);
    }
    /** A vehicle-condition status from the car. */
    condition(v) {
        const n = conditionOf(v && typeof v === 'object' ? v.statusConditionVehicle : v);
        if (this.subs.condition && this.subs.condition.available) this._seenAvailable = true;
        if (n === undefined || n === this._condition) return;
        const was = this.away();
        this._condition = n;
        this._conditionAt = Date.now();
        if (this.away() !== was) { this.log.info('vehicle state: ' + (this.away() ? 'locked or left' : 'in use') + ' (' + n + ')'); this.emit('away', this.away()); }
    }

    mode() { return this._mode; }
    raw() { return this._raw; }
    /**
     * true: parked or standby with nobody in it (1..3); false: in use; null: the car has not said, or the
     * interface that said it is no longer available (a state heard before a disconnect is not trusted after it).
     */
    away() {
        if (this._condition === null) return null;
        const sub = this.subs.condition;
        if (sub && !sub.error && sub.available === false && this._seenAvailable) return null;
        return this._condition <= 3;
    }
    /** The raw vehicle condition (1..12) or null. */
    conditionNumber() { return this._condition; }
    /** The state is expected (the interface answered) but has not arrived yet. */
    stateAwaited() { return !!this.subs.condition && !this.subs.condition.error && this._condition === null; }
    modes() { return KIND_MODES[this.kind]; }
    label(m) { return LABELS[m] || m; }

    choice(m) { return valid(this.choices[m]) ? this.choices[m] : { type: 'default' }; }
    setChoice(m, a) {
        if (MODES.indexOf(m) < 0 || !valid(a)) return false;
        if (a.type === 'default') delete this.choices[m]; else this.choices[m] = JSON.parse(JSON.stringify(a));
        this._save();
        this.emit('choice', m);
        return true;
    }

    /** What the Diagnostics page shows. */
    summary() {
        const link = (s) => (!s ? 'not started' : s.error ? 'not reachable' : 'subscribed');
        const state = this.away() === null ? (this.stateAwaited() ? 'not said yet' : link(this.subs.condition)) : (this.away() ? 'locked or left' : 'in use') + ' (' + this._condition + ')';
        const mode = this._mode ? this.label(this._mode) + ' (raw ' + this._raw + ')' : this._raw != null ? 'unknown (raw ' + this._raw + ')' : link(this.subs.fes);
        return [state, mode + (this.kind === 'hybrid' ? ', plug-in hybrid' : '')];
    }
}

module.exports = { DrivingModes, modeOf, conditionOf, MODES, LABELS, KIND_MODES, FES, CONDITION };
