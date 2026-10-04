import { STEM_CORNERS, notify, tickMixer } from "./mixer-core.js?v=67";
import { audioEngine } from "./audio-engine.js?v=97";
import { gamepadInput } from "./gamepad-input.js?v=19";
import { dualsenseHid } from "./dualsense-hid.js?v=5";
import { mountUiScrolls } from "./ui-scroll.js?v=1";
import * as diagnostics from "./diagnostics.js?v=37";
import * as fallingTab from "./falling-tab.js?v=99";
import * as visualizeTab from "./visualize-tab.js?v=27";

const statusEl = document.querySelector(".status");
const audioHealthEl = document.querySelector("[data-audio-health]");
const audioQuadRoot = document.querySelector("[data-audio-quads]");
const audioQuadEls = {
  tl: audioQuadRoot?.querySelector("[data-audio-quad='tl']") || null,
  tr: audioQuadRoot?.querySelector("[data-audio-quad='tr']") || null,
  bl: audioQuadRoot?.querySelector("[data-audio-quad='bl']") || null,
  br: audioQuadRoot?.querySelector("[data-audio-quad='br']") || null,
};
const AUDIO_QUADS = ["tl", "tr", "bl", "br"];
const statusParts = {
  audio: document.querySelector("[data-status-audio]"),
  mouse: document.querySelector("[data-status-mouse]"),
  pad: document.querySelector("[data-status-pad]"),
};
const catalogCountEls = document.querySelectorAll("[data-catalog-counts]");
let statusText = "";
let statusKey = "";
let audioHealthKey = "";
let audioQuadKey = "";
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

/** Text fields keep the system caret and loupe. Everything else is a control surface. */
function isTextEntryTarget(target) {
  return !!(
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable='true']")
  );
}

document.addEventListener("selectstart", (event) => {
  if (!isTextEntryTarget(event.target)) event.preventDefault();
});

document.addEventListener("selectionchange", () => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return;
  const node = sel.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  if (isTextEntryTarget(el)) return;
  sel.removeAllRanges();
});

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
  if (audioEngine.ctx && !audioEngine.speakerProved()) return "Tap for audio";
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

function escDebug(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

function quadSignature(quad) {
  if (!quad) return "";
  const meters = quad.meters || {};
  return [
    quad.name,
    quad.piles,
    quad.cells,
    (quad.cols || []).join(","),
    quad.rise,
    Number(quad.height).toFixed(2),
    Number(quad.mass).toFixed(2),
    Number(meters.send).toFixed(2),
    Number(meters.fb).toFixed(2),
    Number(meters.h).toFixed(2),
    Number(meters.mass).toFixed(2),
  ].join(":");
}

function paintQuadCell(el, quad) {
  const name = quad?.name || "—";
  const piles = Math.max(0, Number(quad?.piles) || 0);
  const cells = Math.max(0, Number(quad?.cells) || 0);
  const rise = Math.max(0, Number(quad?.rise) || 0);
  const cols = Array.isArray(quad?.cols) ? quad.cols : [];
  const meters = quad?.meters || {};
  const bars = cols
    .map((n) => `<span style="flex:${Math.max(1, Number(n) || 1)} 1 0"></span>`)
    .join("");
  const meter = (key, value, label) => {
    const level = Math.max(0, Math.min(1, Number(meters[key]) || 0));
    return `<div class="falling-meter"><div class="falling-meter-track"><div class="falling-meter-fill" style="height:${(level * 100).toFixed(1)}%"></div></div><span class="falling-meter-value">${escDebug(value)}</span><span class="falling-meter-label">${label}</span></div>`;
  };
  el.innerHTML = `<div class="falling-quad-name">${escDebug(name)}</div><div class="falling-quad-meta">${quad ? `${piles} piles · ${cells} cols · ${rise} rise` : "—"}</div><div class="falling-pilebar">${bars}</div><div class="falling-meters">${meter("h", Number(quad?.height || 0).toFixed(1), "h")}${meter("mass", Number(quad?.mass || 0).toFixed(1), "mass")}${meter("send", Number(quad?.send || 0).toFixed(2), "send")}${meter("fb", Number(quad?.feedback || 0).toFixed(2), "fb")}</div>`;
  el.dataset.empty = piles === 0 && rise === 0 && !(Number(quad?.height) > 0) ? "true" : "";
}

function paintAudioHealth() {
  if (audioHealthEl) {
    const text = audioEngine.audioHealthLabel();
    if (text !== audioHealthKey) {
      audioHealthKey = text;
      audioHealthEl.textContent = text;
    }
  }
  const quads = audioEngine.fieldQuads();
  const nameKey = AUDIO_QUADS.map((id) => STEM_CORNERS[id]?.label || "").join("\u0000");
  const key = `${quads ? AUDIO_QUADS.map((id) => quadSignature(quads[id])).join("\u0000") : ""}\u0001${nameKey}`;
  if (key === audioQuadKey) return;
  audioQuadKey = key;
  for (const id of AUDIO_QUADS) {
    const el = audioQuadEls[id];
    if (!el) continue;
    const quad = quads?.[id];
    paintQuadCell(el, quad || { name: STEM_CORNERS[id]?.label || id.toUpperCase() });
  }
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
    mouse,
    pad,
    label: [audio, "mouse", "DualSense"].join(" · "),
  };
}

function statusSignature() {
  const facts = statusFacts();
  return [
    audioStatusState(),
    facts.label,
    facts.audio === "Browser audio",
    facts.mouse,
    facts.pad,
  ].join("|");
}

function paintStatusLine() {
  const facts = statusFacts();
  paintStatusPart(statusParts.audio, facts.audio, facts.audio === "Browser audio");
  paintStatusPart(statusParts.mouse, "mouse", facts.mouse);
  paintStatusPart(statusParts.pad, "DualSense", facts.pad);
}

function catalogCountsLabel() {
  return `${countPhrase(wamCount, "WAM", "WAMs")} · ${countPhrase(sampleCount, "sample", "samples")}`;
}

function paintCatalogCounts() {
  const text = catalogCountsLabel();
  for (const el of catalogCountEls) {
    if (el.textContent !== text) el.textContent = text;
  }
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
  paintCatalogCounts();
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

function unlockBedsFromGesture(event, phase) {
  if (!event.isTrusted) return;
  if (activeTab === "falling-blocks" && !fallingTab.isAudioEnabled()) return;
  audioEngine.beginGesture(true, phase);
  if (audioEngine.takeGraphRestart()) void ensureBrowserAudio();
}

document.addEventListener("touchstart", (event) => unlockBedsFromGesture(event, "press"), true);
document.addEventListener("pointerdown", (event) => unlockBedsFromGesture(event, "press"), true);
document.addEventListener("keydown", (event) => unlockBedsFromGesture(event, "press"), true);
document.addEventListener("touchend", (event) => unlockBedsFromGesture(event, "lift"), true);
document.addEventListener("click", (event) => unlockBedsFromGesture(event, "lift"), true);
window.addEventListener("pagehide", () => {
  audioEngine.forgetSpeakerProof();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    audioEngine.forgetSpeakerProof();
    return;
  }
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
