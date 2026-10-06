/**
 * Falling Blocks input sampler. Bindings live in input-bindings.js.
 * The sim only consumes FallingInput.sample() each frame.
 */

import { dualsenseHid } from "./dualsense-hid.js?v=5";
import { gamepadAxes, gamepadButtons, inputBindings } from "./input-bindings.js?v=18";
import { TouchInput } from "./touch-input.js?v=4";

/** How long Emit must be held still before atoms pour. Matches --emit-hold. */
const EMIT_HOLD_MS = 280;
/** Movement that counts as still dragging, so the hold waits until the finger rests. */
const EMIT_REST_PX = 6;
/** Finger travel across the whole emitter size, from a single stream to a clump. */
const EMIT_DRAG_SPAN = 36;
/** Motion that starts a size change, so a tap can still pour at the current size. */
const EMIT_DRAG_START = 6;
/** How far the button face slides across the same range. The thumb stays on the control. */
const EMIT_DRAG_SLIDE = 12;
/**
 * After pointercancel or lost capture, wait for a touch that still lists the
 * Emit finger. Silence means the lift never arrived, so the hold ends.
 */
const EMIT_POINTER_DOUBT_MS = 700;
/**
 * Quiet after the last wheel tick. A turn does not start while a zoom
 * is still inside this window.
 */
const WHEEL_GESTURE_MS = 180;
/**
 * One detent, or less, landing as the middle button goes down is the
 * wheel clicking through. A larger burst is a zoom and keeps the view.
 */
const WHEEL_ACCIDENT_NOTCHES = 1.25;
/** How close that stray detent has to be to the middle-button press. */
const WHEEL_ACCIDENT_MS = 50;
/**
 * Miniature of the playfield camera: 60° down, so the ring is the ground
 * plane seen from the same height. The far side is the top of the ellipse.
 */
const YAW_PLANE_PITCH = Math.PI / 3;
const YAW_CX = 36;
const YAW_CY = 36;
const YAW_RING_R = 26;
const YAW_FAR = -Math.PI / 2;
/** Horizontal drag. 96 pixels is a quarter turn. */
const YAW_DRAG_RAD_PER_PX = Math.PI / 2 / 96;
/**
 * Vertical drag on the sphere. Slower than the wheel so the ball can keep
 * changing size for the whole zoom the grid still allows.
 */
const YAW_ZOOM_PER_PX = 0.0016;
/** Pixels of travel before the drag commits to turn or zoom. */
const YAW_AXIS_SLOP = 6;
/** Closest zoom. This size is the ceiling. */
const YAW_ZOOM_SCALE_IN = 0.14;
/** Farthest zoom. A little smaller than the zoom-in nudge. */
const YAW_ZOOM_SCALE_OUT = 0.26;
const YAW_ZOOM_NEUTRAL = 30;

/**
 * Wheel distance in detents. Pixel mode is about 100 units per notch.
 * @param {number} deltaY
 * @param {number} deltaMode
 */
function wheelNotches(deltaY, deltaMode) {
  const dy = deltaY || 0;
  if (deltaMode === 1) return dy;
  if (deltaMode === 2) return dy * 20;
  return dy / 100;
}

/**
 * MouseEvent.buttons is not `1 << button`. Middle is 4, right is 2.
 * @param {number | undefined} buttons
 * @param {number} button
 */
function pointerButtonDown(buttons, button) {
  if (typeof buttons !== "number") return false;
  let mask = 1 << button;
  if (button === 1) mask = 4;
  else if (button === 2) mask = 2;
  return (buttons & mask) !== 0;
}

/**
 * A point on the horizontal ring. θ = 0 is screen-right, and positive θ
 * moves through the near side (the bottom of the ellipse).
 * @param {number} theta
 * @param {number} [radius]
 */
function ringPoint(theta, radius = YAW_RING_R) {
  return {
    x: YAW_CX + radius * Math.cos(theta),
    y: YAW_CY + radius * Math.sin(YAW_PLANE_PITCH) * Math.sin(theta),
  };
}

/**
 * The lower half of the ellipse is in front of the sphere.
 * @param {number} theta
 */
function isRingFront(theta) {
  const turn = Math.PI * 2;
  const wrapped = ((theta % turn) + turn) % turn;
  return wrapped <= Math.PI;
}

/**
 * One open run of the ring, used for the faint track.
 * @param {number} theta0
 * @param {number} theta1
 */
function ringOpen(theta0, theta1) {
  const steps = 28;
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = theta0 + (theta1 - theta0) * (i / steps);
    const p = ringPoint(t);
    pts.push(`${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
  }
  return `M ${pts.join(" L ")}`;
}

/**
 * Sweep split where it passes behind the sphere.
 * @param {number} theta0
 * @param {number} theta1
 */
function ringSweep(theta0, theta1) {
  const span = theta1 - theta0;
  const steps = Math.max(2, Math.ceil(Math.abs(span) / (Math.PI / 32)));
  /** @type {string[][]} */
  const front = [];
  /** @type {string[][]} */
  const back = [];
  /** @type {{ front: boolean, pts: string[] } | null} */
  let run = null;
  /**
   * @param {boolean} frontSide
   * @param {number} theta
   */
  const add = (frontSide, theta) => {
    const p = ringPoint(theta);
    const cmd = `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    if (!run || run.front !== frontSide) {
      run = { front: frontSide, pts: [] };
      (frontSide ? front : back).push(run.pts);
    }
    run.pts.push(cmd);
  };
  /** @type {boolean | null} */
  let prevFront = null;
  for (let i = 0; i <= steps; i += 1) {
    const t = theta0 + span * (i / steps);
    const frontSide = isRingFront(t);
    if (prevFront !== null && prevFront !== frontSide) {
      add(prevFront, t);
      run = null;
    }
    add(frontSide, t);
    prevFront = frontSide;
  }
  const path = (parts) => parts
    .filter((pts) => pts.length >= 2)
    .map((pts) => `M ${pts.join(" L ")}`)
    .join(" ");
  return { front: path(front), back: path(back) };
}

/**
 * Short outward tick on the ring.
 * @param {SVGLineElement | null} line
 * @param {number} theta
 */
function setRingTick(line, theta) {
  if (!line) return;
  const inner = ringPoint(theta, YAW_RING_R - 0.5);
  const outer = ringPoint(theta, YAW_RING_R + 4.5);
  line.setAttribute("x1", inner.x.toFixed(2));
  line.setAttribute("y1", inner.y.toFixed(2));
  line.setAttribute("x2", outer.x.toFixed(2));
  line.setAttribute("y2", outer.y.toFixed(2));
}

/**
 * @param {SVGLineElement | null} line
 */
function hideRingTick(line) {
  if (!line) return;
  line.setAttribute("x1", "0");
  line.setAttribute("y1", "0");
  line.setAttribute("x2", "0");
  line.setAttribute("y2", "0");
}

/**
 * Pull a stick toward the nearer axis without changing its length.
 * `bias` 1 leaves it linear. Above 1, a mostly-horizontal push keeps
 * its yaw and sheds zoom, and a mostly-vertical push does the reverse.
 * A 45° push is unchanged, so both actions still combine.
 * @param {number} x
 * @param {number} y
 * @param {number} bias
 * @returns {{ x: number, y: number }}
 */
function biasCardinalStick(x, y, bias) {
  const len = Math.hypot(x, y);
  if (!(len > 1e-6) || !(bias > 1)) return { x, y };
  const px = Math.pow(Math.abs(x) / len, bias);
  const py = Math.pow(Math.abs(y) / len, bias);
  const plen = Math.hypot(px, py) || 1;
  return {
    x: Math.sign(x) * (px / plen) * len,
    y: Math.sign(y) * (py / plen) * len,
  };
}

/**
 * Sphere size from the live camera distance. It keeps changing until the
 * grid's near limit or the far limit, and it rests at 1 on the default view.
 * @param {number} dist
 * @param {number} min
 * @param {number} max
 */
function sphereZoomScale(dist, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const d = Math.min(hi, Math.max(lo, dist));
  const neutral = Math.min(hi, Math.max(lo, YAW_ZOOM_NEUTRAL));
  if (d <= neutral) {
    const span = Math.log(neutral) - Math.log(lo);
    const t = span > 1e-6 ? (Math.log(neutral) - Math.log(d)) / span : 0;
    return 1 + t * YAW_ZOOM_SCALE_IN;
  }
  const span = Math.log(hi) - Math.log(neutral);
  const t = span > 1e-6 ? (Math.log(d) - Math.log(neutral)) / span : 0;
  return 1 - t * YAW_ZOOM_SCALE_OUT;
}

/**
 * Signed travel of the heading mark from the far side of the ring, in −2π…2π.
 * Positive is clockwise (a right drag). Negative walks back the other way,
 * so a left drag fills only that segment instead of the long way around.
 * @param {number} yaw
 */
function headingSweep(yaw) {
  const turn = Math.PI * 2;
  let sweep = (-yaw) % turn;
  if (Math.abs(sweep) < 0.02) return 0;
  if (sweep > 0 && turn - sweep < 0.02) return 0;
  if (sweep < 0 && turn + sweep < 0.02) return 0;
  return sweep;
}

const YAW_SPHERE_R = 14;
const YAW_SPHERE_LATS = [-60, -30, 0, 30, 60].map((deg) => deg * Math.PI / 180);
const YAW_SPHERE_LONS = [15, 45, 75, 105, 135, 165].map((deg) => deg * Math.PI / 180);

/**
 * Hidden-line wireframe, turned with the playfield. Positive surface yaw
 * walks the near side to the right, matching a left drag on the ring.
 * @param {number} yaw
 */
function sphereWirePath(yaw) {
  const sP = Math.sin(YAW_PLANE_PITCH);
  const cP = Math.cos(YAW_PLANE_PITCH);
  const cY = Math.cos(-yaw);
  const sY = Math.sin(-yaw);
  const steps = 40;
  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  const project = (x, y, z) => {
    const xr = x * cY - z * sY;
    const zr = x * sY + z * cY;
    return {
      x: YAW_CX + YAW_SPHERE_R * xr,
      y: YAW_CY + YAW_SPHERE_R * (sP * zr - cP * y),
      on: y * sP + zr * cP > 0.06,
    };
  };
  /** @type {string[]} */
  const runs = [];
  /**
   * @param {Array<{ x: number, y: number, on: boolean }>} samples
   */
  const chain = (samples) => {
    /** @type {string[] | null} */
    let run = null;
    for (const sample of samples) {
      if (!sample.on) {
        run = null;
        continue;
      }
      if (!run) {
        run = [];
        runs.push("");
      }
      run.push(`${sample.x.toFixed(2)} ${sample.y.toFixed(2)}`);
      runs[runs.length - 1] = run.length >= 5 ? `M ${run.join(" L ")}` : "";
    }
  };
  for (const lat of YAW_SPHERE_LATS) {
    const y = Math.sin(lat);
    const c = Math.cos(lat);
    /** @type {Array<{ x: number, y: number, on: boolean }>} */
    const samples = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = Math.PI * 2 * (i / steps);
      samples.push(project(c * Math.cos(t), y, c * Math.sin(t)));
    }
    chain(samples);
  }
  for (const lon of YAW_SPHERE_LONS) {
    /** @type {Array<{ x: number, y: number, on: boolean }>} */
    const samples = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = Math.PI * 2 * (i / steps);
      samples.push(project(Math.sin(t) * Math.cos(lon), Math.cos(t), Math.sin(t) * Math.sin(lon)));
    }
    chain(samples);
  }
  return runs.filter(Boolean).join(" ");
}

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
 *   yawHome: boolean,
 *   viewYaw: number,
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
    /** @type {HTMLElement | null} */
    this._emitButton = null;
    this._emitHeld = false;
    /** Long-press has committed. Further drags keep pouring and size the plane. */
    this._touchEmit = false;
    this._emitHeldDown = false;
    this._emitHoldTimer = 0;
    this._emitFillGen = 0;
    this._emitPointerId = -1;
    /** Touch.identifier for the thumb. Distinct from the pointer id. */
    this._emitTouchId = null;
    /** pointercancel or lost capture, until a touch event confirms the finger. */
    this._emitPointerUncertain = false;
    this._emitDoubtTimer = 0;
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
    this._yawRingHeld = false;
    this._yawRingPointer = -1;
    /** @type {null | "yaw" | "zoom"} */
    this._yawRingMode = null;
    this._yawOriginX = 0;
    this._yawOriginY = 0;
    this._yawLastX = 0;
    this._yawLastY = 0;
    this._yawZoomDrag = 0;
    this._yawRingTotal = 0;
    /** Playfield yaw the ring is showing. */
    this._surfaceYaw = 0;
    this._yawHome = false;
    /** @type {HTMLElement | null} */
    this._yawRing = null;
    /** @type {SVGPathElement | null} */
    this._yawTrackBack = null;
    /** @type {SVGPathElement | null} */
    this._yawTrackFront = null;
    /** @type {SVGPathElement | null} */
    this._yawRingBack = null;
    /** @type {SVGPathElement | null} */
    this._yawRingFront = null;
    /** @type {SVGPathElement | null} */
    this._yawArcBack = null;
    /** @type {SVGPathElement | null} */
    this._yawArcFront = null;
    /** @type {SVGLineElement | null} */
    this._yawNowBack = null;
    /** @type {SVGLineElement | null} */
    this._yawNowFront = null;
    /** @type {SVGGElement | null} */
    this._yawSphere = null;
    /** @type {SVGPathElement | null} */
    this._yawWire = null;
    this._keyEmit = false;
    this._orbitAccum = 0;
    this._zoomAccum = 1;
    /** Wheel burst since the last quiet gap. A middle-click yields to it. */
    this._wheelNotches = 0;
    this._wheelFactor = 1;
    this._wheelGestureAt = 0;
    /** Wheel zoom shown on the sphere, in the same units as a vertical drag. */
    this._wheelZoomVisual = 0;
    this._wheelZoomVisualTimer = 0;
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
    /** Last mouse, pen, or touch that took the field. Null until one arrives. */
    this._pointerKind = null;
    this._pointerActivity = false;
    this._padWasUsing = false;
    this._padWasDriving = false;
    /** The yaw orb stays up until a gamepad is actually driven. */
    this._yawOrbHidden = false;
    /** Last hide state applied to the orb, so the pop only plays on a change. */
    this._yawOrbApplied = false;
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
    this._onEmitTouchEnd = this._onEmitTouchEnd.bind(this);
    this._onEmitTouchActive = this._onEmitTouchActive.bind(this);
    this._onEmitContextMenu = this._onEmitContextMenu.bind(this);
    this._onPointerDevice = this._onPointerDevice.bind(this);
    this._onWheelDevice = this._onWheelDevice.bind(this);
    this._onYawRingDown = this._onYawRingDown.bind(this);
    this._onYawRingMove = this._onYawRingMove.bind(this);
    this._onYawRingUp = this._onYawRingUp.bind(this);
    this._onYawRingDblClick = this._onYawRingDblClick.bind(this);
    this._onYawRingFade = this._onYawRingFade.bind(this);
    this._onYawOrbMotion = this._onYawOrbMotion.bind(this);
  }

  /** True while PlayStation glyphs should be on screen. */
  get showPadGlyphs() {
    return this._showPadGlyphs;
  }

  /**
   * About navigation tab for the device in use.
   * A controller stays selected while its glyphs are up, including the click
   * that opens About. Otherwise the latest mouse or touch wins, and a device
   * that has not been used yet follows the primary pointer.
   * @returns {"mouse" | "touch" | "pad"}
   */
  get navMode() {
    if (this._showPadGlyphs) return "pad";
    if (this._pointerKind === "touch" || this._pointerKind === "mouse") return this._pointerKind;
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches === true;
    const touch = (navigator.maxTouchPoints || 0) > 0;
    return coarse && touch ? "touch" : "mouse";
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
    this._bindYawRing();
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
    this._releaseYawRing(false);
    this._unbindYawRing();
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
    this._emitButton?.classList.remove("is-pressed", "is-held", "is-charging", "is-filling", "is-pouring");
    this._emitButton?.setAttribute("aria-pressed", "false");
    this._screenTouch.reset();
    this._shiftHeld = false;
    this._altHeld = false;
    this._mouseFull = false;
    this._mouseLight = false;
    this._rightHeld = false;
    this._yawHeld = false;
    this._yawRingHeld = false;
    this._yawRingPointer = -1;
    this._yawRingMode = null;
    this._yawZoomDrag = 0;
    this._yawRingTotal = 0;
    this._yawHome = false;
    this._keyEmit = false;
    this._orbitAccum = 0;
    this._zoomAccum = 1;
    this._wheelNotches = 0;
    this._wheelFactor = 1;
    this._wheelGestureAt = 0;
    this._releaseWheelZoomVisual();
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
    this._pointerKind = null;
    this._pointerActivity = false;
    this._padWasUsing = false;
    this._padWasDriving = false;
    this._yawOrbHidden = false;
    this._yawOrbApplied = false;
    this._showPadGlyphs = false;
    this._applyYawOrb();
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
    const rightStick = biasCardinalStick(rx, ry, g.rightStickAxialBias);
    let orbitDelta = this._orbitAccum;
    const yawHome = this._yawHome;
    this._yawHome = false;
    let viewYaw = 0;
    let zoomFactor = this._zoomAccum;
    this._orbitAccum = 0;
    this._zoomAccum = 1;

    if (dt > 0) {
      // Pointer yaw stays on orbitDelta. Stick yaw is a separate gesture.
      if (rightStick.x) viewYaw += -rightStick.x * g.orbitStickRate * dt;
      if (rightStick.y) zoomFactor *= Math.exp(-rightStick.y * g.zoomStickRate * dt);
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
      yawHome,
      viewYaw,
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
    this._pointerKind = type === "touch" ? "touch" : "mouse";
  }

  _onWheelDevice() {
    this._pointerActivity = true;
    this._pointerKind = "mouse";
  }

  /**
   * Glyphs come on with a PlayStation gesture and stay until a mouse, trackpad,
   * or touchscreen takes over. A pad that is only connected never turns them on.
   * The yaw orb follows any gamepad the same way: hidden once it is driven,
   * back when a pointer takes over.
   * @param {Gamepad | null} pad
   */
  _syncGlyphDevice(pad) {
    const dead = this.bindings.gamepad.stickDeadzone;
    const using = playstationDriving(pad, dead);
    const driving = gamepadDriving(pad, dead);
    if (this._pointerActivity) {
      this._device = "pointer";
      this._yawOrbHidden = false;
      this._pointerActivity = false;
    } else if (using && !this._padWasUsing) {
      this._device = "pad";
    }
    if (driving && !this._padWasDriving) this._yawOrbHidden = true;
    this._padWasUsing = using;
    this._padWasDriving = driving;
    this._showPadGlyphs = this._device === "pad";
    this._applyYawOrb();
  }

  _applyYawOrb() {
    const root = this._yawRing;
    if (!root) return;
    const hide = this._yawOrbHidden;
    if (hide === this._yawOrbApplied) return;
    this._yawOrbApplied = hide;
    if (hide && this._yawRingHeld) this._releaseYawRing(false);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    root.classList.remove("is-leaving", "is-arriving");
    if (reduce) {
      root.classList.toggle("is-hidden", hide);
      return;
    }
    if (hide) {
      root.classList.remove("is-hidden");
      void root.offsetWidth;
      root.classList.add("is-leaving");
      return;
    }
    void root.offsetWidth;
    root.classList.add("is-arriving");
    root.classList.remove("is-hidden");
  }

  /**
   * @param {AnimationEvent} event
   */
  _onYawOrbMotion(event) {
    if (event.target !== this._yawRing) return;
    const root = this._yawRing;
    if (!root) return;
    if (event.animationName === "falling-yaw-leave" && this._yawOrbHidden) {
      root.classList.remove("is-leaving");
      root.classList.add("is-hidden");
      return;
    }
    if (event.animationName === "falling-yaw-arrive" && !this._yawOrbHidden) {
      root.classList.remove("is-arriving");
    }
  }

  /**
   * A field drag fires pointerleave on <html> when that finger lifts, and the
   * browser does it again when it steals the gesture. Neither one is the thumb
   * coming up. Blur still releases Emit.
   * @param {Event} [event]
   */
  _onPointerGone(event) {
    if (event?.type === "blur") this._releaseYawRing(true);
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
    if (event.type === "touchstart" && isEmitTarget(event.target)) {
      const touch = event.changedTouches?.[0];
      if (touch && this._emitTouchId == null) this._emitTouchId = touch.identifier;
      if (event.cancelable) event.preventDefault();
    }
    if (!event.cancelable) return;
    const target = event.target;
    // A material button left to the browser becomes a click that iOS uses to
    // end every other contact, including the thumb still on Emit.
    if (isMaterialSwatch(target)) {
      event.preventDefault();
      return;
    }
    // About is modal. Leave its touches alone so it can scroll and its close
    // control can run. The top-bar buttons stay claimed; they act on pointerdown.
    if (target instanceof Element && target.closest("dialog[open]")) return;
    if (this._emitHeldDown) {
      event.preventDefault();
      return;
    }
    const stage = this._gestureStage;
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

  /** A zoom burst still in progress. A middle click must not turn the view. */
  _wheelGestureOwnsView(now = performance.now()) {
    return (
      now - this._wheelGestureAt <= WHEEL_GESTURE_MS &&
      Math.abs(this._wheelNotches) > WHEEL_ACCIDENT_NOTCHES
    );
  }

  /**
   * One detent in the same instant as a turn is the wheel clicking
   * through. Pull that zoom back out once the drag actually moves,
   * including a tick the sampler already applied.
   */
  _undoStrayWheel(now = performance.now()) {
    if (now - this._wheelGestureAt > WHEEL_ACCIDENT_MS) return;
    if (!(Math.abs(this._wheelNotches) > 0)) return;
    if (Math.abs(this._wheelNotches) > WHEEL_ACCIDENT_NOTCHES) return;
    if (this._wheelFactor !== 1) this._zoomAccum /= this._wheelFactor;
    this._wheelNotches = 0;
    this._wheelFactor = 1;
    this._wheelGestureAt = 0;
    this._releaseWheelZoomVisual();
  }

  /**
   * @param {WheelEvent} event
   */
  _noteWheel(event) {
    const dy = event.deltaY || 0;
    if (!dy) return;
    const now = performance.now();
    if (now - this._wheelGestureAt > WHEEL_GESTURE_MS) {
      this._wheelNotches = 0;
      this._wheelFactor = 1;
    }
    const factor = Math.exp(dy * this.bindings.mouse.wheelZoomExp);
    this._wheelNotches += wheelNotches(dy, event.deltaMode);
    this._wheelFactor *= factor;
    this._wheelGestureAt = now;
    this._zoomAccum *= factor;
  }

  /**
   * The sphere follows the camera. Size keeps changing until zoom itself stops.
   * @param {number} dist
   * @param {number} min
   * @param {number} max
   */
  syncCameraZoom(dist, min, max) {
    if (!Number.isFinite(dist) || !Number.isFinite(min) || !Number.isFinite(max)) return;
    this._setYawSphereScale(sphereZoomScale(dist, min, max));
  }

  _releaseWheelZoomVisual() {
    window.clearTimeout(this._wheelZoomVisualTimer);
    this._wheelZoomVisualTimer = 0;
    this._wheelZoomVisual = 0;
    if (this._yawRingMode === "zoom") return;
    this._yawRing?.classList.remove("is-zooming");
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
      if (event.movementX || event.movementY) this._undoStrayWheel();
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
      event.preventDefault();
      if (this._wheelGestureOwnsView()) return;
      this._yawHeld = true;
      this._aimAt = null;
      this._setDragCursor("yaw");
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
    if (this._yawing()) return;
    const yawDown = pointerButtonDown(event.buttons, this.bindings.mouse.yawButton);
    if (yawDown && !this._wheelGestureOwnsView()) return;
    this._noteWheel(event);
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
    if (!(btn instanceof HTMLElement)) return;
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
    window[method]("lostpointercapture", this._onEmitPointerUp);
    document[method]("touchend", this._onEmitTouchEnd, true);
    document[method]("touchcancel", this._onEmitTouchEnd, true);
    document[method]("touchstart", this._onEmitTouchActive, true);
    document[method]("touchmove", this._onEmitTouchActive, true);
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
    this._clearEmitPointerDoubt();
    this._emitFillGen += 1;
    this._emitPointerId = -1;
    this._emitTouchId = null;
    this._emitSettleY = 0;
    btn.classList.remove("is-pressed", "is-held", "is-charging", "is-filling", "is-pouring");
    btn.setAttribute("aria-pressed", "false");
    this._emitAnalog = 0.5;
    const face = btn.querySelector(".falling-emit-face");
    if (face) face.style.transform = "";
    const fill = btn.querySelector(".falling-emit-fill");
    if (fill) {
      fill.style.transition = "";
      fill.style.transform = "";
    }
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
      this._lockEmitFill();
      this._emitButton?.setAttribute("aria-pressed", "true");
    }, EMIT_HOLD_MS);
  }

  /** Keep the circle full, with no grow animation, for the rest of the pour. */
  _lockEmitFill() {
    const btn = this._emitButton;
    if (!btn) return;
    btn.classList.add("is-pouring", "is-charging", "is-filling");
    const fill = btn.querySelector(".falling-emit-fill");
    if (!fill) return;
    fill.style.transition = "none";
    fill.style.transform = "scale(1)";
  }

  /** Snap the fill shut and grow it again for a fresh hold. */
  _kickEmitCharge() {
    const btn = this._emitButton;
    if (!btn || !this._emitHeldDown || this._touchEmit || btn.classList.contains("is-pouring")) return;
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
    btn?.classList.remove("is-charging", "is-pouring");
    const gen = ++this._emitFillGen;
    window.setTimeout(() => {
      if (gen !== this._emitFillGen) return;
      btn?.classList.remove("is-filling");
    }, 160);
  }

  _endEmitGesture() {
    this._trackEmitPointer(false);
    this._clearEmitHold();
    this._clearEmitPointerDoubt();
    this._touchEmit = false;
    this._emitHeldDown = false;
    this._emitDragging = false;
    this._emitPointerId = -1;
    this._emitTouchId = null;
    this._emitSettleY = 0;
    const fill = this._emitButton?.querySelector(".falling-emit-fill");
    if (fill) {
      fill.style.transition = "";
      fill.style.transform = "";
    }
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
    this._clearEmitPointerDoubt();
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
    this._emitOriginY = event.clientY - (0.5 - this._emitAnalog) * EMIT_DRAG_SPAN;
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
    if (!this._emitDragging && Math.abs(event.clientY - this._emitDownY) <= EMIT_DRAG_START) return;
    if (!this._emitDragging) {
      this._emitDragging = true;
      this._emitSizeLatched = true;
    }
    this._emitAnalog = clamp(0.5 - (event.clientY - this._emitOriginY) / EMIT_DRAG_SPAN, 0, 1);
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
    const shift = (0.5 - this._emitAnalog) * EMIT_DRAG_SLIDE;
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
    // Ending a pan, pinch, or material tap makes iOS fire pointerup for the
    // thumb too, sometimes as a compatibility mouse event. The thumb is still
    // down. A real lift arrives later as touchend for its identifier.
    // pointercancel and lost capture are the same report on Safari, and on
    // some browsers they are the only release. Don't drop the hold immediately.
    if (event?.type === "pointercancel" || event?.type === "lostpointercapture") {
      if (event.pointerId != null && event.pointerId !== this._emitPointerId) return;
      if (this._emitTouchId != null) {
        this._armEmitPointerDoubt();
        return;
      }
      this._endEmitGesture();
      return;
    }
    if (this._emitTouchId != null) return;
    if (event?.pointerId != null && event.pointerId !== this._emitPointerId) return;
    this._endEmitGesture();
  }

  /**
   * The Emit finger left, or the browser cancelled it. Release follows the
   * touch identifier: a retargeted touchend still counts when that finger is
   * no longer in event.touches.
   * @param {TouchEvent} event
   */
  _onEmitTouchEnd(event) {
    this._reconcileEmitTouch(event);
  }

  /**
   * A touch after a cancelled pointer shows whether the thumb is still down.
   * @param {TouchEvent} event
   */
  _onEmitTouchActive(event) {
    if (!this._emitPointerUncertain) return;
    this._reconcileEmitTouch(event);
  }

  /**
   * @param {TouchEvent} event
   */
  _reconcileEmitTouch(event) {
    if (this._emitTouchId == null) return;
    const touches = event.touches;
    if (touches) {
      for (const touch of touches) {
        if (touch.identifier === this._emitTouchId) {
          this._clearEmitPointerDoubt();
          return;
        }
      }
    }
    this._endEmitGesture();
  }

  _armEmitPointerDoubt() {
    if (!this._emitHeldDown || this._emitTouchId == null) return;
    this._emitPointerUncertain = true;
    if (this._emitDoubtTimer) return;
    this._emitDoubtTimer = window.setTimeout(() => {
      this._emitDoubtTimer = 0;
      if (!this._emitPointerUncertain || this._emitTouchId == null) return;
      this._endEmitGesture();
    }, EMIT_POINTER_DOUBT_MS);
  }

  _clearEmitPointerDoubt() {
    this._emitPointerUncertain = false;
    if (!this._emitDoubtTimer) return;
    clearTimeout(this._emitDoubtTimer);
    this._emitDoubtTimer = 0;
  }

  /**
   * @param {Event} event
   */
  _onEmitContextMenu(event) {
    event.preventDefault();
  }

  _bindYawRing() {
    const ring = document.querySelector("[data-falling-yaw]");
    this._yawRing = ring instanceof HTMLElement ? ring : null;
    const root = this._yawRing;
    if (!root) return;
    this._yawTrackBack = root.querySelector("[data-falling-yaw-track-back]");
    this._yawTrackFront = root.querySelector("[data-falling-yaw-track-front]");
    this._yawRingBack = root.querySelector("[data-falling-yaw-ring-back]");
    this._yawRingFront = root.querySelector("[data-falling-yaw-ring-front]");
    this._yawNowBack = root.querySelector("[data-falling-yaw-tick-back]");
    this._yawNowFront = root.querySelector("[data-falling-yaw-tick-front]");
    this._yawSphere = root.querySelector("[data-falling-yaw-sphere]");
    this._yawWire = root.querySelector("[data-falling-yaw-wire]");
    this._paintTrack();
    this._paintHeading();
    this._applyYawOrb();
    root.addEventListener("pointerdown", this._onYawRingDown);
    root.addEventListener("pointermove", this._onYawRingMove);
    root.addEventListener("pointerup", this._onYawRingUp);
    root.addEventListener("pointercancel", this._onYawRingUp);
    root.addEventListener("dblclick", this._onYawRingDblClick);
    root.addEventListener("contextmenu", this._onContextMenu);
    root.addEventListener("transitionend", this._onYawRingFade);
    root.addEventListener("animationend", this._onYawOrbMotion);
  }

  _unbindYawRing() {
    const root = this._yawRing;
    if (!root) return;
    root.removeEventListener("pointerdown", this._onYawRingDown);
    root.removeEventListener("pointermove", this._onYawRingMove);
    root.removeEventListener("pointerup", this._onYawRingUp);
    root.removeEventListener("pointercancel", this._onYawRingUp);
    root.removeEventListener("dblclick", this._onYawRingDblClick);
    root.removeEventListener("contextmenu", this._onContextMenu);
    root.removeEventListener("transitionend", this._onYawRingFade);
    root.removeEventListener("animationend", this._onYawOrbMotion);
    root.classList.remove("is-dragging", "is-fading", "is-zooming", "is-leaving", "is-arriving", "is-hidden");
    document.documentElement.classList.remove("is-yaw-turn", "is-yaw-zoom");
    window.clearTimeout(this._wheelZoomVisualTimer);
    this._wheelZoomVisualTimer = 0;
    this._wheelZoomVisual = 0;
    this._setYawSphereScale(1);
    this._yawRing = null;
    this._yawTrackBack = null;
    this._yawTrackFront = null;
    this._yawRingBack = null;
    this._yawRingFront = null;
    this._yawNowBack = null;
    this._yawNowFront = null;
    this._yawSphere = null;
    this._yawWire = null;
  }

  _paintTrack() {
    this._yawTrackBack?.setAttribute("d", ringOpen(Math.PI, Math.PI * 2));
    this._yawTrackFront?.setAttribute("d", ringOpen(0, Math.PI));
  }

  /**
   * The ring is the playfield heading. Other turns (stick, middle-drag) update it too.
   * @param {number} yaw
   */
  syncSurfaceYaw(yaw) {
    if (!Number.isFinite(yaw)) return;
    if (Math.abs(yaw - this._surfaceYaw) < 1e-5) return;
    this._surfaceYaw = yaw;
    this._paintHeading();
  }

  /**
   * @param {PointerEvent} event
   */
  _onYawRingDown(event) {
    if (event.pointerType === "touch" || event.button !== 0) return;
    const root = this._yawRing;
    if (!root) return;
    this._yawRingHeld = true;
    this._yawRingPointer = event.pointerId;
    this._yawRingMode = null;
    this._yawOriginX = event.clientX;
    this._yawOriginY = event.clientY;
    this._yawLastX = event.clientX;
    this._yawLastY = event.clientY;
    this._yawRingTotal = 0;
    this._yawZoomDrag = 0;
    root.classList.remove("is-fading", "is-dragging", "is-zooming");
    this._setYawSphereScale(1);
    root.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  /**
   * Sideways drag turns the field. Up and down zoom, and the sphere
   * grows or shrinks a little so that mode is visible. The first few
   * pixels pick one axis and the gesture stays there.
   * @param {PointerEvent} event
   */
  _onYawRingMove(event) {
    if (!this._yawRingHeld || event.pointerId !== this._yawRingPointer) return;
    if (event.pointerType === "touch") return;
    let dx = event.clientX - this._yawLastX;
    let dy = event.clientY - this._yawLastY;
    this._yawLastX = event.clientX;
    this._yawLastY = event.clientY;
    if (!this._yawRingMode) {
      const adx = Math.abs(event.clientX - this._yawOriginX);
      const ady = Math.abs(event.clientY - this._yawOriginY);
      if (Math.max(adx, ady) < YAW_AXIS_SLOP) return;
      this._yawRingMode = adx >= ady ? "yaw" : "zoom";
      dx = event.clientX - this._yawOriginX;
      dy = event.clientY - this._yawOriginY;
      const root = this._yawRing;
      if (this._yawRingMode === "yaw") {
        root?.classList.add("is-dragging");
        document.documentElement.classList.add("is-yaw-turn");
      } else {
        window.clearTimeout(this._wheelZoomVisualTimer);
        this._wheelZoomVisualTimer = 0;
        this._wheelZoomVisual = 0;
        root?.classList.add("is-zooming");
        document.documentElement.classList.add("is-yaw-zoom");
      }
    }
    if (this._yawRingMode === "yaw") {
      if (!dx) return;
      const delta = dx * YAW_DRAG_RAD_PER_PX;
      this._yawRingTotal += delta;
      // Dragging right sweeps the ring clockwise. Positive surface yaw
      // turns the other way on this camera.
      this._orbitAccum += -delta;
      this._surfaceYaw -= delta;
      this._paintHeading();
      return;
    }
    if (!dy) return;
    this._yawZoomDrag += dy;
    this._zoomAccum *= Math.exp(dy * YAW_ZOOM_PER_PX);
  }

  /**
   * @param {PointerEvent} event
   */
  _onYawRingUp(event) {
    if (!this._yawRingHeld) return;
    if (event.pointerId !== this._yawRingPointer && event.type !== "pointercancel") return;
    this._releaseYawRing(false);
  }

  /**
   * @param {MouseEvent} event
   */
  _onYawRingDblClick(event) {
    event.preventDefault();
    this._orbitAccum = 0;
    this._zoomAccum = 1;
    this._yawHome = true;
    this._yawRingHeld = false;
    this._yawRingPointer = -1;
    this._yawRingMode = null;
    this._yawRingTotal = 0;
    this._yawZoomDrag = 0;
    this._surfaceYaw = 0;
    document.documentElement.classList.remove("is-yaw-turn", "is-yaw-zoom");
    this._yawRing?.classList.remove("is-dragging", "is-fading", "is-zooming");
    this._paintHeading();
  }

  /**
   * @param {TransitionEvent} event
   */
  _onYawRingFade(event) {
    if (event.propertyName !== "opacity") return;
    const root = this._yawRing;
    if (!root || this._yawRingHeld || !root.classList.contains("is-fading")) return;
    root.classList.remove("is-fading");
  }

  /**
   * @param {boolean} fade
   */
  _releaseYawRing(fade) {
    const root = this._yawRing;
    if (!this._yawRingHeld && !root?.classList.contains("is-dragging") && !root?.classList.contains("is-zooming")) {
      document.documentElement.classList.remove("is-yaw-turn", "is-yaw-zoom");
      return;
    }
    this._yawRingHeld = false;
    this._yawRingPointer = -1;
    this._yawRingMode = null;
    this._yawZoomDrag = 0;
    document.documentElement.classList.remove("is-yaw-turn", "is-yaw-zoom");
    if (!root) return;
    root.classList.remove("is-dragging", "is-zooming");
    root.classList.remove("is-fading");
  }

  /**
   * @param {number} scale
   */
  _setYawSphereScale(scale) {
    const sphere = this._yawSphere;
    if (!sphere) return;
    sphere.style.transform = `scale(${scale})`;
  }

  _paintSphere() {
    this._yawWire?.setAttribute("d", sphereWirePath(this._surfaceYaw));
  }

  _paintHeading() {
    this._paintSphere();
    const sweep = headingSweep(this._surfaceYaw);
    const end = YAW_FAR + sweep;
    hideRingTick(this._yawNowBack);
    hideRingTick(this._yawNowFront);
    const cap = isRingFront(end) ? this._yawNowFront : this._yawNowBack;
    setRingTick(cap, end);
    if (sweep === 0) {
      this._yawRingBack?.setAttribute("d", "");
      this._yawRingFront?.setAttribute("d", "");
      return;
    }
    const path = ringSweep(YAW_FAR, end);
    this._yawRingBack?.setAttribute("d", path.back);
    this._yawRingFront?.setAttribute("d", path.front);
  }
}

export const fallingInput = new FallingInput();

function isEditableTarget(target) {
  return !!(target && /^(INPUT|TEXTAREA|SELECT)$/i.test(target.tagName));
}

/** Palette swatches only. The about-page notes also carry data-material. */
function isMaterialSwatch(target) {
  return target instanceof Element
    && !!target.closest("[data-falling-palette] .falling-material-swatch");
}

function isEmitTarget(target) {
  return target instanceof Element && !!target.closest("[data-falling-touch-emit]");
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
  return isPlayStationPad(pad) && gamepadDriving(pad, dead);
}

/**
 * Any gamepad that is being driven, not one that is only plugged in.
 * @param {Gamepad | null | undefined} pad
 * @param {number} dead
 */
function gamepadDriving(pad, dead) {
  if (pad) {
    const axes = pad.axes || [];
    for (let i = 0; i < axes.length; i += 1) {
      if (Math.abs(Number(axes[i]) || 0) >= dead) return true;
    }
    const buttons = pad.buttons || [];
    for (let i = 0; i < buttons.length; i += 1) {
      const button = buttons[i];
      if (button && (button.pressed || button.value > 0.15)) return true;
    }
  }
  return !!(dualsenseHid.enabled && dualsenseHid.connected && dualsenseHid.touch?.active);
}
