const pad = document.querySelector("[data-pad]");
const cursor = document.querySelector("[data-cursor]");
const statusEl = document.querySelector(".status");
const statusLabel = document.querySelector("[data-status-label]");
const sourceEl = document.querySelector("[data-source]");
const xEl = document.querySelector("[data-x]");
const yEl = document.querySelector("[data-y]");
const dpadEl = document.querySelector("[data-dpad]");
const fxActiveEl = document.querySelector("[data-fx-active]");
const stickRawXEl = document.querySelector("[data-stick-raw-x]");
const stickRawYEl = document.querySelector("[data-stick-raw-y]");
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
const fxNames = {
  cross: "Saturn 2",
  square: "kHs Comb Filter",
  triangle: "kHs Formant Filter",
  circle: "Crystallizer",
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

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const dpadDirs = new Set(["up", "down", "left", "right"]);
const FOLLOW_TAU = 0.035;

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

let x = 0.5;
let y = 0.5;
let targetX = 0.5;
let targetY = 0.5;
let dragging = false;
let lastLive = 0;
let lastFrame = 0;
let socketState = "offline";
let dpadHeld = { up: false, down: false, left: false, right: false };
let activeFx = "cross";
const fxStick = {
  cross: { x: 0, y: 0 },
  square: { x: 0, y: 0 },
  triangle: { x: 0, y: 0 },
  circle: { x: 0, y: 0 },
};

function lerp(inMin, inMax, outMin, outMax, value) {
  if (inMax === inMin) return outMin;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

function applyRawStick(nx, ny) {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
  if (stickRawXEl) stickRawXEl.textContent = fmt(nx);
  if (stickRawYEl) stickRawYEl.textContent = fmt(ny);
  fxStick.cross.x = lerp(-1, 1, 0, 1, nx);
  fxStick.cross.y = lerp(0, 1, 0, 0.75, ny);
  fxStick.square.x = lerp(-1, 1, 0.3, 0.7, nx);
  fxStick.square.y = lerp(-1, 1, 0.3, 0.7, ny);
  fxStick.triangle.x = lerp(-1, 1, 0, 1, nx);
  fxStick.triangle.y = lerp(-1, 1, 0, 1, ny);
  fxStick.circle.x = lerp(-1, 1, 0.825, 0.65, nx);
  fxStick.circle.y = lerp(-1, 1, 0.6, 1, ny);
}

function setFxName(button, name) {
  if (!fxStick[button] || !name) return;
  fxNames[button] = name;
  fxLabels[button] = `${fxButtonLabels[button]} · ${name}`;
  const card = fxCards[button];
  if (!card) return;
  const title = card.querySelector("h3");
  if (title) title.textContent = name;
}

function setFxButton(button, value) {
  if (!fxStick[button]) return;
  if (Number(value) === 0) return;
  activeFx = button;
}

function mix(px, py) {
  const ix = 1 - px;
  const iy = 1 - py;
  return {
    tl: ix * iy,
    tr: px * iy,
    bl: ix * py,
    br: px * py,
  };
}

function render() {
  cursor.style.left = `${x * 100}%`;
  cursor.style.top = `${y * 100}%`;
  document.querySelector(".crosshair.x").style.left = `${x * 100}%`;
  document.querySelector(".crosshair.y").style.top = `${y * 100}%`;
  xEl.textContent = x.toFixed(2);
  yEl.textContent = y.toFixed(2);

  const volumes = mix(x, y);
  for (const [key, value] of Object.entries(volumes)) {
    vols[key].textContent = `${Math.round(value * 100)}%`;
    quads[key].style.opacity = String(0.28 + value * 0.72);
  }

  if (fxActiveEl) fxActiveEl.textContent = fxLabels[activeFx] || activeFx;
  for (const [key, card] of Object.entries(fxCards)) {
    if (!card) continue;
    card.dataset.on = key === activeFx ? "true" : "";
    const fxXEl = card.querySelector("[data-fx-x]");
    const fxYEl = card.querySelector("[data-fx-y]");
    if (fxXEl) fxXEl.textContent = fmt(fxStick[key].x);
    if (fxYEl) fxYEl.textContent = fmt(fxStick[key].y);
  }
}

function setStatus(state, label) {
  socketState = state;
  statusEl.dataset.state = state;
  statusLabel.textContent = label;
}

function pointFromEvent(event) {
  const rect = pad.getBoundingClientRect();
  return {
    x: clamp01((event.clientX - rect.left) / rect.width),
    y: clamp01((event.clientY - rect.top) / rect.height),
  };
}

function setTarget(nx, ny, source, snap) {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
  targetX = clamp01(nx);
  targetY = clamp01(ny);
  sourceEl.textContent = source;
  if (source !== "mouse") lastLive = Date.now();
  if (snap) {
    x = targetX;
    y = targetY;
    render();
  }
}

function tick(now) {
  const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  const follow = dragging ? 1 : 1 - Math.exp(-dt / FOLLOW_TAU);
  x += (targetX - x) * follow;
  y += (targetY - y) * follow;
  render();
  window.requestAnimationFrame(tick);
}

function setDpadLabel() {
  const held = Object.keys(dpadHeld).filter((dir) => dpadHeld[dir]);
  dpadEl.textContent = held[0] || "—";
}

pad.addEventListener("pointerdown", (event) => {
  pad.setPointerCapture(event.pointerId);
  dragging = true;
  const point = pointFromEvent(event);
  setTarget(point.x, point.y, "mouse", true);
});

pad.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  const point = pointFromEvent(event);
  setTarget(point.x, point.y, "mouse", true);
});

pad.addEventListener("pointerup", () => {
  dragging = false;
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

    if (msg.type === "xy" && msg.source === "mixer") {
      setTarget(msg.x, msg.y, "Max mixer", false);
      setStatus("live", "Live from Max");
    }

    if (msg.type === "dpad") {
      const dir = String(msg.dir);
      if (!dpadDirs.has(dir)) return;
      dpadHeld[dir] = Number(msg.value) !== 0;
      setDpadLabel();
      lastLive = Date.now();
      setStatus("live", "Live from Max");
    }

    if (msg.type === "fx-select") {
      setFxButton(msg.button, msg.value);
      lastLive = Date.now();
      setStatus("live", "Live from Max");
    }

    if (msg.type === "fx-stick") {
      const button = String(msg.button);
      if (!fxStick[button]) return;
      if (Number.isFinite(msg.x)) fxStick[button].x = msg.x;
      if (Number.isFinite(msg.y)) fxStick[button].y = msg.y;
      lastLive = Date.now();
      setStatus("live", "Live from Max");
    }

    if (msg.type === "fx-raw") {
      applyRawStick(Number(msg.x), Number(msg.y));
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

render();
window.requestAnimationFrame(tick);
connect();
