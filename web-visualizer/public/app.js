import { STEM_CORNERS, notify, tickMixer } from "./mixer-core.js?v=67";
import { audioEngine } from "./audio-engine.js?v=111";
import { gamepadInput } from "./gamepad-input.js?v=19";
import { dualsenseHid } from "./dualsense-hid.js?v=5";
import { mountUiScrolls } from "./ui-scroll.js?v=1";
import * as diagnostics from "./diagnostics.js?v=50";
import * as fallingTab from "./falling-tab.js?v=116";
import * as visualizeTab from "./visualize-tab.js?v=41";

const statusEl = document.querySelector(".status");
const audioLineEls = {
  splashes: document.querySelector("[data-audio-line='splashes']"),
  flow: document.querySelector("[data-audio-line='flow']"),
  voices: document.querySelector("[data-audio-line='voices']"),
  voiceDetail: document.querySelector("[data-audio-line='voice-detail']"),
  wams: document.querySelector("[data-audio-line='wams']"),
  rising: document.querySelector("[data-audio-line='rising']"),
};
const audioValueEls = {
  splashes: document.querySelector("[data-audio-value='splashes']"),
  flow: document.querySelector("[data-audio-value='flow']"),
  voices: document.querySelector("[data-audio-value='voices']"),
  rising: document.querySelector("[data-audio-value='rising']"),
};
const risingRowEl = document.querySelector("[data-audio-row='rising']");
const sparkLineEls = {
  splashes: document.querySelector("[data-audio-spark='splashes']"),
  flow: document.querySelector("[data-audio-spark='flow']"),
  voices: document.querySelector("[data-audio-spark='voices']"),
  rising: document.querySelector("[data-audio-spark='rising']"),
};
const sparkFillEls = {
  splashes: document.querySelector("[data-audio-spark-fill='splashes']"),
  flow: document.querySelector("[data-audio-spark-fill='flow']"),
  voices: document.querySelector("[data-audio-spark-fill='voices']"),
  rising: document.querySelector("[data-audio-spark-fill='rising']"),
};
const sparkMaxEls = {
  splashes: document.querySelector("[data-audio-spark-max='splashes']"),
  flow: document.querySelector("[data-audio-spark-max='flow']"),
  voices: document.querySelector("[data-audio-spark-max='voices']"),
  rising: document.querySelector("[data-audio-spark-max='rising']"),
};
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
  touch: document.querySelector("[data-status-touch]"),
  pad: document.querySelector("[data-status-pad]"),
};
const catalogCountEls = document.querySelectorAll("[data-catalog-counts]");
let statusText = "";
let statusKey = "";
let audioHealthKey = "";
const SPARK_MS = 250;
const SPARK_LEN = 48;
/** Minimum top of each spark, so a quiet trace does not zoom to a single blip. Voices start at the four beds. */
const SPARK_FLOOR = { splashes: 8, flow: 20, voices: 4, rising: 16 };
const sparkHistory = { splashes: [], flow: [], voices: [], rising: [] };
let sparkAt = 0;
let audioQuadKey = "";
let mouseSeen = false;
let touchSeen = false;
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

function touchAvailable() {
  if (touchSeen) return true;
  const coarse = window.matchMedia?.("(pointer: coarse)");
  return !!coarse?.matches;
}

function notePointer(event) {
  if (event.pointerType === "mouse" || event.pointerType === "pen") mouseSeen = true;
  else if (event.pointerType === "touch") touchSeen = true;
}

window.addEventListener("pointerdown", notePointer, true);
window.addEventListener("pointermove", notePointer, true);

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

const AUDIO_PREF_KEY = "audible-field.audio";

function readAudioPref() {
  try {
    return localStorage.getItem(AUDIO_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeAudioPref(on) {
  try {
    localStorage.setItem(AUDIO_PREF_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

function syncAudioSwitch() {
  const button = document.querySelector("[data-audio-switch]");
  if (!(button instanceof HTMLButtonElement)) return;
  const on = audioEngine.isAudible();
  button.setAttribute("aria-checked", on ? "true" : "false");
  button.setAttribute("aria-label", on ? "Audio on" : "Audio off");
  button.title = on ? "Turn audio off" : "Turn audio on";
}

function setGlobalAudio(on) {
  const enabled = !!on;
  audioEngine.setAudible(enabled);
  writeAudioPref(enabled);
  syncAudioSwitch();
  refreshStatusLine();
  if (enabled) void ensureBrowserAudio();
}

function bindAudioSwitch() {
  const button = document.querySelector("[data-audio-switch]");
  if (!(button instanceof HTMLButtonElement) || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  syncAudioSwitch();
  button.addEventListener("click", () => {
    setGlobalAudio(!audioEngine.isAudible());
  });
}

function audioKindLabel() {
  if (activeTab === "falling-blocks" && !fallingTab.isAudioEnabled()) return "Audio off";
  if (audioStarting) return "Loading audio";
  if (!audioEngine.running) return "Audio off";
  // Before the first trusted press, the browser holds the context suspended.
  if (audioEngine.ctx && !audioEngine.unlocked() && !audioEngine.outputRunning()) return "Tap for audio";
  // The header switch suspends the context. Keep the audio type, and grey it.
  if (audioEngine.isAudible()) {
    const state = audioEngine.ctx?.state;
    if (state === "suspended") return "Audio paused";
    if (state === "interrupted") return "Audio interrupted";
    if (state === "closed") return "Audio closed";
    if (state && state !== "running") return "Audio paused";
  }
  return "Browser audio";
}

function audioStatusLit() {
  return audioKindLabel() === "Browser audio" && audioEngine.isAudible();
}

function audioShouldBeAudible() {
  if (!audioEngine.isAudible()) return false;
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

function rememberSpark(id, value) {
  const buf = sparkHistory[id];
  const n = Number(value) || 0;
  if (!buf.length) {
    for (let i = 0; i < SPARK_LEN; i += 1) buf.push(n);
    return;
  }
  buf.push(n);
  if (buf.length > SPARK_LEN) buf.shift();
}

function paintSpark(id) {
  const line = sparkLineEls[id];
  const fill = sparkFillEls[id];
  const values = sparkHistory[id];
  if (!line || !values.length) return;
  let max = SPARK_FLOOR[id];
  for (let i = 0; i < values.length; i += 1) if (values[i] > max) max = values[i];
  max = Math.ceil(max);
  const scale = sparkMaxEls[id];
  if (scale) {
    const text = String(max);
    if (scale.textContent !== text) scale.textContent = text;
  }
  const pts = [];
  const last = values.length - 1;
  for (let i = 0; i < values.length; i += 1) {
    const x = last === 0 ? 0 : (i / last) * 100;
    const y = 24 - (Math.max(0, values[i]) / max) * 24;
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  const points = pts.join(" ");
  line.setAttribute("points", points);
  if (fill) fill.setAttribute("points", `0,24 ${points} 100,24`);
}

function setAudioLine(id, text) {
  const el = audioLineEls[id];
  if (el && el.textContent !== text) el.textContent = text;
}

function setAudioValue(id, text) {
  const el = audioValueEls[id];
  if (el && el.textContent !== text) el.textContent = text;
}

/** "Audio voices 12  rise 6/8  piles 1" → count on the graph row, the rest underneath. */
function splitVoiceLine(text) {
  const parts = String(text || "").split(/\s{2,}/);
  return {
    count: parts[0] || "",
    detail: parts.slice(1).join("  "),
  };
}

function paintAudioHealth() {
  const health = audioEngine.audioHealth();
  const text = [health.lines.splashes, health.lines.flow, health.lines.voices, health.lines.wams, health.lines.rising].join("\n");
  if (text !== audioHealthKey) {
    audioHealthKey = text;
    const voiceLine = splitVoiceLine(health.lines.voices);
    setAudioValue("splashes", `${health.splashesPerSec}/s`);
    setAudioValue("flow", `${health.flowAtomsPerSec} atoms/s`);
    setAudioValue("voices", String(health.voices.total));
    setAudioValue("rising", health.rising == null ? "—" : String(health.rising));
    setAudioLine("voiceDetail", voiceLine.detail);
    if (audioLineEls.voiceDetail) audioLineEls.voiceDetail.hidden = !voiceLine.detail;
    setAudioLine("wams", health.lines.wams);
    if (risingRowEl) risingRowEl.hidden = health.rising == null;
  }
  const now = performance.now();
  if (!sparkHistory.splashes.length || now - sparkAt >= SPARK_MS) {
    sparkAt = now;
    rememberSpark("splashes", health.splashesPerSec);
    rememberSpark("flow", health.flowAtomsPerSec);
    rememberSpark("voices", health.voices.total);
    rememberSpark("rising", health.rising);
    paintSpark("splashes");
    paintSpark("flow");
    paintSpark("voices");
    paintSpark("rising");
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
  const touch = touchAvailable();
  const pad = dualSenseAvailable();
  return {
    audio,
    mouse,
    touch,
    pad,
    label: [audio, "mouse", "touchscreen", "DualSense"].join(" · "),
  };
}

function statusSignature() {
  const facts = statusFacts();
  return [
    audioStatusState(),
    facts.label,
    audioStatusLit(),
    facts.mouse,
    facts.touch,
    facts.pad,
  ].join("|");
}

function paintStatusLine() {
  const facts = statusFacts();
  paintStatusPart(statusParts.audio, facts.audio, audioStatusLit());
  paintStatusPart(statusParts.mouse, "mouse", facts.mouse);
  paintStatusPart(statusParts.touch, "touchscreen", facts.touch);
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
  // The trace panel's own Share button must not count as the unlock tap.
  if (event.target instanceof Element && event.target.closest("[data-audio-trace]")) return;
  const facts = {
    ev: event.type,
    act: navigator.userActivation?.isActive ?? "n/a",
    tab: activeTab,
  };
  if (!audioEngine.isAudible()) {
    audioEngine.trace(`${phase}-skip`, { ...facts, why: "switch-off" });
    return;
  }
  if (activeTab === "falling-blocks" && !fallingTab.isAudioEnabled()) {
    audioEngine.trace(`${phase}-skip`, { ...facts, why: "field-audio-off" });
    return;
  }
  audioEngine.trace(phase, facts);
  audioEngine.beginGesture(true, phase);
  if (phase === "press") void ensureBrowserAudio();
}

// Press: the earliest trusted event. Lift: the events the HTML spec counts as
// activation triggers (pointerup, touchend, click), in case the press was not one.
document.addEventListener("touchstart", (event) => unlockBedsFromGesture(event, "press"), true);
document.addEventListener("pointerdown", (event) => unlockBedsFromGesture(event, "press"), true);
document.addEventListener("keydown", (event) => unlockBedsFromGesture(event, "press"), true);
document.addEventListener("pointerup", (event) => unlockBedsFromGesture(event, "lift"), true);
document.addEventListener("touchend", (event) => unlockBedsFromGesture(event, "lift"), true);
document.addEventListener("click", (event) => unlockBedsFromGesture(event, "lift"), true);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!audioShouldBeAudible()) return;
  void audioEngine.recoverForeground();
});

const TRACE_STORE_KEY = "audible-field.trace-log";
const TRACE_STORE_MAX = 600;

/**
 * Audio trace for the phone, where there is no console.
 * Open the page with `?trace` (or set localStorage "audible-field.trace" to "1").
 * Every press, lift, context change, and bed event makes one line. Lines go to:
 *  - the on-screen panel (newest first),
 *  - `POST /trace`, which the LAN server appends to web-visualizer/trace.log,
 *  - localStorage, so a reload keeps the previous load's lines,
 *  - the Share button, which hands the whole log to the share sheet as a .txt file.
 */
function mountAudioTrace() {
  let wanted = false;
  try {
    wanted = new URLSearchParams(location.search).has("trace") || localStorage.getItem("audible-field.trace") === "1";
  } catch {
    /* storage unavailable */
  }
  if (!wanted) {
    audioEngine.onTrace = (event, facts) => {
      console.info("[EchoScape trace]", event, facts);
    };
    return;
  }

  const startedAt = performance.now();
  const session = new Date().toISOString();
  const ua = navigator.userAgent.replace(/\s+/g, " ");
  const header = `# ${session} ${location.href} ${ua}`;

  /** @type {string[]} */
  let stored = [];
  try {
    const raw = localStorage.getItem(TRACE_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) stored = parsed.filter((line) => typeof line === "string");
  } catch {
    stored = [];
  }
  stored.push(header);
  const saveStored = () => {
    try {
      const trimmed = stored.length > TRACE_STORE_MAX ? stored.slice(stored.length - TRACE_STORE_MAX) : stored;
      localStorage.setItem(TRACE_STORE_KEY, JSON.stringify(trimmed));
    } catch {
      /* storage full or unavailable */
    }
  };
  saveStored();

  // Server sink. Batched; gives up after the first failure (static hosting has no /trace).
  let serverOk = true;
  /** @type {string[]} */
  let outbox = [header];
  let flushTimer = 0;
  const flush = () => {
    flushTimer = 0;
    if (!serverOk || !outbox.length) return;
    const body = outbox.join("\n");
    outbox = [];
    fetch("/trace", {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body,
      keepalive: true,
    })
      .then((res) => {
        if (!res.ok) serverOk = false;
      })
      .catch(() => {
        serverOk = false;
      });
  };
  const queue = (line) => {
    if (!serverOk) return;
    outbox.push(line);
    if (!flushTimer) flushTimer = window.setTimeout(flush, 400);
  };
  window.addEventListener("pagehide", () => {
    if (flushTimer) window.clearTimeout(flushTimer);
    flush();
  });
  // Send the header now, so the panel learns at once whether a file sink exists.
  flush();

  // Lives in Settings so it never covers Emit or the field controls.
  const panel = document.createElement("div");
  panel.setAttribute("data-audio-trace", "");
  panel.style.cssText =
    "pointer-events:auto;align-self:stretch;width:min(100%,22rem);box-sizing:border-box;" +
    "display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:8px;" +
    "font:10px/1.3 ui-monospace,Menlo,Consolas,monospace;color:#e8ffe8;background:rgba(0,0,0,.72);text-align:left";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;align-items:center";
  const status = document.createElement("span");
  status.style.cssText = "opacity:.75;flex:1 1 auto";
  const share = document.createElement("button");
  share.type = "button";
  share.textContent = "Share trace";
  share.style.cssText =
    "font:inherit;padding:6px 10px;border:1px solid #6c6;border-radius:4px;background:#143;color:#e8ffe8";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear";
  clear.style.cssText =
    "font:inherit;padding:6px 10px;border:1px solid #666;border-radius:4px;background:#222;color:#ccc";
  bar.append(status, share, clear);
  const body = document.createElement("pre");
  body.style.cssText =
    "margin:0;max-height:9rem;overflow:auto;white-space:pre-wrap;pointer-events:auto;-webkit-overflow-scrolling:touch";
  panel.append(bar, body);
  const settings = document.querySelector("[data-falling-settings-panel]");
  if (settings) settings.appendChild(panel);
  else document.body.appendChild(panel);

  const shown = [];
  const setStatus = (text) => {
    status.textContent = text;
  };
  setStatus(`${stored.length} lines`);

  const fullText = () => stored.join("\n");
  const fileName = () => `audible-field-trace-${session.replace(/[:.]/g, "-")}.txt`;

  // pointerdown, not click: the field cancels touchstart, so click never arrives.
  share.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.stopPropagation();
    void shareTrace();
  });
  clear.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.stopPropagation();
    stored = [header];
    shown.length = 0;
    body.textContent = "";
    saveStored();
    setStatus("cleared");
  });

  async function shareTrace() {
    const text = fullText();
    try {
      const file = new File([text], fileName(), { type: "text/plain" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "Audible Field trace" });
        setStatus("shared file");
        return;
      }
      if (navigator.share) {
        await navigator.share({ text, title: "Audible Field trace" });
        setStatus("shared text");
        return;
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        setStatus("share cancelled");
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied to clipboard");
      return;
    } catch {
      /* fall through to download */
    }
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus("downloaded");
  }

  audioEngine.onTrace = (event, facts) => {
    const at = ((performance.now() - startedAt) / 1000).toFixed(2).padStart(6);
    const rest = Object.entries(facts)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    const line = `${at} ${event.padEnd(11)} ${rest}`;
    console.info("[EchoScape trace]", line);
    stored.push(line);
    saveStored();
    queue(line);
    shown.unshift(line);
    if (shown.length > 14) shown.pop();
    body.textContent = shown.join("\n");
    setStatus(`${stored.length} lines${serverOk ? " · file" : ""}`);
  };
}

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

mountAudioTrace();
if (!readAudioPref()) audioEngine.setAudible(false);
bindAudioSwitch();
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
