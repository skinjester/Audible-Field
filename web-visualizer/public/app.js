import {
  clamp01,
  controller,
  mix,
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
  state,
  tickMixer,
} from "./mixer-core.js?v=59";
import { hideVisualize, showVisualize } from "./visualize.js?v=74";

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
const tabButtons = document.querySelectorAll("[data-tab]");
const panels = document.querySelectorAll("[data-panel]");
const vizCanvas = document.querySelector("[data-viz-canvas]");
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
  cross: "X · Saturn 2",
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

const dpadDirs = new Set(["up", "down", "left", "right"]);

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
  const card = fxCards[button];
  if (!card) return;
  const title = card.querySelector("h3");
  if (title) title.textContent = name;
}

function setFxButton(button, value) {
  if (!controller.fx[button]) return;
  if (Number(value) === 0) return;
  setActiveFx(button);
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

  const volumes = mix(state.x, state.y);
  for (const [key, value] of Object.entries(volumes)) {
    vols[key].textContent = `${Math.round(value * 100)}%`;
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
  setTargetFromInput(normalizePadAxis(x), normalizePadAxis(y), source, true);
  setStatus("live", "Live from Max");
  lastLive = Date.now();
}

function tick(now) {
  try {
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

function setActiveTab(tabId) {
  document.body.classList.toggle("mode-visualize", tabId === "visualize");

  for (const button of tabButtons) {
    const active = button.dataset.tab === tabId;
    button.setAttribute("aria-selected", active ? "true" : "false");
  }

  for (const panel of panels) {
    const active = panel.dataset.panel === tabId;
    panel.hidden = !active;
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

for (const button of tabButtons) {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab));
}

pad.addEventListener("pointerdown", (event) => {
  pad.setPointerCapture(event.pointerId);
  state.dragging = true;
  const point = pointFromEvent(event);
  setTargetFromInput(point.x, point.y, "mouse", true);
});

pad.addEventListener("pointermove", (event) => {
  if (!state.dragging) return;
  const point = pointFromEvent(event);
  setTargetFromInput(point.x, point.y, "mouse", true);
});

pad.addEventListener("pointerup", () => {
  state.dragging = false;
});

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.addEventListener("open", () => {
    setStatus("open", "Connected — waiting for Max");
  });

  ws.addEventListener("message", (event) => {
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
    setStatus("offline", "Server disconnected — retrying");
    window.setTimeout(connect, 800);
  });

  ws.addEventListener("error", () => ws.close());
}

window.setInterval(() => {
  if (socketState === "live" && Date.now() - lastLive > 1500) {
    setStatus("open", "Connected — waiting for Max");
  }
}, 400);

notify();
renderDiagnostics();
window.requestAnimationFrame(tick);
connect();
setActiveTab(location.hash.replace("#", "") === "visualize" ? "visualize" : "diagnostics");
