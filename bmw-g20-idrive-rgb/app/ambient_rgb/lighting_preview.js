'use strict';
/**
 * lighting_preview.js - the Modes page's moving picture of a mode: which colour every module would show at each
 * moment, for the cabin view (ui_widgets.carView) to draw. A simulation on the screen and nothing else.
 *
 * It needs lighting_scene.js only (pure) and knows no controller, scheduler or transport: nothing here can write
 * to the car, and previewing costs the car no request. The picture is exact rather than drawn by hand, because
 * lighting_scene.render() is the same function the controller's frames come from: the colours, the direction, the
 * speed and the transitions are those of the mode itself (Ambient Config's scenes.js).
 *
 *   const pv = new ModePreview();
 *   pv.scene(program, modules, now, live) -> { 'bus:nad': { r, g, b, brightness } }
 *       program   the Modes page's draft as a program
 *       live      { program, phase0 } when something is applied (the controller's): a draft that IS the applied
 *                 program is shown from the controller's time origin, so the picture moves in step with the cabin
 *   pv.running    is the last scene the applied program's (in step)?
 *   pv.stop()     the page is no longer shown: the clock is dropped, so the next showing starts from the beginning
 *
 * The clock restarts whenever the program changes (another mode, speed or colour), so a change is seen at once and
 * from its start. A one-time effect (Welcome Sweep, Sport Pulse) plays, rests on what it ends on, and plays again.
 * There is no timer here: a scene is made when the page asks for one, so nothing runs while the page is not drawn.
 */
const S = require('./lighting_scene');

const REST_MS = 1200;                                   // a one-time effect rests this long on its end before replaying

class ModePreview {
    constructor() { this.sig = null; this.t0 = 0; this.running = false; }
    stop() { this.sig = null; this.t0 = 0; this.running = false; }
    scene(program, modules, now, live) {
        const p = S.normalise(program), sig = JSON.stringify(p);
        if (sig !== this.sig) { this.sig = sig; this.t0 = now; }
        this.running = !!(live && live.program && JSON.stringify(S.normalise(live.program)) === sig);
        if (this.running) return S.render(p, modules, now, { phase0: live.phase0 || 0 });
        const once = S.onceMs(p);
        const t = once ? Math.min((now - this.t0) % (once + REST_MS), once) : now - this.t0;
        return S.render(p, modules, t, { phase0: 0 });
    }
}

module.exports = { ModePreview, REST_MS };
