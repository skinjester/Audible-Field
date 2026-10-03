/**
 * Falling Blocks input sampler. Bindings live in input-bindings.js.
 * The sim only consumes FallingInput.sample() each frame.
 */

import { dualsenseHid } from "./dualsense-hid.js?v=5";
import { gamepadAxes, gamepadButtons, inputBindings } from "./input-bindings.js?v=15";
import { TouchInput } from "./touch-input.js?v=4";

/** How long Emit must be held still before atoms pour. Matches --emit-hold. */
const EMIT_HOLD_MS = 280;
/** Movement that counts as still dragging, so the hold waits until the finger rests. */
const EMIT_REST_PX = 6;

/** @typedef {import("./input-bindings.js").BrushMode} BrushMode */

/**
 * @typedef {{
 *   pointerDelta: { x: number, y: number } | null,
 *   pointerAt: { x: number, y: number } | null,
 *   aimAt: { x: number, y: number } | null,
 *   emit: boolean,
 *   emitSizing: boolean,
 *   touchPour: boolean,
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
 *   touchPan: { from: { x: number, y: number }, to: { x: number, y: number } } | null,
 *   touchActive: boolean,
 *   touchZoom: number,
 *   yawing: boolean,
 *   zoomFactor: number,
 *   aimStickX: number,
 *   aimStickY: number,
 *   clearEdge: boolean,
 *   clearHeld: boolean,
 *   audioEdge: boolean,
 *   cycleDelta: number,
 *   cyclePrevHeld: boolean,
 *   cycleNextHeld: boolean,
 *   ltHeld: boolean,
 *   rtHeld: boolean,
 *   shiftHeld: boolean,
 *   touchAim: boolean,
 *   fingerAim: boolean,
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
    /** Long-press has committed. Further drags keep pouring and size the plane. */
    this._touchEmit = false;
    this._emitHeldDown = false;
    this._emitHoldTimer = 0;
    this._emitFillGen = 0;
    this._emitPointerId = -1;
    this._emitDragging = false;
    this._emitSizeLatched = false;
    this._emitAnalog = 0.5;
    this._emitOriginY = 0;
    this._emitDownY = 0;
    this._emitSettleY = 0;
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
    /** "idle" until a device is used, then "pointer" or "pad". */
    this._device = "idle";
    this._pointerActivity = false;
    this._padWasUsing = false;
    this._showPadGlyphs = false;
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
    this._onBlockBrowserGesture = this._onBlockBrowserGesture.bind(this);
    this._onEmitPointerDown = this._onEmitPointerDown.bind(this);
    this._onEmitPointerMove = this._onEmitPointerMove.bind(this);
    this._onEmitPointerUp = this._onEmitPointerUp.bind(this);
    this._onEmitContextMenu = this._onEmitContextMenu.bind(this);
    this._onPointerDevice = this._onPointerDevice.bind(this);
    this._onWheelDevice = this._onWheelDevice.bind(this);
  }

  /** True while PlayStation glyphs should be on screen. */
  get showPadGlyphs() {
    return this._showPadGlyphs;
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
    canvas.addEventListener("touchstart", this._onBlockBrowserGesture, { passive: false });
    canvas.addEventListener("touchmove", this._onBlockBrowserGesture, { passive: false });
    canvas.addEventListener("wheel", this._onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this._onContextMenu);
    canvas.addEventListener("auxclick", this._onAuxClick);
    window.addEventListener("keydown", this._onKeyDown, true);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("pointermove", this._onWindowPointerMove);
    window.addEventListener("blur", this._onPointerGone);
    document.documentElement.addEventListener("pointerleave", this._onPointerGone);
    document.documentElement.classList.add("is-field-play");
    const stage = canvas.parentElement;
    this._gestureStage = stage;
    const guard = { capture: true, passive: false };
    document.addEventListener("touchstart", this._onBlockBrowserGesture, guard);
    document.addEventListener("touchmove", this._onBlockBrowserGesture, guard);
    document.addEventListener("gesturestart", this._onBlockBrowserGesture, guard);
    document.addEventListener("gesturechange", this._onBlockBrowserGesture, guard);
    document.addEventListener("pointerdown", this._onPointerDevice, true);
    document.addEventListener("pointermove", this._onPointerDevice, true);
    document.addEventListener("wheel", this._onWheelDevice, { capture: true, passive: true });
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
      canvas.removeEventListener("touchstart", this._onBlockBrowserGesture);
      canvas.removeEventListener("touchmove", this._onBlockBrowserGesture);
      canvas.removeEventListener("wheel", this._onWheel);
      canvas.removeEventListener("contextmenu", this._onContextMenu);
      canvas.removeEventListener("auxclick", this._onAuxClick);
    }
    window.removeEventListener("keydown", this._onKeyDown, true);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("pointermove", this._onWindowPointerMove);
    window.removeEventListener("blur", this._onPointerGone);
    document.documentElement.removeEventListener("pointerleave", this._onPointerGone);
    document.documentElement.classList.remove("is-field-play");
    const guard = { capture: true };
    document.removeEventListener("touchstart", this._onBlockBrowserGesture, guard);
    document.removeEventListener("touchmove", this._onBlockBrowserGesture, guard);
    document.removeEventListener("gesturestart", this._onBlockBrowserGesture, guard);
    document.removeEventListener("gesturechange", this._onBlockBrowserGesture, guard);
    this._gestureStage = null;
    document.removeEventListener("pointerdown", this._onPointerDevice, true);
    document.removeEventListener("pointermove", this._onPointerDevice, true);
    document.removeEventListener("wheel", this._onWheelDevice, { capture: true });
    this._unbindEmitButton();
    dualsenseHid.routeTouchToMixer = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this._canvas = null;
    this.resetTransient();
  }

  resetTransient() {
    this._emitHeld = false;
    this._touchEmit = false;
    this._clearEmitHold();
    this._emitHeldDown = false;
    this._emitDragging = false;
    this._emitSizeLatched = false;
    this._emitAnalog = 0.5;
    this._emitButton?.classList.remove("is-pressed", "is-held", "is-charging", "is-filling");
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
    this._device = "idle";
    this._pointerActivity = false;
    this._padWasUsing = false;
    this._showPadGlyphs = false;
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
      analog = this._emitAnalog;
      curveInvert = false;
    }
    const emitSizing =
      (this._emitDragging || this._emitSizeLatched) &&
      !this._touchEmit &&
      !mouseEmit &&
      !keyEmit &&
      !rtActive &&
      !ltActive;
    if (emitSizing) {
      analog = this._emitAnalog;
      curveInvert = false;
    }

    const analogActive = rtActive || ltActive;
    const emit = mouseEmit || keyEmit || digitalPad || touch.emit || analogActive || this._touchEmit;

    /** @type {BrushMode} */
    let brushMode = "pressure";
    if (mouseLight) brushMode = "single";
    else if (mouseFull) brushMode = "max";
    else if (this._touchEmit) brushMode = "pressure";
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
    this._syncGlyphDevice(pad);

    const touchDelta = this._consumeTouchDelta();
    const dx = this._moveX + touchDelta.x;
    const dy = this._moveY + touchDelta.y;
    this._moveX = 0;
    this._moveY = 0;

    return {
      pointerDelta: dx || dy ? { x: dx, y: dy } : null,
      pointerAt: this._pointerAt,
      aimAt: screen.active ? null : this._aimAt,
      emit,
      emitSizing,
      touchPour: this._touchEmit,
      brushMode,
      analog,
      curveInvert,
      ltSingle,
      orbitDelta,
      touchTwist: screen.twist,
      touchPan: screen.pan,
      touchActive: screen.active,
      touchZoom: screen.zoomFactor,
      yawing: this._yawing() || rx !== 0,
      zoomFactor,
      aimStickX,
      aimStickY,
      clearEdge,
      clearHeld: clearDown,
      audioEdge,
      cycleDelta,
      cyclePrevHeld: cyclePrev,
      cycleNextHeld: cycleNext,
      ltHeld: ltActive,
      rtHeld: rtActive,
      shiftHeld: this._shiftHeld,
      touchAim: !!touch.aim,
      fingerAim: false,
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

  /**
   * Mouse, trackpad, and touchscreen take the glyphs down. A later controller
   * gesture, after the pad has rested, brings them back.
   * @param {PointerEvent} event
   */
  _onPointerDevice(event) {
    const type = event.pointerType;
    if (type !== "mouse" && type !== "pen" && type !== "touch") return;
    if (event.type === "pointermove" && type !== "touch" && !event.movementX && !event.movementY) return;
    this._pointerActivity = true;
  }

  _onWheelDevice() {
    this._pointerActivity = true;
  }

  /**
   * Glyphs come on with a PlayStation gesture and stay until a mouse, trackpad,
   * or touchscreen takes over. A pad that is only connected never turns them on.
   * @param {Gamepad | null} pad
   */
  _syncGlyphDevice(pad) {
    const using = playstationDriving(pad, this.bindings.gamepad.stickDeadzone);
    if (this._pointerActivity) {
      this._device = "pointer";
      this._pointerActivity = false;
    } else if (using && !this._padWasUsing) {
      this._device = "pad";
    }
    this._padWasUsing = using;
    this._showPadGlyphs = this._device === "pad";
  }

  /**
   * A field drag fires pointerleave on <html> when that finger lifts, and the
   * browser does it again when it steals the gesture. Neither one is the thumb
   * coming up. Blur still releases Emit.
   * @param {Event} [event]
   */
  _onPointerGone(event) {
    if (event?.type === "pointerleave" && this._emitHeldDown) {
      const pointerId = /** @type {PointerEvent} */ (event).pointerId;
      if (pointerId !== this._emitPointerId) this._screenTouch.pointerUp(/** @type {PointerEvent} */ (event));
      return;
    }
    this._pointerAt = null;
    this._aimAt = null;
    this._pointer = null;
    this._pointerFresh = false;
    this._moveX = 0;
    this._moveY = 0;
    this._lastClient = null;
    this._touchPrev = null;
    this._endEmitGesture();
    this._screenTouch.reset();
  }

  /**
   * Back-swipe, pinch-zoom, and pull-to-refresh cancel every contact they claim,
   * including a thumb that is still on Emit. touch-action cannot express "these
   * two fingers are one gesture," so the playfield claims the touches itself.
   * @param {Event} event
   */
  _onBlockBrowserGesture(event) {
    if (!event.cancelable) return;
    if (this._emitHeldDown) {
      event.preventDefault();
      return;
    }
    const stage = this._gestureStage;
    const target = event.target;
    if (stage && target instanceof Node && stage.contains(target)) event.preventDefault();
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
    btn.style.setProperty("--emit-hold", `${EMIT_HOLD_MS}ms`);
    btn.addEventListener("pointerdown", this._onEmitPointerDown);
    btn.addEventListener("touchstart", this._onBlockBrowserGesture, { passive: false });
    btn.addEventListener("touchmove", this._onBlockBrowserGesture, { passive: false });
    btn.addEventListener("contextmenu", this._onEmitContextMenu);
  }

  _trackEmitPointer(on) {
    const method = on ? "addEventListener" : "removeEventListener";
    window[method]("pointermove", this._onEmitPointerMove);
    window[method]("pointerup", this._onEmitPointerUp);
    window[method]("pointercancel", this._onEmitPointerUp);
  }

  _unbindEmitButton() {
    const btn = this._emitButton;
    if (!btn) return;
    btn.removeEventListener("pointerdown", this._onEmitPointerDown);
    btn.removeEventListener("touchstart", this._onBlockBrowserGesture);
    btn.removeEventListener("touchmove", this._onBlockBrowserGesture);
    btn.removeEventListener("contextmenu", this._onEmitContextMenu);
    this._trackEmitPointer(false);
    this._clearEmitHold();
    this._emitFillGen += 1;
    this._emitPointerId = -1;
    this._emitSettleY = 0;
    btn.classList.remove("is-pressed", "is-held", "is-charging", "is-filling");
    btn.setAttribute("aria-pressed", "false");
    this._emitAnalog = 0.5;
    const face = btn.querySelector(".falling-emit-face");
    if (face) face.style.transform = "";
    const fill = btn.querySelector(".falling-emit-fill");
    if (fill) fill.style.transition = "";
    btn.removeAttribute("data-drag");
    const dock = btn.parentElement;
    dock?.querySelector(".falling-emit-clump")?.classList.remove("is-lit");
    dock?.querySelector(".falling-emit-single")?.classList.remove("is-lit");
    dock?.querySelector(".falling-emit-stem")?.style.removeProperty("--emit-notch");
    this._emitButton = null;
  }

  _clearEmitHold() {
    if (!this._emitHoldTimer) return;
    clearTimeout(this._emitHoldTimer);
    this._emitHoldTimer = 0;
  }

  /** Circle grows while the finger rests. Motion before the pour restarts that wait. */
  _armEmitHold() {
    this._clearEmitHold();
    this._emitHoldTimer = window.setTimeout(() => {
      this._emitHoldTimer = 0;
      if (!this._emitHeldDown) return;
      this._touchEmit = true;
      this._emitButton?.setAttribute("aria-pressed", "true");
    }, EMIT_HOLD_MS);
  }

  /** Snap the fill shut and grow it again for a fresh hold. */
  _kickEmitCharge() {
    const btn = this._emitButton;
    if (!btn || !this._emitHeldDown || this._touchEmit) return;
    const fill = btn.querySelector(".falling-emit-fill");
    if (fill) fill.style.transition = "none";
    btn.classList.remove("is-charging");
    if (fill) void fill.offsetWidth;
    if (fill) fill.style.transition = "";
    this._showEmitFill();
    this._armEmitHold();
  }

  _showEmitFill() {
    this._emitFillGen += 1;
    this._emitButton?.classList.add("is-charging", "is-filling");
  }

  /** Drop the charge. The circle scales back, then the ink class leaves. */
  _hideEmitFill() {
    const btn = this._emitButton;
    btn?.classList.remove("is-charging");
    const gen = ++this._emitFillGen;
    window.setTimeout(() => {
      if (gen !== this._emitFillGen) return;
      btn?.classList.remove("is-filling");
    }, 160);
  }

  _endEmitGesture() {
    this._trackEmitPointer(false);
    this._clearEmitHold();
    this._touchEmit = false;
    this._emitHeldDown = false;
    this._emitDragging = false;
    this._emitPointerId = -1;
    this._emitSettleY = 0;
    const fill = this._emitButton?.querySelector(".falling-emit-fill");
    if (fill) fill.style.transition = "";
    this._emitButton?.classList.remove("is-pressed", "is-held");
    this._emitButton?.setAttribute("aria-pressed", "false");
    this._hideEmitFill();
    this._paintEmitDrag();
  }

  /**
   * @param {PointerEvent} event
   */
  _onEmitPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (this._emitHeldDown) {
      // A navigation gesture may have dropped the first contact. This press is the thumb again.
      this._emitPointerId = event.pointerId;
      this._trackEmitPointer(true);
      this._emitButton?.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    this._touchEmit = false;
    this._emitHeldDown = true;
    this._emitDragging = false;
    this._emitPointerId = event.pointerId;
    this._emitDownY = event.clientY;
    this._emitSettleY = event.clientY;
    const span = 72;
    this._emitOriginY = event.clientY - (0.5 - this._emitAnalog) * span;
    this._emitButton?.classList.add("is-pressed", "is-held");
    this._kickEmitCharge();
    this._paintEmitDrag();
    event.preventDefault();
    event.stopPropagation();
    this._trackEmitPointer(true);
    this._emitButton?.setPointerCapture?.(event.pointerId);
  }

  /**
   * Drag up toward a clump, down toward a single stream.
   * @param {PointerEvent} event
   */
  _onEmitPointerMove(event) {
    if (!this._emitHeldDown || event.pointerId !== this._emitPointerId) return;
    if (!this._emitDragging && Math.abs(event.clientY - this._emitDownY) <= 10) return;
    if (!this._emitDragging) {
      this._emitDragging = true;
      this._emitSizeLatched = true;
    }
    const span = 72;
    this._emitAnalog = clamp(0.5 - (event.clientY - this._emitOriginY) / span, 0, 1);
    this._paintEmitDrag();
    if (this._touchEmit) return;
    if (Math.abs(event.clientY - this._emitSettleY) < EMIT_REST_PX) return;
    this._emitSettleY = event.clientY;
    this._kickEmitCharge();
  }

  /** Keep the button at the size it was dragged to. */
  _paintEmitDrag() {
    const btn = this._emitButton;
    if (!btn) return;
    const dock = btn.parentElement;
    const shift = (0.5 - this._emitAnalog) * 28;
    const face = btn.querySelector(".falling-emit-face");
    if (face) face.style.transform = `translateY(${shift}px)`;
    const dir = this._emitAnalog > 0.62 ? "up" : this._emitAnalog < 0.38 ? "down" : "mid";
    btn.dataset.drag = dir;
    dock?.querySelector(".falling-emit-clump")?.classList.toggle("is-lit", dir === "up");
    dock?.querySelector(".falling-emit-single")?.classList.toggle("is-lit", dir === "down");
    dock?.querySelector(".falling-emit-stem")?.style.setProperty(
      "--emit-notch",
      `${(1 - this._emitAnalog) * 100}%`,
    );
  }

  _onEmitPointerUp(event) {
    // pointercancel means the browser took the gesture, not that the thumb lifted.
    if (event?.type === "pointercancel") return;
    if (event?.pointerId != null && event.pointerId !== this._emitPointerId) return;
    this._endEmitGesture();
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

/**
 * Sticks, buttons, triggers, or a finger on the DualSense touch surface.
 * @param {Gamepad | null | undefined} pad
 * @param {number} dead
 */
function playstationDriving(pad, dead) {
  if (!isPlayStationPad(pad)) return false;
  const axes = pad.axes || [];
  for (let i = 0; i < axes.length; i += 1) {
    if (Math.abs(Number(axes[i]) || 0) >= dead) return true;
  }
  const buttons = pad.buttons || [];
  for (let i = 0; i < buttons.length; i += 1) {
    const button = buttons[i];
    if (button && (button.pressed || button.value > 0.15)) return true;
  }
  return !!(dualsenseHid.enabled && dualsenseHid.connected && dualsenseHid.touch?.active);
}
