const pad = document.querySelector("[data-pad]");
const cursor = document.querySelector("[data-cursor]");
const statusEl = document.querySelector(".status");
const statusLabel = document.querySelector("[data-status-label]");
const sourceEl = document.querySelector("[data-source]");
const xEl = document.querySelector("[data-x]");
const yEl = document.querySelector("[data-y]");
const dpadEl = document.querySelector("[data-dpad]");
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

let x = 0.5;
let y = 0.5;
let dragging = false;
let lastLive = 0;
let lastMixer = 0;
let socketState = "offline";

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

const DPAD_MS = 2000;
const TOUCH_TAKEOVER = 0.04;
const dpadTargets = {
  up: { x: 0, y: 0, quad: "tl" },
  right: { x: 1, y: 0, quad: "tr" },
  down: { x: 0, y: 1, quad: "bl" },
  left: { x: 1, y: 1, quad: "br" },
};

let dpadAnim = null;
let dpadLocked = false;
let dpadHeld = { up: false, down: false, left: false, right: false };
let lastTouch = null;
let touchMoves = 0;

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function clearQuadSnap() {
  for (const el of Object.values(quads)) el.dataset.snap = "";
}

function stopDpadRamp() {
  if (dpadAnim?.frame) cancelAnimationFrame(dpadAnim.frame);
  dpadAnim = null;
  clearQuadSnap();
}

function releaseDpadLock() {
  stopDpadRamp();
  dpadLocked = false;
  touchMoves = 0;
}

function applyXy(nx, ny, source) {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
  releaseDpadLock();
  x = clamp01(nx);
  y = clamp01(ny);
  sourceEl.textContent = source;
  if (source !== "mouse") lastLive = Date.now();
  render();
}

function startDpadRamp(dir) {
  const target = dpadTargets[dir];
  if (!target) return;

  if (dpadAnim && dpadAnim.dir === dir) return;
  if (!dpadAnim && dist(x, y, target.x, target.y) < 0.01) {
    dpadLocked = true;
    dpadEl.textContent = dir;
    sourceEl.textContent = `D-pad ${dir}`;
    return;
  }

  const fromX = x;
  const fromY = y;
  if (dpadAnim?.frame) cancelAnimationFrame(dpadAnim.frame);
  clearQuadSnap();
  quads[target.quad].dataset.snap = "on";
  dpadEl.textContent = dir;
  sourceEl.textContent = `D-pad ${dir}`;
  dpadLocked = true;
  lastTouch = null;
  touchMoves = 0;
  setStatus("live", "Live from Max");

  dpadAnim = {
    dir,
    fromX,
    fromY,
    toX: target.x,
    toY: target.y,
    start: performance.now(),
    frame: 0,
  };

  const tick = (now) => {
    if (!dpadAnim || dpadAnim.dir !== dir) return;
    const t = Math.min(1, (now - dpadAnim.start) / DPAD_MS);
    x = clamp01(dpadAnim.fromX + (dpadAnim.toX - dpadAnim.fromX) * t);
    y = clamp01(dpadAnim.fromY + (dpadAnim.toY - dpadAnim.fromY) * t);
    sourceEl.textContent = `D-pad ${dir}`;
    lastLive = Date.now();
    render();
    if (t < 1) {
      dpadAnim.frame = requestAnimationFrame(tick);
      return;
    }
    dpadAnim = null;
    clearQuadSnap();
  };

  dpadAnim.frame = requestAnimationFrame(tick);
}

function oscXyDuringDpad(msg) {
  if (msg.source !== "touch") return true;
  const nx = Number(msg.x);
  const ny = Number(msg.y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return true;
  if (!lastTouch) {
    lastTouch = { x: nx, y: ny };
    return true;
  }
  if (dist(nx, ny, lastTouch.x, lastTouch.y) > TOUCH_TAKEOVER) touchMoves += 1;
  else touchMoves = 0;
  lastTouch = { x: nx, y: ny };
  return touchMoves < 2;
}

pad.addEventListener("pointerdown", (event) => {
  pad.setPointerCapture(event.pointerId);
  dragging = true;
  const point = pointFromEvent(event);
  applyXy(point.x, point.y, "mouse");
});

pad.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  const point = pointFromEvent(event);
  applyXy(point.x, point.y, "mouse");
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

    if (msg.type === "xy") {
      const fromMixer = msg.source === "mixer";
      if (dpadLocked && oscXyDuringDpad(msg)) return;
      if (!fromMixer && Date.now() - lastMixer < 250) return;
      if (fromMixer) lastMixer = Date.now();
      applyXy(msg.x, msg.y, fromMixer ? "Max mixer" : "touchpad");
      setStatus("live", "Live from Max");
    }

    if (msg.type === "dpad") {
      const dir = String(msg.dir);
      if (!dpadTargets[dir]) return;
      const pressed = Number(msg.value) !== 0;
      const rising = pressed && !dpadHeld[dir];
      dpadHeld[dir] = pressed;
      lastLive = Date.now();
      setStatus("live", "Live from Max");
      if (pressed) dpadEl.textContent = dir;
      else if (!Object.values(dpadHeld).some(Boolean) && !dpadAnim) dpadEl.textContent = "—";
      if (rising) startDpadRamp(dir);
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
connect();
