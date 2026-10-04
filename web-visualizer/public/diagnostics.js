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
import { audioEngine } from "./audio-engine.js?v=101";
import { DualsenseHid } from "./dualsense-hid.js?v=5";
import { openStemDropdown } from "./sample-picker.js?v=18";
import { openFxDropdown } from "./fx-picker.js?v=5";
import { neutralParamValue, paramSentValue } from "./wam-host.js?v=14";

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

const FX_PICK_SLOTS = ["square", "triangle", "circle"];
let fxParamsKey = "";

function fmtParam(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 100) return n.toFixed(0);
  if (abs >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function stickSummary(model) {
  const names = (axis) =>
    (model?.params || []).filter((p) => model.axes?.[p.id] === axis).map((p) => p.label);
  const x = names("x");
  const y = names("y");
  return `X · ${x.join(" + ") || "—"}    Y · ${y.join(" + ") || "—"}`;
}

function paintStickSummaries() {
  for (const slot of FX_PICK_SLOTS) {
    const el = root?.querySelector(`[data-fx-summary="${slot}"]`);
    if (!el) continue;
    const assigned = audioEngine.fxAssignment?.[slot];
    const text = assigned?.kind === "wam" ? stickSummary(audioEngine.getFxParamModel(slot)) : "X · —    Y · —";
    if (el.textContent !== text) el.textContent = text;
  }
}

function paintParamSent() {
  const list = root?.querySelector("[data-fx-params]");
  if (!list || list.hidden) return;
  const slot = controller.activeFx;
  const model = audioEngine.getFxParamModel(slot);
  if (!model) return;
  const stickX = Number(controller.rawX) || 0;
  const stickY = Number(controller.rawY) || 0;
  for (const row of list.querySelectorAll("[data-fx-param]")) {
    const param = model.params.find((p) => p.id === row.dataset.fxParam);
    if (!param) continue;
    if (param.type === "float") {
      const armed = model.axes?.[param.id] === "x" || model.axes?.[param.id] === "y";
      const nextArmed = armed ? "true" : "false";
      if (row.dataset.armed !== nextArmed) row.dataset.armed = nextArmed;
      const dial = row.querySelector("[data-fx-dial]");
      const range = model.ranges?.[param.id];
      if (dial && range) {
        dial.title = armed ? WINDOW_TITLE : VALUE_TITLE;
        paintDial(dial, param, range, paramSentValue(param, model, stickX, stickY), armed);
      }
    }
    const sent = row.querySelector("[data-fx-sent]");
    if (!sent) continue;
    const text = sentText(param, model, stickX, stickY);
    if (sent.textContent !== text) sent.textContent = text;
  }
}

function sentText(param, model, stickX, stickY) {
  const value = paramSentValue(param, model, stickX, stickY);
  if (param.type === "boolean") return value >= 0.5 ? "On" : "Off";
  if (param.type === "choice") {
    const index = Math.round(value - param.min);
    return param.choices[index] || fmtParam(value);
  }
  return fmtParam(value);
}

const WINDOW_TITLE = "Drag an edge to set the stick window. Drag the arc to slide it. Shift for fine control. Double-click to reset.";
const VALUE_TITLE = "Drag up or down to set this value. Shift for fine control. Double-click to reset.";
const DIAL = { cx: 22, cy: 22, r: 16, start: Math.PI * 0.75, sweep: Math.PI * 1.5 };
const DIAL_DRAG_PX = 280;
const SVG_NS = "http://www.w3.org/2000/svg";
const BAND_ID = /^(highpass|lowshelf|peaking|highshelf|lowpass)_(\d+)_(Q|detune|frequency|gain)$/;
const BAND_PROPS = ["frequency", "gain", "Q"];
const BAND_PROP_LABEL = { frequency: "Freq", gain: "Gain", Q: "Q", detune: "Detune" };
const BAND_KIND_LABEL = {
  highpass: "Highpass",
  lowshelf: "Low shelf",
  highshelf: "High shelf",
  lowpass: "Lowpass",
};
const PEAKING_LABEL = { 2: "Low-mid", 3: "High-mid", 4: "Presence" };

function dialPoint(t, radius = DIAL.r) {
  const u = Math.min(1, Math.max(0, t));
  const theta = DIAL.start + u * DIAL.sweep;
  return {
    x: DIAL.cx + radius * Math.cos(theta),
    y: DIAL.cy + radius * Math.sin(theta),
  };
}

function dialArc(t0, t1) {
  const delta = t1 - t0;
  if (delta < 0.0008) return "";
  const a = dialPoint(t0);
  const b = dialPoint(t1);
  const large = delta * DIAL.sweep > Math.PI ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${DIAL.r} ${DIAL.r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

function dialHitArc(t0, t1) {
  const arc = dialArc(t0, t1);
  if (arc) return arc;
  const mid = (t0 + t1) / 2;
  let a = mid - 0.03;
  let b = mid + 0.03;
  if (a < 0) {
    b -= a;
    a = 0;
  }
  if (b > 1) {
    a -= b - 1;
    b = 1;
  }
  return dialArc(a, b);
}

function dialUnit(value, param) {
  const span = param.max - param.min || 1;
  return (Number(value) - param.min) / span;
}

function paintDial(host, param, range, sent, windowMode) {
  const sentT = dialUnit(sent, param);
  const originT = param.min < 0 && param.max > 0 ? dialUnit(0, param) : 0;
  const lowT = windowMode ? dialUnit(range.low, param) : Math.min(originT, sentT);
  const highT = windowMode ? dialUnit(range.high, param) : Math.max(originT, sentT);
  const arc = dialArc(lowT, highT);
  const track = host.querySelector("[data-track]");
  const span = host.querySelector("[data-span]");
  const spanHit = host.querySelector("[data-span-hit]");
  const needle = host.querySelector("[data-needle]");
  if (track && !track.getAttribute("d")) track.setAttribute("d", dialArc(0, 1));
  if (span) span.setAttribute("d", arc);
  if (spanHit) spanHit.setAttribute("d", dialHitArc(lowT, highT));
  const inner = dialPoint(sentT, 6);
  const outer = dialPoint(sentT, 13);
  if (needle) {
    needle.setAttribute("x1", inner.x.toFixed(2));
    needle.setAttribute("y1", inner.y.toFixed(2));
    needle.setAttribute("x2", outer.x.toFixed(2));
    needle.setAttribute("y2", outer.y.toFixed(2));
  }
  host.querySelector(".fx-dial-svg")?.setAttribute("aria-valuenow", String(sent));
}

function bindDial(host, slot, param) {
  const svg = host.querySelector(".fx-dial-svg");
  if (!svg) return;
  let drag = null;
  const current = () =>
    audioEngine.getFxParamModel(slot)?.ranges?.[param.id] || { low: param.min, high: param.max };

  const armedNow = () => {
    const axis = audioEngine.getFxParamModel(slot)?.axes?.[param.id];
    return axis === "x" || axis === "y";
  };

  const manualNow = () => {
    const stored = Number(audioEngine.getFxParamModel(slot)?.switches?.[param.id]);
    return Number.isFinite(stored) ? stored : neutralParamValue(param);
  };

  const write = (low, high, persist) => {
    audioEngine.setFxParamRange(slot, param.id, low, high, { persist });
    paintParamSent();
  };

  const writeValue = (value, persist) => {
    audioEngine.setFxParamValue(slot, param.id, value, { persist });
    paintParamSent();
  };

  const deltaFor = (event, originY, fine) => {
    const span = param.max - param.min || 1;
    const travel = window.matchMedia("(pointer: coarse)").matches ? 168 : DIAL_DRAG_PX;
    return ((originY - event.clientY) / travel) * span * fine;
  };

  const kindAt = (event, range) => {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return "span";
    const local = point.matrixTransform(ctm.inverse());
    const low = dialPoint(dialUnit(range.low, param));
    const high = dialPoint(dialUnit(range.high, param));
    const dLow = Math.hypot(local.x - low.x, local.y - low.y);
    const dHigh = Math.hypot(local.x - high.x, local.y - high.y);
    if (Math.min(dLow, dHigh) > 7) return "span";
    return dLow <= dHigh ? "low" : "high";
  };

  svg.addEventListener("pointerdown", (event) => {
    if (event.button != null && event.button !== 0) return;
    const fine = event.shiftKey ? 0.1 : 1;
    if (!armedNow()) {
      const hit = event.target.closest?.("[data-value-hit], [data-span-hit]");
      if (!hit) return;
      drag = {
        kind: "value",
        pointerId: event.pointerId,
        originY: event.clientY,
        value: manualNow(),
        fine,
      };
    } else {
      const onSpan = event.target.closest?.("[data-span-hit]");
      if (!onSpan) return;
      const range = current();
      drag = {
        kind: kindAt(event, range),
        pointerId: event.pointerId,
        originY: event.clientY,
        low: range.low,
        high: range.high,
        fine,
      };
    }
    event.preventDefault();
    event.stopPropagation();
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  });

  svg.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = deltaFor(event, drag.originY, drag.fine);
    if (drag.kind === "value") {
      writeValue(drag.value + delta, false);
      return;
    }
    if (drag.kind === "low") {
      write(Math.min(drag.low + delta, drag.high), drag.high, false);
    } else if (drag.kind === "high") {
      write(drag.low, Math.max(drag.high + delta, drag.low), false);
    } else {
      const width = drag.high - drag.low;
      let low = drag.low + delta;
      let high = drag.high + delta;
      if (low < param.min) {
        low = param.min;
        high = param.min + width;
      }
      if (high > param.max) {
        high = param.max;
        low = param.max - width;
      }
      write(low, high, false);
    }
  });

  const end = (event) => {
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    const kind = drag.kind;
    drag = null;
    if (kind === "value") writeValue(manualNow(), true);
    else {
      const range = current();
      write(range.low, range.high, true);
    }
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);

  svg.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    drag = null;
    if (!armedNow()) writeValue(neutralParamValue(param), true);
    else write(param.min, param.max, true);
  });

  svg.addEventListener("keydown", (event) => {
    const dir = event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : event.key === "ArrowDown" || event.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    event.preventDefault();
    const step = (param.discreteStep > 0 ? param.discreteStep : (param.max - param.min) / 100) * (event.shiftKey ? 0.1 : 1);
    if (!armedNow()) {
      writeValue(manualNow() + dir * step, true);
      return;
    }
    const range = current();
    const width = range.high - range.low;
    let low = range.low + dir * step;
    let high = range.high + dir * step;
    if (low < param.min) {
      low = param.min;
      high = param.min + width;
    }
    if (high > param.max) {
      high = param.max;
      low = param.max - width;
    }
    write(low, high, true);
  });
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function buildDialFace(param) {
  const face = document.createElement("div");
  face.className = "fx-dial-face";
  face.dataset.fxDial = "";
  face.title = VALUE_TITLE;
  const svg = svgEl("svg", {
    class: "fx-dial-svg",
    viewBox: "0 0 44 44",
    tabindex: "0",
    role: "slider",
    "aria-label": param.label,
    "aria-valuemin": String(param.min),
    "aria-valuemax": String(param.max),
  });
  svg.append(
    svgEl("path", { class: "fx-dial-track", "data-track": "", fill: "none" }),
    svgEl("path", { class: "fx-dial-span-hit", "data-span-hit": "", fill: "none" }),
    svgEl("path", { class: "fx-dial-span", "data-span": "", fill: "none" }),
    svgEl("line", { class: "fx-dial-needle", "data-needle": "" }),
    svgEl("circle", { class: "fx-dial-value-hit", "data-value-hit": "", cx: "22", cy: "22", r: "20" })
  );
  face.append(svg);
  return face;
}

function syncAxisButtons(row, axis) {
  for (const button of row.querySelectorAll("[data-fx-axis]")) {
    button.setAttribute("aria-pressed", button.dataset.fxAxis === axis ? "true" : "false");
  }
}

function buildDial(slot, param, model, labelText) {
  const row = document.createElement("div");
  row.className = "fx-dial";
  row.dataset.fxParam = param.id;
  const armed = model.axes?.[param.id] === "x" || model.axes?.[param.id] === "y";
  row.dataset.armed = armed ? "true" : "false";

  const face = buildDialFace(param);
  const range = model.ranges?.[param.id] || { low: param.min, high: param.max };
  const stickX = Number(controller.rawX) || 0;
  const stickY = Number(controller.rawY) || 0;
  face.title = armed ? WINDOW_TITLE : VALUE_TITLE;
  paintDial(face, param, range, paramSentValue(param, model, stickX, stickY), armed);
  bindDial(face, slot, param);

  const label = document.createElement("p");
  label.className = "fx-dial-label";
  label.textContent = labelText || param.label;
  label.title = param.label;

  const sent = document.createElement("p");
  sent.className = "fx-dial-sent";
  sent.dataset.fxSent = "";
  sent.textContent = sentText(param, model, stickX, stickY);

  const axes = document.createElement("div");
  axes.className = "fx-dial-axes";
  for (const axis of ["x", "y"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fx-axis-sw";
    button.dataset.fxAxis = axis;
    button.textContent = axis.toUpperCase();
    button.setAttribute("aria-pressed", model.axes?.[param.id] === axis ? "true" : "false");
    button.setAttribute("aria-label", `Assign ${param.label} to stick ${axis.toUpperCase()}`);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const live = audioEngine.getFxParamModel(slot);
      const current = live?.axes?.[param.id] || null;
      const next = current === axis ? null : axis;
      audioEngine.setFxParamAxis(slot, param.id, next);
      syncAxisButtons(row, next);
      row.dataset.armed = next ? "true" : "false";
      paintStickSummaries();
      paintParamSent();
    });
    axes.append(button);
  }

  row.append(face, label, sent, axes);
  return row;
}

function buildSwitch(slot, param, model) {
  const row = document.createElement("div");
  row.className = "fx-switch";
  row.dataset.fxParam = param.id;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "fx-switch-ctl";
  toggle.setAttribute("role", "switch");
  const on = (model.switches?.[param.id] ?? 0) >= 0.5;
  toggle.setAttribute("aria-pressed", on ? "true" : "false");
  toggle.setAttribute("aria-label", param.label);
  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", next ? "true" : "false");
    audioEngine.setFxParamSwitch(slot, param.id, next ? 1 : 0);
    paintParamSent();
  });

  const label = document.createElement("span");
  label.className = "fx-switch-label";
  label.textContent = param.label;
  label.title = param.label;
  row.append(toggle, label);
  return row;
}

function buildChoice(slot, param, model) {
  const row = document.createElement("div");
  row.className = "fx-choice-row";
  row.dataset.fxParam = param.id;

  const label = document.createElement("p");
  label.className = "fx-dial-label";
  label.textContent = param.label;
  label.title = param.label;

  const select = document.createElement("select");
  select.className = "fx-choice";
  const choices = param.choices.length
    ? param.choices
    : Array.from({ length: Math.round(param.max - param.min) + 1 }, (_, i) => String(param.min + i));
  choices.forEach((choice, index) => {
    const option = document.createElement("option");
    option.value = String(param.min + index);
    option.textContent = choice;
    select.append(option);
  });
  select.value = String(model.switches?.[param.id] ?? param.def);
  select.addEventListener("change", () => {
    audioEngine.setFxParamSwitch(slot, param.id, Number(select.value));
    paintParamSent();
  });
  select.addEventListener("pointerdown", (event) => event.stopPropagation());

  const sent = document.createElement("p");
  sent.className = "fx-dial-sent";
  sent.dataset.fxSent = "";
  sent.textContent = sentText(param, model, Number(controller.rawX) || 0, Number(controller.rawY) || 0);
  row.append(label, select, sent);
  return row;
}

function bandTitle(group) {
  if (group.kind === "peaking") return PEAKING_LABEL[group.index] || `Peaking ${group.index}`;
  return BAND_KIND_LABEL[group.kind] || group.kind;
}

function splitBands(params) {
  const groups = new Map();
  const rest = [];
  for (const param of params) {
    const match = param.id.match(BAND_ID);
    if (!match) {
      rest.push(param);
      continue;
    }
    const key = `${match[1]}_${match[2]}`;
    if (!groups.has(key)) groups.set(key, { kind: match[1], index: Number(match[2]), props: {} });
    groups.get(key).props[match[3]] = param;
  }
  return {
    groups: [...groups.values()].sort((a, b) => a.index - b.index),
    rest,
  };
}

function appendDialGrid(host, slot, params, model, labelFor) {
  if (!params.length) return;
  const grid = document.createElement("div");
  grid.className = "fx-dial-grid";
  for (const param of params) grid.append(buildDial(slot, param, model, labelFor?.(param)));
  host.append(grid);
}

function appendBand(host, slot, group, model) {
  const section = document.createElement("section");
  section.className = "fx-band";
  const title = document.createElement("h4");
  title.className = "fx-band-name";
  title.textContent = bandTitle(group);
  section.append(title);
  appendDialGrid(
    section,
    slot,
    BAND_PROPS.map((prop) => group.props[prop]).filter(Boolean),
    model,
    (param) => BAND_PROP_LABEL[param.id.split("_").pop()] || param.label
  );
  const detune = group.props.detune;
  if (detune) {
    const fine = document.createElement("details");
    fine.className = "fx-band-fine";
    const summary = document.createElement("summary");
    summary.textContent = "Fine";
    fine.append(summary);
    appendDialGrid(fine, slot, [detune], model, () => BAND_PROP_LABEL.detune);
    section.append(fine);
  }
  host.append(section);
}

function ensureParamList() {
  const host = root?.querySelector("[data-fx-params]");
  if (!host) return;
  const slot = controller.activeFx;
  const assigned = audioEngine.fxAssignment?.[slot];
  const model = assigned?.kind === "wam" ? audioEngine.getFxParamModel(slot) : null;
  const key = model ? `${slot}|${model.path}|${model.params.map((p) => p.id).join("\n")}` : "";
  if (!model) {
    host.hidden = true;
    host.replaceChildren();
    fxParamsKey = "";
    return;
  }
  host.hidden = false;
  if (key === fxParamsKey) return;
  fxParamsKey = key;
  host.replaceChildren();
  const head = document.createElement("h3");
  head.className = "fx-params-head";
  head.textContent = `${fxButtonLabels[slot] || slot} · ${assigned.label || model.path}`;
  host.append(head);
  if (!model.params.length) {
    const empty = document.createElement("p");
    empty.className = "fx-params-empty";
    empty.textContent = "This plugin did not report parameters.";
    host.append(empty);
    return;
  }

  const booleans = model.params.filter((param) => param.type === "boolean");
  const choices = model.params.filter((param) => param.type === "choice");
  const floats = model.params.filter((param) => param.type === "float");
  if (booleans.length) {
    const row = document.createElement("div");
    row.className = "fx-switch-row";
    for (const param of booleans) row.append(buildSwitch(slot, param, model));
    host.append(row);
  }
  for (const param of choices) host.append(buildChoice(slot, param, model));
  const { groups, rest } = splitBands(floats);
  appendDialGrid(host, slot, rest, model);
  for (const group of groups) appendBand(host, slot, group, model);
}

export function syncFxLabelsFromEngine() {
  if (!audioEngine.running) return;
  setFxName("cross", "WAM Off");
  for (const slot of FX_PICK_SLOTS) {
    const assigned = audioEngine.fxAssignment?.[slot];
    if (assigned?.label) setFxName(slot, assigned.label);
  }
  paintStickSummaries();
  ensureParamList();
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
    if (fxXEl) fxXEl.textContent = fmt(controller.fx[key].x);
    if (fxYEl) fxYEl.textContent = fmt(controller.fx[key].y);
  }
  ensureParamList();
  paintStickSummaries();
  paintParamSent();

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
