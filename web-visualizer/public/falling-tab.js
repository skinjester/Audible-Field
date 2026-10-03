import { audioEngine } from "./audio-engine.js?v=80";
import {
  clearBoard,
  hideFallingBlocks,
  onFallingAudioToggle,
  readGridSnapshot,
  showFallingBlocks,
} from "./falling-blocks.js?v=351";
import { fieldFrame, resetFieldSonify } from "./grid-sonify.js?v=40";
import { controller, setActiveFx } from "./mixer-core.js?v=67";

/** falling-input.js already turns these into clear, audio toggle, and emit. */
const PLAYFIELD_FACE = new Set(["circle", "square", "cross"]);
const QUAD_IDS = ["tl", "tr", "bl", "br"];

/** Beds, diffuse tails, or a landing still in the graph. An empty grid is none of these. */
function fieldAudible(shadow) {
  for (const id of QUAD_IDS) {
    if ((shadow.gains?.[id] || 0) > 0.001) return true;
    if ((shadow.diffuses?.[id] || 0) > 0.001) return true;
    if ((shadow.wets?.[id] || 0) > 0.001) return true;
    if ((shadow.feedbacks?.[id] || 0) > 0.001) return true;
  }
  return false;
}

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
    const state = audioEngine.ctx?.state;
    if (!(audioEngine.running && (state === "suspended" || state === "interrupted"))) return;
    await audioEngine.ensurePlaying();
    deps.setStatus(audioEngine.running ? "audio" : "offline", deps.browserStatusLabel());
  });
}

export function tick(frame) {
  if (!deps) return;
  if (!(audioEngine.running && fallingAudioEnabled)) return;
  const snap = readGridSnapshot();
  const shadow = fieldFrame(snap, frame?.dt || 0);
  audioEngine.sync({ x: 0.5, y: 0.5 }, shadow.controller, { stems: false });
  audioEngine.setStemGains(shadow.gains, shadow.pans, shadow.cutoffs);
  audioEngine.setStemPitch(shadow.notes);
  audioEngine.setStemReverb(shadow.reverbs, shadow.decays, shadow.longTails);
  audioEngine.setDiffuseGreyhole(shadow.diffuses, shadow.feedbacks, shadow.wets);
  audioEngine.setPileBody(shadow.halls, shadow.weights);
  if (shadow.splash) {
    try {
      audioEngine.playSplash(shadow.splash);
    } catch (err) {
      console.warn("[EchoScape audio] splash failed:", err?.message || err);
    }
  }
  audioEngine.setOutputLevel(
    fieldAudible(shadow) || audioEngine.hasLiveStrikes() || snap.mass > 0 ? 1 : 0
  );
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
