import { notify, tickMixer } from "./mixer-core.js?v=66";
import { audioEngine } from "./audio-engine.js?v=48";
import { gamepadInput } from "./gamepad-input.js?v=17";
import { dualsenseHid } from "./dualsense-hid.js?v=5";
import { mountUiScrolls } from "./ui-scroll.js?v=1";
import * as diagnostics from "./diagnostics.js?v=2";
import * as fallingTab from "./falling-tab.js?v=2";
import * as visualizeTab from "./visualize-tab.js?v=1";

const statusEl = document.querySelector(".status");
const statusLabel = document.querySelector("[data-status-label]");
const tabButtons = document.querySelectorAll("[data-tab]");
const panels = document.querySelectorAll("[data-panel]");

const TAB_IDS = new Set(["diagnostics", "visualize", "falling-blocks"]);
const TAB_STORAGE_KEY = "echoscape.tab";
/** @type {"diagnostics" | "visualize" | "falling-blocks"} */
let activeTab = "diagnostics";
let audioStarting = false;
/** @type {Promise<void> | null} */
let audioStartPromise = null;
let audioChain = Promise.resolve();
let lastFrame = 0;
let socketState = "offline";
/** @type {number} */
let statusMarqueeRaf = 0;

const tabs = {
  diagnostics: diagnostics,
  visualize: visualizeTab,
  "falling-blocks": fallingTab,
};

function setStatus(nextState, label) {
  socketState = nextState;
  if (statusEl) statusEl.dataset.state = nextState;
  if (statusLabel) statusLabel.textContent = label;
  stopStatusMarquee();
}

function statusDiffers(label) {
  return socketState !== "audio" || statusLabel?.textContent !== label;
}

function stopStatusMarquee() {
  if (!statusEl || !statusLabel) return;
  if (statusMarqueeRaf) {
    cancelAnimationFrame(statusMarqueeRaf);
    statusMarqueeRaf = 0;
  }
  statusEl.classList.remove("is-marquee");
  statusEl.style.removeProperty("--marquee-duration");
  statusLabel.style.transition = "none";
  statusLabel.style.transform = "translateX(0)";
  void statusLabel.offsetWidth;
  statusLabel.style.transition = "";
}

function startStatusMarquee() {
  if (!statusEl || !statusLabel) return;
  stopStatusMarquee();

  const clip = statusEl.querySelector(".status-label-clip");
  if (!clip) return;

  statusLabel.style.maxWidth = "none";
  statusLabel.style.overflow = "visible";
  statusLabel.style.textOverflow = "clip";
  const fullWidth = statusLabel.scrollWidth;
  statusLabel.style.maxWidth = "";
  statusLabel.style.overflow = "";
  statusLabel.style.textOverflow = "";

  const overflow = fullWidth - clip.clientWidth;
  if (overflow <= 2) return;

  const duration = Math.min(0.6, Math.max(0.12, overflow / 900));
  statusEl.style.setProperty("--marquee-duration", `${duration}s`);
  statusEl.classList.add("is-marquee");
  statusLabel.style.transform = "translateX(0)";

  statusMarqueeRaf = requestAnimationFrame(() => {
    statusMarqueeRaf = requestAnimationFrame(() => {
      statusLabel.style.transform = `translateX(-${overflow}px)`;
      statusMarqueeRaf = 0;
    });
  });
}

if (statusEl) {
  statusEl.addEventListener("mouseenter", startStatusMarquee);
  statusEl.addEventListener("mouseleave", stopStatusMarquee);
  statusEl.addEventListener("focusin", startStatusMarquee);
  statusEl.addEventListener("focusout", stopStatusMarquee);
}

function browserStatusLabel() {
  if (activeTab === "falling-blocks") {
    return fallingTab.isAudioEnabled()
      ? "Falling Blocks — quadrants"
      : "Falling Blocks — audio off";
  }
  if (audioStarting) return "Loading beds…";
  if (!audioEngine.running) return "Browser audio — click pad to start";
  if (audioEngine.ctx?.state === "suspended") {
    return "Browser audio — click pad to unmute";
  }
  if (dualsenseHid.connected) {
    return "Browser audio · DualSense touchpad";
  }
  return "Browser audio · mouse + DualSense";
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
  return "diagnostics";
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
const hashTab = location.hash.replace("#", "");
setActiveTab(TAB_IDS.has(hashTab) ? hashTab : storedTab());
void startBrowserAudio();
