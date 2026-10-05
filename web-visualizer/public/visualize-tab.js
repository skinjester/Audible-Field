import { hideVisualize, showVisualize } from "./visualize.js?v=82";
import {
  onFaceCommand,
  onFaceEdge,
  renderDiagnostics,
  tickXyAudio,
} from "./diagnostics.js?v=44";
import { dualsenseHid } from "./dualsense-hid.js?v=5";

const canvas = document.querySelector("[data-viz-canvas]");
const padGate = document.querySelector("[data-viz-pad-gate]");
const PLAYSTATION_PAD = /dualsense|dualshock|wireless controller|playstation/i;

function dualSenseConnected() {
  if (dualsenseHid.connected) return true;
  const pads = navigator.getGamepads?.();
  if (!pads) return false;
  for (const pad of pads) {
    if (pad && PLAYSTATION_PAD.test(pad.id || "")) return true;
  }
  return false;
}

function syncPadGate() {
  if (!padGate) return;
  padGate.hidden = dualSenseConnected();
}

export function show() {
  syncPadGate();
  if (canvas) showVisualize(canvas);
}

export function hide() {
  hideVisualize();
}

/** Same XY mix as Diagnostics. The scene keeps its own render loop. */
export function tick() {
  syncPadGate();
  tickXyAudio();
  renderDiagnostics();
}

export { onFaceCommand, onFaceEdge };
