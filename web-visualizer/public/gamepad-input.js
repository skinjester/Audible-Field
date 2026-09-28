/**
 * DualSense (and generic gamepad) → mixer-core, for browser-audio mode
 * without Max / OSC.
 *
 * Button and axis indices live in input-bindings.js.
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
import { gamepadAxes, gamepadButtons, inputBindings } from "./input-bindings.js?v=5";

function lerp(inMin, inMax, outMin, outMax, value) {
  if (inMax === inMin) return outMin;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

function deadzone(v, z = inputBindings.gamepad.mixerStickDeadzone) {
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
    const dead = inputBindings.gamepad.mixerStickDeadzone;
    const lx = deadzone(Number(ax[gamepadAxes.leftX]) || 0, dead);
    const ly = deadzone(-(Number(ax[gamepadAxes.leftY]) || 0), dead); // Max-style: up positive for FX Y scaling
    const rx = deadzone(Number(ax[gamepadAxes.rightX]) || 0, dead);
    const ry = deadzone(-(Number(ax[gamepadAxes.rightY]) || 0), dead);

    if (!this.uiLock.leftStick) applyRawStick(lx, ly);
    if (!this.uiLock.rightStick) setRightStick(rx, ry);

    const b = pad.buttons || [];
    const pressed = (i) => !!(b[i] && (b[i].pressed || b[i].value > 0.5));
    const value = (i) => (b[i] ? Number(b[i].value) || (b[i].pressed ? 1 : 0) : 0);

    const face = {
      cross: pressed(gamepadButtons.cross),
      circle: pressed(gamepadButtons.circle),
      square: pressed(gamepadButtons.square),
      triangle: pressed(gamepadButtons.triangle),
    };
    const playfield = document.querySelector("[data-panel='falling-blocks']");
    const onPlayfield = !!playfield && !playfield.hidden;
    for (const [btn, on] of Object.entries(face)) {
      // Square toggles field audio on the playfield; it does not select FX.
      if (onPlayfield && btn === inputBindings.gamepad.audioToggle) {
        this._prev[btn] = on;
        continue;
      }
      if (on && !this._prev[btn]) setActiveFx(btn);
      this._prev[btn] = on;
    }

    const dpad = {
      up: pressed(gamepadButtons.dpadUp),
      down: pressed(gamepadButtons.dpadDown),
      left: pressed(gamepadButtons.dpadLeft),
      right: pressed(gamepadButtons.dpadRight),
    };
    for (const [dir, on] of Object.entries(dpad)) {
      if (on !== this._prev[dir]) setDpad(dir, on ? 1 : 0);
      this._prev[dir] = on;
    }

    if (!this.uiLock.l1) setShoulder("l1", pressed(gamepadButtons.l1) ? 1 : 0);
    if (!this.uiLock.r1) setShoulder("r1", pressed(gamepadButtons.r1) ? 1 : 0);
    setTrigger("lt", value(gamepadButtons.lt));
    setTrigger("rt", value(gamepadButtons.rt));
    setStickClick("ls", pressed(gamepadButtons.ls) ? 1 : 0);
    setStickClick("rs", pressed(gamepadButtons.rs) ? 1 : 0);

    return true;
  }
}

export const gamepadInput = new GamepadInput();
