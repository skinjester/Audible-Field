/**
 * DualSense (and generic gamepad) → mixer-core, for browser-audio mode
 * without Max / OSC.
 *
 * Gamepad API: sticks / face / D-pad / shoulders / triggers.
 * Touchpad XY needs WebHID — see dualsense-hid.js (Connect button in UI).
 */

import {
  setActiveFx,
  setDpad,
  setRawStick,
  setRightStick,
  setShoulder,
  setStickClick,
  setTrigger,
  setFxStick,
} from "./mixer-core.js?v=65";

function lerp(inMin, inMax, outMin, outMax, value) {
  if (inMax === inMin) return outMin;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

function deadzone(v, z = 0.08) {
  return Math.abs(v) < z ? 0 : v;
}

/** Same stick→FX scaling as Max / app.js applyRawStick. */
function applyRawStick(nx, ny) {
  setRawStick(nx, ny);
  setFxStick("cross", lerp(-1, 1, 0, 1, nx), lerp(0, 1, 0, 0.75, ny));
  setFxStick("square", lerp(-1, 1, 0.3, 0.7, nx), lerp(-1, 1, 0.3, 0.7, ny));
  setFxStick("triangle", lerp(-1, 1, 0, 1, nx), lerp(-1, 1, 0, 1, ny));
  setFxStick("circle", lerp(-1, 1, 0.825, 0.65, nx), lerp(-1, 1, 0.6, 1, ny));
}

function pickPad(pads) {
  if (!pads?.length) return null;
  const named = pads.find(
    (p) =>
      p &&
      /dualsense|dualshock|wireless controller|playstation/i.test(p.id || "")
  );
  return named || pads.find((p) => p) || null;
}

export class GamepadInput {
  constructor() {
    this.enabled = false;
    this.padIndex = null;
    this._prev = {
      cross: false,
      circle: false,
      square: false,
      triangle: false,
      up: false,
      down: false,
      left: false,
      right: false,
      l1: false,
      r1: false,
      ls: false,
      rs: false,
    };
    this.connected = false;
    this.padId = "";
    /** UI pointer capture owns these while true (skip gamepad overwrite). */
    this.uiLock = {
      leftStick: false,
      rightStick: false,
      l1: false,
      r1: false,
    };
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
    this.connected = false;
    this.padId = "";
  }

  /** Call once per animation frame while browser-audio mode is active. */
  poll() {
    if (!this.enabled || !navigator.getGamepads) return false;
    const pad = pickPad(navigator.getGamepads());
    if (!pad) {
      this.connected = false;
      this.padId = "";
      return false;
    }

    this.connected = true;
    this.padId = pad.id || "Gamepad";
    this.padIndex = pad.index;

    const ax = pad.axes || [];
    const lx = deadzone(Number(ax[0]) || 0);
    const ly = deadzone(-(Number(ax[1]) || 0)); // Max-style: up positive for FX Y scaling
    const rx = deadzone(Number(ax[2]) || 0);
    const ry = deadzone(-(Number(ax[3]) || 0));

    if (!this.uiLock.leftStick) applyRawStick(lx, ly);
    if (!this.uiLock.rightStick) setRightStick(rx, ry);

    const b = pad.buttons || [];
    const pressed = (i) => !!(b[i] && (b[i].pressed || b[i].value > 0.5));
    const value = (i) => (b[i] ? Number(b[i].value) || (b[i].pressed ? 1 : 0) : 0);

    // Standard mapping: 0 A/Cross, 1 B/Circle, 2 X/Square, 3 Y/Triangle
    const face = {
      cross: pressed(0),
      circle: pressed(1),
      square: pressed(2),
      triangle: pressed(3),
    };
    for (const [btn, on] of Object.entries(face)) {
      if (on && !this._prev[btn]) setActiveFx(btn);
      this._prev[btn] = on;
    }

    const dpad = {
      up: pressed(12),
      down: pressed(13),
      left: pressed(14),
      right: pressed(15),
    };
    for (const [dir, on] of Object.entries(dpad)) {
      if (on !== this._prev[dir]) setDpad(dir, on ? 1 : 0);
      this._prev[dir] = on;
    }

    if (!this.uiLock.l1) setShoulder("l1", pressed(4) ? 1 : 0);
    if (!this.uiLock.r1) setShoulder("r1", pressed(5) ? 1 : 0);
    setTrigger("lt", value(6));
    setTrigger("rt", value(7));
    setStickClick("ls", pressed(10) ? 1 : 0);
    setStickClick("rs", pressed(11) ? 1 : 0);

    return true;
  }
}

export const gamepadInput = new GamepadInput();
