'use strict';
/**
 * car_signals.js - the doors, the turn indicators and day / night, read from the head unit (never written).
 *
 * The three interfaces and their values are the ones the MGU App Kit's Ambient Config reads (apps/ambient_config,
 * MIT, (c) its authors; THIRD_PARTY.md), each checked against this G20's head-unit catalogue
 * (/etc/oap/someip/someip-interfaces.json, read 2026-11-12):
 *
 *   de.bmw.body.DoorsWindowsRoofMirrors . CentralLockingSystemAndPanelStatus  (notifier 32769, no getter)
 *       statusDoorSwitchDRD   driver door front      FAT_IST_OFFEN 1             (..._GESCHLOSSEN 0, 2 implausible, 3 invalid)
 *       statusDoorSwitchPSD   passenger door front   BEIFAHRERTUER_IST_OFFEN 1
 *       statusDoorSwitchDRDR  driver door rear       FATH_IST_OFFEN 1
 *       statusDoorSwitchPSDR  passenger door rear    BFTH_IST_OFFEN 1
 *   de.bmw.body.Light . StatusFunctionsIndicators  (notifier 32774, no getter)
 *       activeFunctionIndicateDirection   DAUERBLINKEN_LINKS 7, _RECHTS 8, TIPPBLINKEN_LINKS 9, _RECHTS 10, the driving
 *       assistant's 18..23, the hazards 6 and the warning flashes 1, 12, 13, 16, 24, 25; the lock, unlock and alarm
 *       flashes (2..5, 11, 14, 15, 17, 26) are NOT a turn signal
 *   de.bmw.infotainment.vehicle.Vehicle . statusDayNightChangeOver  (getter 19, notifier 32787)
 *       dayNightChangeOver   TAG 1, NACHT 2 (0 no change, 3 invalid: ignored)
 *
 * "driver" and "passenger" are the car's own words (the door switches are named for the driver's door, not for a
 * side), so the doors need no left / right mapping. The indicators are left / right: on a right-hand-drive car the
 * LEFT indicator is the PASSENGER side (sideOf below, setting "drive").
 *
 * NOT verified on the car: that an installed app is given these interfaces, and what this G20 sends. Both effects
 * that use them are off until switched on, and a value that is not understood switches an effect off, never on.
 */
const EventEmitter = require('events');

const DOORS_IFACE = 'de.bmw.body.DoorsWindowsRoofMirrors';
const LIGHT_IFACE = 'de.bmw.body.Light';
const VEHICLE_IFACE = 'de.bmw.infotainment.vehicle.Vehicle';

const DOORS = Object.freeze(['driverFront', 'passengerFront', 'driverRear', 'passengerRear']);
const DOOR_FIELDS = Object.freeze({ statusDoorSwitchDRD: 'driverFront', statusDoorSwitchPSD: 'passengerFront', statusDoorSwitchDRDR: 'driverRear', statusDoorSwitchPSDR: 'passengerRear' });
const DOOR_LABELS = Object.freeze({ driverFront: 'driver front', passengerFront: 'passenger front', driverRear: 'driver rear', passengerRear: 'passenger rear' });
/** One door switch: open only on 1 or a name ending _OFFEN; closed, implausible and invalid are all "not open". */
const isOpen = (v) => v === 1 || (typeof v === 'string' && /_OFFEN$/.test(v));
/** The open doors (some of DOORS, in that order) from a CentralLockingSystemAndPanelStatus value. */
function doorsOf(v) {
    if (!v || typeof v !== 'object') return [];
    return Object.keys(DOOR_FIELDS).filter((k) => isOpen(v[k])).map((k) => DOOR_FIELDS[k]);
}

const TURN_BY_NUMBER = Object.freeze({ 7: 'left', 9: 'left', 18: 'left', 20: 'left', 22: 'left', 8: 'right', 10: 'right', 19: 'right', 21: 'right', 23: 'right',
    1: 'both', 6: 'both', 12: 'both', 13: 'both', 16: 'both', 24: 'both', 25: 'both' });
/** 'left' | 'right' | 'both' (hazards) | null from a StatusFunctionsIndicators value (name or wire number). */
function turnOf(v) {
    const x = v && typeof v === 'object' ? v.activeFunctionIndicateDirection : v;
    if (typeof x === 'number') return TURN_BY_NUMBER[x] || null;
    const s = String(x == null ? '' : x).toUpperCase();
    if (/^\d+$/.test(s)) return TURN_BY_NUMBER[Number(s)] || null;
    if (/^(DAUERBLINKEN|TIPPBLINKEN|FAS_RICHTUNGSBLINKEN_\w+PRIO)_LINKS$/.test(s)) return 'left';
    if (/^(DAUERBLINKEN|TIPPBLINKEN|FAS_RICHTUNGSBLINKEN_\w+PRIO)_RECHTS$/.test(s)) return 'right';
    if (/^(WARNBLINKEN_MANUELL|CRASH_BLINKEN|AUFFAHRWARNBLINKEN|WARNBLINKEN_NACH_GEFAHRENBREMSUNG|FAS_WARNBLINKEN_AUSPRAEGUNG_[123])$/.test(s)) return 'both';
    return null;
}
/** The car's sides a turn signal lights: ['driver'] | ['passenger'] | both | []. drive: 'rhd' (default) | 'lhd'. */
function sidesOf(turn, drive) {
    if (!turn) return [];
    if (turn === 'both') return ['driver', 'passenger'];
    const leftIsDriver = drive === 'lhd';
    return [(turn === 'left') === leftIsDriver ? 'driver' : 'passenger'];
}

/** true (night) | false (day) | null (says nothing) from a statusDayNightChangeOver value. */
function nightOf(v) {
    const x = v && typeof v === 'object' ? v.dayNightChangeOver : v;
    if (x === 2 || x === 'NACHT') return true;
    if (x === 1 || x === 'TAG') return false;
    return null;
}

class CarSignals extends EventEmitter {
    constructor(o) {
        super();
        this.signals = o.signals; this.log = o.log || { info() {}, warn() {} };
        this.subs = { doors: null, light: null, vehicle: null };
        this._doors = []; this._turn = null; this._night = null;
        this.started = false;
    }

    /** Subscribe (once). Safe without SOME/IP: every interface that cannot be reached leaves its effect off. */
    async start() {
        if (this.started) return this;
        this.started = true;
        const one = async (iface, handlers) => {
            if (!this.signals || !this.signals.watch) return { error: 'no signals module' };
            try { return await this.signals.watch(iface, '1', handlers, this.log); } catch (e) { return { error: String(e) }; }
        };
        this.subs.doors = await one(DOORS_IFACE, { CentralLockingSystemAndPanelStatus: (v) => this.doorStatus(v) });
        this.subs.light = await one(LIGHT_IFACE, { StatusFunctionsIndicators: (v) => this.indicatorStatus(v) });
        this.subs.vehicle = await one(VEHICLE_IFACE, { statusDayNightChangeOver: (v) => this.dayNight(v) });
        return this;
    }
    async shutdown() {
        for (const k of Object.keys(this.subs)) { const s = this.subs[k]; if (s && s.shutdown) { try { await s.shutdown(); } catch (e) { /* */ } } }
        this.started = false;
    }

    doorStatus(v) {
        const open = doorsOf(v);
        if (open.join() === this._doors.join()) return;
        this._doors = open;
        this.log.info('doors open: ' + (open.length ? open.map((d) => DOOR_LABELS[d]).join(', ') : 'none'));
        this.emit('doors', open.slice());
    }
    indicatorStatus(v) {
        const t = turnOf(v);
        if (t === this._turn) return;
        this._turn = t;
        this.emit('turn', t);
    }
    dayNight(v) {
        const n = nightOf(v);
        if (n === null || n === this._night) return;
        this._night = n;
        this.log.info(n ? 'night' : 'day');
        this.emit('night', n);
    }

    /** The doors and the turn signal are forgotten (their interface went away, or the car was left). */
    reset() {
        if (this._doors.length) { this._doors = []; this.emit('doors', []); }
        if (this._turn) { this._turn = null; this.emit('turn', null); }
    }
    /** A subscription whose provider went away: what it last said is no longer trusted. */
    lost() {
        const gone = (s) => !!s && !s.error && s.available === false;
        return { doors: gone(this.subs.doors), turn: gone(this.subs.light) };
    }

    doors() { return this._doors.slice(); }
    turn() { return this._turn; }
    night() { return this._night; }

    /** One line for the Diagnostics page. */
    summary() {
        const link = (s) => (!s ? 'not started' : s.error ? 'not reachable' : s.available === false ? 'no provider' : 'subscribed');
        return 'doors ' + (this._doors.length ? this._doors.map((d) => DOOR_LABELS[d]).join(' + ') + ' open' : link(this.subs.doors))
            + '; indicators ' + (this._turn || link(this.subs.light))
            + '; ' + (this._night === null ? 'day/night ' + link(this.subs.vehicle) : this._night ? 'night' : 'day');
    }
}

module.exports = { CarSignals, doorsOf, turnOf, sidesOf, nightOf, isOpen, DOORS, DOOR_FIELDS, DOOR_LABELS, DOORS_IFACE, LIGHT_IFACE, VEHICLE_IFACE };
