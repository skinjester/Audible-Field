/**
 * Falling Blocks — mouse & controller bindings (edit here, not the sim).
 *
 * Mouse (default):
 *   move           → aim emitter (world / screen space)
 *   LMB hold       → emit at full RT pressure (wide end of the curve)
 *   RMB hold       → emit at the lightest RT pressure (narrow end)
 *   MMB drag       → yaw the playfield surface (grid); emitter stays put
 *   wheel          → zoom
 *
 * Triangle still mirrors that curve, so the two buttons swap ends with it.
 * Gamepad / keys stay configurable below; the engine only consumes
 * FallingInput.sample() each frame.
 */

/** @typedef {"pressure" | "max" | "single"} BrushMode */

/**
 * Mutable binding table — change on the fly:
 *   import { fallingBindings } from "./falling-input.js";
 *   fallingBindings.mouse.emitFullButton = 0;
 */
export const fallingBindings = {
  mouse: {
    /** 0 = left, 1 = middle, 2 = right */
    /** Deep-squeeze end of the RT pressure curve. */
    emitFullButton: 0,
    /** Lightest-press end of the same curve. */
    emitLightButton: 2,
    orbitButton: 1,
    /** Pointer move always aims the emitter (unless orbiting). */
    moveAimsEmitter: true,
    wheelZooms: true,
    /** MMB drag: radians of surface yaw per pixel (grid rotates under emitter). */
    orbitRadiansPerPx: 0.005,
    wheelZoomExp: 0.0012,
  },
  keyboard: {
    /** KeyboardEvent.code — hold to emit. Empty string disables. */
    emit: "KeyX",
    emitBrush: /** @type {BrushMode} */ ("max"),
  },
  gamepad: {
    /** Standard mapping indices. */
    emitDigitalButton: 0, // Cross / A / X
    emitAnalogButton: 7, // RT
    emitAnalogThreshold: 0.08,
    emitDigitalBrush: /** @type {BrushMode} */ ("max"),
    clearButton: 1, // Circle
    invertCurveButton: 3, // Triangle
    cyclePrevButton: 4, // L1
    cycleNextButton: 5, // R1
    stickDeadzone: 0.12,
    /** Right-stick X → surface yaw rate (rad/s at full deflection). */
    orbitStickRate: 1.15,
    /** Right-stick Y → zoom exp rate. */
    zoomStickRate: 1.15,
  },
};

/**
 * @typedef {{
 *   pointer: { x: number, y: number } | null,
 *   emit: boolean,
 *   brushMode: BrushMode,
 *   analog: number,
 *   orbitDelta: number,
 *   zoomFactor: number,
 *   aimStickX: number,
 *   aimStickY: number,
 *   clearEdge: boolean,
 *   invertEdge: boolean,
 *   cycleDelta: number,
 * }} FallingInputFrame
 */

export class FallingInput {
  /**
   * @param {typeof fallingBindings} [bindings]
   */
  constructor(bindings = fallingBindings) {
    this.bindings = bindings;
    /** @type {HTMLElement | null} */
    this._canvas = null;
    this._mouseFull = false;
    this._mouseLight = false;
    this._orbiting = false;
    this._keyEmit = false;
    this._orbitAccum = 0;
    this._zoomAccum = 1;
    /** @type {{ x: number, y: number } | null} */
    this._pointer = null;
    /** True only for frames where the pointer actually moved (or clicked). */
    this._pointerFresh = false;
    this._prevClear = false;
    this._prevInvert = false;
    this._prevCyclePrev = false;
    this._prevCycleNext = false;

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
  }

  /**
   * @param {HTMLElement} canvas
   */
  attach(canvas) {
    this.detach();
    this._canvas = canvas;
    canvas.addEventListener("pointermove", this._onPointerMove);
    canvas.addEventListener("pointerdown", this._onPointerDown);
    canvas.addEventListener("pointerup", this._onPointerUp);
    canvas.addEventListener("pointercancel", this._onPointerCancel);
    canvas.addEventListener("wheel", this._onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this._onContextMenu);
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
  }

  detach() {
    const canvas = this._canvas;
    if (canvas) {
      canvas.removeEventListener("pointermove", this._onPointerMove);
      canvas.removeEventListener("pointerdown", this._onPointerDown);
      canvas.removeEventListener("pointerup", this._onPointerUp);
      canvas.removeEventListener("pointercancel", this._onPointerCancel);
      canvas.removeEventListener("wheel", this._onWheel);
      canvas.removeEventListener("contextmenu", this._onContextMenu);
    }
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    this._canvas = null;
    this.resetTransient();
  }

  resetTransient() {
    this._mouseFull = false;
    this._mouseLight = false;
    this._orbiting = false;
    this._keyEmit = false;
    this._orbitAccum = 0;
    this._zoomAccum = 1;
    this._pointer = null;
    this._pointerFresh = false;
    this._prevClear = false;
    this._prevInvert = false;
    this._prevCyclePrev = false;
    this._prevCycleNext = false;
  }

  /**
   * Sample mouse + mixer/gamepad into one frame for the sim.
   * @param {number} dt
   * @param {import("./mixer-core.js").controller extends object ? any : any} mixer
   * @param {Gamepad | null} pad
   * @returns {FallingInputFrame}
   */
  sample(dt, mixer, pad) {
    const g = this.bindings.gamepad;
    const k = this.bindings.keyboard;

    const buttons = pad?.buttons || [];
    const pressed = (i) =>
      !!(buttons[i] && (buttons[i].pressed || buttons[i].value > 0.5));

    const dead = g.stickDeadzone;
    const axis = (v) => {
      const n = Number(v) || 0;
      return Math.abs(n) < dead ? 0 : n;
    };
    /** Prefer the stronger of mixer (Max/UI) vs live Gamepad API axes. */
    const mergeAxis = (fromMixer, fromPad) =>
      Math.abs(fromMixer) >= Math.abs(fromPad) ? fromMixer : fromPad;

    // Standard mapping: 0/1 left stick, 2/3 right; Y inverted like Max / gamepad-input.
    const ax = pad?.axes || [];
    const padLx = axis(Number(ax[0]) || 0);
    const padLy = axis(-(Number(ax[1]) || 0));
    const padRx = axis(Number(ax[2]) || 0);
    const padRy = axis(-(Number(ax[3]) || 0));

    const lx = mergeAxis(axis(mixer?.rawX), padLx);
    const ly = mergeAxis(axis(mixer?.rawY), padLy);
    const dpad = dpadAxes(mixer?.dpad, {
      up: pressed(12),
      down: pressed(13),
      left: pressed(14),
      right: pressed(15),
    });
    const aimStickX = clamp(lx + dpad.lx, -1, 1);
    const aimStickY = clamp(ly + dpad.ly, -1, 1);

    const rx = mergeAxis(axis(mixer?.rightX), padRx);
    const ry = mergeAxis(axis(mixer?.rightY), padRy);
    let orbitDelta = this._orbitAccum;
    let zoomFactor = this._zoomAccum;
    this._orbitAccum = 0;
    this._zoomAccum = 1;

    if (dt > 0) {
      if (rx) orbitDelta += -rx * g.orbitStickRate * dt;
      if (ry) zoomFactor *= Math.exp(-ry * g.zoomStickRate * dt);
    }

    const analogPad = readAnalogTrigger(mixer, pad, g.emitAnalogButton);
    const digitalPad = pressed(g.emitDigitalButton);
    const mouseFull = this._mouseFull;
    const mouseLight = this._mouseLight;
    const mouseEmit = mouseFull || mouseLight;
    const keyEmit = this._keyEmit;

    // Mouse has no pressure axis. Pin it to an end of the same RT curve
    // Triangle mirrors, so full and light swap when the curve is inverted.
    const analog = mouseEmit
      ? mouseFull
        ? 1
        : g.emitAnalogThreshold
      : analogPad;

    const analogActive = analogPad >= g.emitAnalogThreshold;
    const emit = mouseEmit || keyEmit || digitalPad || analogActive;

    /** @type {BrushMode} */
    let brushMode = "pressure";
    if (!mouseEmit && keyEmit) brushMode = k.emitBrush;
    else if (!mouseEmit && digitalPad && !analogActive) brushMode = g.emitDigitalBrush;

    const clearDown = pressed(g.clearButton);
    const invertDown = pressed(g.invertCurveButton);
    const cyclePrev = !!(mixer?.l1 || pressed(g.cyclePrevButton));
    const cycleNext = !!(mixer?.r1 || pressed(g.cycleNextButton));

    const clearEdge = clearDown && !this._prevClear;
    const invertEdge = invertDown && !this._prevInvert;
    let cycleDelta = 0;
    if (cyclePrev && !this._prevCyclePrev) cycleDelta -= 1;
    if (cycleNext && !this._prevCycleNext) cycleDelta += 1;

    this._prevClear = clearDown;
    this._prevInvert = invertDown;
    this._prevCyclePrev = cyclePrev;
    this._prevCycleNext = cycleNext;

    const pointer = this._pointerFresh ? this._pointer : null;
    this._pointerFresh = false;

    return {
      pointer,
      emit,
      brushMode,
      analog,
      orbitDelta,
      zoomFactor,
      aimStickX,
      aimStickY,
      clearEdge,
      invertEdge,
      cycleDelta,
    };
  }

  _onPointerMove(event) {
    const m = this.bindings.mouse;
    if (this._orbiting) {
      this._orbitAccum += -event.movementX * m.orbitRadiansPerPx;
      return;
    }
    if (m.moveAimsEmitter) {
      this._pointer = { x: event.clientX, y: event.clientY };
      this._pointerFresh = true;
    }
  }

  _onPointerDown(event) {
    const m = this.bindings.mouse;
    const canvas = this._canvas;
    if (event.button === m.orbitButton) {
      this._orbiting = true;
      event.preventDefault();
      canvas?.setPointerCapture?.(event.pointerId);
      return;
    }
    if (event.button === m.emitFullButton || event.button === m.emitLightButton) {
      if (event.button === m.emitFullButton) this._mouseFull = true;
      if (event.button === m.emitLightButton) this._mouseLight = true;
      this._pointer = { x: event.clientX, y: event.clientY };
      this._pointerFresh = true;
      event.preventDefault();
      canvas?.setPointerCapture?.(event.pointerId);
    }
  }

  _onPointerUp(event) {
    const m = this.bindings.mouse;
    if (event.button === m.orbitButton) {
      this._orbiting = false;
      return;
    }
    if (event.button === m.emitFullButton) this._mouseFull = false;
    if (event.button === m.emitLightButton) this._mouseLight = false;
  }

  _onPointerCancel() {
    this._orbiting = false;
    this._mouseFull = false;
    this._mouseLight = false;
  }

  _onWheel(event) {
    if (!this.bindings.mouse.wheelZooms) return;
    event.preventDefault();
    this._zoomAccum *= Math.exp(event.deltaY * this.bindings.mouse.wheelZoomExp);
  }

  _onContextMenu(event) {
    event.preventDefault();
  }

  _onKeyDown(event) {
    const code = this.bindings.keyboard.emit;
    if (!code || event.code !== code || event.repeat) return;
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/i.test(event.target.tagName)) {
      return;
    }
    this._keyEmit = true;
    event.preventDefault();
  }

  _onKeyUp(event) {
    const code = this.bindings.keyboard.emit;
    if (!code || event.code !== code) return;
    this._keyEmit = false;
  }
}

export const fallingInput = new FallingInput();

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function dpadAxes(mixerDpad, padDpad) {
  let lx = 0;
  let ly = 0;
  const up = !!(mixerDpad?.up || padDpad?.up);
  const down = !!(mixerDpad?.down || padDpad?.down);
  const left = !!(mixerDpad?.left || padDpad?.left);
  const right = !!(mixerDpad?.right || padDpad?.right);
  if (left) lx -= 1;
  if (right) lx += 1;
  if (up) ly += 1;
  if (down) ly -= 1;
  if (lx && ly) {
    lx *= Math.SQRT1_2;
    ly *= Math.SQRT1_2;
  }
  return { lx, ly };
}

function readAnalogTrigger(mixer, pad, buttonIndex) {
  const fromCore = clamp01(Number(mixer?.rt) || 0);
  const btn = pad?.buttons?.[buttonIndex];
  const fromPad = btn
    ? Number.isFinite(btn.value)
      ? clamp01(btn.value)
      : btn.pressed
        ? 1
        : 0
    : 0;
  return Math.max(fromCore, fromPad);
}
