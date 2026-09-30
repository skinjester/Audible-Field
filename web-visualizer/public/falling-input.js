/**
 * Falling Blocks input sampler. Bindings live in input-bindings.js.
 * The sim only consumes FallingInput.sample() each frame.
 */

import { dualsenseHid } from "./dualsense-hid.js?v=5";
import { gamepadAxes, gamepadButtons, inputBindings } from "./input-bindings.js?v=15";
import { TouchInput } from "./touch-input.js?v=2";

/** @typedef {import("./input-bindings.js").BrushMode} BrushMode */

/**
 * @typedef {{
 *   pointerDelta: { x: number, y: number } | null,
 *   pointerAt: { x: number, y: number } | null,
 *   aimAt: { x: number, y: number } | null,
 *   emit: boolean,
 *   brushMode: BrushMode,
 *   analog: number,
 *   curveInvert: boolean,
 *   orbitDelta: number,
 *   touchTwist: {
 *     a0: { x: number, y: number },
 *     b0: { x: number, y: number },
 *     a1: { x: number, y: number },
 *     b1: { x: number, y: number },
 *   } | null,
 *   yawing: boolean,
 *   zoomFactor: number,
 *   aimStickX: number,
 *   aimStickY: number,
 *   clearEdge: boolean,
 *   audioEdge: boolean,
 *   cycleDelta: number,
 *   cyclePrevHeld: boolean,
 *   cycleNextHeld: boolean,
 *   ltHeld: boolean,
 *   rtHeld: boolean,
 *   shiftHeld: boolean,
 *   touchAim: boolean,
 * }} FallingInputFrame
 */

export class FallingInput {
  /**
   * @param {typeof inputBindings} [bindings]
   */
  constructor(bindings = inputBindings) {
    this.bindings = bindings;
    this._screenTouch = new TouchInput(bindings.touch);
    /** @type {HTMLElement | null} */
    this._canvas = null;
    /** @type {HTMLButtonElement | null} */
    this._emitButton = null;
    this._emitHeld = false;
    /** On-screen Emit control. Separate from the mouse button so a finger drag cannot pour. */
    this._touchEmit = false;
    this._shiftHeld = false;
    this._altHeld = false;
    this._mouseFull = false;
    this._mouseLight = false;
    this._rightHeld = false;
    this._yawHeld = false;
    this._keyEmit = false;
    this._orbitAccum = 0;
    this._zoomAccum = 1;
    /** @type {{ x: number, y: number } | null} */
    this._pointer = null;
    /** True only for frames where the pointer actually moved (or clicked). */
    this._pointerFresh = false;
    /** Last pointer, kept while it rests so a pinned cursor can keep panning. */
    /** @type {{ x: number, y: number } | null} */
    this._pointerAt = null;
    /** Canvas pointer while it is just hovering, so the emitter can follow it. */
    /** @type {{ x: number, y: number } | null} */
    this._aimAt = null;
    this._moveX = 0;
    this._moveY = 0;
    /** @type {{ x: number, y: number } | null} */
    this._lastClient = null;
    /** @type {{ x: number, y: number } | null} */
    this._touchPrev = null;
    this._prevClear = false;
    this._prevAudio = false;
    this._prevCyclePrev = false;
    this._prevCycleNext = false;
    /** Presses of Tab / Shift+Tab since the last sample. */
    this._keyCycle = 0;
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerOut = this._onPointerOut.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._onAuxClick = this._onAuxClick.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onWindowPointerMove = this._onWindowPointerMove.bind(this);
    this._onPointerGone = this._onPointerGone.bind(this);
    this._onEmitPointerDown = this._onEmitPointerDown.bind(this);
    this._onEmitPointerUp = this._onEmitPointerUp.bind(this);
    this._onEmitContextMenu = this._onEmitContextMenu.bind(this);
  }

  /**
   * @param {HTMLElement} canvas
   */
  attach(canvas) {
    this.detach();
    if (document.pointerLockElement) document.exitPointerLock();
    this._canvas = canvas;
    dualsenseHid.routeTouchToMixer = false;
    canvas.addEventListener("pointermove", this._onPointerMove);
    canvas.addEventListener("pointerout", this._onPointerOut);
    canvas.addEventListener("pointerdown", this._onPointerDown);
    canvas.addEventListener("pointerup", this._onPointerUp);
    canvas.addEventListener("pointercancel", this._onPointerCancel);
    canvas.addEventListener("wheel", this._onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this._onContextMenu);
    canvas.addEventListener("auxclick", this._onAuxClick);
    window.addEventListener("keydown", this._onKeyDown, true);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("pointermove", this._onWindowPointerMove);
    window.addEventListener("blur", this._onPointerGone);
    document.documentElement.addEventListener("pointerleave", this._onPointerGone);
    this._bindEmitButton();
  }

  detach() {
    const canvas = this._canvas;
    if (canvas) {
      canvas.classList.remove("is-grabbing", "is-yawing");
      canvas.removeEventListener("pointermove", this._onPointerMove);
      canvas.removeEventListener("pointerout", this._onPointerOut);
      canvas.removeEventListener("pointerdown", this._onPointerDown);
      canvas.removeEventListener("pointerup", this._onPointerUp);
      canvas.removeEventListener("pointercancel", this._onPointerCancel);
      canvas.removeEventListener("wheel", this._onWheel);
      canvas.removeEventListener("contextmenu", this._onContextMenu);
      canvas.removeEventListener("auxclick", this._onAuxClick);
    }
    window.removeEventListener("keydown", this._onKeyDown, true);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("pointermove", this._onWindowPointerMove);
    window.removeEventListener("blur", this._onPointerGone);
    document.documentElement.removeEventListener("pointerleave", this._onPointerGone);
    this._unbindEmitButton();
    dualsenseHid.routeTouchToMixer = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this._canvas = null;
    this.resetTransient();
  }

  resetTransient() {
    this._emitHeld = false;
    this._touchEmit = false;
    this._emitButton?.classList.remove("is-pressed");
    this._emitButton?.setAttribute("aria-pressed", "false");
    this._screenTouch.reset();
    this._shiftHeld = false;
    this._altHeld = false;
    this._mouseFull = false;
    this._mouseLight = false;
    this._rightHeld = false;
    this._yawHeld = false;
    this._keyEmit = false;
    this._orbitAccum = 0;
    this._zoomAccum = 1;
    this._pointer = null;
    this._pointerFresh = false;
    this._pointerAt = null;
    this._aimAt = null;
    this._moveX = 0;
    this._moveY = 0;
    this._lastClient = null;
    this._touchPrev = null;
    this._prevClear = false;
    this._prevAudio = false;
    this._prevCyclePrev = false;
    this._prevCycleNext = false;
    this._keyCycle = 0;
  }

  /**
   * Sample mouse, touch, and mixer/gamepad into one frame for the sim.
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
    /** Prefer the stronger of mixer UI vs live Gamepad API axes. */
    const mergeAxis = (fromMixer, fromPad) =>
      Math.abs(fromMixer) >= Math.abs(fromPad) ? fromMixer : fromPad;

    // Standard mapping: 0/1 left stick, 2/3 right; Y inverted like gamepad-input.
    const ax = pad?.axes || [];
    const padLx = axis(Number(ax[gamepadAxes.leftX]) || 0);
    const padLy = axis(-(Number(ax[gamepadAxes.leftY]) || 0));
    const padRx = axis(Number(ax[gamepadAxes.rightX]) || 0);
    const padRy = axis(-(Number(ax[gamepadAxes.rightY]) || 0));

    const lx = mergeAxis(axis(mixer?.rawX), padLx);
    const ly = mergeAxis(axis(mixer?.rawY), padLy);
    const dpad = dpadAxes(mixer?.dpad, {
      up: pressed(gamepadButtons.dpadUp),
      down: pressed(gamepadButtons.dpadDown),
      left: pressed(gamepadButtons.dpadLeft),
      right: pressed(gamepadButtons.dpadRight),
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

    const screen = this._screenTouch.consume();
    if (screen.zoomFactor !== 1) zoomFactor *= screen.zoomFactor;

    const rt = readAnalogTrigger(mixer?.rt, pad, gamepadButtons.rt);
    const lt = readAnalogTrigger(mixer?.lt, pad, gamepadButtons.lt);
    const digitalPad = pressed(gamepadButtons[g.emitDigital]);
    const touch = readTouchpad(pad, pressed);
    const mouseFull = this._mouseFull;
    const mouseLight = this._mouseLight;
    const mouseEmit = mouseFull || mouseLight;
    const keyEmit = this._keyEmit;

    // RT opens from a single stream to the wide field as the pull deepens.
    // LT is a single stream at any pull past the threshold. The trigger
    // pulled further wins. LMB is always the largest emitter.
    // Shift+LMB is always the smallest. A touchpad click emits a clump.
    // A finger on the pad only aims.
    const rtActive = rt >= g.emitAnalogThreshold;
    const ltActive = lt >= g.emitAnalogThreshold;
    let analog = 0;
    let curveInvert = false;
    let ltSingle = false;
    if (rtActive || ltActive) {
      if (!ltActive || rt >= lt) {
        analog = rt;
        curveInvert = false;
      } else {
        analog = lt;
        curveInvert = true;
        ltSingle = true;
      }
    }
    if (mouseEmit) {
      analog = mouseFull ? 1 : g.emitAnalogThreshold;
      curveInvert = false;
    }
    if (this._touchEmit) {
      analog = 1;
      curveInvert = false;
    }

    const analogActive = rtActive || ltActive;
    const emit = mouseEmit || keyEmit || digitalPad || touch.emit || analogActive || this._touchEmit;

    /** @type {BrushMode} */
    let brushMode = "pressure";
    if (mouseLight) brushMode = "single";
    else if (mouseFull || this._touchEmit) brushMode = "max";
    else if (keyEmit) brushMode = k.emitBrush;
    else if ((digitalPad || touch.emit) && !analogActive) brushMode = g.emitDigitalBrush;

    const clearDown = pressed(gamepadButtons[g.clear]);
    const audioDown = pressed(gamepadButtons[g.audioToggle]);
    const cyclePrev = !!(mixer?.l1 || pressed(gamepadButtons[g.cyclePrev]));
    const cycleNext = !!(mixer?.r1 || pressed(gamepadButtons[g.cycleNext]));

    const clearEdge = clearDown && !this._prevClear;
    const audioEdge = audioDown && !this._prevAudio;
    let cycleDelta = this._keyCycle;
    this._keyCycle = 0;
    if (cyclePrev && !this._prevCyclePrev) cycleDelta -= 1;
    if (cycleNext && !this._prevCycleNext) cycleDelta += 1;

    this._prevClear = clearDown;
    this._prevAudio = audioDown;
    this._prevCyclePrev = cyclePrev;
    this._prevCycleNext = cycleNext;

    const touchDelta = this._consumeTouchDelta();
    const dx = this._moveX + touchDelta.x;
    const dy = this._moveY + touchDelta.y;
    this._moveX = 0;
    this._moveY = 0;

    return {
      pointerDelta: dx || dy ? { x: dx, y: dy } : null,
      pointerAt: this._pointerAt,
      aimAt: screen.active ? screen.aimAt : this._aimAt,
      emit,
      brushMode,
      analog,
      curveInvert,
      ltSingle,
      orbitDelta,
      touchTwist: screen.twist,
      yawing: this._yawing() || rx !== 0,
      zoomFactor,
      aimStickX,
      aimStickY,
      clearEdge,
      audioEdge,
      cycleDelta,
      cyclePrevHeld: cyclePrev,
      cycleNextHeld: cycleNext,
      ltHeld: ltActive,
      rtHeld: rtActive,
      shiftHeld: this._shiftHeld,
      touchAim: !!touch.aim,
    };
  }

  /**
   * Finger motion on the touchpad, in canvas pixels. A new contact does not jump.
   * @returns {{ x: number, y: number }}
   */
  _consumeTouchDelta() {
    const touch = dualsenseHid.touch;
    const canvas = this._canvas;
    if (!touch?.active || !canvas) {
      this._touchPrev = null;
      return { x: 0, y: 0 };
    }
    const rect = canvas.getBoundingClientRect();
    const prev = this._touchPrev;
    this._touchPrev = { x: touch.x, y: touch.y };
    if (!prev || rect.width < 1 || rect.height < 1) return { x: 0, y: 0 };
    return {
      x: (touch.x - prev.x) * rect.width,
      y: (touch.y - prev.y) * rect.height,
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

  _onPointerGone() {
    this._pointerAt = null;
    this._aimAt = null;
    this._pointer = null;
    this._pointerFresh = false;
    this._moveX = 0;
    this._moveY = 0;
    this._lastClient = null;
    this._touchPrev = null;
    this._touchEmit = false;
    this._emitButton?.classList.remove("is-pressed");
    this._emitButton?.setAttribute("aria-pressed", "false");
    this._screenTouch.reset();
  }

  /**
   * A move on the view places the emitter. Right-drag slides the grid.
   * Middle-drag, Shift+right-drag, and Alt+right-drag rotate.
   */
  _onWindowPointerMove(event) {
    if (event.pointerType === "touch") return;
    this._noteModifiers(event);
    this._lastClient = { x: event.clientX, y: event.clientY };
    this._pointerAt = { x: event.clientX, y: event.clientY };
  }

  _onPointerOut(event) {
    if (event?.pointerType === "touch") return;
    if (this._rightHeld || this._yawHeld) return;
    this._aimAt = null;
  }

  _yawing() {
    const mods = this.bindings.mouse.yawModifiers || [];
    const modified = this._rightHeld && mods.some((name) => this._modifierHeld(name));
    return this._yawHeld || modified;
  }

  /**
   * @param {string} name
   */
  _modifierHeld(name) {
    if (name === "shift") return this._shiftHeld;
    if (name === "alt") return this._altHeld;
    return false;
  }

  /** Shift previews the single-stream mark even when the keydown landed before focus. */
  _noteModifiers(event) {
    if (event.pointerType === "touch") return;
    const shiftChanged = event.shiftKey !== this._shiftHeld;
    const altChanged = event.altKey !== this._altHeld;
    if (!shiftChanged && !altChanged) return;
    this._shiftHeld = event.shiftKey;
    this._altHeld = event.altKey;
    if (shiftChanged) this._syncMouseEmit();
    if (this._rightHeld || this._yawHeld) this._setDragCursor(this._yawing() ? "yaw" : "pan");
  }

  _onPointerMove(event) {
    if (event.pointerType === "touch") {
      this._screenTouch.pointerMove(event);
      event.preventDefault();
      return;
    }
    const m = this.bindings.mouse;
    this._noteModifiers(event);
    if (this._yawing()) {
      this._aimAt = null;
      this._setDragCursor("yaw");
      this._orbitAccum += -event.movementX * m.orbitRadiansPerPx;
      return;
    }
    if (this._rightHeld) {
      this._aimAt = null;
      this._setDragCursor("pan");
      this._moveX += event.movementX || 0;
      this._moveY += event.movementY || 0;
      return;
    }
    this._aimAt = { x: event.clientX, y: event.clientY };
  }

  /**
   * @param {"pan" | "yaw" | null} mode
   */
  _setDragCursor(mode) {
    const canvas = this._canvas;
    if (!canvas) return;
    canvas.classList.toggle("is-grabbing", mode === "pan");
    canvas.classList.toggle("is-yawing", mode === "yaw");
  }

  _onPointerDown(event) {
    if (event.pointerType === "touch") {
      this._screenTouch.pointerDown(event);
      event.preventDefault();
      this._canvas?.setPointerCapture?.(event.pointerId);
      return;
    }
    const m = this.bindings.mouse;
    const canvas = this._canvas;
    if (event.button === m.yawButton) {
      this._yawHeld = true;
      this._aimAt = null;
      this._setDragCursor("yaw");
      event.preventDefault();
      canvas?.setPointerCapture?.(event.pointerId);
      return;
    }
    if (event.button === m.orbitButton) {
      this._rightHeld = true;
      this._shiftHeld = event.shiftKey;
      this._altHeld = event.altKey;
      this._setDragCursor(this._yawing() ? "yaw" : "pan");
      event.preventDefault();
      canvas?.setPointerCapture?.(event.pointerId);
      return;
    }
    if (event.button === m.emitButton) {
      this._emitHeld = true;
      this._shiftHeld = event.shiftKey;
      this._altHeld = event.altKey;
      this._syncMouseEmit();
      this._pointer = { x: event.clientX, y: event.clientY };
      this._pointerFresh = true;
      event.preventDefault();
      canvas?.setPointerCapture?.(event.pointerId);
    }
  }

  _onPointerUp(event) {
    if (event.pointerType === "touch") {
      this._screenTouch.pointerUp(event);
      event.preventDefault();
      return;
    }
    const m = this.bindings.mouse;
    if (event.button === m.yawButton) {
      this._yawHeld = false;
      this._setDragCursor(this._yawing() ? "yaw" : this._rightHeld ? "pan" : null);
      return;
    }
    if (event.button === m.orbitButton) {
      this._rightHeld = false;
      this._setDragCursor(this._yawHeld ? "yaw" : null);
      return;
    }
    if (event.button === m.emitButton) {
      this._emitHeld = false;
      this._syncMouseEmit();
    }
  }

  _onPointerCancel(event) {
    if (event?.pointerType === "touch") {
      this._screenTouch.pointerUp(event);
      return;
    }
    this._rightHeld = false;
    this._yawHeld = false;
    this._setDragCursor(null);
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

  _onAuxClick(event) {
    if (event.button === this.bindings.mouse.yawButton) event.preventDefault();
  }

  _onKeyDown(event) {
    if (event.key === "Shift") {
      this._shiftHeld = true;
      this._syncMouseEmit();
      if (this._rightHeld || this._yawHeld) this._setDragCursor(this._yawing() ? "yaw" : "pan");
    }
    if (event.key === "Alt") {
      this._altHeld = true;
      if (this._rightHeld || this._yawHeld) this._setDragCursor(this._yawing() ? "yaw" : "pan");
      if (!isEditableTarget(event.target)) event.preventDefault();
    }
    const k = this.bindings.keyboard;
    // Tab only selects materials. It never moves focus, including in fields and dialogs.
    if (k.cycleNext && event.code === k.cycleNext) {
      if (!event.repeat) this._keyCycle += event.shiftKey ? -1 : 1;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    if (event.target && /^(INPUT|TEXTAREA|SELECT)$/i.test(event.target.tagName)) {
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
      if (this._rightHeld || this._yawHeld) this._setDragCursor(this._yawing() ? "yaw" : "pan");
    }
    if (event.key === "Alt") {
      this._altHeld = false;
      if (this._rightHeld || this._yawHeld) this._setDragCursor(this._yawing() ? "yaw" : "pan");
      if (!isEditableTarget(event.target)) event.preventDefault();
    }
    const k = this.bindings.keyboard;
    if (!k.emit || event.code !== k.emit) return;
    this._keyEmit = false;
  }

  _bindEmitButton() {
    const btn = this._canvas?.parentElement?.querySelector("[data-falling-touch-emit]");
    if (!(btn instanceof HTMLButtonElement)) return;
    this._emitButton = btn;
    btn.addEventListener("pointerdown", this._onEmitPointerDown);
    btn.addEventListener("pointerup", this._onEmitPointerUp);
    btn.addEventListener("pointercancel", this._onEmitPointerUp);
    btn.addEventListener("contextmenu", this._onEmitContextMenu);
  }

  _unbindEmitButton() {
    const btn = this._emitButton;
    if (!btn) return;
    btn.removeEventListener("pointerdown", this._onEmitPointerDown);
    btn.removeEventListener("pointerup", this._onEmitPointerUp);
    btn.removeEventListener("pointercancel", this._onEmitPointerUp);
    btn.removeEventListener("contextmenu", this._onEmitContextMenu);
    btn.classList.remove("is-pressed");
    btn.setAttribute("aria-pressed", "false");
    this._emitButton = null;
  }

  /**
   * @param {PointerEvent} event
   */
  _onEmitPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    this._touchEmit = true;
    this._emitButton?.classList.add("is-pressed");
    this._emitButton?.setAttribute("aria-pressed", "true");
    event.preventDefault();
    event.stopPropagation();
    this._emitButton?.setPointerCapture?.(event.pointerId);
  }

  /**
   * @param {PointerEvent} event
   */
  _onEmitPointerUp() {
    this._touchEmit = false;
    this._emitButton?.classList.remove("is-pressed");
    this._emitButton?.setAttribute("aria-pressed", "false");
  }

  /**
   * @param {Event} event
   */
  _onEmitContextMenu(event) {
    event.preventDefault();
  }
}

export const fallingInput = new FallingInput();

function isEditableTarget(target) {
  return !!(target && /^(INPUT|TEXTAREA|SELECT)$/i.test(target.tagName));
}

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

function readAnalogTrigger(mixerValue, pad, buttonIndex) {
  const fromCore = clamp01(Number(mixerValue) || 0);
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
 * A finger aims the emitter. The mechanical click emits a clump at that aim.
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
  return { aim, emit: click };
}

function isPlayStationPad(pad) {
  return /dualsense|dualshock|wireless controller|playstation/i.test(pad?.id || "");
}
