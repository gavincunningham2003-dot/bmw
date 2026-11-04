'use strict';
/**
 * emu_win_shim.js - loaded through NODE_OPTIONS=--require by scripts/emu.js on Windows, into the emulator and
 * the app it forks. The kit's renderd.js decides a renderer is there with fs.statSync(path).isSocket(); a Windows
 * named pipe (\\.\pipe\...) cannot be stat'ed, so the app would fall back to software drawing and no touch
 * would reach it. For pipe paths, report "a socket" when the pipe answers.
 */
const fs = require('fs');
const net = require('net');
const PIPE = /^\\\\[.?]\\pipe\\/i;
const statSync = fs.statSync;
fs.statSync = function (p, opts) {
    if (typeof p === 'string' && PIPE.test(p)) {
        // the pipe exists while its server listens: a sync connect is not possible, so trust the name
        return { isSocket: () => true, isFile: () => false, isDirectory: () => false, isFIFO: () => true, size: 0, mode: 0 };
    }
    return statSync.call(this, p, opts);
};
void net;
