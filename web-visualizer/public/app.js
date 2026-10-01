import { notify, tickMixer } from "./mixer-core.js?v=67";
import { audioEngine } from "./audio-engine.js?v=65";
import { gamepadInput } from "./gamepad-input.js?v=19";
import { dualsenseHid } from "./dualsense-hid.js?v=5";
import { mountUiScrolls } from "./ui-scroll.js?v=1";
import * as diagnostics from "./diagnostics.js?v=15";
import * as fallingTab from "./falling-tab.js?v=28";
import * as visualizeTab from "./visualize-tab.js?v=11";

const statusEl = document.querySelector(".status");
const audioHealthEl = document.querySelector("[data-audio-health]");
const statusParts = {
  audio: document.querySelector("[data-status-audio]"),
  wams: document.querySelector("[data-status-wams]"),
  samples: document.querySelector("[data-status-samples]"),
  mouse: document.querySelector("[data-status-mouse]"),
  pad: document.querySelector("[data-status-pad]"),
};
let statusText = "";
let statusKey = "";
let audioHealthKey = "";
let mouseSeen = false;
const tabButtons = document.querySelectorAll("[data-tab]");
const panels = document.querySelectorAll("[data-panel]");

const TAB_IDS = new Set(["diagnostics", "visualize", "falling-blocks"]);
const TAB_STORAGE_KEY = "audible-field.tab";
/** @type {"diagnostics" | "visualize" | "falling-blocks"} */
let activeTab = "falling-blocks";
let audioStarting = false;
/** @type {Promise<void> | null} */
let audioStartPromise = null;
let audioChain = Promise.resolve();
let lastFrame = 0;
let socketState = "offline";
/** @type {number | null} */
let sampleCount = null;
/** @type {number | null} */
let wamCount = null;

const tabs = {
  diagnostics: diagnostics,
  visualize: visualizeTab,
  "falling-blocks": fallingTab,
};

function setStatus(nextState, label) {
  socketState = nextState;
  statusText = label;
  if (statusEl) statusEl.dataset.state = nextState;
  paintStatusLine();
  statusKey = statusSignature();
}

function statusDiffers(label) {
  return statusText !== label;
}

function paintStatusPart(el, text, on) {
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle("is-off", !on);
}

function countPhrase(count, singular, plural) {
  if (count == null) return `… ${plural}`;
  const n = Number(count) || 0;
  return `${n} ${n === 1 ? singular : plural}`;
}

function mouseAvailable() {
  if (mouseSeen) return true;
  const fine = window.matchMedia?.("(any-pointer: fine), (pointer: fine), (hover: hover)");
  if (fine?.matches) return true;
  return navigator.maxTouchPoints === 0;
}

function noteMouse(event) {
  if (event.pointerType === "mouse" || event.pointerType === "pen") mouseSeen = true;
}

window.addEventListener("pointerdown", noteMouse, true);
window.addEventListener("pointermove", noteMouse, true);

function dualSenseAvailable() {
  if (dualsenseHid.connected || gamepadInput.connected) return true;
  const pads = navigator.getGamepads?.();
  if (!pads) return false;
  for (const pad of pads) {
    if (pad) return true;
  }
  return false;
}

function audioKindLabel() {
  if (activeTab === "falling-blocks" && !fallingTab.isAudioEnabled()) return "Audio off";
  if (audioStarting) return "Loading audio";
  if (!audioEngine.running) return "Audio off";
  const state = audioEngine.ctx?.state;
  if (state === "suspended") return "Audio paused";
  if (state === "interrupted") return "Audio interrupted";
  if (state === "closed") return "Audio closed";
  if (state && state !== "running") return "Audio paused";
  return "Browser audio";
}

function audioShouldBeAudible() {
  if (activeTab === "falling-blocks" && !fallingTab.isAudioEnabled()) return false;
  return !!(audioEngine.running || audioEngine.ctx);
}

function paintAudioHealth() {
  if (!audioHealthEl) return;
  const text = audioEngine.audioHealthLabel();
  if (text === audioHealthKey) return;
  audioHealthKey = text;
  audioHealthEl.textContent = text;
}

function audioStatusState() {
  if (audioStarting) return "loading";
  if (audioKindLabel() === "Browser audio") return "audio";
  return "offline";
}

function statusFacts() {
  const audio = audioKindLabel();
  const mouse = mouseAvailable();
  const pad = dualSenseAvailable();
  return {
    audio,
    wamsText: countPhrase(wamCount, "WAM", "WAMs"),
    wamsOn: wamCount > 0,
    samplesText: countPhrase(sampleCount, "sample", "samples"),
    samplesOn: sampleCount > 0,
    mouse,
    pad,
    label: [
      audio,
      countPhrase(wamCount, "WAM", "WAMs"),
      countPhrase(sampleCount, "sample", "samples"),
      "mouse",
      "DualSense",
    ].join(" · "),
  };
}

function statusSignature() {
  const facts = statusFacts();
  return [
    audioStatusState(),
    facts.label,
    facts.audio === "Browser audio",
    facts.wamsOn,
    facts.samplesOn,
    facts.mouse,
    facts.pad,
  ].join("|");
}

function paintStatusLine() {
  const facts = statusFacts();
  paintStatusPart(statusParts.audio, facts.audio, facts.audio === "Browser audio");
  paintStatusPart(statusParts.wams, facts.wamsText, facts.wamsOn);
  paintStatusPart(statusParts.samples, facts.samplesText, facts.samplesOn);
  paintStatusPart(statusParts.mouse, "mouse", facts.mouse);
  paintStatusPart(statusParts.pad, "DualSense", facts.pad);
}

function browserStatusLabel() {
  return statusFacts().label;
}

function refreshStatusLine() {
  const key = statusSignature();
  if (key === statusKey) return;
  setStatus(audioStatusState(), browserStatusLabel());
}

async function loadCatalogCounts() {
  try {
    const [samplesRes, wamsRes] = await Promise.all([
      fetch("/catalog/samples-all.json"),
      fetch("/catalog/wams.json"),
    ]);
    if (samplesRes.ok) {
      const data = await samplesRes.json();
      const groups = Array.isArray(data?.groups) ? data.groups : [];
      sampleCount = groups.reduce((sum, group) => sum + (group.files?.length || 0), 0);
    }
    if (wamsRes.ok) {
      const data = await wamsRes.json();
      wamCount = Array.isArray(data?.plugins) ? data.plugins.length : 0;
    }
  } catch (err) {
    console.warn("Could not count catalogs:", err);
  }
  refreshStatusLine();
}

/**
 * Suspend and resume share one chain. Each task re-reads the live tab when it starts.
 * @param {() => Promise<void> | void} task
 */
function enqueueAudio(task) {
  const run = audioChain.then(() => task());
  audioChain = run.then(
    () => undefined,
    (err) => {
      console.error(err);
    }
  );
  return run;
}

function unlockBedsFromGesture() {
  if (activeTab === "falling-blocks" && !fallingTab.isAudioEnabled()) return;
  audioEngine.beginGesture();
}

document.addEventListener("pointerdown", unlockBedsFromGesture, true);
document.addEventListener("keydown", unlockBedsFromGesture, true);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!audioShouldBeAudible()) return;
  void audioEngine.recoverForeground();
});

async function runEnsureBrowserAudio() {
  if (activeTab === "falling-blocks" && !fallingTab.isAudioEnabled()) return;
  if (audioEngine.running) {
    await audioEngine.resume();
    await audioEngine.ensurePlaying();
    return;
  }
  if (audioStartPromise) {
    await audioStartPromise;
    return;
  }

  audioStarting = true;
  setStatus("loading", "Loading soundscape beds…");
  audioStartPromise = audioEngine.start();

  try {
    await audioStartPromise;
    setStatus("audio", browserStatusLabel());
  } catch (err) {
    console.error(err);
    setStatus("offline", audioEngine.error || err.message || "Audio failed");
    throw err;
  } finally {
    audioStarting = false;
    audioStartPromise = null;
  }
}

function ensureBrowserAudio() {
  if (activeTab === "falling-blocks" && !fallingTab.isAudioEnabled()) return Promise.resolve();
  audioEngine.beginGesture();
  if (!audioEngine.running && !audioStartPromise) {
    audioStarting = true;
    setStatus("loading", "Loading soundscape beds…");
  }
  return enqueueAudio(runEnsureBrowserAudio);
}

async function startBrowserAudio() {
  gamepadInput.enable();
  dualsenseHid.enable();
  diagnostics.updateCornerLabels();
  diagnostics.updateFxPluginState();
  diagnostics.setFxName("cross", "WAM Off");
  diagnostics.setFxName("square", "Comb");
  diagnostics.setFxName("triangle", "Formant");
  diagnostics.setFxName("circle", "Crystallizer");
  setStatus(audioEngine.running ? "audio" : "loading", browserStatusLabel());
  await ensureBrowserAudio();
  diagnostics.syncFxLabelsFromEngine();
  setStatus(audioEngine.running ? "audio" : "offline", browserStatusLabel());
  diagnostics.updateDualsenseHidUi();
  diagnostics.renderDiagnostics();
}

function tick(now) {
  try {
    const frameDt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
    gamepadInput.poll();
    for (const button of gamepadInput.takeFaceEdges()) {
      tabs[activeTab].onFaceEdge(button);
    }
    if (dualsenseHid.poll()) diagnostics.noteDualSenseSource();
    diagnostics.syncDualsenseHidUi();
    tickMixer(now, lastFrame);
    lastFrame = now;
    tabs[activeTab].tick({ dt: frameDt });
    refreshStatusLine();
    paintAudioHealth();
  } catch (err) {
    console.error("EchoScape diagnostics tick failed:", err);
  }
  window.requestAnimationFrame(tick);
}

function storedTab() {
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    if (TAB_IDS.has(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return "falling-blocks";
}

function rememberTab(tabId) {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tabId);
  } catch {
    /* storage unavailable */
  }
}

function setActiveTab(tabId) {
  if (!TAB_IDS.has(tabId)) return;
  const prevTab = activeTab;
  activeTab = tabId;
  rememberTab(tabId);

  document.body.classList.toggle("mode-visualize", tabId === "visualize");
  document.body.classList.toggle("mode-falling-blocks", tabId === "falling-blocks");

  for (const button of tabButtons) {
    const active = button.dataset.tab === tabId;
    button.setAttribute("aria-selected", active ? "true" : "false");
  }

  let activePanel = null;
  for (const panel of panels) {
    const active = panel.dataset.panel === tabId;
    panel.hidden = !active;
    if (active) activePanel = panel;
  }
  void activePanel?.offsetHeight;

  if (prevTab !== tabId) tabs[prevTab].hide();
  tabs[tabId].show();
}

for (const button of tabButtons) {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab));
}

const deps = {
  getActiveTab: () => activeTab,
  ensureBrowserAudio,
  enqueueAudio,
  setStatus,
  browserStatusLabel,
  statusDiffers,
  gamepadInput,
  dualsenseHid,
};

diagnostics.initDiagnostics(deps);
fallingTab.initFallingTab(deps);

mountUiScrolls();
notify();
diagnostics.updateCornerLabels();
diagnostics.updateDualsenseHidUi();
diagnostics.renderDiagnostics();
window.requestAnimationFrame(tick);
void loadCatalogCounts();
const hashTab = location.hash.replace("#", "");
setActiveTab(TAB_IDS.has(hashTab) ? hashTab : storedTab());
void startBrowserAudio();
