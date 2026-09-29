import { audioEngine } from "./audio-engine.js?v=49";
import {
  clearBoard,
  hideFallingBlocks,
  onFallingAudioToggle,
  readGridSnapshot,
  showFallingBlocks,
} from "./falling-blocks.js?v=308";
import { fieldFrame, resetFieldSonify } from "./grid-sonify.js?v=17";
import { controller, setActiveFx } from "./mixer-core.js?v=67";

/** falling-input.js already turns these into clear, audio toggle, and emit. */
const PLAYFIELD_FACE = new Set(["circle", "square", "cross"]);

/** @type {null | {
 *   getActiveTab: () => string,
 *   ensureBrowserAudio: () => Promise<void>,
 *   enqueueAudio: (task: () => Promise<void>) => Promise<void>,
 *   setStatus: (state: string, label: string) => void,
 *   browserStatusLabel: () => string,
 * }} */
let deps = null;
let fallingAudioEnabled = true;
let showGen = 0;

export function isAudioEnabled() {
  return fallingAudioEnabled;
}

function syncFallingAudioButton() {
  const button = document.querySelector("[data-falling-audio]");
  if (!(button instanceof HTMLButtonElement)) return;
  button.setAttribute("aria-pressed", fallingAudioEnabled ? "true" : "false");
}

export function setFallingAudioEnabled(enabled) {
  fallingAudioEnabled = !!enabled;
  syncFallingAudioButton();
  if (!deps || deps.getActiveTab() !== "falling-blocks") {
    return;
  }
  if (fallingAudioEnabled) {
    audioEngine.beginGesture();
    resetFieldSonify();
    void deps.ensureBrowserAudio().then(() => {
      deps.setStatus(audioEngine.running ? "audio" : "loading", deps.browserStatusLabel());
    }, (err) => {
      console.error(err);
    });
    return;
  }
  resetFieldSonify();
  void deps.enqueueAudio(async () => {
    if (deps.getActiveTab() !== "falling-blocks" || isAudioEnabled()) return;
    if (audioEngine.running) {
      audioEngine.setStemPitch(null);
      await audioEngine.suspendPlayback();
    }
    deps.setStatus("offline", deps.browserStatusLabel());
  });
}

function bindFallingAudioUi() {
  const button = document.querySelector("[data-falling-audio]");
  if (!(button instanceof HTMLButtonElement) || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  syncFallingAudioButton();
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void setFallingAudioEnabled(!fallingAudioEnabled);
  });
}

export function initFallingTab(nextDeps) {
  deps = nextDeps;
  bindFallingAudioUi();
  onFallingAudioToggle(() => {
    void setFallingAudioEnabled(!fallingAudioEnabled);
  });
}

export function show() {
  const canvas = document.querySelector("[data-falling-canvas]");
  const mine = ++showGen;
  if (canvas) void showFallingBlocks(canvas, () => mine === showGen);
  if (!deps) return;
  if (fallingAudioEnabled) {
    void deps.ensureBrowserAudio();
    return;
  }
  if (!audioEngine.running) return;
  void deps.enqueueAudio(async () => {
    if (deps.getActiveTab() !== "falling-blocks" || isAudioEnabled()) return;
    if (!audioEngine.running) return;
    audioEngine.setStemPitch(null);
    await audioEngine.suspendPlayback();
    deps.setStatus("offline", deps.browserStatusLabel());
  });
}

export function hide() {
  showGen += 1;
  hideFallingBlocks();
  if (!deps) return;
  void deps.enqueueAudio(async () => {
    if (deps.getActiveTab() === "falling-blocks") return;
    if (!(audioEngine.running && audioEngine.ctx?.state === "suspended")) return;
    await audioEngine.ensurePlaying();
    deps.setStatus(audioEngine.running ? "audio" : "offline", deps.browserStatusLabel());
  });
}

export function tick(frame) {
  if (!deps) return;
  if (!(audioEngine.running && fallingAudioEnabled)) return;
  const snap = readGridSnapshot();
  const shadow = fieldFrame(snap, frame?.dt || 0);
  audioEngine.sync({ x: 0.5, y: 0.5 }, shadow.controller);
  audioEngine.setStemGains(shadow.gains, shadow.pans, shadow.cutoffs);
  audioEngine.setStemPitch(shadow.rates);
  audioEngine.setStemReverb(shadow.reverbs, shadow.decays, shadow.longTails);
  if (shadow.splash) audioEngine.playSplash(shadow.splash);
  audioEngine.setOutputLevel(1);
  audioEngine.setCameraPresence(snap.view?.near, snap.view?.far);
  const label = deps.browserStatusLabel();
  if (deps.statusDiffers(label)) deps.setStatus("audio", label);
}

export function onFaceEdge(button) {
  if (PLAYFIELD_FACE.has(button)) return;
  if (!controller.fx[button]) return;
  setActiveFx(button);
}

export function onFaceCommand(button) {
  if (!controller.fx[button]) return;
  if (button === "circle") {
    clearBoard();
    return;
  }
  if (button === "square") {
    void setFallingAudioEnabled(!fallingAudioEnabled);
    return;
  }
  if (button === "cross") return;
  setActiveFx(button);
}
