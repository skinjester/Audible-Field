import * as THREE from "three";
import { controller, mix } from "./mixer-core.js?v=66";
import { compileMaterials, parseMaterialsJson, stepWorld } from "./rule-engine.js?v=37";
import { fallingBindings, fallingInput } from "./falling-input.js?v=4";

/**
 * Fixed atom pitch. Smaller than the old default so the playfield holds a
 * denser grid (Sand1-style room to paint).
 */
const ATOM_SIZE = 0.25;
/** Max emitter height above the ground plane (world units). */
const EMIT_HEIGHT_MAX_U = 12;
/** Tall enough for the emitter to sit at EMIT_HEIGHT_MAX_U. */
const MAX_Y = Math.ceil(EMIT_HEIGHT_MAX_U / ATOM_SIZE - 0.5) + 1;
/** Fixed ground / aim span (world units). */
const PLAYFIELD_SPAN = 16;
const PLAYFIELD_HALF = PLAYFIELD_SPAN / 2;
const GROUND_PLANE_SIZE = PLAYFIELD_SPAN + 2;
/** Cells across the playfield at the fixed atom pitch. */
const GRID_XZ = Math.max(1, Math.floor(PLAYFIELD_SPAN / ATOM_SIZE + 1e-9));
const GRID_MAX = GRID_XZ;
/**
 * Falling-blocks sky / clear color by yaw quadrant.
 * Muted primaries (not the Max pad greys) so blends read while orbiting.
 *   tl red · tr yellow · bl blue · br green
 */
const QUAD_COLORS = {
  tl: new THREE.Color(0x8f4a4a),
  tr: new THREE.Color(0x8f7e3d),
  bl: new THREE.Color(0x3d5f8f),
  br: new THREE.Color(0x3d7a55),
};
const SCENE_BG = QUAD_COLORS.tl.getHex();
const scratchBg = new THREE.Color();
const SPLASH_LIFE = 0.42;
const CLICK_SLOP = 6;
const RULE_HZ = 22;

/** Fixed isometric-style view: 45° down; distance is zoomable. */
const CAMERA_PITCH = Math.PI / 4;
const CAMERA_YAW = Math.PI / 4;
const CAMERA_DIST_DEFAULT = 30;
const CAMERA_DIST_MIN = 10;
const CAMERA_DIST_MAX = 60;
const AIM_SPEED = 9;
/**
 * Max Sand1-style brush edge (odd). RT pressure maps 1×1 → this N×N field;
 * each cell rolls a chance so atoms cascade instead of dropping as a slab.
 */
const BRUSH_MAX = 11;
/**
 * RT→brush ease: >1 keeps light squeezes on a thin stream longer;
 * only deep pressure opens the wide field.
 */
const BRUSH_RT_GAMMA = 2.6;
const EMIT_INTERVAL = 1 / 40;
const EMIT_CHANCE = 0.4;
/** Lowest spawn height the slider can pick (world units). */
const EMIT_HEIGHT_MIN_U = 0.5;
/** Default spawn height (world units). */
const EMIT_HEIGHT_DEFAULT_U = 5.5;
/** Continuous fall speed toward contact (world units / second). */
const GRAVITY = 28;
/**
 * Block `lifetime` is an erosion clock for a resting block with no other
 * block above it. The clock stays at zero while a block is stacked on top
 * and starts the moment that cover is gone, so the block shrinks over
 * `lifetime` instead of vanishing as soon as it is uncovered.
 */

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
/** Edge length baked at emit time (existing atoms keep their size). */
/** @type {Float32Array | null} */
let emitSizes = null;
/**
 * 1 when a resting block has no other block above it.
 * Rebuilt each step; the erosion clock runs only while this is set.
 */
/** @type {Uint8Array | null} */
let exposedBlocks = null;
/** Consecutive same-height hops (shuffle detection). */
/** @type {Uint8Array | null} */
let shuffleCounts = null;
/** Cell X where the current shuffle streak began. */
/** @type {Uint16Array | null} */
let shuffleOriginX = null;
/** Cell Z where the current shuffle streak began. */
/** @type {Uint16Array | null} */
let shuffleOriginZ = null;
/** Seconds spent below minNeighbors (sparse absorb). */
/** @type {Float32Array | null} */
let sparseAges = null;
/** Seconds spent resting on the liquid world floor. */
/** @type {Float32Array | null} */
let floorAges = null;
/** Last horizontal flow facing (path follow). */
/** @type {Int8Array | null} */
let flowDx = null;
/** @type {Int8Array | null} */
let flowDz = null;
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
/** Emitter aim in world XZ (decoupled from rotating surface / grid). */
let aimWorldX = 0;
let aimWorldZ = 0;
let emitAcc = 0;
let emitting = false;
/** Current emit / preview brush edge length (odd, 1…BRUSH_MAX). */
let brushN = 1;
/** When true, RT pressure maps large→small (mirrored curve). */
let brushCurveInvert = false;
/** Spawn height above ground in world units (slider-controlled). */
let emitHeightU = EMIT_HEIGHT_DEFAULT_U;
/** Last cell poured while dragging — used to fill trail between pulses. */
let lastPourIx = -1;
let lastPourIz = -1;

/** @type {ReturnType<typeof compileMaterials> | null} */
let catalog = null;
let activeMaterialId = "sand";
/** Fixed atom cube edge length (world units). */
const atomSize = ATOM_SIZE;
/** Cells across the playfield. */
const gridXZ = GRID_XZ;

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
  return (y * GRID_MAX + z) * GRID_MAX + x;
}

function decodeCell(i) {
  const x = i % GRID_MAX;
  const rest = (i / GRID_MAX) | 0;
  const z = rest % GRID_MAX;
  const y = (rest / GRID_MAX) | 0;
  return { x, y, z };
}

/** World X of a cell center for a given pitch, anchored to the playfield. */
function worldXForCell(x, pitch) {
  return -PLAYFIELD_HALF + (x + 0.5) * pitch;
}

/** World Z of a cell center for a given pitch, anchored to the playfield. */
function worldZForCell(z, pitch) {
  return -PLAYFIELD_HALF + (z + 0.5) * pitch;
}

function inBounds(x, y, z) {
  return x >= 0 && z >= 0 && y >= 0 && x < GRID_MAX && z < GRID_MAX && y < MAX_Y;
}

/** Valid column for new emits. */
function inEmitXZ(x, z) {
  return x >= 0 && z >= 0 && x < gridXZ && z < gridXZ;
}

/** Max world Y an atom may occupy (top of the tallest cell stack). */
const SIM_Y_MAX = MAX_Y * ATOM_SIZE;

/**
 * True when the atom's visual AABB stays inside the playfield.
 * Anything drawn past the edges is treated as out of the sim.
 */
function isDrawnInSim(wx, wy, wz, halfExtent) {
  const eps = 1e-3;
  const h = Math.max(0, halfExtent);
  if (wx - h < -PLAYFIELD_HALF - eps) return false;
  if (wx + h > PLAYFIELD_HALF + eps) return false;
  if (wz - h < -PLAYFIELD_HALF - eps) return false;
  if (wz + h > PLAYFIELD_HALF + eps) return false;
  if (wy - h < -eps) return false;
  if (wy + h > SIM_Y_MAX + eps) return false;
  return true;
}

/**
 * Delete / consume any atom whose drawn volume leaves the sim area
 * (e.g. fluid that flowed past the playfield edge).
 * @returns {boolean}
 */
function consumeOutOfBounds() {
  if (!cells || occupied.size === 0) return false;
  /** @type {number[]} */
  const doomed = [];
  for (const i of occupied) {
    const mat = cells[i];
    if (mat <= 0) continue;
    const { x, y, z } = decodeCell(i);
    const pitch = cellAtomSize(i);
    const half = atomExtent(x, y, z, mat) * 0.5;
    const wx = posX ? posX[i] : worldXForCell(x, pitch);
    const wy = posY ? posY[i] : (y + 0.5) * pitch;
    const wz = posZ ? posZ[i] : worldZForCell(z, pitch);
    if (!isDrawnInSim(wx, wy, wz, half)) doomed.push(i);
  }
  if (!doomed.length) return false;
  for (const i of doomed) {
    if (cells[i] <= 0) continue;
    const { x, y, z } = decodeCell(i);
    setCell(x, y, z, 0);
  }
  return true;
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
    if (emitSizes) emitSizes[i] = 0;
    if (shuffleCounts) shuffleCounts[i] = 0;
    if (shuffleOriginX) shuffleOriginX[i] = 0;
    if (shuffleOriginZ) shuffleOriginZ[i] = 0;
    if (sparseAges) sparseAges[i] = 0;
    if (floorAges) floorAges[i] = 0;
    if (flowDx) flowDx[i] = 0;
    if (flowDz) flowDz[i] = 0;
  } else if (prev === 0) {
    // Fresh spawn: bake current atom size; pitch matches so neighbors of this size touch.
    // Clear lifetime so rule transfers (or emit) start clean — don't inherit stale shrink.
    if (ages) ages[i] = 0;
    if (erodeLives) erodeLives[i] = 0;
    if (emitSizes) emitSizes[i] = atomSize;
    if (shuffleCounts) shuffleCounts[i] = 0;
    if (shuffleOriginX) shuffleOriginX[i] = 0;
    if (shuffleOriginZ) shuffleOriginZ[i] = 0;
    if (sparseAges) sparseAges[i] = 0;
    if (floorAges) floorAges[i] = 0;
    if (flowDx) flowDx[i] = 0;
    if (flowDz) flowDz[i] = 0;
    if (posY) posY[i] = (y + 0.5) * atomSize;
    if (posX) posX[i] = worldXForCell(x, atomSize);
    if (posZ) posZ[i] = worldZForCell(z, atomSize);
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

function getCellEmitSize(x, y, z) {
  if (!emitSizes || !inBounds(x, y, z)) return 0;
  return emitSizes[idx(x, y, z)];
}

function setCellEmitSize(x, y, z, value) {
  if (!emitSizes || !inBounds(x, y, z)) return;
  const n = Number(value);
  emitSizes[idx(x, y, z)] = Number.isFinite(n) && n > 0 ? n : 0;
}

function getShuffle(x, y, z) {
  if (!shuffleCounts || !inBounds(x, y, z)) return 0;
  return shuffleCounts[idx(x, y, z)];
}

function setShuffle(x, y, z, value) {
  if (!shuffleCounts || !inBounds(x, y, z)) return;
  shuffleCounts[idx(x, y, z)] = Math.max(0, value | 0);
}

function getShuffleOriginX(x, y, z) {
  if (!shuffleOriginX || !inBounds(x, y, z)) return 0;
  return shuffleOriginX[idx(x, y, z)];
}

function setShuffleOriginX(x, y, z, value) {
  if (!shuffleOriginX || !inBounds(x, y, z)) return;
  shuffleOriginX[idx(x, y, z)] = Math.max(0, value | 0);
}

function getShuffleOriginZ(x, y, z) {
  if (!shuffleOriginZ || !inBounds(x, y, z)) return 0;
  return shuffleOriginZ[idx(x, y, z)];
}

function setShuffleOriginZ(x, y, z, value) {
  if (!shuffleOriginZ || !inBounds(x, y, z)) return;
  shuffleOriginZ[idx(x, y, z)] = Math.max(0, value | 0);
}

function getFlowDx(x, y, z) {
  if (!flowDx || !inBounds(x, y, z)) return 0;
  return flowDx[idx(x, y, z)];
}

function setFlowDx(x, y, z, value) {
  if (!flowDx || !inBounds(x, y, z)) return;
  flowDx[idx(x, y, z)] = value | 0;
}

function getFlowDz(x, y, z) {
  if (!flowDz || !inBounds(x, y, z)) return 0;
  return flowDz[idx(x, y, z)];
}

function setFlowDz(x, y, z, value) {
  if (!flowDz || !inBounds(x, y, z)) return;
  flowDz[idx(x, y, z)] = value | 0;
}

function getSparseAge(x, y, z) {
  if (!sparseAges || !inBounds(x, y, z)) return 0;
  return sparseAges[idx(x, y, z)];
}

function setSparseAge(x, y, z, value) {
  if (!sparseAges || !inBounds(x, y, z)) return;
  sparseAges[idx(x, y, z)] = Math.max(0, Number(value) || 0);
}

function getFloorAge(x, y, z) {
  if (!floorAges || !inBounds(x, y, z)) return 0;
  return floorAges[idx(x, y, z)];
}

function setFloorAge(x, y, z, value) {
  if (!floorAges || !inBounds(x, y, z)) return;
  floorAges[idx(x, y, z)] = Math.max(0, Number(value) || 0);
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
  getEmitSize: getCellEmitSize,
  setEmitSize: setCellEmitSize,
  getShuffle,
  setShuffle,
  getShuffleOriginX,
  setShuffleOriginX,
  getShuffleOriginZ,
  setShuffleOriginZ,
  getFlowDx,
  setFlowDx,
  getFlowDz,
  setFlowDz,
  getSparseAge,
  setSparseAge,
  getFloorAge,
  setFloorAge,
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

function cellAtomSize(cellIndex) {
  if (emitSizes && emitSizes[cellIndex] > 0) return emitSizes[cellIndex];
  return atomSize;
}

function cellScale(x, y, z, matIndex) {
  const life = cellLifetime(idx(x, y, z), matIndex);
  if (life <= 0 || !ages) return 1;
  const t = Math.min(1, Math.max(0, getAge(x, y, z) / life));
  return Math.max(0.02, 1 - t);
}

function atomExtent(x, y, z, matIndex) {
  return cellAtomSize(idx(x, y, z)) * cellScale(x, y, z, matIndex);
}

function cellWorld(x, y, z, target, scale = 1) {
  const i = idx(x, y, z);
  const pitch = cellAtomSize(i);
  target.x = posX ? posX[i] : worldXForCell(x, pitch);
  target.y = posY ? posY[i] : (y + 0.5) * pitch;
  target.z = posZ ? posZ[i] : worldZForCell(z, pitch);
  return target;
}

export function getAtomSize() {
  return atomSize;
}

function rebuildAtomGeometry() {
  if (blockGeo) {
    blockGeo.dispose();
    blockGeo = null;
  }
  // Unit cube; per-instance scale carries each atom's baked emit size.
  blockGeo = new THREE.BoxGeometry(1, 1, 1);
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

/** Yaw the playfield / grid; emitter stays fixed in world space. */
function rotateSurface(deltaYaw) {
  if (!surface || !deltaYaw) return;
  surface.rotation.y += deltaYaw;
  // Grid spun under the fixed world aim — refresh which cell is targeted.
  setAimFromWorld();
  syncEmitter();
  syncSceneBackground();
}

/**
 * Map surface yaw → pad x/y so cardinals land on quadrant corners
 * (same bilinear blend as the Max / visualize mixer).
 */
function padFromYaw(yaw) {
  // Amplitude √2/2 puts the four π/4 offsets on the square corners.
  const x = clamp01(0.5 + Math.sin(yaw) * Math.SQRT1_2);
  const y = clamp01(0.5 - Math.cos(yaw) * Math.SQRT1_2);
  return { x, y };
}

function blendQuadColor(weights, target) {
  target.setRGB(0, 0, 0);
  for (const key of Object.keys(QUAD_COLORS)) {
    const w = weights[key] || 0;
    if (w <= 0) continue;
    const part = QUAD_COLORS[key];
    target.r += part.r * w;
    target.g += part.g * w;
    target.b += part.b * w;
  }
  return target;
}

function syncSceneBackground() {
  if (!scene) return;
  const yaw = surface ? surface.rotation.y : 0;
  const { x, y } = padFromYaw(yaw);
  blendQuadColor(mix(x, y), scratchBg);
  scene.background.copy(scratchBg);
  renderer?.setClearColor(scratchBg, 1);
}

/** World XZ → surface-local XZ (inverse of surface yaw). */
function worldToSurfaceXZ(wx, wz) {
  const sy = surface ? surface.rotation.y : 0;
  const c = Math.cos(-sy);
  const s = Math.sin(-sy);
  return { x: c * wx - s * wz, z: s * wx + c * wz };
}

/** Surface-local XZ → world XZ. */
function surfaceToWorldXZ(lx, lz) {
  const sy = surface ? surface.rotation.y : 0;
  const c = Math.cos(sy);
  const s = Math.sin(sy);
  return { x: c * lx - s * lz, z: s * lx + c * lz };
}

/**
 * Resolve world aim → playfield cell. Emitter stays in world space; the
 * rotating surface only affects which grid cell sits under it.
 */
function setAimFromWorld() {
  const limit = PLAYFIELD_HALF - 0.001;
  let { x: lx, z: lz } = worldToSurfaceXZ(aimWorldX, aimWorldZ);
  // Keep the emitter over the square playfield when it would drift off.
  if (Math.abs(lx) > limit || Math.abs(lz) > limit) {
    lx = Math.min(limit, Math.max(-limit, lx));
    lz = Math.min(limit, Math.max(-limit, lz));
    const world = surfaceToWorldXZ(lx, lz);
    aimWorldX = world.x;
    aimWorldZ = world.z;
  }
  let ix = Math.floor((lx + PLAYFIELD_HALF) / atomSize);
  let iz = Math.floor((lz + PLAYFIELD_HALF) / atomSize);
  ix = Math.min(gridXZ - 1, Math.max(0, ix));
  iz = Math.min(gridXZ - 1, Math.max(0, iz));
  aim = { ix, iz };
}

/**
 * Move the emitter in screen-relative world XZ (not glued to the grid).
 * Stick/D-pad: +lx = right on screen, +ly = up on screen.
 */
function moveAim(lx, ly, dt) {
  if (dt <= 0 || (!lx && !ly)) return;
  const camSin = Math.sin(CAMERA_YAW);
  const camCos = Math.cos(CAMERA_YAW);
  const step = AIM_SPEED * dt;
  aimWorldX += (camCos * lx - camSin * ly) * step;
  aimWorldZ += (-camSin * lx - camCos * ly) * step;
  setAimFromWorld();
  syncEmitter();
}

function aimFromClient(clientX, clientY) {
  if (!canvas || !camera || !surface) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return;
  // Store world hit — do not bake into surface-local (decoupled from grid yaw).
  aimWorldX = hitPoint.x;
  aimWorldZ = hitPoint.z;
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

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Map analog 0…1 → odd brush edge 1…BRUSH_MAX (pressure curve).
 */
function brushSizeFromTrigger(rt) {
  const threshold = fallingBindings.gamepad.emitAnalogThreshold ?? 0.08;
  const span = 1 - threshold;
  const linear = span > 0 ? clamp01((clamp01(rt) - threshold) / span) : 1;
  const t = Math.pow(linear, BRUSH_RT_GAMMA);
  const steps = ((BRUSH_MAX - 1) >> 1) + 1;
  let i = Math.min(steps - 1, Math.floor(t * steps));
  if (brushCurveInvert) i = steps - 1 - i;
  return 1 + i * 2;
}

function brushSizeFromMode(mode, analog) {
  if (mode === "single") return 1;
  if (mode === "max") return BRUSH_MAX;
  return brushSizeFromTrigger(analog);
}

export function toggleBrushCurveInvert() {
  brushCurveInvert = !brushCurveInvert;
  return brushCurveInvert;
}

export function getBrushCurveInvert() {
  return brushCurveInvert;
}

function setBrushN(n) {
  const odd = Math.max(1, Math.min(BRUSH_MAX, n | 0));
  const next = odd % 2 === 0 ? odd - 1 : odd;
  if (next === brushN) return;
  brushN = next;
  rebuildEmitterGeometry();
}

function emitterBoxSize() {
  // Flat brush footprint (Sand1-style array), thin so it reads as a field.
  return {
    x: brushN * atomSize,
    y: atomSize * 0.35,
    z: brushN * atomSize,
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
  emitter.position.set(aimWorldX, emitWorldY(), aimWorldZ);
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
  const id = catalog?.idByIndex[matIndex];
  const def = id ? catalog.byId.get(id) : null;
  const opacity = def?.opacity ?? 1;
  const transparent = opacity < 1;
  mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(materialColor(matIndex)),
    roughness: transparent ? 0.28 : 0.76,
    metalness: transparent ? 0.08 : 0.02,
    transparent,
    opacity,
    depthWrite: !transparent,
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
  if (emitSizes) emitSizes.fill(0);
  if (exposedBlocks) exposedBlocks.fill(0);
  if (shuffleCounts) shuffleCounts.fill(0);
  if (shuffleOriginX) shuffleOriginX.fill(0);
  if (shuffleOriginZ) shuffleOriginZ.fill(0);
  if (sparseAges) sparseAges.fill(0);
  if (floorAges) floorAges.fill(0);
  if (flowDx) flowDx.fill(0);
  if (flowDz) flowDz.fill(0);
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

  aimWorldX = 0;
  aimWorldZ = 0;
  emitting = false;
  emitAcc = 0;
  setAimFromWorld();
  syncEmitter();
  syncSceneBackground();
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

function clampEmitHeightU(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return EMIT_HEIGHT_DEFAULT_U;
  return Math.min(EMIT_HEIGHT_MAX_U, Math.max(EMIT_HEIGHT_MIN_U, n));
}

/** Discrete spawn row for the current emit height. */
function emitY() {
  const row = Math.round(emitHeightU / atomSize - 0.5);
  return Math.min(MAX_Y - 1, Math.max(0, row));
}

function emitWorldY() {
  return emitHeightU;
}

function syncEmitHeightUi() {
  const input = document.querySelector("[data-falling-emit-height]");
  const label = document.querySelector("[data-falling-emit-height-val]");
  if (input instanceof HTMLInputElement) {
    input.min = String(EMIT_HEIGHT_MIN_U);
    input.max = String(EMIT_HEIGHT_MAX_U);
    input.step = String(atomSize);
    input.value = String(emitHeightU);
  }
  if (label) label.textContent = `${emitHeightU.toFixed(1)}u`;
}

function setEmitHeight(value) {
  emitHeightU = clampEmitHeightU(value);
  // Snap to the slider step so 12.0 is reachable exactly.
  const step = atomSize > 1e-9 ? atomSize : 0.25;
  emitHeightU = Math.round(emitHeightU / step) * step;
  emitHeightU = clampEmitHeightU(emitHeightU);
  syncEmitHeightUi();
  syncEmitter();
}

function bindEmitHeightUi() {
  const input = document.querySelector("[data-falling-emit-height]");
  if (!(input instanceof HTMLInputElement)) return;
  syncEmitHeightUi();
  if (input.dataset.bound === "1") return;
  input.dataset.bound = "1";
  const onChange = () => setEmitHeight(input.value);
  input.addEventListener("input", onChange);
  input.addEventListener("change", onChange);
}

function applyInput(dt) {
  if (!camera || dt <= 0) return;

  const frame = fallingInput.sample(dt, controller, connectedPad());

  // Mouse / pad / keys are additive — none blocks the others.
  if (frame.pointer) aimFromClient(frame.pointer.x, frame.pointer.y);
  if (frame.aimStickX || frame.aimStickY) {
    moveAim(frame.aimStickX, frame.aimStickY, dt);
  }
  if (frame.orbitDelta) rotateSurface(frame.orbitDelta);
  if (frame.zoomFactor !== 1) zoomCamera(frame.zoomFactor);

  setBrushN(brushSizeFromMode(frame.brushMode, frame.analog));
  updateEmitStream(dt, frame.emit);

  if (frame.cycleDelta) cycleMaterial(frame.cycleDelta);
  if (frame.clearEdge) clearBoard();
  if (frame.invertEdge) toggleBrushCurveInvert();
}

function updateEmitStream(dt, active) {
  if (active && aim) {
    const moved = lastPourIx !== aim.ix || lastPourIz !== aim.iz;
    if (!emitting) {
      emitting = true;
      emitAcc = 0;
      pourBrush(aim.ix, aim.iz);
      lastPourIx = aim.ix;
      lastPourIz = aim.iz;
      syncEmitter();
    } else {
      emitAcc += dt;
      let pulsed = false;
      while (emitAcc >= EMIT_INTERVAL) {
        emitAcc -= EMIT_INTERVAL;
        pourBrush(aim.ix, aim.iz);
        pulsed = true;
      }
      // Moving the aim leaves a field-trail even between cascade pulses.
      if (moved && !pulsed) pourBrush(aim.ix, aim.iz);
      lastPourIx = aim.ix;
      lastPourIz = aim.iz;
    }
  } else if (emitting) {
    emitting = false;
    emitAcc = 0;
    lastPourIx = -1;
    lastPourIz = -1;
    syncEmitter();
  }
}

/**
 * Sand1-style brush: scatter atoms across a flat N×N field centered on aim.
 * Each cell rolls EMIT_CHANCE so the column cascades instead of falling as one slab.
 * Brush edge comes from RT pressure (or BRUSH_MAX for pointer pour).
 */
function pourBrush(ix, iz) {
  if (!cells || !catalog) return;
  const matIndex = catalog.indexById.get(activeMaterialId);
  if (!matIndex) return;

  const half = (brushN - 1) >> 1;
  const y = emitY();
  if (y < 0 || y >= MAX_Y) return;
  let placed = 0;

  for (let dz = -half; dz <= half; dz += 1) {
    for (let dx = -half; dx <= half; dx += 1) {
      // Single-cell pour always places; larger fields keep staggered chance.
      if (brushN > 1 && Math.random() > EMIT_CHANCE) continue;
      const x = ix + dx;
      const z = iz + dz;
      if (!inEmitXZ(x, z) || !inBounds(x, y, z)) continue;
      if (getCell(x, y, z) !== 0) continue;
      setCell(x, y, z, matIndex);
      placed += 1;
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
  const sz = cellAtomSize(idx(x, y, z));
  mesh.position.y = (posY ? posY[idx(x, y, z)] : (y + 0.5) * sz) - sz * 0.42;
  mesh.scale.setScalar(atomSize > 1e-6 ? sz / atomSize : 1);
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
    const x = i % GRID_MAX;
    const rest = (i / GRID_MAX) | 0;
    const z = rest % GRID_MAX;
    const y = (rest / GRID_MAX) | 0;
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
    const x = i % GRID_MAX;
    const rest = (i / GRID_MAX) | 0;
    const z = rest % GRID_MAX;
    const y = (rest / GRID_MAX) | 0;
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
      const scale = cellScale(x, y, z, mat) * cellAtomSize(idx(x, y, z));
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
 * Tag neighbors of eroding atoms with a forced lifetime.
 * Solids shrink/dissolve on contact; liquids are left alone so they can spill
 * into gaps instead of being pulled into the erode cluster.
 * Runs before and after rules so newly adjacent solids still get tagged.
 * @returns {boolean}
 */
function infectErodeContacts() {
  if (!cells || !erodeLives || !catalog || occupied.size === 0) return false;
  let dirty = false;
  const NEIGHBORS = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

  for (const i of occupied) {
    const mat = cells[i];
    if (mat <= 0) continue;
    const duration = materialErode(mat);
    if (duration <= 0) continue;
    const { x, y, z } = decodeCell(i);
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!inBounds(nx, ny, nz)) continue;
      const ni = idx(nx, ny, nz);
      const nmat = cells[ni];
      if (nmat <= 0 || nmat === mat) continue;
      if ((erodeLives[ni] || 0) > 0) continue;
      const nid = catalog.idByIndex[nmat];
      const nDef = nid ? catalog.byId.get(nid) : null;
      // Liquids flow into openings; don't infect/shrink them toward erode.
      if (nDef?.surface === "liquid") continue;
      erodeLives[ni] = duration;
      dirty = true;
    }
  }
  return dirty;
}

/**
 * Mark resting blocks that have no other block above them.
 * Buried blocks stay unmarked so their erosion clock does not run.
 */
function refreshExposedBlocks() {
  if (!exposedBlocks) return;
  exposedBlocks.fill(0);
  if (!cells || !posY || !catalog || occupied.size === 0) return;
  const blockIndex = catalog.indexById.get("block") || 0;
  if (blockIndex <= 0 || materialLifetime(blockIndex) <= 0) return;

  /** @type {Map<number, number[]>} */
  const columns = new Map();
  for (const i of occupied) {
    if (cells[i] <= 0) continue;
    const x = i % GRID_MAX;
    const rest = (i / GRID_MAX) | 0;
    const z = rest % GRID_MAX;
    const key = z * GRID_MAX + x;
    let list = columns.get(key);
    if (!list) {
      list = [];
      columns.set(key, list);
    }
    list.push(i);
  }

  for (const list of columns.values()) {
    list.sort((a, b) => (posY[a] || 0) - (posY[b] || 0) || a - b);
    let floorTop = 0;
    for (let n = 0; n < list.length; n += 1) {
      const i = list[n];
      const { x, y, z } = decodeCell(i);
      const mat = cells[i];
      const size = atomExtent(x, y, z, mat);
      const restCenter = floorTop + size * 0.5;
      const yCenter = posY[i] > 0 ? posY[i] : restCenter;
      const resting = yCenter <= restCenter + 0.05;
      let blockAbove = false;
      for (let k = n + 1; k < list.length; k += 1) {
        if (cells[list[k]] === blockIndex) {
          blockAbove = true;
          break;
        }
      }
      if (mat === blockIndex && resting && !blockAbove) exposedBlocks[i] = 1;
      const placed = yCenter > restCenter + 1e-4 ? yCenter : restCenter;
      floorTop = placed + size * 0.5;
    }
  }
}

/**
 * Age materials with a lifetime; shrink visually and despawn when expired.
 * A block's clock stays at zero until it is resting with no block above it,
 * then starts from that moment.
 * @returns {boolean} true if meshes need a refresh
 */
function ageAtoms(dt) {
  if (!cells || !ages || !catalog || dt <= 0 || occupied.size === 0) return false;
  let dirty = false;

  const doomed = [];
  for (const i of occupied) {
    const mat = cells[i];
    if (mat <= 0) continue;
    if (catalog.idByIndex[mat] === "block" && !exposedBlocks?.[i]) {
      if (ages[i] !== 0) {
        ages[i] = 0;
        dirty = true;
      }
      continue;
    }
    const life = cellLifetime(i, mat);
    if (life <= 0) continue;
    ages[i] += dt;
    dirty = true;
    if (ages[i] >= life) doomed.push(i);
  }
  for (const i of doomed) {
    const { x, y, z } = decodeCell(i);
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
    const x = i % GRID_MAX;
    const rest = (i / GRID_MAX) | 0;
    const z = rest % GRID_MAX;
    const key = z * GRID_MAX + x;
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
      const x = i % GRID_MAX;
      const rest = (i / GRID_MAX) | 0;
      const z = rest % GRID_MAX;
      const y = (rest / GRID_MAX) | 0;
      const size = atomExtent(x, y, z, mat);
      const restCenter = floorTop + size * 0.5;
      let yCenter = posY[i] > 0 ? posY[i] : restCenter;

      if (yCenter > restCenter + 1e-5) {
        yCenter = Math.max(restCenter, yCenter - fall);
        moved = true;
      } else if (yCenter < restCenter - 1e-5) {
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

/** True when a cell is actively shrinking (native lifetime or erode infection). */
function isShrinking(cellIndex, matIndex) {
  if (catalog?.idByIndex[matIndex] === "block") {
    return exposedBlocks?.[cellIndex] === 1;
  }
  return cellLifetime(cellIndex, matIndex) > 0;
}

/**
 * Keep non-shrinking atoms easing toward their grid cell centers in XZ
 * (smooths slide/flow hops instead of teleporting each rule tick).
 * @returns {boolean}
 */
function settleLateral(dt) {
  if (!cells || !posX || !posZ || dt <= 0 || occupied.size === 0) return false;

  let moved = false;
  for (const i of occupied) {
    const mat = cells[i];
    if (mat <= 0 || isShrinking(i, mat)) continue;
    const x = i % GRID_MAX;
    const rest = (i / GRID_MAX) | 0;
    const z = rest % GRID_MAX;
    const pitch = cellAtomSize(i);
    const tx = worldXForCell(x, pitch);
    const tz = worldZForCell(z, pitch);
    let px = posX[i];
    let pz = posZ[i];
    const dx = tx - px;
    const dz = tz - pz;
    const dist = Math.hypot(dx, dz);
    if (dist <= 1e-5) {
      if (px !== tx || pz !== tz) {
        posX[i] = tx;
        posZ[i] = tz;
        moved = true;
      }
      continue;
    }
    // Ease toward the cell; slightly under one-cell/tick so hops don't look frantic.
    const maxStep = pitch * RULE_HZ * 0.85 * dt;
    if (dist <= maxStep) {
      posX[i] = tx;
      posZ[i] = tz;
    } else {
      const s = maxStep / dist;
      posX[i] = px + dx * s;
      posZ[i] = pz + dz * s;
    }
    moved = true;
  }
  return moved;
}

/**
 * Keep connected shrinking atoms flush: contract each shrinking cluster in XZ
 * so neighbors stay in contact. Full-size atoms ease onto the grid via settleLateral.
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
    const startMat = cells[start];
    if (startMat <= 0 || visited.has(start) || !isShrinking(start, startMat)) {
      continue;
    }

    /** @type {number[]} */
    const comp = [];
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const i = queue.pop();
      comp.push(i);
      const x = i % GRID_MAX;
      const rest = (i / GRID_MAX) | 0;
      const z = rest % GRID_MAX;
      const y = (rest / GRID_MAX) | 0;
      for (const [dx, dy, dz] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (!inBounds(nx, ny, nz)) continue;
        const ni = idx(nx, ny, nz);
        if (visited.has(ni) || cells[ni] <= 0) continue;
        if (!isShrinking(ni, cells[ni])) continue;
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
      const x = i % GRID_MAX;
      const rest = (i / GRID_MAX) | 0;
      const z = rest % GRID_MAX;
      const y = (rest / GRID_MAX) | 0;
      const mat = cells[i];
      const s = cellScale(x, y, z, mat);
      const pitch = cellAtomSize(i);
      const wx = worldXForCell(x, pitch);
      const wz = worldZForCell(z, pitch);
      sumS += s;
      cX += wx;
      cZ += wz;
      members.push({ i, x, y, z, ext: pitch * s, wx, wz });
    }

    const n = members.length;
    const sAvg = sumS / n;
    cX /= n;
    cZ /= n;

    // Contract toward centroid by average scale so the shrinking surface stays flush.
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
  const { splashes: splashCells, moves } = stepWorld(gridApi, occupiedList, catalog);
  const culledShuffle = cullShuffling(moves);
  refreshFloorAgeOnMerge(moves);

  consumeOutOfBounds();
  reconcileMeshes();
  for (const cell of splashCells) {
    const pitch = cellAtomSize(idx(cell.x, cell.y, cell.z));
    const wx = worldXForCell(cell.x, pitch);
    const wy = (cell.y + 0.5) * pitch;
    const wz = worldZForCell(cell.z, pitch);
    if (!isDrawnInSim(wx, wy, wz, pitch * 0.5)) continue;
    spawnSplash(cell.x, cell.y, cell.z);
  }
  return culledShuffle;
}

/**
 * Unbounded water that gains same-material contacts (a merge) gets a fresh
 * floorAbsorb lifespan.
 * @param {{ from: { x: number, y: number, z: number }, to: { x: number, y: number, z: number }, mat: number }[]} moves
 */
function refreshFloorAgeOnMerge(moves) {
  if (!catalog || !floorAges || !moves?.length) return;
  for (const move of moves) {
    const id = catalog.idByIndex[move.mat];
    const def = id ? catalog.byId.get(id) : null;
    if (!def?.floorAbsorb) continue;
    if (gridApi.get(move.to.x, move.to.y, move.to.z) !== move.mat) continue;
    // Origin is empty now; counting same-mat around it recovers pre-move contacts.
    const before = countSameNeighbors(move.from.x, move.from.y, move.from.z, move.mat);
    const after = countSameNeighbors(move.to.x, move.to.y, move.to.z, move.mat);
    if (after > before) {
      setFloorAge(move.to.x, move.to.y, move.to.z, 0);
      // Refresh the water it just touched too.
      for (const [dx, dy, dz] of FACE_DIRS) {
        const nx = move.to.x + dx;
        const ny = move.to.y + dy;
        const nz = move.to.z + dz;
        if (!inBounds(nx, ny, nz)) continue;
        if (getCell(nx, ny, nz) === move.mat) setFloorAge(nx, ny, nz, 0);
      }
    }
  }
}

/**
 * Track same-height hops. If a grain does many without leaving its local
 * neighborhood, treat it as shuffle thrash and delete it.
 * @param {{ from: { x: number, y: number, z: number }, to: { x: number, y: number, z: number }, mat: number }[]} moves
 * @returns {boolean}
 */
function cullShuffling(moves) {
  if (!catalog || !moves?.length || !shuffleCounts) return false;
  let culled = false;
  for (const move of moves) {
    const id = catalog.idByIndex[move.mat];
    const material = id ? catalog.byId.get(id) : null;
    const limit = material?.shuffleLimit || 0;
    if (limit <= 0) continue;
    if (gridApi.get(move.to.x, move.to.y, move.to.z) !== move.mat) continue;

    // Progress downward resets the streak.
    if (move.to.y < move.from.y) {
      setShuffle(move.to.x, move.to.y, move.to.z, 0);
      setShuffleOriginX(move.to.x, move.to.y, move.to.z, 0);
      setShuffleOriginZ(move.to.x, move.to.y, move.to.z, 0);
      continue;
    }
    // Only same-height hops count as potential shuffle.
    if (move.to.y !== move.from.y) {
      setShuffle(move.to.x, move.to.y, move.to.z, 0);
      continue;
    }

    let count = getShuffle(move.to.x, move.to.y, move.to.z);
    let ox = getShuffleOriginX(move.to.x, move.to.y, move.to.z);
    let oz = getShuffleOriginZ(move.to.x, move.to.y, move.to.z);
    if (count <= 0) {
      ox = move.from.x;
      oz = move.from.z;
      count = 0;
    }
    count += 1;
    if (count >= limit) {
      const span = Math.abs(move.to.x - ox) + Math.abs(move.to.z - oz);
      if (span <= 2) {
        setCell(move.to.x, move.to.y, move.to.z, 0);
        culled = true;
        continue;
      }
      // Made real travel — start a new window from here.
      ox = move.to.x;
      oz = move.to.z;
      count = 1;
    }
    setShuffle(move.to.x, move.to.y, move.to.z, count);
    setShuffleOriginX(move.to.x, move.to.y, move.to.z, ox);
    setShuffleOriginZ(move.to.x, move.to.y, move.to.z, oz);
  }
  return culled;
}

const FACE_DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function countSameNeighbors(x, y, z, matIndex) {
  let n = 0;
  for (const [dx, dy, dz] of FACE_DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (!inBounds(nx, ny, nz)) continue;
    if (getCell(nx, ny, nz) === matIndex) n += 1;
  }
  return n;
}

/** True when resting on a solid or touching a solid wall (a basin / container). */
function isInBoundedCatchment(x, y, z) {
  if (!catalog) return false;
  if (y > 0) {
    const below = getCell(x, y - 1, z);
    if (below > 0) {
      const id = catalog.idByIndex[below];
      const def = id ? catalog.byId.get(id) : null;
      if (def?.surface === "solid") return true;
    }
  }
  for (const [dx, , dz] of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ]) {
    const nx = x + dx;
    const ny = y;
    const nz = z + dz;
    if (!inBounds(nx, ny, nz)) continue;
    const nmat = getCell(nx, ny, nz);
    if (nmat <= 0) continue;
    const id = catalog.idByIndex[nmat];
    const def = id ? catalog.byId.get(id) : null;
    if (def?.surface === "solid") return true;
  }
  return false;
}

/**
 * Absorb under-connected grains, and dry unbounded floorAbsorb liquids.
 * Contained water (solid basin / wall contact) is exempt from floorAbsorb.
 * @param {number} dt
 * @returns {boolean}
 */
function absorbSparseAndFloor(dt) {
  if (!cells || !catalog || !sparseAges || dt <= 0 || occupied.size === 0) {
    return false;
  }
  /** @type {number[]} */
  const doomed = [];
  for (const i of occupied) {
    const mat = cells[i];
    if (mat <= 0) continue;
    const id = catalog.idByIndex[mat];
    const def = id ? catalog.byId.get(id) : null;
    if (!def) continue;
    const { x, y, z } = decodeCell(i);

    const minN = def.minNeighbors || 0;
    const sparseLimit = def.sparseAbsorb || 0;
    if (minN > 0 && sparseLimit > 0) {
      if (countSameNeighbors(x, y, z, mat) < minN) {
        const onOpenFloor = catalog.floor === "liquid" && y === 0;
        if (!onOpenFloor && hasEmptyFaceNeighbor(x, y, z)) {
          sparseAges[i] = 0;
        } else {
          sparseAges[i] += dt;
          if (sparseAges[i] >= sparseLimit) {
            doomed.push(i);
            continue;
          }
        }
      } else {
        sparseAges[i] = 0;
      }
    } else if (sparseAges) {
      sparseAges[i] = 0;
    }

    const floorLimit = def.floorAbsorb || 0;
    if (!floorAges || floorLimit <= 0) {
      if (floorAges) floorAges[i] = 0;
      continue;
    }
    // Contained in a solid catchment — keep forever.
    if (isInBoundedCatchment(x, y, z)) {
      floorAges[i] = 0;
      continue;
    }
    // Unbounded: dry up after floorAbsorb seconds unless a merge resets the age.
    floorAges[i] += dt;
    if (floorAges[i] >= floorLimit) doomed.push(i);
  }
  if (!doomed.length) return false;
  for (const i of doomed) {
    if (cells[i] <= 0) continue;
    const { x, y, z } = decodeCell(i);
    setCell(x, y, z, 0);
  }
  return true;
}

function hasEmptyFaceNeighbor(x, y, z) {
  for (const [dx, dy, dz] of FACE_DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (!inBounds(nx, ny, nz)) continue;
    if (getCell(nx, ny, nz) === 0) return true;
  }
  return false;
}

function step(dt) {
  applyInput(dt);

  // Infect solids before rules; liquids are not tagged (they spill into gaps).
  let infected = infectErodeContacts();

  ruleAcc += dt;
  const interval = 1 / RULE_HZ;
  while (ruleAcc >= interval) {
    ruleAcc -= interval;
    runRules();
  }

  // Catch solids/liquids that fell or slid into contact during the rule pass.
  infected = infectErodeContacts() || infected;

  refreshExposedBlocks();
  const aged = ageAtoms(dt);
  const absorbed = absorbSparseAndFloor(dt);
  const settled = settleGravity(dt);
  const lateral = settleLateral(dt);
  const packed = packStickTogether();
  const culled = consumeOutOfBounds();
  if (infected || aged || absorbed || settled || lateral || packed || culled) {
    reconcileMeshes();
  }

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

async function loadCatalog() {
  const res = await fetch(`/materials.json?v=54`);
  if (!res.ok) throw new Error(`materials.json ${res.status}`);
  const prev = activeMaterialId;
  catalog = compileMaterials(parseMaterialsJson(await res.text()));
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

  cells = new Uint8Array(GRID_MAX * GRID_MAX * MAX_Y);
  budgets = new Uint8Array(GRID_MAX * GRID_MAX * MAX_Y);
  ages = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  erodeLives = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  posY = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  posX = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  posZ = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  emitSizes = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  exposedBlocks = new Uint8Array(GRID_MAX * GRID_MAX * MAX_Y);
  shuffleCounts = new Uint8Array(GRID_MAX * GRID_MAX * MAX_Y);
  shuffleOriginX = new Uint16Array(GRID_MAX * GRID_MAX * MAX_Y);
  shuffleOriginZ = new Uint16Array(GRID_MAX * GRID_MAX * MAX_Y);
  sparseAges = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  floorAges = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  flowDx = new Int8Array(GRID_MAX * GRID_MAX * MAX_Y);
  flowDz = new Int8Array(GRID_MAX * GRID_MAX * MAX_Y);
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
  syncSceneBackground();

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

  blockGeo = new THREE.BoxGeometry(1, 1, 1);
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
  // World-space emitter so surface yaw spins the grid underneath it.
  scene.add(emitter);

  setAimFromWorld();
  syncEmitter();

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
      canvas = nextCanvas;
      wrap = canvas.parentElement;
      buildPalette();
      fpsEl = document.querySelector("[data-falling-fps]");
      atomsEl = document.querySelector("[data-falling-atoms]");
      trisEl = document.querySelector("[data-falling-tris]");
      fpsFrames = 0;
      fpsLastAt = 0;
    }
    bindClearUi();
    bindEmitHeightUi();
    fallingInput.attach(canvas);
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
  fallingInput.detach();
  emitting = false;
  emitAcc = 0;
  if (rafId) window.cancelAnimationFrame(rafId);
  rafId = 0;
  fpsFrames = 0;
  fpsLastAt = 0;
}
