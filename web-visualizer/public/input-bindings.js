/**
 * Mouse, keyboard, and controller bindings.
 * Edit controls here. falling-input.js and gamepad-input.js only read this file.
 *
 * Mouse:
 *   move            → aim emitter
 *   LMB hold        → largest emitter (full field, full atom size)
 *   Shift+LMB hold  → smallest emitter (one half-size column)
 *   RMB drag        → yaw the playfield (camera / grid)
 *   wheel           → zoom
 *
 * Touchpad (DualSense, after Connect touchpad):
 *   finger          → aim the emitter on the emit-height plane
 *   touchpad click  → emit a clump (largest brush) while the pad is pressed in
 *
 * Right trigger emits. A light pull is a single stream; a full pull is the wide field.
 * Left trigger emits on the opposite curve: a hard pull is a single stream.
 * Square toggles field audio. Circle clears the board.
 *
 * D-pad left / right aims across the playfield.
 *
 * Keyboard:
 *   X hold          → emit
 *   Tab             → next material (never moves focus)
 *   Shift+Tab       → previous material
 */

/** @typedef {"pressure" | "max" | "single"} BrushMode */

/**
 * W3C Standard Gamepad indices.
 * https://w3c.github.io/gamepad/#remapping
 */
export const gamepadButtons = {
  cross: 0,
  circle: 1,
  square: 2,
  triangle: 3,
  l1: 4,
  r1: 5,
  lt: 6,
  rt: 7,
  ls: 10,
  rs: 11,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
  /** DualSense / DualShock touchpad click in Chrome's standard mapping. */
  touchpad: 17,
};

/** Standard mapping axes. Y is inverted at the call site (up = positive). */
export const gamepadAxes = {
  leftX: 0,
  leftY: 1,
  rightX: 2,
  rightY: 3,
};

export const inputBindings = {
  mouse: {
    /** 0 = left, 1 = middle, 2 = right */
    emitButton: 0,
    /** Held with emitButton: smallest emitter instead of the largest. */
    emitSingleModifier: "shift",
    orbitButton: 2,
    /** Pointer move always aims the emitter (unless orbiting). */
    moveAimsEmitter: true,
    wheelZooms: true,
    /** RMB drag: radians of surface yaw per pixel (grid rotates under emitter). */
    orbitRadiansPerPx: 0.005,
    wheelZoomExp: 0.0012,
  },
  keyboard: {
    /** KeyboardEvent.code — hold to emit. Empty string disables. */
    emit: "KeyX",
    emitBrush: /** @type {BrushMode} */ ("max"),
    /** KeyboardEvent.code — Tab steps forward, Shift+Tab steps back. */
    cycleNext: "Tab",
  },
  gamepad: {
    /** Deadzone for the mixer poll in gamepad-input.js. */
    mixerStickDeadzone: 0.08,
    /** Deadzone for falling-blocks aim / orbit sticks. */
    stickDeadzone: 0.12,
    /** Names from gamepadButtons. */
    emitDigital: "cross",
    /** Either trigger emits once it passes this. RT and LT use opposite curves. */
    emitAnalogThreshold: 0.08,
    emitDigitalBrush: /** @type {BrushMode} */ ("max"),
    clear: "circle",
    /** Toggles sonification of the field. */
    audioToggle: "square",
    cyclePrev: "l1",
    cycleNext: "r1",
    /** Right-stick X → surface yaw rate (rad/s at full deflection). */
    orbitStickRate: 1.15,
    /** Right-stick Y → zoom exp rate. */
    zoomStickRate: 1.15,
  },
};
