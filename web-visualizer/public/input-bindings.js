/**
 * Mouse, keyboard, and controller bindings.
 * Edit controls here. falling-input.js and gamepad-input.js only read this file.
 *
 * Mouse:
 *   move            → aim emitter
 *   LMB hold        → emit at full width
 *   Shift+LMB hold  → emit a single column
 *   RMB drag        → yaw the playfield (camera / grid)
 *   wheel           → zoom
 *
 * Triangle still mirrors the RT width curve. Gamepad / keys stay below.
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
    /** Held with emitButton: 1×1 column instead of the wide brush. */
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
  },
  gamepad: {
    /** Deadzone for the mixer poll in gamepad-input.js. */
    mixerStickDeadzone: 0.08,
    /** Deadzone for falling-blocks aim / orbit sticks. */
    stickDeadzone: 0.12,
    /** Names from gamepadButtons. */
    emitDigital: "cross",
    emitAnalog: "rt",
    emitAnalogThreshold: 0.08,
    emitDigitalBrush: /** @type {BrushMode} */ ("max"),
    clear: "circle",
    invertCurve: "triangle",
    cyclePrev: "l1",
    cycleNext: "r1",
    /** Right-stick X → surface yaw rate (rad/s at full deflection). */
    orbitStickRate: 1.15,
    /** Right-stick Y → zoom exp rate. */
    zoomStickRate: 1.15,
  },
};
