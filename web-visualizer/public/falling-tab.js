import { audioEngine } from "./audio-engine.js?v=103";
import {
  clearBoard,
  hideFallingBlocks,
  onFallingAudioToggle,
  onFieldPress,
  readGridSnapshot,
  showFallingBlocks,
} from "./falling-blocks.js?v=383";
import { fieldDebug, fieldFrame, resetFieldSonify, setDiffuseReverb } from "./grid-sonify.js?v=55";
import { STEM_CORNERS, controller, setActiveFx } from "./mixer-core.js?v=67";

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
    audioEngine.beginGesture(true);
    resetFieldSonify();
    void deps.ensureBrowserAudio().then(() => {
      deps.setStatus(audioEngine.running ? "audio" : "loading", deps.browserStatusLabel());
    }, (err) => {
      console.error(err);
    });
    return;
  }
  resetFieldSonify();
  audioEngine.syncRiseGrains(null);
  void deps.enqueueAudio(async () => {
    if (deps.getActiveTab() !== "falling-blocks" || isAudioEnabled()) return;
    if (audioEngine.running) {
      audioEngine.setStemPitch(null);
      await audioEngine.suspendPlayback();
    }
    deps.setStatus("offline", deps.browserStatusLabel());
  });
}

const RISE_MODES = {
  drift: "The piece keeps playing, thins as it shrinks, and drifts upward.",
  loose: "A bright scrap of the bed keeps playing at the pile's pitch, and fades as the atom shrinks.",
  flake: "One bright speck of the bed when the atom lifts off.",
  thread: "A lower strand of the bed is pulled free and thins as the atom shrinks.",
  shed: "The atom keeps dropping short specks of the bed on the way up.",
  halo: "A midrange band of the bed. The band rises with the cluster, on the same height that opens the reverb.",
};

function bindRiseModeUi() {
  const group = document.querySelector("[data-falling-rise-modes]");
  if (!(group instanceof HTMLElement) || group.dataset.bound === "1") return;
  group.dataset.bound = "1";
  const hint = group.querySelector("[data-falling-rise-hint]");
  const inputs = group.querySelectorAll("input[name='falling-rise-mode']");
  let stored = "";
  try {
    stored = sessionStorage.getItem("echoscape.riseMode") || "";
  } catch {
    /* private mode */
  }
  const initial = Object.prototype.hasOwnProperty.call(RISE_MODES, stored) ? stored : "drift";
  audioEngine.setRiseMode(initial);
  // A label click never arrives: the playfield cancels touchstart.
  group.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element)) return;
    const label = event.target.closest(".falling-rise-option");
    if (!(label instanceof HTMLLabelElement) || !group.contains(label)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const input = label.querySelector("input");
    if (!(input instanceof HTMLInputElement)) return;
    event.stopPropagation();
    if (input.checked) return;
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  for (const input of inputs) {
    if (!(input instanceof HTMLInputElement)) continue;
    input.checked = input.value === initial;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const mode = Object.prototype.hasOwnProperty.call(RISE_MODES, input.value) ? input.value : "drift";
      audioEngine.setRiseMode(mode);
      if (hint) hint.textContent = RISE_MODES[mode];
      try {
        sessionStorage.setItem("echoscape.riseMode", mode);
      } catch {
        /* private mode */
      }
    });
  }
  if (hint) hint.textContent = RISE_MODES[initial];
}

const DIFFUSE_REVERB_KEY = "echoscape.diffuseReverb";

function bindDiffuseReverbUi() {
  const button = document.querySelector("[data-falling-diffuse-reverb]");
  if (!(button instanceof HTMLButtonElement) || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  const apply = (on) => {
    button.setAttribute("aria-checked", on ? "true" : "false");
    button.title = on ? "Turn reverb off" : "Turn reverb on";
    setDiffuseReverb(on);
    try {
      sessionStorage.setItem(DIFFUSE_REVERB_KEY, on ? "1" : "0");
    } catch {
      /* private mode */
    }
  };
  let stored = "1";
  try {
    stored = sessionStorage.getItem(DIFFUSE_REVERB_KEY) || "1";
  } catch {
    /* private mode */
  }
  apply(stored !== "0");
  onFieldPress(button, () => {
    apply(button.getAttribute("aria-checked") !== "true");
  });
}

function bindFallingAudioUi() {
  const button = document.querySelector("[data-falling-audio]");
  if (!(button instanceof HTMLButtonElement) || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  syncFallingAudioButton();
  onFieldPress(button, () => {
    void setFallingAudioEnabled(!fallingAudioEnabled);
  });
}

export function initFallingTab(nextDeps) {
  deps = nextDeps;
  bindFallingAudioUi();
  bindRiseModeUi();
  bindDiffuseReverbUi();
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
  audioEngine.syncRiseGrains(null);
  audioEngine.setFieldDebug(null);
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
  if (!(audioEngine.running && fallingAudioEnabled)) {
    audioEngine.setFieldDebug(null);
    return;
  }
  const snap = readGridSnapshot();
  const shadow = fieldFrame(snap, frame?.dt || 0);
  const sampleNames = {};
  for (const id of QUAD_IDS) sampleNames[id] = STEM_CORNERS[id]?.label || id.toUpperCase();
  audioEngine.setFieldDebug(fieldDebug(snap, shadow, sampleNames));
  audioEngine.sync({ x: 0.5, y: 0.5 }, shadow.controller, { stems: false });
  audioEngine.setStemGains(shadow.gains, shadow.pans, shadow.cutoffs);
  audioEngine.setStemPitch(shadow.notes);
  audioEngine.setStemReverb(shadow.reverbs, shadow.decays, shadow.longTails);
  audioEngine.setDiffuseGreyhole(shadow.diffuses, shadow.feedbacks, shadow.wets);
  audioEngine.setPileBody(shadow.halls, shadow.weights);
  audioEngine.syncRiseGrains(snap.rises);
  if (shadow.splash) {
    try {
      audioEngine.playSplash(shadow.splash);
    } catch (err) {
      console.warn("[EchoScape audio] splash failed:", err?.message || err);
    }
  }
  audioEngine.setOutputLevel(
    fieldAudible(shadow) || audioEngine.diffuseTailOpen() || audioEngine.hasLiveStrikes() || snap.mass > 0 ? 1 : 0
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
