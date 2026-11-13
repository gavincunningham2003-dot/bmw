'use strict';
/**
 * ambient_config_notice.js - where the two files beside this one come from, and the licence they carry.
 *
 *   ambient_config_scenes.js   = apps/ambient_config/scenes.js   UNCHANGED (byte for byte)
 *   ambient_config_lin.js      = apps/ambient_config/lin.js      UNCHANGED (byte for byte)
 *
 * of the MGU App Kit, https://github.com/cauliflowermossgrape/idrive7-apps, at the commit below. Only the file
 * names differ (the kit's build copies an app's .js files flat, so they carry a prefix here). They are never
 * edited in this repository: tests/node/test_v051.js checks the SHA-256 of each against the values below, so a
 * change shows as a failing test. To take a newer version: copy the files again and update COMMIT and FILES.
 *
 * This file travels in every package next to them, so the copyright notice and the permission notice below are
 * "included in all copies", as the licence asks. THIRD_PARTY.md says which other parts of the app follow that
 * project's lights.js and control.js.
 *
 * ---------------------------------------------------------------------------------------------------------
 * MIT License
 *
 * Copyright (c) 2026 cauliflowermossgrape
 * Copyright (c) 2026 小白151 (GitHub: JackieZ123430), Chinese translation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * ---------------------------------------------------------------------------------------------------------
 */
const SOURCE = 'https://github.com/cauliflowermossgrape/idrive7-apps';
const COMMIT = '89de8c0444294ec8a5020b2f870952660de2819d';      // read 2026-11-13
const LICENCE = 'MIT';
const FILES = Object.freeze({
    'ambient_config_scenes.js': { from: 'apps/ambient_config/scenes.js', sha256: '53885f89440c6787d2e38dd8b754340d332394556a9bbc32f24a4592a263b47f', gitBlob: '0af98a685746d48958729f00d80f8ef2c90925fc' },
    'ambient_config_lin.js': { from: 'apps/ambient_config/lin.js', sha256: 'bacd3963ab536e38a858c86e40156e0ddfe4ad9ed77a64c7ccbf5f0f8397d9de', gitBlob: '61edea250bcca6d77d4c28a86d8ac2c65775fc51' },
});

module.exports = { SOURCE, COMMIT, LICENCE, FILES };
