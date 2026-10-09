/**
 * Mouse, keyboard, controller, and touch bindings.
 * Edit controls here. falling-input.js and gamepad-input.js read this file.
 * falling-input.js passes the touch block into touch-input.js.
 *
 * Mouse:
 *   move            → aim emitter
 *   LMB hold        → largest emitter (full field, full atom size)
 *   Shift+LMB hold  → smallest emitter (one half-size column)
 *   RMB drag             → slide the playfield, holding the emitter on the cursor.
 *                          The pointer stays locked until the button is released.
 *   Shift+RMB or Alt+RMB → yaw the playfield
 *   MMB drag             → yaw the playfield (the wheel is ignored while it is held)
 *   top-center ring      → drag sideways to yaw, up or down to zoom; double-click resets the heading
 *   wheel           → zoom (a middle click does not yaw while the wheel is moving)
 *
 * Touchpad (DualSense, after Connect touchpad):
 *   finger          → steer the centered emitter; the pour travels with the finger
 *   touchpad click  → emit a clump (largest brush) while the pad is pressed in
 *
 * Right trigger emits. A light pull is a single stream; a full pull is the wide field.
 * Left trigger emits on the opposite curve: a hard pull is a single stream.
 * Square toggles field audio. Circle clears the board.
 *
 * Left stick and D-pad move the emitter across the plane above the grid.
 * At the edge of the view they scroll the plane, so the whole surface stays reachable.
 * Right stick X turns the plane about the center of the view. Right stick Y zooms.
 * A push nearer one axis favors that action. A diagonal still does both.
 *
 * Options opens and closes settings. While that menu is open, the D-pad or
 * left stick moves between its options and Cross confirms the highlighted one.
 * Create, the button to the left of the DualSense touchpad, opens and closes
 * the frame readout.
 *
 * Keyboard:
 *   X hold          → emit
 *   Tab             → next material (never moves focus)
 *   Shift+Tab       → previous material
 *
 * Touchscreen:
 *   one-finger drag  → pan the field under the emitter (a tap, or the first of two fingers, does not)
 *   two-finger twist → yaw the field around the emitter at screen center
 *   pinch            → zoom toward and away from that emitter
 *   Emit button      → press to emit immediately; drag up or down sizes the emitter while it pours.
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
  /** Create / Share / View. Left of the DualSense touchpad. */
  create: 8,
  /** Options / Menu / Start. Right of the DualSense touchpad. */
  options: 9,
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
    /** Middle button yaws. Shift+right-drag and Alt+right-drag yaw as well. */
    yawButton: 1,
    /** Held with the right button: yaw instead of sliding the grid. */
    yawModifiers: ["shift", "alt"],
    /** A move on the view places the emitter. Right-drag slides the grid. */
    moveAimsEmitter: true,
    wheelZooms: true,
    /** Yaw drag: radians of surface yaw per pixel. The Mouse turn setting picks the pivot. */
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
    /** Either trigger emits once it passes this. RT widens with pressure. LT stays a single stream. */
    emitAnalogThreshold: 0.08,
    emitDigitalBrush: /** @type {BrushMode} */ ("max"),
    clear: "circle",
    /** Toggles sonification of the field. */
    audioToggle: "square",
    /** Options / Start. Opens and closes the settings menu. */
    settingsToggle: "options",
    /** Create, left of the DualSense touchpad. Opens and closes the frame readout. */
    debugToggle: "create",
    cyclePrev: "l1",
    cycleNext: "r1",
    /** Right-stick X → yaw about the view center (rad/s at full deflection). */
    orbitStickRate: 1.15,
    /** Right-stick Y → zoom exp rate. */
    zoomStickRate: 1.15,
    /**
     * How hard the right stick favors the nearer axis. 1 is linear.
     * Higher quiets the lesser axis on a mostly-straight push (yaw without
     * much zoom, or zoom without much yaw). A 45° push is unchanged.
     */
    rightStickAxialBias: 2.2,
  },
  touch: {
    /** 1 matches the pinch ratio to camera distance. Above 1 is more sensitive. */
    zoomGain: 1,
  },
};
