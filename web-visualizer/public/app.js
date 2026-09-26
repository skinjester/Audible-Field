import {
  clamp01,
  controller,
  equalPowerMix,
  notify,
  setActiveFx,
  setFxName as setFxNameCore,
  setFxStick,
  setDpad,
  setRawStick,
  setRightStick,
  setStickClick,
  setShoulder,
  setTarget,
  setTrigger,
  setStemCorner,
  state,
  tickMixer,
  STEM_CORNERS,
} from "./mixer-core.js?v=65";
import { hideVisualize, showVisualize } from "./visualize.js?v=82";
import { clearBoard, hideFallingBlocks, showFallingBlocks, toggleBrushCurveInvert } from "./falling-blocks.js?v=120";
import { audioEngine } from "./audio-engine.js?v=20";
import { gamepadInput } from "./gamepad-input.js?v=6";
import { dualsenseHid, DualsenseHid } from "./dualsense-hid.js?v=4";
import { openStemDropdown } from "./sample-picker.js?v=15";
import { openFxDropdown } from "./fx-picker.js?v=3";
import {
  DEFAULT_STICK_SCALE,
  STICK_SCALE_STEP,
  STICK_SCALE_MIN,
  STICK_SCALE_MAX,
} from "./wam-catalog.js?v=4";

const pad = document.querySelector("[data-pad]");
const cursor = document.querySelector("[data-cursor]");
const crosshairX = document.querySelector(".crosshair.x");
const crosshairY = document.querySelector(".crosshair.y");
const statusEl = document.querySelector(".status");
const statusLabel = document.querySelector("[data-status-label]");
const sourceEl = document.querySelector("[data-source]");
const xEl = document.querySelector("[data-x]");
const yEl = document.querySelector("[data-y]");
const dpadEl = document.querySelector("[data-dpad]");
const fxActiveEl = document.querySelector("[data-fx-active]");
const stickRawXEl = document.querySelector("[data-stick-raw-x]");
const stickRawYEl = document.querySelector("[data-stick-raw-y]");
const rightXEl = document.querySelector("[data-right-x]");
const rightYEl = document.querySelector("[data-right-y]");
const ltEl = document.querySelector("[data-lt]");
const rtEl = document.querySelector("[data-rt]");
const ltBarEl = document.querySelector("[data-lt-bar]");
const rtBarEl = document.querySelector("[data-rt-bar]");
const lsEl = document.querySelector("[data-ls]");
const rsEl = document.querySelector("[data-rs]");
const l1El = document.querySelector("[data-l1]");
const r1El = document.querySelector("[data-r1]");
const leftDot = document.querySelector('[data-stick-dot="left"]');
const rightDot = document.querySelector('[data-stick-dot="right"]');
const dsConnectBtn = document.querySelector("[data-ds-connect]");
const dsConnectLabel = document.querySelector("[data-ds-connect-label]");
const dsStatusEl = document.querySelector("[data-ds-status]");
const tabButtons = document.querySelectorAll("[data-tab]");
const panels = document.querySelectorAll("[data-panel]");
const vizCanvas = document.querySelector("[data-viz-canvas]");
const fallingCanvas = document.querySelector("[data-falling-canvas]");
const modeButtons = document.querySelectorAll("[data-mode]");
const stemSlots = document.querySelectorAll("[data-stem-slot]");
const fxPluginBtns = document.querySelectorAll("[data-fx-plugin]");
const CORNER_TITLES = { tl: "TL", tr: "TR", bl: "BL", br: "BR" };
const fxCards = {
  cross: document.querySelector('[data-fx-card="cross"]'),
  square: document.querySelector('[data-fx-card="square"]'),
  triangle: document.querySelector('[data-fx-card="triangle"]'),
  circle: document.querySelector('[data-fx-card="circle"]'),
};
const fxButtonLabels = {
  cross: "X",
  square: "Square",
  triangle: "Triangle",
  circle: "Circle",
};
const fxLabels = {
  cross: "X · WAM Off",
  square: "Square · kHs Comb Filter",
  triangle: "Triangle · kHs Formant Filter",
  circle: "Circle · Crystallizer",
};
const vols = {
  tl: document.querySelector('[data-vol="tl"]'),
  tr: document.querySelector('[data-vol="tr"]'),
  bl: document.querySelector('[data-vol="bl"]'),
  br: document.querySelector('[data-vol="br"]'),
};
const quads = {
  tl: document.querySelector('[data-quad="tl"]'),
  tr: document.querySelector('[data-quad="tr"]'),
  bl: document.querySelector('[data-quad="bl"]'),
  br: document.querySelector('[data-quad="br"]'),
};

const VIZ_NAMES = {
  tl: "Sphere",
  tr: "Square",
  bl: "Torus",
  br: "Cylinder",
};

const dpadDirs = new Set(["up", "down", "left", "right"]);

/** @type {"max" | "browser"} */
let inputMode = "browser";
const TAB_IDS = new Set(["diagnostics", "visualize", "falling-blocks"]);
const TAB_STORAGE_KEY = "echoscape.tab";

/** @type {"diagnostics" | "visualize" | "falling-blocks"} */
let activeTab = "diagnostics";
/** True while Falling Blocks has suspended browser playback. */
let audioOffForFallingBlocks = false;
let audioStarting = false;
/** @type {Promise<void> | null} */
let audioStartPromise = null;

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

let lastLive = 0;
let lastFrame = 0;
let socketState = "offline";

function lerp(inMin, inMax, outMin, outMax, value) {
  if (inMax === inMin) return outMin;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

function axisPct(n) {
  const t = Math.min(1, Math.max(0, (Number(n) || 0) * 0.5 + 0.5));
  return `calc(5px + (100% - 10px) * ${t})`;
}

function triggerAmt(n) {
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n) > 1.5) return clamp01(n / 255);
  return clamp01(n);
}

function applyRawStick(nx, ny) {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
  setRawStick(nx, ny);
  setFxStick("cross", lerp(-1, 1, 0, 1, nx), lerp(0, 1, 0, 0.75, ny));
  setFxStick("square", lerp(-1, 1, 0.3, 0.7, nx), lerp(-1, 1, 0.3, 0.7, ny));
  setFxStick("triangle", lerp(-1, 1, 0, 1, nx), lerp(-1, 1, 0, 1, ny));
  setFxStick("circle", lerp(-1, 1, 0.825, 0.65, nx), lerp(-1, 1, 0.6, 1, ny));
}

function setFxName(button, name) {
  if (!controller.fx[button] || !name) return;
  setFxNameCore(button, name);
  fxLabels[button] = `${fxButtonLabels[button]} · ${name}`;
  const label = document.querySelector(`[data-fx-name="${button}"]`);
  if (label) label.textContent = name;
}

function updateFxPluginState() {
  const browser = inputMode === "browser";
  for (const btn of fxPluginBtns) {
    btn.disabled = !browser;
    btn.classList.toggle("is-interactive", browser);
    const slot = btn.dataset.fxPlugin;
    btn.title = browser
      ? `Choose ${fxButtonLabels[slot] || slot} FX / WAM`
      : "Switch to Browser audio to change FX";
  }
}

function syncFxLabelsFromEngine() {
  if (!audioEngine.running) return;
  setFxName("cross", "WAM Off");
  for (const slot of ["square", "triangle", "circle"]) {
    const assigned = audioEngine.fxAssignment?.[slot];
    const scaleWraps = document.querySelectorAll(`[data-fx-scale-wrap="${slot}"]`);
    const xLabel = document.querySelector(`[data-fx-x-label="${slot}"]`);
    const yLabel = document.querySelector(`[data-fx-y-label="${slot}"]`);
    const isWam = assigned?.kind === "wam";
    for (const wrap of scaleWraps) {
      wrap.hidden = !isWam;
    }
    if (isWam) {
      for (const axis of ["x", "y"]) {
        const scaleInput = document.querySelector(
          `[data-fx-scale="${slot}"][data-fx-scale-axis="${axis}"]`
        );
        if (scaleInput && document.activeElement !== scaleInput) {
          scaleInput.value = String(audioEngine.getFxStickScale(slot, axis));
        }
      }
      const binding = audioEngine.getFxStickParams(slot);
      const xNames = Array.isArray(binding?.x)
        ? binding.x.map((p) => p.label || p.id)
        : [];
      const yNames = Array.isArray(binding?.y)
        ? binding.y.map((p) => p.label || p.id)
        : [];
      if (xLabel) {
        xLabel.textContent = xNames.length
          ? `X · ${xNames.join(" + ")}`
          : "Stick X";
      }
      if (yLabel) {
        yLabel.textContent = yNames.length
          ? `Y · ${yNames.join(" + ")}`
          : "Stick Y";
      }
      setFxName(slot, assigned.label);
    } else if (assigned?.label) {
      if (xLabel) xLabel.textContent = "Stick X";
      if (yLabel) yLabel.textContent = "Stick Y";
      setFxName(slot, assigned.label);
    }
  }
}

function clampStickScale(n) {
  const v = Math.round((Number(n) || DEFAULT_STICK_SCALE) * 10) / 10;
  return Math.min(STICK_SCALE_MAX, Math.max(STICK_SCALE_MIN, v));
}

function setStickScaleUi(slot, axis, value) {
  if (axis !== "x" && axis !== "y") return;
  const next = clampStickScale(value);
  audioEngine.setFxStickScale(slot, axis, next);
  const input = document.querySelector(
    `[data-fx-scale="${slot}"][data-fx-scale-axis="${axis}"]`
  );
  if (input) input.value = String(next);
}

/** Hold a button to keep firing `step` until release (or leave / cancel). */
function bindHoldRepeat(button, step, { delayMs = 350, intervalMs = 60 } = {}) {
  if (!button) return;
  let delayId = 0;
  let intervalId = 0;

  const stop = () => {
    if (delayId) {
      clearTimeout(delayId);
      delayId = 0;
    }
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = 0;
    }
  };

  button.addEventListener("pointerdown", (event) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    stop();
    step();
    delayId = setTimeout(() => {
      delayId = 0;
      intervalId = setInterval(step, intervalMs);
    }, delayMs);
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  });

  button.addEventListener("pointerup", stop);
  button.addEventListener("pointercancel", stop);
  button.addEventListener("lostpointercapture", stop);
  button.addEventListener("click", (event) => {
    // Steps are driven by pointerdown / hold; suppress the default click.
    event.preventDefault();
    event.stopPropagation();
  });
}

function bindStickScaleControls() {
  for (const slot of ["square", "triangle", "circle"]) {
    for (const axis of ["x", "y"]) {
      const wrap = document.querySelector(
        `[data-fx-scale-wrap="${slot}"][data-fx-scale-axis="${axis}"]`
      );
      const input = document.querySelector(
        `[data-fx-scale="${slot}"][data-fx-scale-axis="${axis}"]`
      );
      const dec = document.querySelector(
        `[data-fx-scale-dec="${slot}"][data-fx-scale-axis="${axis}"]`
      );
      const inc = document.querySelector(
        `[data-fx-scale-inc="${slot}"][data-fx-scale-axis="${axis}"]`
      );
      if (wrap) {
        wrap.addEventListener("click", (event) => event.stopPropagation());
        wrap.addEventListener("pointerdown", (event) => event.stopPropagation());
      }
      if (input) {
        input.addEventListener("change", () => setStickScaleUi(slot, axis, input.value));
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            setStickScaleUi(slot, axis, input.value);
            input.blur();
          }
        });
      }
      bindHoldRepeat(dec, () => {
        setStickScaleUi(
          slot,
          axis,
          audioEngine.getFxStickScale(slot, axis) - STICK_SCALE_STEP
        );
      });
      bindHoldRepeat(inc, () => {
        setStickScaleUi(
          slot,
          axis,
          audioEngine.getFxStickScale(slot, axis) + STICK_SCALE_STEP
        );
      });
    }
  }
}

async function assignFxPlugin(slot, choice) {
  if (slot === "cross") return;
  try {
    if (inputMode !== "browser") {
      await setInputMode("browser");
    }
    await ensureBrowserAudio();
    const assigned = await audioEngine.replaceFx(slot, choice);
    syncFxLabelsFromEngine();
    setActiveFx(slot);
    const label = assigned?.label || choice.label;
    setStatus("audio", `${fxButtonLabels[slot] || slot} ← ${label}`);
    renderDiagnostics();
  } catch (err) {
    console.error(err);
    setStatus("offline", err?.message || "FX load failed");
  }
}

function openFxPicker(slot, anchor) {
  if (slot === "cross") return;
  if (inputMode !== "browser") {
    setStatus("loading", "Switch to Browser audio to assign FX");
    return;
  }
  void openFxDropdown({
    anchor,
    slot,
    onSelect: (choice) => {
      void assignFxPlugin(slot, choice);
    },
  });
}

function activateFaceButton(button) {
  if (!controller.fx[button]) return;
  if (button === "circle" && activeTab === "falling-blocks") {
    clearBoard();
    return;
  }
  if (button === "triangle" && activeTab === "falling-blocks") {
    toggleBrushCurveInvert();
    return;
  }
  if (button === "cross" && activeTab === "falling-blocks") {
    // Cross / X is held to emit in falling-blocks; ignore as FX select.
    return;
  }
  setActiveFx(button);
  // X / Cross only switches the wet insert off the WAM faces (slot gains).
  // Do not tear down WAM assignments or stick scales — press Square/△/○ to hear them again.
  if (button === "cross" && inputMode === "browser" && audioEngine.running) {
    setStatus("audio", "X · WAM Off");
  }
  renderDiagnostics();
}

function setFxButton(button, value) {
  if (!controller.fx[button]) return;
  if (Number(value) === 0) return;
  activateFaceButton(button);
}

function updateCornerLabels() {
  for (const corner of Object.keys(STEM_CORNERS)) {
    const el = document.querySelector(`[data-corner-name="${corner}"]`);
    if (!el) continue;
    el.textContent =
      inputMode === "browser" ? STEM_CORNERS[corner].label : VIZ_NAMES[corner];
  }
  updateStemSlotState();
}

function updateStemSlotState() {
  const browser = inputMode === "browser";
  for (const slot of stemSlots) {
    slot.disabled = !browser;
    slot.classList.toggle("is-interactive", browser);
    const corner = slot.dataset.stemSlot;
    slot.title = browser
      ? `Choose ${CORNER_TITLES[corner] || corner} sample`
      : "Switch to Browser audio to change samples";
  }
}

async function assignCornerSample(corner, file) {
  const meta = setStemCorner(corner, {
    label: file.label || file.name,
    file: file.name,
    url: file.url,
    id: file.path,
  });
  if (!meta) return;
  updateCornerLabels();
  try {
    if (inputMode !== "browser") {
      await setInputMode("browser");
    }
    await ensureBrowserAudio();
    await audioEngine.replaceStem(corner, meta);
    setStatus(
      "audio",
      `${CORNER_TITLES[corner] || corner} ← ${meta.label} (move pad toward that corner to hear)`
    );
  } catch (err) {
    console.error(err);
    setStatus("offline", err?.message || "Sample load failed");
  }
}

function openCornerPicker(corner, anchor) {
  if (inputMode !== "browser") {
    setStatus("loading", "Switch to Browser audio to assign samples");
    return;
  }
  void openStemDropdown({
    anchor,
    onSelect: (file) => {
      void assignCornerSample(corner, file);
    },
  });
}

function renderDiagnostics() {
  if (!cursor || !crosshairX || !crosshairY) return;

  cursor.style.left = `${state.x * 100}%`;
  cursor.style.top = `${state.y * 100}%`;
  crosshairX.style.left = `${state.x * 100}%`;
  crosshairY.style.top = `${state.y * 100}%`;
  if (xEl) xEl.textContent = state.x.toFixed(2);
  if (yEl) yEl.textContent = state.y.toFixed(2);
  setDpadLabel();

  // Power share (gain²) so the four % labels still sum ~100 and match hearing.
  const gains = equalPowerMix(state.x, state.y);
  for (const [key, gain] of Object.entries(gains)) {
    vols[key].textContent = `${Math.round(gain * gain * 100)}%`;
  }

  if (fxActiveEl) fxActiveEl.textContent = fxLabels[controller.activeFx] || controller.activeFx;
  for (const [key, card] of Object.entries(fxCards)) {
    if (!card) continue;
    card.dataset.on = key === controller.activeFx ? "true" : "";
    const fxXEl = card.querySelector("[data-fx-x]");
    const fxYEl = card.querySelector("[data-fx-y]");
    if (audioEngine.fxAssignment?.[key]?.kind === "wam") {
      const x01 = Math.min(1, Math.max(0, (Number(controller.rawX) || 0) * 0.5 + 0.5));
      const y01 = Math.min(1, Math.max(0, (Number(controller.rawY) || 0) * 0.5 + 0.5));
      if (fxXEl) fxXEl.textContent = fmt(x01);
      if (fxYEl) fxYEl.textContent = fmt(y01);
    } else {
      if (fxXEl) fxXEl.textContent = fmt(controller.fx[key].x);
      if (fxYEl) fxYEl.textContent = fmt(controller.fx[key].y);
    }
  }

  if (stickRawXEl) stickRawXEl.textContent = fmt(controller.rawX);
  if (stickRawYEl) stickRawYEl.textContent = fmt(controller.rawY);
  if (rightXEl) rightXEl.textContent = fmt(controller.rightX);
  if (rightYEl) rightYEl.textContent = fmt(controller.rightY);
  if (leftDot) {
    leftDot.style.left = axisPct(controller.rawX);
    leftDot.style.top = axisPct(-(Number(controller.rawY) || 0));
  }
  if (rightDot) {
    rightDot.style.left = axisPct(controller.rightX);
    rightDot.style.top = axisPct(-(Number(controller.rightY) || 0));
  }

  const lt = triggerAmt(controller.lt);
  const rt = triggerAmt(controller.rt);
  if (ltEl) ltEl.textContent = fmt(controller.lt);
  if (rtEl) rtEl.textContent = fmt(controller.rt);
  if (ltBarEl) ltBarEl.style.width = `${lt * 100}%`;
  if (rtBarEl) rtBarEl.style.width = `${rt * 100}%`;
  if (lsEl) lsEl.dataset.on = controller.ls ? "true" : "";
  if (rsEl) rsEl.dataset.on = controller.rs ? "true" : "";
  if (l1El) l1El.dataset.on = controller.l1 ? "true" : "";
  if (r1El) r1El.dataset.on = controller.r1 ? "true" : "";
}

function setStatus(nextState, label) {
  socketState = nextState;
  statusEl.dataset.state = nextState;
  statusLabel.textContent = label;
  stopStatusMarquee();
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

/** @type {number} */
let statusMarqueeRaf = 0;

function startStatusMarquee() {
  if (!statusEl || !statusLabel) return;
  stopStatusMarquee();

  const clip = statusEl.querySelector(".status-label-clip");
  if (!clip) return;

  // Measure full text width without the idle ellipsis clamp.
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

  // Double rAF so the browser paints translateX(0) before animating.
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

function pointFromEvent(event) {
  const rect = pad.getBoundingClientRect();
  return {
    x: clamp01((event.clientX - rect.left) / rect.width),
    y: clamp01((event.clientY - rect.top) / rect.height),
  };
}

function setTargetFromInput(nx, ny, source, snap) {
  setTarget(nx, ny, source, snap);
  if (sourceEl) sourceEl.textContent = state.source;
  renderDiagnostics();
}

function normalizePadAxis(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.5;
  if (v >= 0 && v <= 1) return v;
  if (v >= -1.5 && v <= 1.5) return clamp01(v * 0.5 + 0.5);
  return clamp01(v);
}

function applyMaxPad(x, y, source) {
  if (inputMode === "browser") return;
  setTargetFromInput(normalizePadAxis(x), normalizePadAxis(y), source, true);
  setStatus("live", "Live from Max");
  lastLive = Date.now();
}

function browserStatusLabel() {
  if (activeTab === "falling-blocks" || audioOffForFallingBlocks) {
    return "Falling Blocks — audio off";
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

function isEmbeddedIdeBrowser() {
  try {
    if (window.self !== window.top) return true;
  } catch {
    return true;
  }
  const ua = navigator.userAgent || "";
  // Cursor / VS Code Simple Browser ride on Electron and usually lack a HID chooser.
  if (/Electron/i.test(ua) && !/Edg\//i.test(ua)) return true;
  if (/Cursor|VSCode|Code\/1\d/i.test(ua)) return true;
  return false;
}

/** True after a successful HID session so disconnect can offer Reconnect. */
let dsHadSession = false;

function setDsConnectLabel(text) {
  if (dsConnectLabel) dsConnectLabel.textContent = text;
  else if (dsConnectBtn) dsConnectBtn.textContent = text;
}

function updateDualsenseHidUi() {
  if (!dsStatusEl || !dsConnectBtn) return;

  const browser = inputMode === "browser";
  const embedded = isEmbeddedIdeBrowser();

  if (!DualsenseHid.isSupported()) {
    dsStatusEl.textContent = "Touchpad: Chrome / Edge only (WebHID)";
    dsConnectBtn.disabled = true;
    setDsConnectLabel("Unavailable");
    dsConnectBtn.dataset.state = "unavailable";
  } else if (embedded) {
    dsStatusEl.textContent =
      "Touchpad: open http://localhost:8080 in Chrome or Edge (Cursor browser can’t use WebHID)";
    dsConnectBtn.disabled = true;
    setDsConnectLabel("Use Chrome / Edge");
    dsConnectBtn.dataset.state = "unavailable";
  } else if (!browser) {
    dsStatusEl.textContent = "Touchpad: switch to Browser audio";
    dsConnectBtn.disabled = true;
    setDsConnectLabel(dsHadSession ? "Reconnect" : "Connect touchpad");
    dsConnectBtn.dataset.state = "";
  } else if (dualsenseHid.connected) {
    dsHadSession = true;
    const via =
      dualsenseHid.connectionType === "bluetooth"
        ? "BT"
        : dualsenseHid.connectionType === "usb"
          ? "USB"
          : "HID";
    const reports = dualsenseHid.reportCount;
    const touch = dualsenseHid.touch.active ? " · finger" : "";
    const rid =
      dualsenseHid.lastReportId != null
        ? ` · r0x${dualsenseHid.lastReportId.toString(16)}`
        : "";
    dsStatusEl.textContent = reports
      ? `Touchpad: ${via}${rid} · ${reports} reports${touch}`
      : `Touchpad: ${dualsenseHid.padId || "DualSense"} (${via}) — waiting for reports…`;
    // Live link — no reconnect until HID drops.
    dsConnectBtn.disabled = true;
    setDsConnectLabel("Connected");
    dsConnectBtn.dataset.state = "connected";
  } else {
    dsStatusEl.textContent = dsHadSession
      ? "Touchpad: disconnected — tap Reconnect"
      : "Touchpad: connect once to grant WebHID";
    dsConnectBtn.disabled = false;
    setDsConnectLabel(dsHadSession ? "Reconnect" : "Connect touchpad");
    dsConnectBtn.dataset.state = "";
  }

  lastDsHidUiKey = `${inputMode}|${dualsenseHid.connected}|${dualsenseHid.connectionType}|${dualsenseHid.padId}|${DualsenseHid.isSupported()}|${embedded}|${dualsenseHid.reportCount > 0}|${dualsenseHid.touch.active}|${dualsenseHid.lastReportId}|${dsHadSession}`;
}

let lastDsHidUiKey = "";

function syncDualsenseHidUi() {
  const key = `${inputMode}|${dualsenseHid.connected}|${dualsenseHid.connectionType}|${dualsenseHid.padId}|${DualsenseHid.isSupported()}|${isEmbeddedIdeBrowser()}|${dualsenseHid.reportCount > 0}|${dualsenseHid.touch.active}|${dualsenseHid.lastReportId}|${dsHadSession}`;
  if (key === lastDsHidUiKey) return;
  updateDualsenseHidUi();
}

async function ensureBrowserAudio() {
  if (inputMode !== "browser") return;
  if (activeTab === "falling-blocks" || audioOffForFallingBlocks) return;
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
  audioStartPromise = (async () => {
    await audioEngine.start();
  })();

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

async function setInputMode(mode) {
  if (mode !== "max" && mode !== "browser") return;
  inputMode = mode;

  for (const button of modeButtons) {
    button.setAttribute("aria-pressed", button.dataset.mode === mode ? "true" : "false");
  }

  updateCornerLabels();
  updateFxPluginState();

  if (mode === "browser") {
    gamepadInput.enable();
    dualsenseHid.enable();
    setFxName("cross", "WAM Off");
    setFxName("square", "Comb");
    setFxName("triangle", "Formant");
    setFxName("circle", "Crystallizer");
    setStatus(audioEngine.running ? "audio" : "loading", browserStatusLabel());
    await ensureBrowserAudio();
    syncFxLabelsFromEngine();
    setStatus(audioEngine.running ? "audio" : "offline", browserStatusLabel());
    updateDualsenseHidUi();
  } else {
    gamepadInput.disable();
    dualsenseHid.disable();
    if (audioEngine.running) await audioEngine.stop();
    setFxName("cross", "WAM Off");
    setFxName("square", "kHs Comb Filter");
    setFxName("triangle", "kHs Formant Filter");
    setFxName("circle", "Crystallizer");
    setStatus(socketState === "live" ? "live" : "open", "Connected — waiting for Max");
    updateDualsenseHidUi();
  }
  renderDiagnostics();
}

function tick(now) {
  try {
    if (inputMode === "browser") {
      gamepadInput.poll();
      if (dualsenseHid.poll() && sourceEl) {
        sourceEl.textContent = state.source;
      }
      syncDualsenseHidUi();
      if (audioEngine.running && activeTab !== "falling-blocks" && !audioOffForFallingBlocks) {
        audioEngine.sync(state, controller);
        syncFxLabelsFromEngine();
        const label = browserStatusLabel();
        if (socketState !== "audio" || statusLabel?.textContent !== label) {
          setStatus("audio", label);
        }
      }
    }
    tickMixer(now, lastFrame);
    lastFrame = now;
    renderDiagnostics();
  } catch (err) {
    console.error("EchoScape diagnostics tick failed:", err);
  }
  window.requestAnimationFrame(tick);
}

function setDpadLabel() {
  if (dpadEl) dpadEl.textContent = controller.dpadDir || "—";
}

async function setFallingBlocksAudio(disabled) {
  if (disabled) {
    if (audioEngine.running) {
      await audioEngine.suspendPlayback();
    }
    audioOffForFallingBlocks = true;
    setStatus("offline", "Falling Blocks — audio off");
    return;
  }

  if (!audioOffForFallingBlocks) return;
  audioOffForFallingBlocks = false;
  if (inputMode === "browser" && audioEngine.running) {
    await audioEngine.ensurePlaying();
    setStatus("audio", browserStatusLabel());
  } else if (inputMode === "browser") {
    setStatus(audioEngine.running ? "audio" : "loading", browserStatusLabel());
  }
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

  for (const panel of panels) {
    const active = panel.dataset.panel === tabId;
    panel.hidden = !active;
  }

  if (tabId === "falling-blocks") {
    hideVisualize();
    void setFallingBlocksAudio(true);
    const panel = [...panels].find((item) => item.dataset.panel === "falling-blocks");
    void panel?.offsetHeight;
    if (fallingCanvas) showFallingBlocks(fallingCanvas);
  } else {
    if (prevTab === "falling-blocks") {
      hideFallingBlocks();
      void setFallingBlocksAudio(false);
    }
    if (tabId === "visualize") {
      const panel = [...panels].find((item) => item.dataset.panel === "visualize");
      void panel?.offsetHeight;
      if (vizCanvas) showVisualize(vizCanvas);
    } else {
      hideVisualize();
      renderDiagnostics();
    }
  }
}

for (const button of tabButtons) {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab));
}

for (const button of modeButtons) {
  button.addEventListener("click", () => {
    void setInputMode(button.dataset.mode);
  });
}

for (const slot of stemSlots) {
  slot.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  slot.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCornerPicker(slot.dataset.stemSlot, slot);
  });
}

/** Map pointer position inside a mini-stick to −1…1 (up = +Y). */
function stickAxesFromEvent(stickEl, event) {
  const rect = stickEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const radius = Math.max(1, Math.min(rect.width, rect.height) / 2);
  let nx = (event.clientX - cx) / radius;
  let ny = -((event.clientY - cy) / radius);
  const mag = Math.hypot(nx, ny);
  if (mag > 1) {
    nx /= mag;
    ny /= mag;
  }
  return { nx, ny };
}

function bindUiStick(stickEl) {
  if (!stickEl) return;
  const side = stickEl.dataset.stick;
  const lockKey = side === "right" ? "rightStick" : "leftStick";
  let dragging = false;

  const apply = (event) => {
    const { nx, ny } = stickAxesFromEvent(stickEl, event);
    if (side === "right") setRightStick(nx, ny);
    else applyRawStick(nx, ny);
  };

  const release = () => {
    if (!dragging) return;
    dragging = false;
    stickEl.classList.remove("is-dragging");
    gamepadInput.uiLock[lockKey] = false;
    if (side === "right") setRightStick(0, 0);
    else applyRawStick(0, 0);
  };

  stickEl.addEventListener("pointerdown", (event) => {
    if (inputMode !== "browser") return;
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    stickEl.classList.add("is-dragging");
    gamepadInput.uiLock[lockKey] = true;
    stickEl.setPointerCapture(event.pointerId);
    void ensureBrowserAudio();
    apply(event);
  });

  stickEl.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    apply(event);
  });

  stickEl.addEventListener("pointerup", release);
  stickEl.addEventListener("pointercancel", release);
  stickEl.addEventListener("lostpointercapture", release);
}

function bindUiShoulder(btn, side) {
  if (!btn) return;
  const lockKey = side === "r1" ? "r1" : "l1";
  let holding = false;

  const press = (event) => {
    if (inputMode !== "browser") return;
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    holding = true;
    gamepadInput.uiLock[lockKey] = true;
    btn.setPointerCapture(event.pointerId);
    void ensureBrowserAudio();
    setShoulder(side, 1);
  };

  const release = () => {
    if (!holding) return;
    holding = false;
    gamepadInput.uiLock[lockKey] = false;
    setShoulder(side, 0);
  };

  btn.addEventListener("pointerdown", press);
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("lostpointercapture", release);
  // Prevent sticky click focus stealing without releasing mid-hold via click
  btn.addEventListener("click", (event) => event.preventDefault());
}

for (const stickEl of document.querySelectorAll("[data-stick]")) {
  bindUiStick(stickEl);
}
bindUiShoulder(l1El, "l1");
bindUiShoulder(r1El, "r1");
bindStickScaleControls();

pad.addEventListener("pointerdown", (event) => {
  pad.setPointerCapture(event.pointerId);
  state.dragging = true;
  dualsenseHid.uiLockPad = true;
  const point = pointFromEvent(event);
  setTargetFromInput(point.x, point.y, "mouse", true);
  if (inputMode === "browser") void ensureBrowserAudio();
});

pad.addEventListener("pointermove", (event) => {
  if (!state.dragging) return;
  const point = pointFromEvent(event);
  setTargetFromInput(point.x, point.y, "mouse", true);
});

pad.addEventListener("pointerup", () => {
  state.dragging = false;
  dualsenseHid.uiLockPad = false;
});

pad.addEventListener("pointercancel", () => {
  state.dragging = false;
  dualsenseHid.uiLockPad = false;
});

pad.addEventListener("lostpointercapture", () => {
  state.dragging = false;
  dualsenseHid.uiLockPad = false;
});

if (dsConnectBtn) {
  dsConnectBtn.addEventListener("click", async () => {
    // requestDevice MUST stay in the same user-gesture turn — do not await
    // audio startup / mode switch before opening the HID picker.
    try {
      const ok = await dualsenseHid.requestDevice();
      if (inputMode !== "browser") {
        await setInputMode("browser");
      } else {
        dualsenseHid.enable();
      }
      updateDualsenseHidUi();
      if (ok) {
        setStatus("audio", browserStatusLabel());
        void ensureBrowserAudio();
      } else if (dualsenseHid.lastError && dsStatusEl) {
        dsStatusEl.textContent = `Touchpad: ${dualsenseHid.lastError}`;
      }
    } catch (err) {
      console.error(err);
      if (dsStatusEl) {
        dsStatusEl.textContent =
          err?.message || "Touchpad: permission denied or unavailable";
      }
      updateDualsenseHidUi();
    }
  });
}

updateDualsenseHidUi();

// Click FX cards to activate; Square/Triangle/Circle titles open WAM picker
for (const [button, card] of Object.entries(fxCards)) {
  if (!card) continue;
  card.style.cursor = "pointer";
  card.addEventListener("click", () => {
    if (inputMode !== "browser") return;
    activateFaceButton(button);
  });
}

for (const btn of fxPluginBtns) {
  btn.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openFxPicker(btn.dataset.fxPlugin, btn);
  });
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener("open", () => {
    if (inputMode === "max") setStatus("open", "Connected — waiting for Max");
  });

  ws.addEventListener("message", (event) => {
    if (inputMode === "browser") return;

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "xy") {
      const label = msg.source === "touch" ? "Max touch" : "Max mixer";
      applyMaxPad(msg.x, msg.y, label);
    }

    if (msg.type === "dpad") {
      const dir = String(msg.dir || "").toLowerCase().trim();
      if (!dpadDirs.has(dir)) return;
      setDpad(dir, msg.value);
      setDpadLabel();
      renderDiagnostics();
      lastLive = Date.now();
      setStatus("live", "Live from Max");
    }

    if (msg.type === "fx-select") {
      setFxButton(msg.button, msg.value);
      renderDiagnostics();
      lastLive = Date.now();
      setStatus("live", "Live from Max");
    }

    if (msg.type === "fx-stick") {
      const button = String(msg.button);
      if (!controller.fx[button]) return;
      setFxStick(button, msg.x, msg.y);
      renderDiagnostics();
      lastLive = Date.now();
      setStatus("live", "Live from Max");
    }

    if (msg.type === "fx-raw") {
      applyRawStick(Number(msg.x), Number(msg.y));
      renderDiagnostics();
      lastLive = Date.now();
      setStatus("live", "Live from Max");
    }

    if (msg.type === "pad-right") {
      setRightStick(Number(msg.x), Number(msg.y));
      renderDiagnostics();
      lastLive = Date.now();
      setStatus("live", "Live from Max");
    }

    if (msg.type === "pad-trigger") {
      setTrigger(String(msg.side), msg.value);
      renderDiagnostics();
      lastLive = Date.now();
      setStatus("live", "Live from Max");
    }

    if (msg.type === "pad-click") {
      setStickClick(String(msg.side), msg.value);
      renderDiagnostics();
      lastLive = Date.now();
      setStatus("live", "Live from Max");
    }

    if (msg.type === "pad-shoulder") {
      setShoulder(String(msg.side), msg.value);
      renderDiagnostics();
      lastLive = Date.now();
      setStatus("live", "Live from Max");
    }

    if (msg.type === "fx-name") {
      setFxName(String(msg.button), String(msg.name || "").trim());
      lastLive = Date.now();
      setStatus("live", "Live from Max");
    }
  });

  ws.addEventListener("close", () => {
    if (inputMode === "max") setStatus("offline", "Server disconnected — retrying");
    window.setTimeout(connect, 800);
  });

  ws.addEventListener("error", () => ws.close());
}

window.setInterval(() => {
  if (inputMode === "max" && socketState === "live" && Date.now() - lastLive > 1500) {
    setStatus("open", "Connected — waiting for Max");
  }
}, 400);

notify();
updateCornerLabels();
renderDiagnostics();
window.requestAnimationFrame(tick);
connect();
const hashTab = location.hash.replace("#", "");
setActiveTab(TAB_IDS.has(hashTab) ? hashTab : storedTab());

if (location.hash.replace("#", "") === "max") {
  void setInputMode("max");
} else {
  void setInputMode("browser");
}