import { hideVisualize, showVisualize } from "./visualize.js?v=82";
import {
  onFaceCommand,
  onFaceEdge,
  renderDiagnostics,
  tickXyAudio,
} from "./diagnostics.js?v=2";

const canvas = document.querySelector("[data-viz-canvas]");

export function show() {
  if (canvas) showVisualize(canvas);
}

export function hide() {
  hideVisualize();
}

/** Same XY mix as Diagnostics. The scene keeps its own render loop. */
export function tick() {
  tickXyAudio();
  renderDiagnostics();
}

export { onFaceCommand, onFaceEdge };
