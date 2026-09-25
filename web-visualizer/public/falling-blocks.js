import * as THREE from "three";
import { controller } from "./mixer-core.js?v=65";
import { compileMaterials, stepWorld } from "./rule-engine.js?v=14";

const GRID = 16;
const MAX_Y = 12;
/**
 * Atom edge length AND grid pitch (world units). Neighbors always touch.
 * Change at runtime with setAtomSize().
 */
const ATOM_SIZE_DEFAULT = 1;
const ATOM_SIZE_MIN = 0.1;
const ATOM_SIZE_MAX = 2;
/** Fixed ground plane edge length (world units). Independent of atom size. */
const GROUND_PLANE_SIZE = GRID * ATOM_SIZE_DEFAULT + 10 * ATOM_SIZE_DEFAULT;
const SCENE_BG = 0x000000;
const SPLASH_LIFE = 0.42;
const CLICK_SLOP = 6;
const RULE_HZ = 22;

/** Fixed isometric-style view: 45° down; distance is zoomable. */
const CAMERA_PITCH = Math.PI / 4;
const CAMERA_YAW = Math.PI / 4;
const CAMERA_DIST_DEFAULT = 30;
const CAMERA_DIST_MIN = 10;
const CAMERA_DIST_MAX = 60;
const CAMERA_ZOOM_RATE = 1.15;
const STICK_DEADZONE = 0.12;
const AIM_SPEED = 9;
const SURFACE_YAW_RATE = 1.15;
const RT_PRESS = 0.08;
const DROP_INTERVAL = 0.1;
/** Continuous fall speed toward contact (world units / second). */
const GRAVITY = 28;
/** Default spawn altitude (cell Y for bottom of emit volume). */
const EMIT_ALTITUDE_DEFAULT = MAX_Y - 5;
const EMIT_DIM_MIN = 1;

let canvas = null;
let wrap = null;
let scene = null;
/** Rotatable playfield (ground, grid, blocks). Emitter aims across it. */
let surface = null;
let camera = null;
let renderer = null;
let emitter = null;
let groundMesh = null;
let blockGeo = null;
let emitterGeo = null;
let splashGeo = null;
let resizeObserver = null;
let paletteEl = null;
let fpsEl = null;
let atomsEl = null;
let trisEl = null;
let fpsFrames = 0;
let fpsLastAt = 0;

let running = false;
let rafId = 0;
let sizeTries = 0;
let lastNow = 0;
let rotatingSurface = false;
let ruleAcc = 0;
let cameraDist = CAMERA_DIST_DEFAULT;

/** @type {Uint8Array | null} */
let cells = null;
/** @type {Uint8Array | null} */
let budgets = null;
/** Per-cell age in seconds (for materials with lifetime). */
/** @type {Float32Array | null} */
let ages = null;
/** Forced lifetime from contact with an eroding material (0 = none). */
/** @type {Float32Array | null} */
let erodeLives = null;
/** Continuous world-space Y of each atom center (gravity / contact). */
/** @type {Float32Array | null} */
let posY = null;
/** Continuous world-space XZ (cluster packing so shrink stays flush). */
/** @type {Float32Array | null} */
let posX = null;
/** @type {Float32Array | null} */
let posZ = null;
/** Packed cell indices that currently hold material. */
const occupied = new Set();
/** @type {Map<number, THREE.InstancedMesh>} */
const instances = new Map();
/** @type {Map<number, THREE.MeshStandardMaterial>} */
const matCache = new Map();
/** @type {{ mesh: THREE.Mesh, age: number }[]} */
let splashes = [];
/** @type {{ ix: number, iz: number } | null} */
let aim = null;
/** @type {{ x: number, y: number, id: number } | null} */
let press = null;
let aimX = 0;
let aimZ = 0;
let l1WasDown = false;
let r1WasDown = false;
let circleWasDown = false;
let pointerPouring = false;
let emitAcc = 0;
let emitting = false;

/** @type {ReturnType<typeof compileMaterials> | null} */
let catalog = null;
let activeMaterialId = "block";
/** Current atom cube edge length (world units). */
let atomSize = ATOM_SIZE_DEFAULT;
/** Emitter volume in cells: length (X) × width (Z) × height (Y). */
let emitL = 1;
let emitW = 1;
let emitH = 1;
/** Cell Y for the bottom layer of the emit volume. */
let emitAltitude = EMIT_ALTITUDE_DEFAULT;

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hitPoint = new THREE.Vector3();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3(1, 1, 1);
const scratchQuat = new THREE.Quaternion();
const scratchMat4 = new THREE.Matrix4();

function showError(message) {
  const el = document.querySelector("[data-falling-error]");
  if (!el) return;
  el.hidden = false;
  el.textContent = message;
}

function clearError() {
  const el = document.querySelector("[data-falling-error]");
  if (el) el.hidden = true;
}

function idx(x, y, z) {
  return (y * GRID + z) * GRID + x;
}

function inBounds(x, y, z) {
  return x >= 0 && z >= 0 && y >= 0 && x < GRID && z < GRID && y < MAX_Y;
}

function getCell(x, y, z) {
  if (!cells || !inBounds(x, y, z)) return 0;
  return cells[idx(x, y, z)];
}

function setCell(x, y, z, value) {
  if (!cells || !inBounds(x, y, z)) return;
  const i = idx(x, y, z);
  const prev = cells[i];
  cells[i] = value;
  if (!value) {
    if (budgets) budgets[i] = 0;
    if (ages) ages[i] = 0;
    if (erodeLives) erodeLives[i] = 0;
    if (posY) posY[i] = 0;
    if (posX) posX[i] = 0;
    if (posZ) posZ[i] = 0;
  } else if (prev === 0) {
    // Fresh spawn: start at discrete cell center; gravity / pack settle from there.
    const p = atomSize;
    if (posY) posY[i] = (y + 0.5) * p;
    if (posX) posX[i] = (x + 0.5 - GRID / 2) * p;
    if (posZ) posZ[i] = (z + 0.5 - GRID / 2) * p;
  }
  if (value > 0) occupied.add(i);
  else if (prev > 0) occupied.delete(i);
}

function getBudget(x, y, z) {
  if (!budgets || !inBounds(x, y, z)) return 0;
  return budgets[idx(x, y, z)];
}

function setBudget(x, y, z, value) {
  if (!budgets || !inBounds(x, y, z)) return;
  budgets[idx(x, y, z)] = Math.max(0, value | 0);
}

function getAge(x, y, z) {
  if (!ages || !inBounds(x, y, z)) return 0;
  return ages[idx(x, y, z)];
}

function setAge(x, y, z, value) {
  if (!ages || !inBounds(x, y, z)) return;
  ages[idx(x, y, z)] = Math.max(0, Number(value) || 0);
}

function getErodeLife(x, y, z) {
  if (!erodeLives || !inBounds(x, y, z)) return 0;
  return erodeLives[idx(x, y, z)];
}

function setErodeLife(x, y, z, value) {
  if (!erodeLives || !inBounds(x, y, z)) return;
  erodeLives[idx(x, y, z)] = Math.max(0, Number(value) || 0);
}

function getPosY(x, y, z) {
  if (!posY || !inBounds(x, y, z)) return 0;
  return posY[idx(x, y, z)];
}

function setPosY(x, y, z, value) {
  if (!posY || !inBounds(x, y, z)) return;
  posY[idx(x, y, z)] = Number.isFinite(value) ? value : 0;
}

function getPosX(x, y, z) {
  if (!posX || !inBounds(x, y, z)) return 0;
  return posX[idx(x, y, z)];
}

function setPosX(x, y, z, value) {
  if (!posX || !inBounds(x, y, z)) return;
  posX[idx(x, y, z)] = Number.isFinite(value) ? value : 0;
}

function getPosZ(x, y, z) {
  if (!posZ || !inBounds(x, y, z)) return 0;
  return posZ[idx(x, y, z)];
}

function setPosZ(x, y, z, value) {
  if (!posZ || !inBounds(x, y, z)) return;
  posZ[idx(x, y, z)] = Number.isFinite(value) ? value : 0;
}

const gridApi = {
  get: getCell,
  set: setCell,
  inBounds,
  getBudget,
  setBudget,
  getAge,
  setAge,
  getErodeLife,
  setErodeLife,
  getPosY,
  setPosY,
  getPosX,
  setPosX,
  getPosZ,
  setPosZ,
};

function materialLifetime(matIndex) {
  if (!catalog || matIndex <= 0) return 0;
  const id = catalog.idByIndex[matIndex];
  const def = id ? catalog.byId.get(id) : null;
  return def?.lifetime || 0;
}

function materialErode(matIndex) {
  if (!catalog || matIndex <= 0) return 0;
  const id = catalog.idByIndex[matIndex];
  const def = id ? catalog.byId.get(id) : null;
  return def?.erode || 0;
}

/** Effective shrink lifetime for a cell (native material life and/or erode infection). */
function cellLifetime(cellIndex, matIndex) {
  const native = materialLifetime(matIndex);
  const forced = erodeLives ? erodeLives[cellIndex] || 0 : 0;
  if (forced > 0 && native > 0) return Math.min(forced, native);
  if (forced > 0) return forced;
  return native;
}

function cellScale(x, y, z, matIndex) {
  const life = cellLifetime(idx(x, y, z), matIndex);
  if (life <= 0 || !ages) return 1;
  const t = Math.min(1, Math.max(0, getAge(x, y, z) / life));
  return Math.max(0.02, 1 - t);
}

function atomExtent(x, y, z, matIndex) {
  return atomSize * cellScale(x, y, z, matIndex);
}

function cellWorld(x, y, z, target, scale = 1) {
  const p = atomSize;
  const i = idx(x, y, z);
  target.x = posX ? posX[i] : (x + 0.5 - GRID / 2) * p;
  target.y = posY ? posY[i] : (y + 0.5) * p;
  target.z = posZ ? posZ[i] : (z + 0.5 - GRID / 2) * p;
  return target;
}

export function getAtomSize() {
  return atomSize;
}

/**
 * Set atom cube size. Also sets grid pitch so neighbors stay in contact.
 */
export function setAtomSize(size) {
  const next = Math.min(
    ATOM_SIZE_MAX,
    Math.max(ATOM_SIZE_MIN, Number(size) || ATOM_SIZE_DEFAULT),
  );
  if (Math.abs(next - atomSize) < 1e-6) return atomSize;
  atomSize = next;
  rebuildAtomGeometry();
  rebuildEmitterGeometry();
  rebuildSplashGeometry();
  setAimFromWorld();
  syncEmitter();
  syncAtomSizeUi();
  return atomSize;
}

function rebuildAtomGeometry() {
  if (blockGeo) {
    blockGeo.dispose();
    blockGeo = null;
  }
  blockGeo = new THREE.BoxGeometry(atomSize, atomSize, atomSize);
  if (!surface) return;
  for (const mesh of instances.values()) {
    surface.remove(mesh);
  }
  instances.clear();
  reconcileMeshes();
}

function rebuildSplashGeometry() {
  if (splashGeo) splashGeo.dispose();
  splashGeo = new THREE.RingGeometry(atomSize * 0.55, atomSize * 0.8, 28);
}

function syncCamera() {
  if (!camera) return;
  const horizontal = Math.cos(CAMERA_PITCH) * cameraDist;
  camera.position.set(
    Math.sin(CAMERA_YAW) * horizontal,
    Math.sin(CAMERA_PITCH) * cameraDist,
    Math.cos(CAMERA_YAW) * horizontal,
  );
  camera.lookAt(0, 0.35, 0);
}

function setCameraDist(next) {
  const clamped = Math.min(CAMERA_DIST_MAX, Math.max(CAMERA_DIST_MIN, next));
  if (Math.abs(clamped - cameraDist) < 1e-6) return cameraDist;
  cameraDist = clamped;
  syncCamera();
  return cameraDist;
}

function zoomCamera(factor) {
  if (!Number.isFinite(factor) || factor <= 0) return cameraDist;
  return setCameraDist(cameraDist * factor);
}

/** Yaw the playfield in place (stays centered). */
function rotateSurface(deltaYaw) {
  if (!surface || !deltaYaw) return;
  surface.rotation.y += deltaYaw;
}

/** Clamp continuous aim and snap to the nearest grid cell. */
function setAimFromWorld() {
  const half = (GRID * atomSize) / 2;
  const limit = half - 0.001;
  aimX = Math.min(limit, Math.max(-limit, aimX));
  aimZ = Math.min(limit, Math.max(-limit, aimZ));
  const ix = Math.floor(aimX / atomSize + GRID / 2);
  const iz = Math.floor(aimZ / atomSize + GRID / 2);
  if (ix < 0 || iz < 0 || ix >= GRID || iz >= GRID) {
    aim = null;
    return;
  }
  aim = { ix, iz };
}

/** Move the emitter in camera-relative XZ (surface stays put). */
function moveAim(lx, ly, dt) {
  if (dt <= 0 || (!lx && !ly)) return;
  const camSin = Math.sin(CAMERA_YAW);
  const camCos = Math.cos(CAMERA_YAW);
  const step = AIM_SPEED * dt;
  const wx = (camCos * lx - camSin * ly) * step;
  const wz = (-camSin * lx - camCos * ly) * step;
  const sy = surface ? surface.rotation.y : 0;
  const c = Math.cos(sy);
  const s = Math.sin(sy);
  aimX += c * wx + s * wz;
  aimZ += -s * wx + c * wz;
  setAimFromWorld();
  syncEmitter();
}

function aimFromEvent(event) {
  if (!canvas || !camera || !surface) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return;
  surface.updateMatrixWorld(true);
  surface.worldToLocal(hitPoint);
  aimX = hitPoint.x;
  aimZ = hitPoint.z;
  setAimFromWorld();
  syncEmitter();
}

function measureWrap() {
  if (!wrap) return { width: 0, height: 0 };
  const rect = wrap.getBoundingClientRect();
  return {
    width: Math.max(0, Math.floor(rect.width)),
    height: Math.max(0, Math.floor(rect.height)),
  };
}

function resizeCanvas() {
  if (!renderer || !camera || !wrap) return false;
  const { width, height } = measureWrap();
  if (width < 32 || height < 32) return false;

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  return true;
}

function stickAxis(value) {
  const n = Number(value) || 0;
  return Math.abs(n) < STICK_DEADZONE ? 0 : n;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function readRightTrigger(pad) {
  const fromCore = clamp01(Number(controller.rt) || 0);
  const btn = pad?.buttons?.[7];
  const fromPad = btn
    ? Number.isFinite(btn.value)
      ? clamp01(btn.value)
      : btn.pressed
        ? 1
        : 0
    : 0;
  return Math.max(fromCore, fromPad);
}

function emitWorldY() {
  // Height uses a fixed pitch so atom size does not move the emitter.
  return (emitAltitude + emitH * 0.5) * ATOM_SIZE_DEFAULT;
}

/** Bottom cell Y of the emit volume, aligned to the emitter's world height. */
function emitCellBottom() {
  const bottomWorld = emitWorldY() - emitH * atomSize * 0.5;
  return Math.max(0, Math.min(maxEmitAltitude(), Math.round(bottomWorld / atomSize)));
}

function maxEmitAltitude() {
  return Math.max(0, MAX_Y - emitH);
}

function clampEmitAltitude(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return EMIT_ALTITUDE_DEFAULT;
  return Math.max(0, Math.min(maxEmitAltitude(), n));
}

export function getEmitAltitude() {
  return emitAltitude;
}

/** Set emitter spawn altitude in cells (bottom of emit volume). */
export function setEmitAltitude(value) {
  const next = clampEmitAltitude(value);
  if (next === emitAltitude) return emitAltitude;
  emitAltitude = next;
  syncEmitter();
  syncEmitAltitudeUi();
  return emitAltitude;
}

function clampEmitDim(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return EMIT_DIM_MIN;
  return Math.max(EMIT_DIM_MIN, n);
}

export function getEmitSize() {
  return { l: emitL, w: emitW, h: emitH };
}

/**
 * Set emitter volume in cells (L×W×H). Rebuilds emitter geometry with direct sizes.
 */
export function setEmitSize(l, w, h) {
  const nextL = clampEmitDim(l);
  const nextW = clampEmitDim(w);
  const nextH = clampEmitDim(h);
  if (nextL === emitL && nextW === emitW && nextH === emitH) {
    return getEmitSize();
  }
  emitL = nextL;
  emitW = nextW;
  emitH = nextH;
  emitAltitude = clampEmitAltitude(emitAltitude);
  rebuildEmitterGeometry();
  syncEmitter();
  syncEmitAltitudeUi();
  return getEmitSize();
}

function emitterBoxSize() {
  // Span cell centers for multi-atom volumes; pitch equals atomSize.
  return {
    x: emitL * atomSize,
    y: emitH * atomSize,
    z: emitW * atomSize,
  };
}

function rebuildEmitterGeometry() {
  if (!emitter) return;
  if (emitterGeo) {
    emitterGeo.dispose();
    emitterGeo = null;
  }
  const size = emitterBoxSize();
  emitterGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
  emitter.geometry = emitterGeo;
}

function syncEmitter() {
  if (!emitter) return;
  emitter.position.set(aimX, emitWorldY(), aimZ);
  const matIndex = catalog?.indexById.get(activeMaterialId) || 0;
  emitter.material.color.set(materialColor(matIndex));
  emitter.material.opacity = emitting ? 0.72 : 0.45;
  emitter.visible = true;
}

function materialColor(matIndex) {
  const id = catalog?.idByIndex[matIndex];
  const def = id ? catalog.byId.get(id) : null;
  return def?.color || "#cccccc";
}

function materialMeshMat(matIndex) {
  let mat = matCache.get(matIndex);
  if (mat) return mat;
  mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(materialColor(matIndex)),
    roughness: 0.76,
    metalness: 0.02,
  });
  matCache.set(matIndex, mat);
  return mat;
}

function connectedPad() {
  const pads = navigator.getGamepads?.();
  if (!pads) return null;
  let fallback = null;
  for (let i = 0; i < pads.length; i += 1) {
    const pad = pads[i];
    if (!pad) continue;
    if (/dualsense|dualshock|wireless controller|playstation/i.test(pad.id || "")) return pad;
    if (!fallback) fallback = pad;
  }
  return fallback;
}

function setActiveMaterial(id) {
  if (!catalog?.byId.has(id)) return;
  activeMaterialId = id;
  syncPaletteUi();
  syncEmitter();
}

function cycleMaterial(delta) {
  if (!catalog?.list.length) return;
  const i = catalog.list.findIndex((m) => m.id === activeMaterialId);
  const next = catalog.list[(i + delta + catalog.list.length) % catalog.list.length];
  setActiveMaterial(next.id);
}

function syncPaletteUi() {
  if (!paletteEl) return;
  for (const btn of paletteEl.querySelectorAll("[data-material]")) {
    const on = btn.getAttribute("data-material") === activeMaterialId;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function syncAtomSizeUi() {
  const input = document.querySelector("[data-atom-size]");
  const valueEl = document.querySelector("[data-atom-size-value]");
  if (input instanceof HTMLInputElement) input.value = String(atomSize);
  if (valueEl) valueEl.textContent = atomSize.toFixed(2);
}

function syncEmitAltitudeUi() {
  const input = document.querySelector("[data-emit-altitude]");
  const valueEl = document.querySelector("[data-emit-altitude-value]");
  if (input instanceof HTMLInputElement) {
    input.max = String(maxEmitAltitude());
    input.value = String(emitAltitude);
  }
  if (valueEl) valueEl.textContent = String(emitAltitude);
}

function bindEmitAltitudeUi() {
  const input = document.querySelector("[data-emit-altitude]");
  if (!(input instanceof HTMLInputElement) || input.dataset.bound === "1") {
    syncEmitAltitudeUi();
    return;
  }
  input.dataset.bound = "1";
  input.min = "0";
  input.max = String(maxEmitAltitude());
  input.step = "1";
  const onInput = () => {
    setEmitAltitude(Number(input.value));
  };
  input.addEventListener("input", onInput);
  syncEmitAltitudeUi();
}

function bindAtomSizeUi() {
  const input = document.querySelector("[data-atom-size]");
  if (!(input instanceof HTMLInputElement) || input.dataset.bound === "1") {
    syncAtomSizeUi();
    return;
  }
  input.dataset.bound = "1";
  input.min = String(ATOM_SIZE_MIN);
  input.max = String(ATOM_SIZE_MAX);
  input.step = "0.01";
  const onInput = () => {
    setAtomSize(Number(input.value));
    syncAtomSizeUi();
  };
  input.addEventListener("input", onInput);
  syncAtomSizeUi();
}

function syncEmitSizeUi() {
  const lEl = document.querySelector("[data-emit-l]");
  const wEl = document.querySelector("[data-emit-w]");
  const hEl = document.querySelector("[data-emit-h]");
  if (lEl instanceof HTMLInputElement) lEl.value = String(emitL);
  if (wEl instanceof HTMLInputElement) wEl.value = String(emitW);
  if (hEl instanceof HTMLInputElement) hEl.value = String(emitH);
}

function bindEmitSizeUi() {
  const lEl = document.querySelector("[data-emit-l]");
  const wEl = document.querySelector("[data-emit-w]");
  const hEl = document.querySelector("[data-emit-h]");
  if (
    !(lEl instanceof HTMLInputElement) ||
    !(wEl instanceof HTMLInputElement) ||
    !(hEl instanceof HTMLInputElement)
  ) {
    return;
  }
  if (lEl.dataset.bound === "1") {
    syncEmitSizeUi();
    return;
  }
  lEl.dataset.bound = "1";
  wEl.dataset.bound = "1";
  hEl.dataset.bound = "1";
  lEl.min = String(EMIT_DIM_MIN);
  wEl.min = String(EMIT_DIM_MIN);
  hEl.min = String(EMIT_DIM_MIN);
  lEl.removeAttribute("max");
  wEl.removeAttribute("max");
  hEl.removeAttribute("max");
  const apply = (sync) => {
    const rawL = lEl.value.trim();
    const rawW = wEl.value.trim();
    const rawH = hEl.value.trim();
    if (rawL === "" || rawW === "" || rawH === "") return;
    setEmitSize(rawL, rawW, rawH);
    if (sync) syncEmitSizeUi();
  };
  for (const el of [lEl, wEl, hEl]) {
    el.addEventListener("input", () => apply(false));
    el.addEventListener("change", () => apply(true));
  }
  syncEmitSizeUi();
}

function buildPalette() {
  paletteEl = document.querySelector("[data-falling-palette]");
  if (!paletteEl || !catalog) return;
  paletteEl.replaceChildren();
  for (const mat of catalog.list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.material = mat.id;
    btn.textContent = mat.label;
    btn.style.setProperty("--swatch", mat.color);
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      setActiveMaterial(mat.id);
    });
    paletteEl.appendChild(btn);
  }
  syncPaletteUi();
  bindAtomSizeUi();
  bindEmitAltitudeUi();
  bindEmitSizeUi();
  bindClearUi();
}

/** Wipe all atoms, splashes, and surface transform. */
export function clearBoard() {
  if (cells) cells.fill(0);
  if (budgets) budgets.fill(0);
  if (ages) ages.fill(0);
  if (erodeLives) erodeLives.fill(0);
  if (posY) posY.fill(0);
  if (posX) posX.fill(0);
  if (posZ) posZ.fill(0);
  occupied.clear();

  for (const splash of splashes) {
    surface?.remove(splash.mesh);
    splash.mesh.material.dispose();
  }
  splashes = [];

  for (const mesh of instances.values()) {
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  if (surface) {
    surface.position.set(0, 0, 0);
    surface.rotation.set(0, 0, 0);
  }

  aimX = 0;
  aimZ = 0;
  emitting = false;
  emitAcc = 0;
  pointerPouring = false;
  setAimFromWorld();
  syncEmitter();
  reconcileMeshes();
}

function bindClearUi() {
  const btn = document.querySelector("[data-falling-clear]");
  if (!(btn instanceof HTMLButtonElement) || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    clearBoard();
  });
}

function applyController(dt) {
  if (!camera || dt <= 0) return;

  const lx = stickAxis(controller.rawX);
  const ly = stickAxis(controller.rawY);
  const rx = stickAxis(controller.rightX);
  const ry = stickAxis(controller.rightY);

  if (rx) rotateSurface(-rx * SURFACE_YAW_RATE * dt);
  if (lx || ly) moveAim(lx, ly, dt);
  if (ry) zoomCamera(Math.exp(-ry * CAMERA_ZOOM_RATE * dt));

  const pad = connectedPad();
  const buttons = pad?.buttons || [];
  const pressed = (i) => !!(buttons[i] && (buttons[i].pressed || buttons[i].value > 0.5));

  const rt = readRightTrigger(pad);
  updateEmitStream(dt, rt >= RT_PRESS || pointerPouring);

  const l1Down = !!(controller.l1 || pressed(4));
  if (l1Down && !l1WasDown) cycleMaterial(-1);
  l1WasDown = l1Down;

  const r1Down = !!(controller.r1 || pressed(5));
  if (r1Down && !r1WasDown) cycleMaterial(1);
  r1WasDown = r1Down;

  // Standard mapping: 1 = B / Circle
  const circleDown = pressed(1);
  if (circleDown && !circleWasDown) clearBoard();
  circleWasDown = circleDown;
}

function updateEmitStream(dt, active) {
  if (active && aim) {
    if (!emitting) {
      emitting = true;
      emitAcc = 0;
      dropAt(aim.ix, aim.iz);
      syncEmitter();
    } else {
      emitAcc += dt;
      while (emitAcc >= DROP_INTERVAL) {
        emitAcc -= DROP_INTERVAL;
        dropAt(aim.ix, aim.iz);
      }
    }
  } else if (emitting) {
    emitting = false;
    emitAcc = 0;
    syncEmitter();
  }
}

/**
 * SandPond Dropper: place an L×W×H block of atoms centered on (ix, iz),
 * starting at the floating emitter height. Skips occupied cells.
 */
function dropAt(ix, iz) {
  if (!cells || !catalog) return;
  const matIndex = catalog.indexById.get(activeMaterialId);
  if (!matIndex) return;

  const x0 = ix - Math.floor((emitL - 1) / 2);
  const z0 = iz - Math.floor((emitW - 1) / 2);
  const y0 = emitCellBottom();
  let placed = 0;

  for (let dy = 0; dy < emitH; dy += 1) {
    const y = y0 + dy;
    if (y >= MAX_Y) break;
    for (let dx = 0; dx < emitL; dx += 1) {
      for (let dz = 0; dz < emitW; dz += 1) {
        const x = x0 + dx;
        const z = z0 + dz;
        if (!inBounds(x, y, z)) continue;
        if (getCell(x, y, z) !== 0) continue;
        setCell(x, y, z, matIndex);
        placed += 1;
      }
    }
  }

  if (placed) reconcileMeshes();
}

function spawnSplash(x, y, z) {
  if (!surface || !splashGeo) return;
  const material = new THREE.MeshBasicMaterial({
    color: 0xf0d8cc,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(splashGeo, material);
  mesh.rotation.x = -Math.PI / 2;
  cellWorld(x, y, z, mesh.position);
  mesh.position.y = y * atomSize + atomSize * 0.08;
  mesh.scale.setScalar(1);
  surface.add(mesh);
  splashes.push({ mesh, age: 0 });
}

function collectOccupied() {
  /** @type {{ x: number, y: number, z: number, mat: number }[]} */
  const list = [];
  if (!cells) return list;
  for (const i of occupied) {
    const mat = cells[i];
    if (mat <= 0) {
      occupied.delete(i);
      continue;
    }
    const x = i % GRID;
    const rest = (i / GRID) | 0;
    const z = rest % GRID;
    const y = (rest / GRID) | 0;
    list.push({ x, y, z, mat });
  }
  return list;
}

function ensureInstanced(matIndex, count) {
  let mesh = instances.get(matIndex);
  const capacity = mesh ? mesh.instanceMatrix.count : 0;
  if (!mesh || capacity < count) {
    if (mesh) surface?.remove(mesh);
    const nextCap = Math.max(count, capacity * 2 || 4096);
    mesh = new THREE.InstancedMesh(blockGeo, materialMeshMat(matIndex), nextCap);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    surface.add(mesh);
    instances.set(matIndex, mesh);
  }
  return mesh;
}

function reconcileMeshes() {
  if (!surface || !blockGeo) return;

  /** @type {Map<number, number[]>} */
  const byMat = new Map();
  for (const i of occupied) {
    const mat = cells[i];
    if (mat <= 0) continue;
    const x = i % GRID;
    const rest = (i / GRID) | 0;
    const z = rest % GRID;
    const y = (rest / GRID) | 0;
    let coords = byMat.get(mat);
    if (!coords) {
      coords = [];
      byMat.set(mat, coords);
    }
    coords.push(x, y, z);
  }

  for (const [mat, mesh] of instances) {
    if (byMat.has(mat)) continue;
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  for (const [mat, coords] of byMat) {
    const n = (coords.length / 3) | 0;
    const mesh = ensureInstanced(mat, n);
    for (let k = 0; k < n; k += 1) {
      const o = k * 3;
      const x = coords[o];
      const y = coords[o + 1];
      const z = coords[o + 2];
      const scale = cellScale(x, y, z, mat);
      cellWorld(x, y, z, scratchPos, scale);
      scratchScale.set(scale, scale, scale);
      scratchMat4.compose(scratchPos, scratchQuat, scratchScale);
      mesh.setMatrixAt(k, scratchMat4);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }
  syncEmitter();
}

/**
 * Age materials with a lifetime; shrink visually and despawn when expired.
 * Contact with eroding materials infects neighbors with a forced lifetime.
 * @returns {boolean} true if meshes need a refresh
 */
function ageAtoms(dt) {
  if (!cells || !ages || !catalog || dt <= 0 || occupied.size === 0) return false;
  let dirty = false;

  const NEIGHBORS = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

  // Infect neighbors of eroding atoms (once infected, shrink continues even if they separate).
  if (erodeLives) {
    for (const i of occupied) {
      const mat = cells[i];
      if (mat <= 0) continue;
      const duration = materialErode(mat);
      if (duration <= 0) continue;
      const x = i % GRID;
      const rest = (i / GRID) | 0;
      const z = rest % GRID;
      const y = (rest / GRID) | 0;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (!inBounds(nx, ny, nz)) continue;
        const ni = idx(nx, ny, nz);
        const nmat = cells[ni];
        if (nmat <= 0 || nmat === mat) continue;
        if ((erodeLives[ni] || 0) > 0) continue;
        erodeLives[ni] = duration;
        dirty = true;
      }
    }
  }

  const doomed = [];
  for (const i of occupied) {
    const mat = cells[i];
    if (mat <= 0) continue;
    const life = cellLifetime(i, mat);
    if (life <= 0) continue;
    ages[i] += dt;
    dirty = true;
    if (ages[i] >= life) doomed.push(i);
  }
  for (const i of doomed) {
    const x = i % GRID;
    const rest = (i / GRID) | 0;
    const z = rest % GRID;
    const y = (rest / GRID) | 0;
    setCell(x, y, z, 0);
  }
  return dirty || doomed.length > 0;
}

/**
 * Recompute contact each tick from current atom sizes: fall until resting on
 * the ground plane or the atom below in the same column.
 * @returns {boolean}
 */
function settleGravity(dt) {
  if (!cells || !posY || dt <= 0 || occupied.size === 0) return false;

  /** @type {Map<number, number[]>} */
  const columns = new Map();
  for (const i of occupied) {
    if (cells[i] <= 0) continue;
    const x = i % GRID;
    const rest = (i / GRID) | 0;
    const z = rest % GRID;
    const key = z * GRID + x;
    let list = columns.get(key);
    if (!list) {
      list = [];
      columns.set(key, list);
    }
    list.push(i);
  }

  let moved = false;
  const fall = GRAVITY * dt;

  for (const list of columns.values()) {
    list.sort((a, b) => {
      const ay = posY[a] || 0;
      const by = posY[b] || 0;
      if (ay !== by) return ay - by;
      return a - b;
    });

    let floorTop = 0;
    for (const i of list) {
      const mat = cells[i];
      const x = i % GRID;
      const rest = (i / GRID) | 0;
      const z = rest % GRID;
      const y = (rest / GRID) | 0;
      const size = atomExtent(x, y, z, mat);
      const restCenter = floorTop + size * 0.5;
      let yCenter = posY[i] > 0 ? posY[i] : restCenter;

      if (yCenter > restCenter + 1e-5) {
        yCenter = Math.max(restCenter, yCenter - fall);
        moved = true;
      } else if (yCenter < restCenter - 1e-5) {
        // Support grew/shrunk — snap up onto contact (no tunneling into ground).
        yCenter = restCenter;
        moved = true;
      } else {
        yCenter = restCenter;
      }

      if (Math.abs(posY[i] - yCenter) > 1e-5) moved = true;
      posY[i] = yCenter;
      floorTop = yCenter + size * 0.5;
    }
  }

  return moved;
}

/**
 * Keep connected atoms flush as they shrink: contract each cluster in XZ so
 * neighbors stay in contact and the surface area shrinks as a whole.
 * @returns {boolean}
 */
function packStickTogether() {
  if (!cells || !posX || !posZ || occupied.size === 0) return false;

  const visited = new Set();
  const dirs = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  let moved = false;

  for (const start of occupied) {
    if (cells[start] <= 0 || visited.has(start)) continue;

    /** @type {number[]} */
    const comp = [];
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const i = queue.pop();
      comp.push(i);
      const x = i % GRID;
      const rest = (i / GRID) | 0;
      const z = rest % GRID;
      const y = (rest / GRID) | 0;
      for (const [dx, dy, dz] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (!inBounds(nx, ny, nz)) continue;
        const ni = idx(nx, ny, nz);
        if (visited.has(ni) || cells[ni] <= 0) continue;
        visited.add(ni);
        queue.push(ni);
      }
    }

    let sumS = 0;
    let cX = 0;
    let cZ = 0;
    /** @type {{ i: number, x: number, y: number, z: number, ext: number, wx: number, wz: number }[]} */
    const members = [];
    for (const i of comp) {
      const x = i % GRID;
      const rest = (i / GRID) | 0;
      const z = rest % GRID;
      const y = (rest / GRID) | 0;
      const mat = cells[i];
      const s = cellScale(x, y, z, mat);
      const wx = (x + 0.5 - GRID / 2) * atomSize;
      const wz = (z + 0.5 - GRID / 2) * atomSize;
      sumS += s;
      cX += wx;
      cZ += wz;
      members.push({ i, x, y, z, ext: atomSize * s, wx, wz });
    }

    const n = members.length;
    const sAvg = sumS / n;
    cX /= n;
    cZ /= n;

    // Full-size clusters stay on the grid pitch.
    if (sAvg >= 0.999) {
      for (const m of members) {
        if (Math.abs(posX[m.i] - m.wx) > 1e-5 || Math.abs(posZ[m.i] - m.wz) > 1e-5) {
          moved = true;
        }
        posX[m.i] = m.wx;
        posZ[m.i] = m.wz;
      }
      continue;
    }

    // Contract toward centroid by average scale so the whole surface shrinks.
    for (const m of members) {
      const nx = cX + (m.wx - cX) * sAvg;
      const nz = cZ + (m.wz - cZ) * sAvg;
      if (Math.abs(posX[m.i] - nx) > 1e-5 || Math.abs(posZ[m.i] - nz) > 1e-5) {
        moved = true;
      }
      posX[m.i] = nx;
      posZ[m.i] = nz;
    }

    // Snap face-neighbors onto exact contact from individual extents (no gaps).
    const inComp = new Set(comp);
    for (let pass = 0; pass < 4; pass += 1) {
      for (const m of members) {
        for (const [dx, dz] of [
          [1, 0],
          [0, 1],
        ]) {
          const nx = m.x + dx;
          const nz = m.z + dz;
          if (!inBounds(nx, m.y, nz)) continue;
          const ni = idx(nx, m.y, nz);
          if (!inComp.has(ni) || cells[ni] <= 0) continue;
          const nMat = cells[ni];
          const nExt = atomExtent(nx, m.y, nz, nMat);
          const desired = (m.ext + nExt) * 0.5;
          if (dx === 1) {
            const sep = posX[ni] - posX[m.i];
            const gap = sep - desired;
            if (Math.abs(gap) > 1e-5) {
              posX[m.i] += gap * 0.5;
              posX[ni] -= gap * 0.5;
              moved = true;
            }
          } else {
            const sep = posZ[ni] - posZ[m.i];
            const gap = sep - desired;
            if (Math.abs(gap) > 1e-5) {
              posZ[m.i] += gap * 0.5;
              posZ[ni] -= gap * 0.5;
              moved = true;
            }
          }
        }
      }
    }
  }

  return moved;
}

function runRules() {
  if (!catalog) return;
  const occupiedList = collectOccupied();
  const { splashes: splashCells } = stepWorld(gridApi, occupiedList, catalog);

  reconcileMeshes();
  for (const cell of splashCells) {
    spawnSplash(cell.x, cell.y, cell.z);
  }
}

function step(dt) {
  applyController(dt);

  ruleAcc += dt;
  const interval = 1 / RULE_HZ;
  while (ruleAcc >= interval) {
    ruleAcc -= interval;
    runRules();
  }

  const aged = ageAtoms(dt);
  const settled = settleGravity(dt);
  const packed = packStickTogether();
  if (aged || settled || packed) reconcileMeshes();

  for (let i = splashes.length - 1; i >= 0; i -= 1) {
    const splash = splashes[i];
    splash.age += dt;
    const t = splash.age / SPLASH_LIFE;
    if (t >= 1) {
      surface?.remove(splash.mesh);
      splash.mesh.material.dispose();
      splashes.splice(i, 1);
      continue;
    }
    splash.mesh.scale.setScalar(1 + t * 3);
    splash.mesh.material.opacity = 0.75 * (1 - t);
  }
}

function renderFrame(now) {
  if (!running || !renderer || !scene || !camera) return;

  const dt = lastNow ? Math.min(0.05, (now - lastNow) / 1000) : 0;
  lastNow = now;

  try {
    step(dt);
    renderer.render(scene, camera);
    updateHud(now);
  } catch (err) {
    console.error("EchoScape falling blocks frame failed:", err);
    showError(`3D render error: ${err.message}`);
    running = false;
    return;
  }

  rafId = window.requestAnimationFrame(renderFrame);
}

function formatCount(n) {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function updateHud(now) {
  if (!fpsEl || !atomsEl || !trisEl) return;
  fpsFrames += 1;
  if (!fpsLastAt) fpsLastAt = now;
  const elapsed = now - fpsLastAt;
  if (elapsed >= 500) {
    fpsEl.textContent = String(Math.round((fpsFrames * 1000) / elapsed));
    fpsFrames = 0;
    fpsLastAt = now;
  }
  atomsEl.textContent = formatCount(occupied.size);
  const tris = renderer?.info?.render?.triangles;
  trisEl.textContent = Number.isFinite(tris) ? formatCount(tris) : "--";
}

function startRenderLoop() {
  if (rafId) window.cancelAnimationFrame(rafId);
  rafId = 0;
  if (!running) return;

  if (!resizeCanvas()) {
    sizeTries += 1;
    if (sizeTries < 40) {
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        if (running) startRenderLoop();
      });
      return;
    }
    const { width, height } = measureWrap();
    showError(`3D view has no size yet (${width}×${height}). Try resizing the window.`);
    return;
  }

  sizeTries = 0;
  lastNow = 0;
  clearError();
  renderFrame(performance.now());
}

function onPointerMove(event) {
  if (rotatingSurface) {
    rotateSurface(-event.movementX * 0.005);
    return;
  }
  if (pointerPouring) aimFromEvent(event);
}

function onPointerDown(event) {
  if (event.button === 2) {
    rotatingSurface = true;
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  press = { x: event.clientX, y: event.clientY, id: event.pointerId };
  aimFromEvent(event);
  pointerPouring = true;
}

function onPointerUp(event) {
  if (event.button === 2) {
    rotatingSurface = false;
    return;
  }
  if (event.button !== 0) return;
  press = null;
  pointerPouring = false;
}

function onPointerCancel() {
  rotatingSurface = false;
  press = null;
  pointerPouring = false;
}

function onContextMenu(event) {
  event.preventDefault();
}

function onWheel(event) {
  event.preventDefault();
  // Scroll up → zoom in (closer), scroll down → zoom out.
  zoomCamera(Math.exp(event.deltaY * 0.0012));
}

async function loadCatalog() {
  const res = await fetch(`/materials.json?v=15`);
  if (!res.ok) throw new Error(`materials.json ${res.status}`);
  const prev = activeMaterialId;
  catalog = compileMaterials(await res.json());
  activeMaterialId = catalog.byId.has(prev)
    ? prev
    : catalog.defaultId || catalog.list[0]?.id || "block";
  buildPalette();
}

function initScene(nextCanvas) {
  canvas = nextCanvas;
  wrap = canvas.parentElement;
  canvas.style.cursor = "crosshair";
  canvas.style.touchAction = "none";
  fpsEl = document.querySelector("[data-falling-fps]");
  atomsEl = document.querySelector("[data-falling-atoms]");
  trisEl = document.querySelector("[data-falling-tris]");
  fpsFrames = 0;
  fpsLastAt = 0;

  cells = new Uint8Array(GRID * GRID * MAX_Y);
  budgets = new Uint8Array(GRID * GRID * MAX_Y);
  ages = new Float32Array(GRID * GRID * MAX_Y);
  erodeLives = new Float32Array(GRID * GRID * MAX_Y);
  posY = new Float32Array(GRID * GRID * MAX_Y);
  posX = new Float32Array(GRID * GRID * MAX_Y);
  posZ = new Float32Array(GRID * GRID * MAX_Y);
  occupied.clear();
  for (const mesh of instances.values()) {
    surface?.remove(mesh);
  }
  instances.clear();
  splashes = [];
  ruleAcc = 0;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(SCENE_BG);

  surface = new THREE.Group();
  scene.add(surface);

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  syncCamera();

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(SCENE_BG, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene.add(new THREE.AmbientLight(0xffffff, 0.38));
  scene.add(new THREE.HemisphereLight(0xc5d0d8, 0x3a2e28, 0.42));
  const key = new THREE.DirectionalLight(0xfff4ea, 1.3);
  key.position.set(8, 14, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xd6e2ea, 0.32);
  fill.position.set(-7, 6, -5);
  scene.add(fill);

  groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_PLANE_SIZE, GROUND_PLANE_SIZE),
    new THREE.MeshStandardMaterial({ color: 0x10181c, roughness: 1, metalness: 0 }),
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.position.y = -0.02;
  surface.add(groundMesh);

  blockGeo = new THREE.BoxGeometry(atomSize, atomSize, atomSize);
  {
    const size = emitterBoxSize();
    emitterGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
  }
  splashGeo = new THREE.RingGeometry(atomSize * 0.55, atomSize * 0.8, 28);

  emitter = new THREE.Mesh(
    emitterGeo,
    new THREE.MeshStandardMaterial({
      color: 0xf0e2d6,
      transparent: true,
      opacity: 0.45,
      roughness: 0.55,
      metalness: 0.05,
      depthWrite: false,
    }),
  );
  emitter.renderOrder = 2;
  surface.add(emitter);
  setAimFromWorld();
  syncEmitter();

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);

  resizeObserver = new ResizeObserver(() => {
    resizeCanvas();
  });
  resizeObserver.observe(wrap);
  window.addEventListener("resize", resizeCanvas);
  clearError();
}

export async function showFallingBlocks(nextCanvas) {
  try {
    await loadCatalog();
    if (!scene) initScene(nextCanvas);
    else {
      buildPalette();
      fpsEl = document.querySelector("[data-falling-fps]");
      atomsEl = document.querySelector("[data-falling-atoms]");
      trisEl = document.querySelector("[data-falling-tris]");
      fpsFrames = 0;
      fpsLastAt = 0;
    }
    running = true;
    sizeTries = 0;
    startRenderLoop();
  } catch (err) {
    console.error("EchoScape falling blocks init failed:", err);
    showError(`3D view failed to start: ${err.message}`);
  }
}

export function hideFallingBlocks() {
  running = false;
  rotatingSurface = false;
  press = null;
  pointerPouring = false;
  emitting = false;
  emitAcc = 0;
  circleWasDown = false;
  if (rafId) window.cancelAnimationFrame(rafId);
  rafId = 0;
  fpsFrames = 0;
  fpsLastAt = 0;
}
