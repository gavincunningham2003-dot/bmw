'use strict';
/**
 * favourites.js - saved colours: the BDC's own library colours as a fixed row, plus the user's, kept in
 * data/favourites.json. The OEM six are the RGB values of 360A LIC_LCI_COLOR_LIBRARY_DATA as published for
 * G-series cars (Dauxdu/bmw-coding, e-sys/02-Codings/Lighting/Ambient-Lighting.md); they are a convenience,
 * not what this car's BDC necessarily holds.
 */
const fs = require('fs');
const path = require('path');
const { hexToRgb, rgbToHex } = require('./colour');

const OEM = Object.freeze([
    { name: 'White', hex: '#90E090' }, { name: 'Bronze', hex: '#D76E14' }, { name: 'Orange', hex: '#931A01' },
    { name: 'Blue', hex: '#0020FE' }, { name: 'Green', hex: '#10FE32' }, { name: 'Violet', hex: '#783CFE' },
]);
const MAX = 24;

class Favourites {
    constructor(dataDir, log) {
        this.file = dataDir ? path.join(dataDir, 'favourites.json') : null;
        this.log = log || { warn() {} };
        this.items = [];
        this.load();
    }
    load() {
        this.items = [];
        if (!this.file) return;
        try {
            const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (Array.isArray(j.items)) this.items = j.items.filter((i) => i && hexToRgb(i.hex)).map((i) => ({ name: String(i.name || i.hex).slice(0, 24), hex: rgbToHex(hexToRgb(i.hex)) })).slice(0, MAX);
        } catch (e) { /* none yet */ }
    }
    save() {
        if (!this.file) return;
        try { fs.writeFileSync(this.file, JSON.stringify({ items: this.items }, null, 1)); } catch (e) { this.log.warn('favourites: ' + e); }
    }
    oem() { return OEM.slice(); }
    list() { return this.items.slice(); }
    has(hex) { const c = hexToRgb(hex); return !!c && this.items.some((i) => i.hex === rgbToHex(c)); }
    add(hex, name) {
        const c = hexToRgb(hex);
        if (!c) return false;
        const h = rgbToHex(c);
        if (this.items.some((i) => i.hex === h)) return false;
        if (this.items.length >= MAX) this.items.shift();
        this.items.push({ name: String(name || h).slice(0, 24), hex: h });
        this.save();
        return true;
    }
    remove(hex) {
        const c = hexToRgb(hex);
        if (!c) return false;
        const h = rgbToHex(c), n = this.items.length;
        this.items = this.items.filter((i) => i.hex !== h);
        if (this.items.length !== n) this.save();
        return this.items.length !== n;
    }
}

module.exports = { Favourites, OEM, MAX };
