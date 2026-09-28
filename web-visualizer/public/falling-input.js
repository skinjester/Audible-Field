/**
 * Falling Blocks input sampler. Bindings live in input-bindings.js.
 * The sim only consumes FallingInput.sample() each frame.
 */

import { dualsenseHid } from "./dualsense-hid.js?v=5";
import { gamepadAxes, gamepadButtons, inputBindings } from "./input-bindings.js?v=5";

/** @typedef {import("./input-bindings.js").BrushMode} BrushMode */

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
 *   audioEdge: boolean,
 *   invertEdge: boolean,
 *   cycleDelta: number,
 *   cyclePrevHeld: boolean,
 *   cycleNextHeld: boolean,
 *   heightDelta: number,
 *   touchAim: boolean,
 * }} FallingInputFrame
 */

export class FallingInput {
  /**
   * @param {typeof inputBindings} [bindings]
   */
  constructor(bindings = inputBindings) {
    this.bindings = bindings;
    /** @type {HTMLElement | null} */
    this._canvas = null;
    this._emitHeld = false;
    this._shiftHeld = false;
    this._mouseFull = false;
    this._mouseLight = false;
    this._orbiting = false;
    this._keyEmit = false;
    this._keyHeightUp = false;
    this._keyHeightDown = false;
    this._orbitAccum = 0;
    this._zoomAccum = 1;
    /** @type {{ x: number, y: number } | null} */
    this._pointer = null;
    /** True only for frames where the pointer actually moved (or clicked). */
    this._pointerFresh = false;
    this._prevClear = false;
    this._prevAudio = false;
    this._prevInvert = false;
    this._prevCyclePrev = false;
    this._prevCycleNext = false;
    this._prevDpadUp = false;
    this._prevDpadDown = false;
    /** Signed height direction currently held (-1, 0, +1). */
    this._heightDir = 0;
    this._heightHold = 0;
    this._heightRepeating = false;

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
    dualsenseHid.routeTouchToMixer = false;
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
    dualsenseHid.routeTouchToMixer = true;
    this._canvas = null;
    this.resetTransient();
  }

  resetTransient() {
    this._emitHeld = false;
    this._shiftHeld = false;
    this._mouseFull = false;
    this._mouseLight = false;
    this._orbiting = false;
    this._keyEmit = false;
    this._keyHeightUp = false;
    this._keyHeightDown = false;
    this._orbitAccum = 0;
    this._zoomAccum = 1;
    this._pointer = null;
    this._pointerFresh = false;
    this._prevClear = false;
    this._prevAudio = false;
    this._prevInvert = false;
    this._prevCyclePrev = false;
    this._prevCycleNext = false;
    this._prevDpadUp = false;
    this._prevDpadDown = false;
    this._heightDir = 0;
    this._heightHold = 0;
    this._heightRepeating = false;
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
    const padLx = axis(Number(ax[gamepadAxes.leftX]) || 0);
    const padLy = axis(-(Number(ax[gamepadAxes.leftY]) || 0));
    const padRx = axis(Number(ax[gamepadAxes.rightX]) || 0);
    const padRy = axis(-(Number(ax[gamepadAxes.rightY]) || 0));

    const lx = mergeAxis(axis(mixer?.rawX), padLx);
    const ly = mergeAxis(axis(mixer?.rawY), padLy);
    const dpadUp = !!(mixer?.dpad?.up || pressed(gamepadButtons.dpadUp));
    const dpadDown = !!(mixer?.dpad?.down || pressed(gamepadButtons.dpadDown));
    const dpad = dpadAxes(null, {
      up: false,
      down: false,
      left: !!(mixer?.dpad?.left || pressed(gamepadButtons.dpadLeft)),
      right: !!(mixer?.dpad?.right || pressed(gamepadButtons.dpadRight)),
    });
    const aimStickX = clamp(lx + dpad.lx, -1, 1);
    const aimStickY = clamp(ly + dpad.ly, -1, 1);
    const heightDelta = this._sampleHeightDelta(
      dt,
      dpadUp || this._keyHeightUp,
      dpadDown || this._keyHeightDown,
    );

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

    const analogPad = readAnalogTrigger(mixer, pad, gamepadButtons[g.emitAnalog]);
    const digitalPad = pressed(gamepadButtons[g.emitDigital]);
    const touch = readTouchpad(pad, pressed);
    const mouseFull = this._mouseFull;
    const mouseLight = this._mouseLight;
    const mouseEmit = mouseFull || mouseLight;
    const keyEmit = this._keyEmit;

    // LMB is always the largest emitter. Shift+LMB is always the smallest.
    // Neither follows the RT curve (including when that curve is inverted).
    // A finger or click on the touchpad is the same kind of digital hold.
    const analog = mouseEmit ? (mouseFull ? 1 : g.emitAnalogThreshold) : analogPad;

    const analogActive = analogPad >= g.emitAnalogThreshold;
    const emit = mouseEmit || keyEmit || digitalPad || touch.emit || analogActive;

    /** @type {BrushMode} */
    let brushMode = "pressure";
    if (mouseLight) brushMode = "single";
    else if (mouseFull) brushMode = "max";
    else if (keyEmit) brushMode = k.emitBrush;
    else if ((digitalPad || touch.emit) && !analogActive) brushMode = g.emitDigitalBrush;

    const clearDown = pressed(gamepadButtons[g.clear]);
    const audioDown = pressed(gamepadButtons[g.audioToggle]);
    const invertDown = pressed(gamepadButtons[g.invertCurve]);
    const cyclePrev = !!(mixer?.l1 || pressed(gamepadButtons[g.cyclePrev]));
    const cycleNext = !!(mixer?.r1 || pressed(gamepadButtons[g.cycleNext]));

    const clearEdge = clearDown && !this._prevClear;
    const audioEdge = audioDown && !this._prevAudio;
    const invertEdge = invertDown && !this._prevInvert;
    let cycleDelta = 0;
    if (cyclePrev && !this._prevCyclePrev) cycleDelta -= 1;
    if (cycleNext && !this._prevCycleNext) cycleDelta += 1;

    this._prevClear = clearDown;
    this._prevAudio = audioDown;
    this._prevInvert = invertDown;
    this._prevCyclePrev = cyclePrev;
    this._prevCycleNext = cycleNext;

    let pointer = this._pointerFresh ? this._pointer : null;
    this._pointerFresh = false;
    const touchPointer = touch.aim ? this._touchPointer() : null;
    if (touchPointer) pointer = touchPointer;

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
      audioEdge,
      invertEdge,
      cycleDelta,
      cyclePrevHeld: cyclePrev,
      cycleNextHeld: cycleNext,
      heightDelta,
      touchAim: !!touchPointer,
    };
  }

  /**
   * D-pad up/down → emitter height steps. A tap moves one row; a hold
   * waits, then repeats. Up and down together cancel.
   * @param {number} dt
   * @param {boolean} up
   * @param {boolean} down
   */
  _sampleHeightDelta(dt, up, down) {
    const dir = up && !down ? 1 : down && !up ? -1 : 0;
    const edge =
      (up && !this._prevDpadUp) || (down && !this._prevDpadDown);
    this._prevDpadUp = up;
    this._prevDpadDown = down;

    let heightDelta = 0;
    if (!dir) {
      this._heightDir = 0;
      this._heightHold = 0;
      this._heightRepeating = false;
      return 0;
    }

    if (edge || this._heightDir !== dir) {
      this._heightDir = dir;
      this._heightHold = 0;
      this._heightRepeating = false;
      return dir;
    }

    this._heightDir = dir;
    this._heightHold += dt;
    const initial = this.bindings.gamepad.heightInitialDelay;
    const repeat = this.bindings.gamepad.heightRepeat;
    if (!this._heightRepeating) {
      if (this._heightHold < initial) return 0;
      this._heightRepeating = true;
      this._heightHold -= initial;
      heightDelta += dir;
    }
    if (repeat > 0) {
      const steps = Math.floor(this._heightHold / repeat);
      if (steps > 0) {
        this._heightHold -= steps * repeat;
        heightDelta += dir * steps;
      }
    }
    return heightDelta;
  }

  /**
   * Map the finger onto the canvas so the existing plane raycast aims the emitter.
   * @returns {{ x: number, y: number } | null}
   */
  _touchPointer() {
    const canvas = this._canvas;
    const touch = dualsenseHid.touch;
    if (!canvas || !touch?.active) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      x: rect.left + touch.x * rect.width,
      y: rect.top + touch.y * rect.height,
    };
  }

  _syncMouseEmit() {
    const single =
      this._emitHeld &&
      this._shiftHeld &&
      this.bindings.mouse.emitSingleModifier === "shift";
    this._mouseFull = this._emitHeld && !single;
    this._mouseLight = single;
  }

  _onPointerMove(event) {
    const m = this.bindings.mouse;
    if (this._emitHeld && event.shiftKey !== this._shiftHeld) {
      this._shiftHeld = event.shiftKey;
      this._syncMouseEmit();
    }
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
    if (event.button === m.emitButton) {
      this._emitHeld = true;
      this._shiftHeld = event.shiftKey;
      this._syncMouseEmit();
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
    if (event.button === m.emitButton) {
      this._emitHeld = false;
      this._syncMouseEmit();
    }
  }

  _onPointerCancel() {
    this._orbiting = false;
    this._emitHeld = false;
    this._syncMouseEmit();
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
    if (event.key === "Shift") {
      this._shiftHeld = true;
      this._syncMouseEmit();
    }
    if (document.querySelector("dialog[open]")) return;
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/i.test(event.target.tagName)) {
      return;
    }
    const k = this.bindings.keyboard;
    if (event.code === k.heightUp) {
      this._keyHeightUp = true;
      event.preventDefault();
      return;
    }
    if (event.code === k.heightDown) {
      this._keyHeightDown = true;
      event.preventDefault();
      return;
    }
    if (!k.emit || event.code !== k.emit || event.repeat) return;
    this._keyEmit = true;
    event.preventDefault();
  }

  _onKeyUp(event) {
    if (event.key === "Shift") {
      this._shiftHeld = false;
      this._syncMouseEmit();
    }
    const k = this.bindings.keyboard;
    if (event.code === k.heightUp) {
      this._keyHeightUp = false;
      return;
    }
    if (event.code === k.heightDown) {
      this._keyHeightDown = false;
      return;
    }
    if (!k.emit || event.code !== k.emit) return;
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

/**
 * Finger contact aims and emits. A click emits even if the contact point
 * didn't parse, so a held press keeps pouring at the current aim.
 * @param {Gamepad | null} pad
 * @param {(index: number) => boolean} pressed
 */
function readTouchpad(pad, pressed) {
  const touch = dualsenseHid.touch;
  const hidReady = !!(dualsenseHid.enabled && dualsenseHid.connected);
  const aim = !!(hidReady && touch?.active);
  const click =
    !!(hidReady && touch?.pressed) ||
    (isPlayStationPad(pad) && pressed(gamepadButtons.touchpad));
  return { aim, emit: aim || click };
}

function isPlayStationPad(pad) {
  return /dualsense|dualshock|wireless controller|playstation/i.test(pad?.id || "");
}
