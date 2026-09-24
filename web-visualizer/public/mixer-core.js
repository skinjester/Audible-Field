export const FOLLOW_TAU = 0.035;
export const DPAD_MS = 2000;

const dpadTargets = {
  up: { x: 0, y: 0 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: 1, y: 1 },
};

let dpadAnim = null;

function easeInOut(t) {
  return t * t * (3 - 2 * t);
}

export const state = {
  x: 0.5,
  y: 0.5,
  targetX: 0.5,
  targetY: 0.5,
  dragging: false,
  source: "mouse",
};

export const controller = {
  activeFx: "cross",
  rawX: 0,
  rawY: 0,
  rightX: 0,
  rightY: 0,
  lt: 0,
  rt: 0,
  l1: false,
  r1: false,
  ls: false,
  rs: false,
  pulse: 0,
  dpad: { up: false, down: false, left: false, right: false },
  dpadDir: null,
  fx: {
    cross: { x: 0, y: 0 },
    square: { x: 0, y: 0 },
    triangle: { x: 0, y: 0 },
    circle: { x: 0, y: 0 },
  },
  names: {
    cross: "Saturn 2",
    square: "kHs Comb Filter",
    triangle: "kHs Formant Filter",
    circle: "Crystallizer",
  },
};

const listeners = new Set();

export function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

/** Bilinear corner weights (UI / viz). */
export function mix(px, py) {
  const ix = 1 - px;
  const iy = 1 - py;
  return {
    tl: ix * iy,
    tr: px * iy,
    bl: ix * py,
    br: px * py,
  };
}

/**
 * Equal-power mix matching Max `nodes` → `vexpr sqrt($f1)` → `matrix~`.
 * Keeps perceived loudness steadier while crossfading four stems.
 */
export function equalPowerMix(px, py) {
  const w = mix(px, py);
  return {
    tl: Math.sqrt(w.tl),
    tr: Math.sqrt(w.tr),
    bl: Math.sqrt(w.bl),
    br: Math.sqrt(w.br),
  };
}

/** Canonical bed → corner map (Vault `nodes` x/y places: TL TR BL BR). */
export const STEM_CORNERS = {
  tl: { id: "beach", label: "Beach", file: "Beach-rx.wav", url: "/beds/Beach-rx.wav" },
  tr: { id: "forest", label: "Forest", file: "Forest-rx.wav", url: "/beds/Forest-rx.wav" },
  bl: { id: "river", label: "River", file: "River-rx.wav", url: "/beds/River-rx.wav" },
  br: {
    id: "synth",
    label: "Meditation Synth",
    file: "Meditation Synth-rx.wav",
    url: "/beds/Meditation%20Synth-rx.wav",
  },
};

/** Update a corner's sample assignment (label + playback URL). */
export function setStemCorner(corner, next) {
  if (!STEM_CORNERS[corner] || !next) return null;
  const label = String(next.label || next.name || STEM_CORNERS[corner].label).trim();
  const url = String(next.url || "").trim();
  if (!url) return null;
  const file = String(next.file || next.name || STEM_CORNERS[corner].file);
  const id = String(next.id || label.toLowerCase().replace(/\s+/g, "-"));
  STEM_CORNERS[corner] = { id, label, file, url };
  notify();
  return STEM_CORNERS[corner];
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  const weights = mix(state.x, state.y);
  for (const fn of listeners) {
    try {
      fn(state, weights, controller);
    } catch (err) {
      console.error("EchoScape mixer listener failed:", err);
    }
  }
}

export function setTarget(nx, ny, source, snap) {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
  const fromMax = typeof source === "string" && source.startsWith("Max");
  if (dpadAnim && source !== "D-pad" && source !== "mouse" && !fromMax) return;
  if (source !== "D-pad") dpadAnim = null;
  state.targetX = clamp01(nx);
  state.targetY = clamp01(ny);
  state.source = source;
  if (snap || fromMax) {
    state.x = state.targetX;
    state.y = state.targetY;
  }
  notify();
}

function startDpadBlend(dir) {
  const next = dpadTargets[dir];
  if (!next) return;
  dpadAnim = {
    fromX: state.x,
    fromY: state.y,
    toX: next.x,
    toY: next.y,
    elapsed: 0,
    dir,
  };
  state.source = "D-pad";
  state.targetX = next.x;
  state.targetY = next.y;
  notify();
}

export function setDpad(dir, value) {
  const name = String(dir || "").toLowerCase().trim();
  if (!(name in controller.dpad)) return;
  const pressed = Number(value) !== 0;
  controller.dpad[name] = pressed;
  if (pressed) {
    controller.dpadDir = name;
    startDpadBlend(name);
    return;
  }
  controller.dpadDir = Object.keys(controller.dpad).find((key) => controller.dpad[key]) || null;
  notify();
}

export function setActiveFx(button) {
  if (!controller.fx[button]) return;
  controller.activeFx = button;
  controller.pulse = 1;
  notify();
}

export function setRawStick(x, y) {
  if (Number.isFinite(x)) controller.rawX = x;
  if (Number.isFinite(y)) controller.rawY = y;
  notify();
}

export function setRightStick(x, y) {
  if (Number.isFinite(x)) controller.rightX = x;
  if (Number.isFinite(y)) controller.rightY = y;
  notify();
}

export function setTrigger(side, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  if (side === "lt") controller.lt = n;
  else if (side === "rt") controller.rt = n;
  else return;
  notify();
}

export function setStickClick(side, value) {
  const pressed = Number(value) !== 0;
  if (side === "ls") controller.ls = pressed;
  else if (side === "rs") controller.rs = pressed;
  else return;
  notify();
}

export function setShoulder(side, value) {
  const pressed = Number(value) !== 0;
  if (side === "l1") controller.l1 = pressed;
  else if (side === "r1") controller.r1 = pressed;
  else return;
  notify();
}

export function setFxStick(button, x, y) {
  if (!controller.fx[button]) return;
  if (Number.isFinite(x)) controller.fx[button].x = x;
  if (Number.isFinite(y)) controller.fx[button].y = y;
  notify();
}

export function setFxName(button, name) {
  if (!controller.names[button] || !name) return;
  controller.names[button] = name;
  notify();
}

export function tickMixer(now, lastFrame) {
  const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
  const prevX = state.x;
  const prevY = state.y;

  if (dpadAnim) {
    dpadAnim.elapsed += dt;
    const u = clamp01(dpadAnim.elapsed / (DPAD_MS / 1000));
    const e = easeInOut(u);
    state.x = dpadAnim.fromX + (dpadAnim.toX - dpadAnim.fromX) * e;
    state.y = dpadAnim.fromY + (dpadAnim.toY - dpadAnim.fromY) * e;
    state.targetX = state.x;
    state.targetY = state.y;
    if (u >= 1) dpadAnim = null;
  } else {
    const follow = state.dragging ? 1 : 1 - Math.exp(-dt / FOLLOW_TAU);
    state.x += (state.targetX - state.x) * follow;
    state.y += (state.targetY - state.y) * follow;
  }

  if (controller.pulse > 0) {
    controller.pulse = Math.max(0, controller.pulse - dt * 1.8);
  }
  if (state.x !== prevX || state.y !== prevY || controller.pulse > 0 || dpadAnim) notify();
  return dt;
}
