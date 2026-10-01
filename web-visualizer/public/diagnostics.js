import {
  clamp01,
  controller,
  equalPowerMix,
  setActiveFx,
  setFxName as setFxNameCore,
  setFxStick,
  setRawStick,
  setRightStick,
  setShoulder,
  setStemCorner,
  setTarget,
  state,
  STEM_CORNERS,
} from "./mixer-core.js?v=67";
import { audioEngine } from "./audio-engine.js?v=67";
import { DualsenseHid } from "./dualsense-hid.js?v=5";
import { openStemDropdown } from "./sample-picker.js?v=18";
import { openFxDropdown } from "./fx-picker.js?v=5";
import {
  DEFAULT_STICK_SCALE,
  STICK_SCALE_STEP,
  STICK_SCALE_MIN,
} from "./wam-catalog.js?v=5";
import { stickMultiplier } from "./wam-host.js?v=9";

const root = document.querySelector('[data-panel="diagnostics"]');
const pad = root?.querySelector("[data-pad]");
const cursor = root?.querySelector("[data-cursor]");
const crosshairX = root?.querySelector(".crosshair.x");
const crosshairY = root?.querySelector(".crosshair.y");
const sourceEl = root?.querySelector("[data-source]");
const xEl = root?.querySelector("[data-x]");
const yEl = root?.querySelector("[data-y]");
const dpadEl = root?.querySelector("[data-dpad]");
const audioDetailEl = root?.querySelector("[data-audio-detail]");
const fxActiveEl = root?.querySelector("[data-fx-active]");
const stickRawXEl = root?.querySelector("[data-stick-raw-x]");
const stickRawYEl = root?.querySelector("[data-stick-raw-y]");
const rightXEl = root?.querySelector("[data-right-x]");
const rightYEl = root?.querySelector("[data-right-y]");
const ltEl = root?.querySelector("[data-lt]");
const rtEl = root?.querySelector("[data-rt]");
const ltBarEl = root?.querySelector("[data-lt-bar]");
const rtBarEl = root?.querySelector("[data-rt-bar]");
const lsEl = root?.querySelector("[data-ls]");
const rsEl = root?.querySelector("[data-rs]");
const l1El = root?.querySelector("[data-l1]");
const r1El = root?.querySelector("[data-r1]");
const leftDot = root?.querySelector('[data-stick-dot="left"]');
const rightDot = root?.querySelector('[data-stick-dot="right"]');
const dsConnectBtn = root?.querySelector("[data-ds-connect]");
const dsConnectLabel = root?.querySelector("[data-ds-connect-label]");
const dsStatusEl = root?.querySelector("[data-ds-status]");
const stemSlots = root?.querySelectorAll("[data-stem-slot]") ?? [];
const fxPluginBtns = root?.querySelectorAll("[data-fx-plugin]") ?? [];
const CORNER_TITLES = { tl: "TL", tr: "TR", bl: "BL", br: "BR" };
const fxCards = {
  cross: root?.querySelector('[data-fx-card="cross"]'),
  square: root?.querySelector('[data-fx-card="square"]'),
  triangle: root?.querySelector('[data-fx-card="triangle"]'),
  circle: root?.querySelector('[data-fx-card="circle"]'),
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
  tl: root?.querySelector('[data-vol="tl"]'),
  tr: root?.querySelector('[data-vol="tr"]'),
  bl: root?.querySelector('[data-vol="bl"]'),
  br: root?.querySelector('[data-vol="br"]'),
};

/** @type {null | {
 *   ensureBrowserAudio: () => Promise<void>,
 *   setStatus: (state: string, label: string) => void,
 *   browserStatusLabel: () => string,
 *   gamepadInput: { uiLock: Record<string, boolean> },
 *   dualsenseHid: {
 *     uiLockPad: boolean,
 *     connected: boolean,
 *     connectionType: string,
 *     padId: string,
 *     reportCount: number,
 *     touch: { active: boolean, pressed: boolean },
 *     lastReportId: number | null,
 *     lastError: string,
 *     requestDevice: () => Promise<boolean>,
 *     enable: () => void,
 *   },
 * }} */
let deps = null;

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

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

export function applyRawStick(nx, ny) {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
  setRawStick(nx, ny);
  setFxStick("cross", lerp(-1, 1, 0, 1, nx), lerp(0, 1, 0, 0.75, ny));
  setFxStick("square", lerp(-1, 1, 0.3, 0.7, nx), lerp(-1, 1, 0.3, 0.7, ny));
  setFxStick("triangle", lerp(-1, 1, 0, 1, nx), lerp(-1, 1, 0, 1, ny));
  setFxStick("circle", lerp(-1, 1, 0.825, 0.65, nx), lerp(-1, 1, 0.6, 1, ny));
}

export function setFxName(button, name) {
  if (!controller.fx[button] || !name) return;
  setFxNameCore(button, name);
  fxLabels[button] = `${fxButtonLabels[button]} · ${name}`;
  const label = root?.querySelector(`[data-fx-name="${button}"]`);
  if (label) label.textContent = name;
}

export function updateFxPluginState() {
  for (const btn of fxPluginBtns) {
    btn.disabled = false;
    btn.classList.toggle("is-interactive", true);
    const slot = btn.dataset.fxPlugin;
    btn.title = `Choose ${fxButtonLabels[slot] || slot} FX / WAM`;
  }
}

export function syncFxLabelsFromEngine() {
  if (!audioEngine.running) return;
  setFxName("cross", "WAM Off");
  for (const slot of ["square", "triangle", "circle"]) {
    const assigned = audioEngine.fxAssignment?.[slot];
    const scaleWraps = root?.querySelectorAll(`[data-fx-scale-wrap="${slot}"]`) ?? [];
    const xLabel = root?.querySelector(`[data-fx-x-label="${slot}"]`);
    const yLabel = root?.querySelector(`[data-fx-y-label="${slot}"]`);
    const isWam = assigned?.kind === "wam";
    for (const wrap of scaleWraps) {
      wrap.hidden = !isWam;
    }
    if (isWam) {
      for (const axis of ["x", "y"]) {
        const scaleInput = root?.querySelector(
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
        xLabel.textContent = xNames.length ? `X · ${xNames.join(" + ")}` : "Stick X";
      }
      if (yLabel) {
        yLabel.textContent = yNames.length ? `Y · ${yNames.join(" + ")}` : "Stick Y";
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
  if (!Number.isFinite(v)) return DEFAULT_STICK_SCALE;
  return Math.max(STICK_SCALE_MIN, v);
}

function setStickScaleUi(slot, axis, value) {
  if (axis !== "x" && axis !== "y") return;
  const next = clampStickScale(value);
  audioEngine.setFxStickScale(slot, axis, next);
  const input = root?.querySelector(
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
    event.preventDefault();
    event.stopPropagation();
  });
}

function bindStickScaleControls() {
  for (const slot of ["square", "triangle", "circle"]) {
    for (const axis of ["x", "y"]) {
      const wrap = root?.querySelector(
        `[data-fx-scale-wrap="${slot}"][data-fx-scale-axis="${axis}"]`
      );
      const input = root?.querySelector(
        `[data-fx-scale="${slot}"][data-fx-scale-axis="${axis}"]`
      );
      const dec = root?.querySelector(
        `[data-fx-scale-dec="${slot}"][data-fx-scale-axis="${axis}"]`
      );
      const inc = root?.querySelector(
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
        setStickScaleUi(slot, axis, audioEngine.getFxStickScale(slot, axis) - STICK_SCALE_STEP);
      });
      bindHoldRepeat(inc, () => {
        setStickScaleUi(slot, axis, audioEngine.getFxStickScale(slot, axis) + STICK_SCALE_STEP);
      });
    }
  }
}

async function assignFxPlugin(slot, choice) {
  if (!deps || slot === "cross") return;
  try {
    await deps.ensureBrowserAudio();
    const assigned = await audioEngine.replaceFx(slot, choice);
    syncFxLabelsFromEngine();
    setActiveFx(slot);
    const label = assigned?.label || choice.label;
    deps.setStatus("audio", `${fxButtonLabels[slot] || slot} ← ${label}`);
    renderDiagnostics();
  } catch (err) {
    console.error(err);
    deps.setStatus("offline", err?.message || "FX load failed");
  }
}

function openFxPicker(slot, anchor) {
  if (!deps || slot === "cross") return;
  void openFxDropdown({
    anchor,
    slot,
    onSelect: (choice) => {
      void assignFxPlugin(slot, choice);
    },
  });
}

/** Face presses while Diagnostics or Visualize is showing. */
export function onFaceCommand(button) {
  if (!deps || !controller.fx[button]) return;
  setActiveFx(button);
  if (button === "cross" && audioEngine.running) {
    deps.setStatus("audio", "X · WAM Off");
  }
  renderDiagnostics();
}

/** Gamepad rising edge while this tab, or Visualize, is showing. */
export function onFaceEdge(button) {
  if (!controller.fx[button]) return;
  setActiveFx(button);
}

export function updateCornerLabels() {
  for (const corner of Object.keys(STEM_CORNERS)) {
    const el = root?.querySelector(`[data-corner-name="${corner}"]`);
    if (!el) continue;
    el.textContent = STEM_CORNERS[corner].label;
  }
  updateStemSlotState();
}

function updateStemSlotState() {
  for (const slot of stemSlots) {
    slot.disabled = false;
    slot.classList.toggle("is-interactive", true);
    const corner = slot.dataset.stemSlot;
    slot.title = `Choose ${CORNER_TITLES[corner] || corner} sample`;
  }
}

async function assignCornerSample(corner, file) {
  if (!deps) return;
  const meta = setStemCorner(corner, {
    label: file.label || file.name,
    file: file.name,
    url: file.url,
    id: file.path,
  });
  if (!meta) return;
  updateCornerLabels();
  try {
    await deps.ensureBrowserAudio();
    await audioEngine.replaceStem(corner, meta);
    deps.setStatus(
      "audio",
      `${CORNER_TITLES[corner] || corner} ← ${meta.label} (move pad toward that corner to hear)`
    );
  } catch (err) {
    console.error(err);
    deps.setStatus("offline", err?.message || "Sample load failed");
  }
}

function openCornerPicker(corner, anchor) {
  if (!deps) return;
  void openStemDropdown({
    anchor,
    onSelect: (file) => {
      void assignCornerSample(corner, file);
    },
  });
}

function setDpadLabel() {
  if (dpadEl) dpadEl.textContent = controller.dpadDir || "—";
}

function paintAudioDetail() {
  if (!audioDetailEl) return;
  const text = audioEngine.audioHealthLabel();
  if (audioDetailEl.textContent !== text) audioDetailEl.textContent = text;
}

export function renderDiagnostics() {
  paintAudioDetail();
  if (!cursor || !crosshairX || !crosshairY) return;

  cursor.style.left = `${state.x * 100}%`;
  cursor.style.top = `${state.y * 100}%`;
  crosshairX.style.left = `${state.x * 100}%`;
  crosshairY.style.top = `${state.y * 100}%`;
  if (xEl) xEl.textContent = state.x.toFixed(2);
  if (yEl) yEl.textContent = state.y.toFixed(2);
  setDpadLabel();

  const gains = equalPowerMix(state.x, state.y);
  for (const [key, gain] of Object.entries(gains)) {
    if (vols[key]) vols[key].textContent = `${Math.round(gain * gain * 100)}%`;
  }

  if (fxActiveEl) fxActiveEl.textContent = fxLabels[controller.activeFx] || controller.activeFx;
  for (const [key, card] of Object.entries(fxCards)) {
    if (!card) continue;
    card.dataset.on = key === controller.activeFx ? "true" : "";
    const fxXEl = card.querySelector("[data-fx-x]");
    const fxYEl = card.querySelector("[data-fx-y]");
    if (audioEngine.fxAssignment?.[key]?.kind === "wam") {
      const maxX = audioEngine.getFxStickScale(key, "x");
      const maxY = audioEngine.getFxStickScale(key, "y");
      if (fxXEl) fxXEl.textContent = fmt(stickMultiplier(controller.rawX, maxX));
      if (fxYEl) fxYEl.textContent = fmt(stickMultiplier(controller.rawY, maxY));
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

export function noteDualSenseSource() {
  if (sourceEl) sourceEl.textContent = state.source;
}

function isEmbeddedIdeBrowser() {
  try {
    if (window.self !== window.top) return true;
  } catch {
    return true;
  }
  const ua = navigator.userAgent || "";
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

export function updateDualsenseHidUi() {
  if (!deps || !dsStatusEl || !dsConnectBtn) return;
  const dualsenseHid = deps.dualsenseHid;

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
    const click = dualsenseHid.touch.pressed ? " · click" : "";
    const rid =
      dualsenseHid.lastReportId != null ? ` · r0x${dualsenseHid.lastReportId.toString(16)}` : "";
    dsStatusEl.textContent = reports
      ? `Touchpad: ${via}${rid} · ${reports} reports${touch}${click}`
      : `Touchpad: ${dualsenseHid.padId || "DualSense"} (${via}) — waiting for reports…`;
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

  lastDsHidUiKey = dualSenseKey(embedded);
}

let lastDsHidUiKey = "";

function dualSenseKey(embedded = isEmbeddedIdeBrowser()) {
  const dualsenseHid = deps?.dualsenseHid;
  if (!dualsenseHid) return "";
  return `${dualsenseHid.connected}|${dualsenseHid.connectionType}|${dualsenseHid.padId}|${DualsenseHid.isSupported()}|${embedded}|${dualsenseHid.reportCount > 0}|${dualsenseHid.touch.active}|${dualsenseHid.touch.pressed}|${dualsenseHid.lastReportId}|${dsHadSession}`;
}

export function syncDualsenseHidUi() {
  const key = dualSenseKey();
  if (key === lastDsHidUiKey) return;
  updateDualsenseHidUi();
}

/** XY mix for Diagnostics and Visualize. Falling Blocks does not call this. */
export function tickXyAudio() {
  if (!deps || !audioEngine.running) return;
  audioEngine.setStemPitch(null);
  audioEngine.setOutputLevel(1);
  audioEngine.setCameraPresence(0, 0);
  audioEngine.sync(state, controller);
  syncFxLabelsFromEngine();
  const label = deps.browserStatusLabel();
  if (deps.statusDiffers(label)) deps.setStatus("audio", label);
}

export function show() {
  renderDiagnostics();
}

export function hide() {}

export function tick() {
  tickXyAudio();
  renderDiagnostics();
}

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
    if (deps) deps.gamepadInput.uiLock[lockKey] = false;
    if (side === "right") setRightStick(0, 0);
    else applyRawStick(0, 0);
  };

  stickEl.addEventListener("pointerdown", (event) => {
    if (!deps) return;
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    stickEl.classList.add("is-dragging");
    deps.gamepadInput.uiLock[lockKey] = true;
    stickEl.setPointerCapture(event.pointerId);
    void deps.ensureBrowserAudio();
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
    if (!deps) return;
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    holding = true;
    deps.gamepadInput.uiLock[lockKey] = true;
    btn.setPointerCapture(event.pointerId);
    void deps.ensureBrowserAudio();
    setShoulder(side, 1);
  };

  const release = () => {
    if (!holding) return;
    holding = false;
    if (deps) deps.gamepadInput.uiLock[lockKey] = false;
    setShoulder(side, 0);
  };

  btn.addEventListener("pointerdown", press);
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("lostpointercapture", release);
  btn.addEventListener("click", (event) => event.preventDefault());
}

function bindPad() {
  if (!pad || !deps) return;
  pad.addEventListener("pointerdown", (event) => {
    pad.setPointerCapture(event.pointerId);
    state.dragging = true;
    deps.dualsenseHid.uiLockPad = true;
    const point = pointFromEvent(event);
    setTargetFromInput(point.x, point.y, "mouse", true);
    void deps.ensureBrowserAudio();
  });

  pad.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    const point = pointFromEvent(event);
    setTargetFromInput(point.x, point.y, "mouse", true);
  });

  const release = () => {
    state.dragging = false;
    if (deps) deps.dualsenseHid.uiLockPad = false;
  };
  pad.addEventListener("pointerup", release);
  pad.addEventListener("pointercancel", release);
  pad.addEventListener("lostpointercapture", release);
}

export function initDiagnostics(nextDeps) {
  deps = nextDeps;

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

  for (const stickEl of root?.querySelectorAll("[data-stick]") ?? []) {
    bindUiStick(stickEl);
  }
  bindUiShoulder(l1El, "l1");
  bindUiShoulder(r1El, "r1");
  bindStickScaleControls();
  bindPad();

  if (dsConnectBtn) {
    dsConnectBtn.addEventListener("click", async () => {
      try {
        const ok = await deps.dualsenseHid.requestDevice();
        deps.dualsenseHid.enable();
        updateDualsenseHidUi();
        if (ok) {
          deps.setStatus("audio", deps.browserStatusLabel());
          void deps.ensureBrowserAudio();
        } else if (deps.dualsenseHid.lastError && dsStatusEl) {
          dsStatusEl.textContent = `Touchpad: ${deps.dualsenseHid.lastError}`;
        }
      } catch (err) {
        console.error(err);
        if (dsStatusEl) {
          dsStatusEl.textContent = err?.message || "Touchpad: permission denied or unavailable";
        }
        updateDualsenseHidUi();
      }
    });
  }

  for (const [button, card] of Object.entries(fxCards)) {
    if (!card) continue;
    card.style.cursor = "pointer";
    card.addEventListener("click", () => {
      onFaceCommand(button);
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
}
