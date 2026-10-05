import * as THREE from "three";
import { audioEngine } from "./audio-engine.js?v=107";
import { STEM_CORNERS, controller, subscribe } from "./mixer-core.js?v=67";
import { applyConvert, applyInfect, applyPostMoves, applyVacuum, compileMaterials, parseMaterialsJson, stepWorld, tickEffects } from "./rule-engine.js?v=77";
import { inputBindings } from "./input-bindings.js?v=15";
import { fallingInput } from "./falling-input.js?v=62";
import { createBlockExpSurface } from "./block-exp-surface.js?v=4";

/**
 * Fixed atom pitch. Smaller than the old default so the playfield holds a
 * denser grid (Sand1-style room to paint).
 */
const ATOM_SIZE = 0.25;
/**
 * Lightest RT pull emits atoms at this fraction of the grid pitch.
 * Full pull reaches full size. The same curve widens the brush.
 * A single stream (LT, Shift) always uses this size.
 */
const ATOM_SCALE_MIN = 0.5;
/** Max emitter height above the ground plane (world units). */
const EMIT_HEIGHT_MAX_U = 12;
/**
 * Shortest atom. Column slots are counted in these, not in full-pitch cells,
 * so a single stream can stack up to the emitter instead of stopping halfway.
 */
const ATOM_MIN_EXTENT = ATOM_SIZE * ATOM_SCALE_MIN;
/** Enough rows for a column of the shortest atoms to reach the emitter. */
const MAX_Y = Math.ceil(EMIT_HEIGHT_MAX_U / ATOM_MIN_EXTENT - 0.5) + 1;
/** Fixed ground / aim span (world units). */
const PLAYFIELD_SPAN = 16;
const PLAYFIELD_HALF = PLAYFIELD_SPAN / 2;
/** Same span as the playfield, so the drawn edge is the last placeable cell. */
const GROUND_PLANE_SIZE = PLAYFIELD_SPAN;
/** Cells across the playfield at the fixed atom pitch. */
const GRID_XZ = Math.max(1, Math.floor(PLAYFIELD_SPAN / ATOM_SIZE + 1e-9));
const GRID_MAX = GRID_XZ;
/** Near-black field. Quadrant identity lives in the labels, not the sky. */
const SCENE_BG = 0x070708;
const scratchBg = new THREE.Color(SCENE_BG);
const SPLASH_LIFE = 0.42;
const CLICK_SLOP = 6;
/** Mouse aim passes 0. Touch no longer places the emitter under the fingertip. */
const FINGER_ABOVE_PLANE_PX = 40;
const RULE_HZ = 22;

/** Fixed view, 60° down, so a finger twist stays closer to the ground heading. Distance is zoomable. */
const CAMERA_PITCH = Math.PI / 3;
const CAMERA_YAW = Math.PI / 4;
const CAMERA_DIST_DEFAULT = 30;
const CAMERA_DIST_MIN = 10;
const CAMERA_DIST_MAX = 60;
const AIM_SPEED = 9;
/**
 * Stick and D-pad keep the ground target inside this NDC box.
 * Motion past the box scrolls the plane instead of leaving the view.
 */
const AIM_VIEW_LIMIT = 0.8;
/**
 * Max Sand1-style brush edge (odd). RT maps a light pull from 1×1 up to this
 * N×N field; LT uses the opposite curve. Each cell rolls a chance so atoms
 * cascade instead of dropping as a slab.
 */
const BRUSH_MAX = 11;
/**
 * Trigger→brush ease: >1 keeps the thin-stream end of RT longer.
 * RT opens the wide field only on a deep pull. LT is always a single stream.
 */
const BRUSH_RT_GAMMA = 2.6;
const EMIT_INTERVAL = 1 / 40;
const EMIT_CHANCE = 0.4;
/** Atoms wait until the emitter footprint has stopped changing for this long. */
const EMIT_SIZE_SETTLE = 0.16;
/** Spawn height above the ground (world units). */
const EMIT_HEIGHT_DEFAULT_U = 5.5;
/** Continuous fall speed toward contact (world units / second). */
const GRAVITY = 28;
/** Lone ground blocks shrink; stacked supports clear. Both are material effects. */

let canvas = null;
let wrap = null;
let scene = null;
/** Rotatable playfield (ground, grid, blocks). Emitter aims across it. */
let surface = null;
let camera = null;
let renderer = null;
let emitter = null;
let emitterFill = null;
let emitterEdge = null;
let emitterMark = null;
let emitterStem = null;
let groundMesh = null;
let blockGeo = null;
let splashGeo = null;
let resizeObserver = null;
let paletteEl = null;
let fpsEl = null;
let atomsEl = null;
let trisEl = null;
let gpuEl = null;
let gpuLabel = "";
let fpsFrames = 0;
let fpsLastAt = 0;
let hudFpsText = "";
let hudAtomsText = "";
let hudTrisText = "";

let running = false;
let rafId = 0;
let sizeTries = 0;
let lastNow = 0;
let ruleAcc = 0;
let cameraDist = CAMERA_DIST_DEFAULT;
/** Fixed look-at. Zoom changes distance; the ground offset does the traveling. */
const CAMERA_LOOK = new THREE.Vector3(0, 0.35, 0);
/** Travel while closer than this fraction of the full-grid distance. */
const TRAVEL_FIT = 0.92;
/** Full-grid camera distance from the last zoom or resize. 0 until measured. */
let gridFitDist = 0;
/** Corner NDC limit used to find a full-grid framing. */
const GRID_NDC_LIMIT = 1;
/**
 * Closest zoom as a fraction of the full-grid distance.
 * 0.35 reaches the original close limit, so the grid can leave the frame.
 */
const CAMERA_ZOOM_PAST_FIT = 0.35;
/** Frame counters for the audio snapshot. Reset after each capture. */
let audioPour = 0;
let audioFall = 0;
let audioDeath = 0;
let audioSplash = 0;
/** Grid cells that splashed since the last audio snapshot. */
const audioSplashAt = [];
let audioGen = 0;
/** @type {ReturnType<typeof captureAudioSnapshot> | null} */
let audioSnap = null;

/** @type {Uint8Array | null} */
let cells = null;
/** @type {Uint8Array | null} */
let budgets = null;
/** Per compiled effect clock (age, absorb, dry). */
/** @type {Float32Array[]} */
let effectClocks = [];
/** Infection duration written onto neighbors (0 = none). */
/** @type {Float32Array | null} */
let infection = null;
/** Age while a cell shrinks from infection with no matching age effect. */
/** @type {Float32Array | null} */
let infectionAge = null;
/** 1 when a vacuumed neighbor has snapped to half size. */
/** @type {Float32Array | null} */
let holeShrink = null;
/** 1 while an effect is shrinking this cell. */
/** @type {Uint8Array | null} */
let shrinkFlags = null;
/** Shrink progress 0..1 for the mesh scale. */
/** @type {Float32Array | null} */
let shrinkT = null;
/** Rise/fade progress 0..1. 0 means not rising. */
/** @type {Float32Array | null} */
let riseT = null;
/** Seconds spent climbing. Lift is this times one inverse-size atomic unit. */
/** @type {Float32Array | null} */
let riseElapsed = null;
/** Column snapshot: resting on the atom or floor below. */
/** @type {Uint8Array | null} */
let restingFlags = null;
/** Column snapshot: support surface is the world floor. */
/** @type {Uint8Array | null} */
let onFloorFlags = null;
/** Column snapshot: same material exists above in this column. */
/** @type {Uint8Array | null} */
let sameAboveFlags = null;
/** Column snapshot: any atom, any material, is higher in this column. */
/** @type {Uint8Array | null} */
let aboveFlags = null;
/** Column snapshot: a block is higher in this column. */
/** @type {Uint8Array | null} */
let blockAboveFlags = null;
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
 * Per-atom dissolve time, assigned at emit by sampling a continuous oscillator
 * between 0.1s and 5s. The wave keeps moving whether or not atoms are poured.
 */
/** @type {Float32Array | null} */
let lifeSpans = null;
const EMIT_LIFE_MIN = 0.1;
const EMIT_LIFE_MAX = 5;
/**
 * Seconds for one cycle: minimum, through the maximum, back to the minimum.
 * Short so a brief pour sweeps most of the 0.1–5s range.
 */
const EMIT_LIFE_PERIOD = 0.4;
/** 0 at the minimum, 0.5 at the maximum, 1 back at the minimum. */
let emitLifePhase = 0;
/** Consecutive same-height hops (shuffle detection). */
/** @type {Uint8Array | null} */
let shuffleCounts = null;
/** Cell X where the current shuffle streak began. */
/** @type {Uint16Array | null} */
let shuffleOriginX = null;
/** Cell Z where the current shuffle streak began. */
/** @type {Uint16Array | null} */
let shuffleOriginZ = null;
/** Last horizontal flow facing (path follow). */
/** @type {Int8Array | null} */
let flowDx = null;
/** @type {Int8Array | null} */
let flowDz = null;
/** Stable per-grain id copied when a cell moves. 0 means unassigned. */
/** @type {Uint32Array | null} */
let audioIds = null;
let nextAudioId = 1;
/** Packed cell indices that currently hold material. */
const occupied = new Set();
/** @type {Map<number, THREE.InstancedMesh>} */
const instances = new Map();
/** In-flight atoms — same materials, but without the projected target. */
/** @type {Map<number, THREE.InstancedMesh>} */
const fallingInstances = new Map();
/** Rising grains draw on the opaque falling meshes and are removed when the age clock ends. */
/** @type {Map<number, THREE.InstancedMesh>} */
const risingInstances = new Map();
/** Column lists reused across flags, gravity, and mesh classify. Key is z * GRID_MAX + x. */
/** @type {Map<number, number[]>} */
const columns = new Map();
/** Keys with at least one atom in the latest buildColumns(). */
const columnKeys = [];
/** Landed instance slot per cell, or -1. Stable so resting cubes are not reuploaded. */
/** @type {Int32Array | null} */
let landedSlot = null;
/** Material that owns landedSlot[i]. */
/** @type {Uint8Array | null} */
let landedMatOf = null;
/** @type {Map<number, number[]>} material → cell indices in landed instance order */
const landedOrder = new Map();
/** @type {Map<number, number[]>} material → x,y,z triples for the falling draw */
const fallingBuckets = new Map();
/** @type {Map<number, number[]>} material → x,y,z triples for the rise/fade draw */
const risingBuckets = new Map();
/** @type {Uint32Array | null} */
let xformStamp = null;
let xformGen = 1;
/** @type {Uint32Array | null} */
let classStamp = null;
let classGen = 1;
/** Cells drawn with a shrink scale, so the next sync can restore them when shrink ends. */
const wasScaled = new Set();
/** @type {Map<number, THREE.MeshPhongMaterial>} */
const matCache = new Map();
/** @type {{ mesh: THREE.Mesh, age: number }[]} */
let splashes = [];
/** @type {{ ix: number, iz: number } | null} */
let aim = null;
/** Emitter aim in world XZ (decoupled from rotating surface / grid). */
let aimWorldX = 0;
/**
 * Pointer position captured while the stick or D-pad is aiming.
 * A resting cursor does not pull the emitter back until the mouse moves.
 */
let stickAimPointer = null;
let aimWorldZ = 0;
let emitAcc = 0;
let emitting = false;
/** Shift is previewing a one-cell pour, before or during the click. */
let shiftStream = false;
/** Quantized emitter size last applied. A change restarts the settle wait. */
let emitSizeKey = -1;
let emitSizeHold = 0;
/** Current emit / preview brush edge length (odd, 1…BRUSH_MAX). Rests at full size. */
let brushN = BRUSH_MAX;
/**
 * Current emit scale (ATOM_SCALE_MIN…1).
 * Baked into each new atom so later trigger motion does not resize the pile.
 */
let emitScale = 1;
/** Spawn height above ground in world units. */
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
const emitterNdc = new THREE.Vector3();
/** Horizontal plane. A screen point becomes world XZ on the ground or the emitter. */
const emitterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hitPoint = new THREE.Vector3();
const scratchPos = new THREE.Vector3();
/** @type {ReturnType<typeof createBlockExpSurface> | null} */
let blockExpSurface = null;
const blockExpPoints = [];
const blockExpHalf = [];
const scratchScale = new THREE.Vector3(1, 1, 1);
const scratchQuat = new THREE.Quaternion();
const scratchMat4 = new THREE.Matrix4();

/**
 * How hard the ground mark mixes toward black.
 * A wide field stays a light shade. A single stream is solid black so the
 * small square still reads, and a trigger pull fades between those as the
 * footprint grows.
 */
const LAND_INK_WIDE = 0.45;
const LAND_INK_TIGHT = 1;

/**
 * Filled square on the ground under the emitter, the size of the pour.
 * Hidden while atoms are pouring.
 */
const landingTarget = {
  center: { value: new THREE.Vector2() },
  /** Half-extent of the square, in world units. */
  half: { value: ATOM_SIZE * 0.5 },
  yaw: { value: 0 },
  /** 1 while aiming, 0 while atoms are pouring. */
  on: { value: 1 },
  /** Mix toward black. 1 is solid black. */
  ink: { value: LAND_INK_WIDE },
  /** Surface origin in world XZ. The atom grid is locked to the playfield. */
  origin: { value: new THREE.Vector2() },
  pitch: { value: ATOM_SIZE },
};

function compileLandingTarget(shader, grid) {
  shader.uniforms.uLandCenter = landingTarget.center;
  shader.uniforms.uLandHalf = landingTarget.half;
  shader.uniforms.uLandYaw = landingTarget.yaw;
  shader.uniforms.uLandOn = landingTarget.on;
  shader.uniforms.uLandInk = landingTarget.ink;
  shader.uniforms.uSurfOrigin = landingTarget.origin;
  shader.uniforms.uGridPitch = landingTarget.pitch;
  shader.uniforms.uGridOn = { value: grid ? 1 : 0 };
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vLandWorld;")
    .replace(
      "#include <project_vertex>",
      `#include <project_vertex>
{
  vec4 landPos = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    landPos = instanceMatrix * landPos;
  #endif
  vLandWorld = (modelMatrix * landPos).xyz;
}`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
varying vec3 vLandWorld;
uniform vec2 uLandCenter;
uniform float uLandHalf;
uniform float uLandYaw;
uniform float uLandOn;
uniform float uLandInk;
uniform vec2 uSurfOrigin;
uniform float uGridPitch;
uniform float uGridOn;`,
    )
    .replace(
      "#include <opaque_fragment>",
      `{
  if (uGridOn > 0.5) {
    vec2 sd = vLandWorld.xz - uSurfOrigin;
    float gc = cos(uLandYaw);
    float gs = sin(uLandYaw);
    vec2 surf = vec2(gc * sd.x - gs * sd.y, gs * sd.x + gc * sd.y);
    vec2 cell = surf / max(uGridPitch, 0.0001);
    vec2 gfw = max(fwidth(cell), vec2(0.0001));
    vec2 dist = abs(fract(cell - 0.5) - 0.5);
    float dPx = min(dist.x / gfw.x, dist.y / gfw.y);
    float line = 1.0 - smoothstep(0.0, 1.0, dPx);
    float keep = 1.0 - smoothstep(0.35, 0.75, max(gfw.x, gfw.y));
    outgoingLight += vec3(0.028) * line * keep;
  }
  vec2 d = vLandWorld.xz - uLandCenter;
  float c = cos(uLandYaw);
  float s = sin(uLandYaw);
  vec2 local = vec2(c * d.x - s * d.y, s * d.x + c * d.y);
  float halfE = max(uLandHalf, 0.001);
  vec2 fw = max(fwidth(local), vec2(0.0001));
  float coverX = 1.0 - smoothstep(halfE - fw.x, halfE + fw.x, abs(local.x));
  float coverY = 1.0 - smoothstep(halfE - fw.y, halfE + fw.y, abs(local.y));
  float cover = coverX * coverY;
  if (uLandOn > 0.5 && cover > 0.001) {
    outgoingLight = mix(outgoingLight, vec3(0.0), uLandInk * cover);
  }
}
#include <opaque_fragment>`,
    );
}

function attachLandingTarget(material, grid = false) {
  material.onBeforeCompile = (shader) => compileLandingTarget(shader, grid);
}

function compileRiseFade(shader) {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      "#include <common>\nattribute float instanceOpacity;\nvarying float vAtomOpacity;",
    )
    .replace("#include <project_vertex>", "#include <project_vertex>\nvAtomOpacity = instanceOpacity;");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nvarying float vAtomOpacity;")
    .replace("#include <opaque_fragment>", "#include <opaque_fragment>\ngl_FragColor.a *= vAtomOpacity;");
}

/**
 * Smallest stream is black. The wide field keeps the light shade.
 * Analog trigger pressure changes the footprint, so the mark darkens as that
 * square shrinks and lightens as it grows.
 */
function landingInkForFootprint(brush, scale) {
  const edge = brush * scale;
  const minEdge = ATOM_SCALE_MIN;
  const maxEdge = BRUSH_MAX;
  const span = maxEdge - minEdge;
  const t = span > 0 ? clamp01((edge - minEdge) / span) : 1;
  return LAND_INK_TIGHT + t * (LAND_INK_WIDE - LAND_INK_TIGHT);
}

function syncLandingTarget() {
  landingTarget.center.value.set(aimWorldX, aimWorldZ);
  const edge = atomSize * emitScale;
  const pourHalf = brushN * edge * 0.5;
  const yaw = surface ? surface.rotation.y : 0;
  landingTarget.yaw.value = yaw;
  landingTarget.half.value = pourHalf;
  landingTarget.on.value = emitting ? 0 : 1;
  landingTarget.ink.value = landingInkForFootprint(brushN, emitScale);
  landingTarget.origin.value.set(surface ? surface.position.x : 0, surface ? surface.position.z : 0);
  canvas?.classList.toggle("is-emitting", emitting);
  canvas?.classList.toggle("is-single-stream", shiftStream);
}

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

/** Poured grains of a collection-limited converter start with one conversion. */
function freshSpreadCharge(matIndex) {
  if (!catalog || matIndex <= 0) return 0;
  const id = catalog.idByIndex[matIndex];
  const material = id ? catalog.byId.get(id) : null;
  if (!material?.effects?.some((effect) => effect.kind === "convert" && effect.limit === "collection")) {
    return 0;
  }
  return 1;
}

function setCell(x, y, z, value) {
  if (!cells || !inBounds(x, y, z)) return;
  const i = idx(x, y, z);
  const prev = cells[i];
  if (prev !== value && landedSlot && landedSlot[i] >= 0) removeLanded(i);
  cells[i] = value;
  if (!value) {
    if (budgets) budgets[i] = 0;
    clearEffectCell(i);
    if (posY) posY[i] = 0;
    if (posX) posX[i] = 0;
    if (posZ) posZ[i] = 0;
    if (emitSizes) emitSizes[i] = 0;
    if (lifeSpans) lifeSpans[i] = 0;
    if (shuffleCounts) shuffleCounts[i] = 0;
    if (shuffleOriginX) shuffleOriginX[i] = 0;
    if (shuffleOriginZ) shuffleOriginZ[i] = 0;
    if (flowDx) flowDx[i] = 0;
    if (flowDz) flowDz[i] = 0;
  } else if (prev === 0) {
    // Fresh spawn: bake current atom size; pitch matches so neighbors of this size touch.
    clearEffectCell(i);
    if (emitSizes) emitSizes[i] = atomSize;
    if (lifeSpans) lifeSpans[i] = 0;
    if (shuffleCounts) shuffleCounts[i] = 0;
    if (shuffleOriginX) shuffleOriginX[i] = 0;
    if (shuffleOriginZ) shuffleOriginZ[i] = 0;
    if (flowDx) flowDx[i] = 0;
    if (flowDz) flowDz[i] = 0;
    if (posY) posY[i] = (y + 0.5) * atomSize;
    if (posX) posX[i] = worldXForCell(x, atomSize);
    if (posZ) posZ[i] = worldZForCell(z, atomSize);
    // A poured diffuse grain can turn one other atom. Moves copy this budget afterward.
    if (freshSpreadCharge(value) > 0) setBudget(x, y, z, 1);
  }
  if (value > 0) occupied.add(i);
  else if (prev > 0) occupied.delete(i);
}

/** Advance the lifetime oscillator. Emission reads it; it does not step the wave. */
function advanceEmitLife(dt) {
  if (!(dt > 0) || EMIT_LIFE_PERIOD <= 0) return;
  emitLifePhase = (emitLifePhase + dt / EMIT_LIFE_PERIOD) % 1;
}

/** Lifetime in seconds at a phase on the displayed wave. */
function lifeFromPhase(phase) {
  const height = (1 - Math.cos(phase * Math.PI * 2)) * 0.5;
  return EMIT_LIFE_MIN + height * (EMIT_LIFE_MAX - EMIT_LIFE_MIN);
}

/** Sample the oscillator where it is right now. */
function sampleEmitLife() {
  return lifeFromPhase(emitLifePhase);
}

function resetEmitLife() {
  emitLifePhase = 0;
}

function getLife(x, y, z) {
  if (!lifeSpans || !inBounds(x, y, z)) return 0;
  return lifeSpans[idx(x, y, z)];
}

function setLife(x, y, z, value) {
  if (!lifeSpans || !inBounds(x, y, z)) return;
  lifeSpans[idx(x, y, z)] = Math.max(0, Number(value) || 0);
}

function getBudget(x, y, z) {
  if (!budgets || !inBounds(x, y, z)) return 0;
  return budgets[idx(x, y, z)];
}

function setBudget(x, y, z, value) {
  if (!budgets || !inBounds(x, y, z)) return;
  budgets[idx(x, y, z)] = Math.max(0, value | 0);
}

function clearEffectCell(i) {
  for (const clocks of effectClocks) clocks[i] = 0;
  if (infection) infection[i] = 0;
  if (infectionAge) infectionAge[i] = 0;
  if (holeShrink) holeShrink[i] = 0;
  if (shrinkFlags) shrinkFlags[i] = 0;
  if (shrinkT) shrinkT[i] = 0;
  if (riseT) riseT[i] = 0;
  if (riseElapsed) riseElapsed[i] = 0;
  if (audioIds) audioIds[i] = 0;
}

function getEffectClock(x, y, z, channel) {
  const clocks = effectClocks[channel];
  if (!clocks || !inBounds(x, y, z)) return 0;
  return clocks[idx(x, y, z)];
}

function setEffectClock(x, y, z, channel, value) {
  const clocks = effectClocks[channel];
  if (!clocks || !inBounds(x, y, z)) return;
  clocks[idx(x, y, z)] = Math.max(0, Number(value) || 0);
}

function getInfection(x, y, z) {
  if (!infection || !inBounds(x, y, z)) return 0;
  return infection[idx(x, y, z)];
}

function setInfection(x, y, z, value) {
  if (!infection || !inBounds(x, y, z)) return;
  infection[idx(x, y, z)] = Math.max(0, Number(value) || 0);
}

function getInfectionAge(x, y, z) {
  if (!infectionAge || !inBounds(x, y, z)) return 0;
  return infectionAge[idx(x, y, z)];
}

function setInfectionAge(x, y, z, value) {
  if (!infectionAge || !inBounds(x, y, z)) return;
  infectionAge[idx(x, y, z)] = Math.max(0, Number(value) || 0);
}

function getHoleShrink(x, y, z) {
  if (!holeShrink || !inBounds(x, y, z)) return 0;
  return holeShrink[idx(x, y, z)] || 0;
}

function setHoleShrink(x, y, z, value) {
  if (!holeShrink || !inBounds(x, y, z)) return;
  holeShrink[idx(x, y, z)] = Math.max(0, Number(value) || 0);
}

function setShrink(x, y, z, shrinking, t) {
  if (!inBounds(x, y, z)) return;
  const i = idx(x, y, z);
  if (shrinkFlags) shrinkFlags[i] = shrinking ? 1 : 0;
  if (shrinkT) shrinkT[i] = shrinking ? Math.max(0, Math.min(1, Number(t) || 0)) : 0;
}

function setRise(x, y, z, rising, t, elapsed) {
  if (!inBounds(x, y, z)) return;
  const i = idx(x, y, z);
  if (riseT) riseT[i] = rising ? Math.max(0, Math.min(1, Number(t) || 0)) : 0;
  if (riseElapsed) riseElapsed[i] = rising ? Math.max(0, Number(elapsed) || 0) : 0;
}

function getRiseT(x, y, z) {
  if (!riseT || !inBounds(x, y, z)) return 0;
  return riseT[idx(x, y, z)] || 0;
}

function getRiseElapsed(x, y, z) {
  if (!riseElapsed || !inBounds(x, y, z)) return 0;
  return riseElapsed[idx(x, y, z)] || 0;
}

function getShrink(x, y, z) {
  if (!shrinkFlags || !inBounds(x, y, z)) return false;
  return shrinkFlags[idx(x, y, z)] === 1;
}

function getShrinkT(x, y, z) {
  if (!shrinkT || !inBounds(x, y, z)) return 0;
  return shrinkT[idx(x, y, z)] || 0;
}

function getResting(x, y, z) {
  if (!restingFlags || !inBounds(x, y, z)) return false;
  return restingFlags[idx(x, y, z)] === 1;
}

function getOnFloor(x, y, z) {
  if (!onFloorFlags || !inBounds(x, y, z)) return false;
  return onFloorFlags[idx(x, y, z)] === 1;
}

function getSameAbove(x, y, z) {
  if (!sameAboveFlags || !inBounds(x, y, z)) return false;
  return sameAboveFlags[idx(x, y, z)] === 1;
}

function getExtent(x, y, z) {
  if (!inBounds(x, y, z)) return 0;
  return atomExtent(x, y, z, getCell(x, y, z));
}

function getPitch(x, y, z) {
  if (!inBounds(x, y, z)) return atomSize;
  return cellAtomSize(idx(x, y, z));
}

function cellCenter(x, y, z) {
  const pitch = getPitch(x, y, z);
  return {
    x: worldXForCell(x, pitch),
    y: (y + 0.5) * pitch,
    z: worldZForCell(z, pitch),
  };
}

function getWorld(x, y, z) {
  const center = cellCenter(x, y, z);
  if (getCell(x, y, z) <= 0) return center;
  const i = idx(x, y, z);
  return {
    x: posX ? posX[i] : center.x,
    y: posY ? posY[i] : center.y,
    z: posZ ? posZ[i] : center.z,
  };
}

function materialSlidesOpen(matIndex) {
  const id = catalog?.idByIndex[matIndex];
  return !!id && catalog.byId.get(id)?.slideOpen === true;
}

/** Silent grains stay out of footprint, height, pan, and the other audio measures. */
function materialSonifies(matIndex) {
  const id = catalog?.idByIndex[matIndex];
  const def = id ? catalog.byId.get(id) : null;
  return !def || def.sonify !== false;
}

/** Diffuse grains and liquids. A sideways step is flow; a straight fall is not. */
function materialSpreads(matIndex) {
  const id = catalog?.idByIndex[matIndex];
  const def = id ? catalog.byId.get(id) : null;
  if (!def) return false;
  return def.id === "diffuse" || def.surface === "liquid";
}

function countSonifying() {
  let n = 0;
  if (!cells) return 0;
  for (const i of occupied) {
    if (cells[i] > 0 && materialSonifies(cells[i])) n += 1;
  }
  return n;
}

function getPosY(x, y, z) {
  if (!posY || !inBounds(x, y, z)) return 0;
  return posY[idx(x, y, z)];
}

function setPosY(x, y, z, value) {
  if (!posY || !inBounds(x, y, z)) return;
  const i = idx(x, y, z);
  posY[i] = Number.isFinite(value) ? value : 0;
  markXform(i);
}

function getPosX(x, y, z) {
  if (!posX || !inBounds(x, y, z)) return 0;
  return posX[idx(x, y, z)];
}

function setPosX(x, y, z, value) {
  if (!posX || !inBounds(x, y, z)) return;
  const i = idx(x, y, z);
  posX[i] = Number.isFinite(value) ? value : 0;
  markXform(i);
}

function getPosZ(x, y, z) {
  if (!posZ || !inBounds(x, y, z)) return 0;
  return posZ[idx(x, y, z)];
}

function setPosZ(x, y, z, value) {
  if (!posZ || !inBounds(x, y, z)) return;
  const i = idx(x, y, z);
  posZ[i] = Number.isFinite(value) ? value : 0;
  markXform(i);
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

function getAudioId(x, y, z) {
  if (!audioIds || !inBounds(x, y, z)) return 0;
  return audioIds[idx(x, y, z)] || 0;
}

function setAudioId(x, y, z, value) {
  if (!audioIds || !inBounds(x, y, z)) return;
  const id = Number(value) || 0;
  audioIds[idx(x, y, z)] = id > 0 ? id >>> 0 : 0;
}

/** Stable id for one grain. A slide keeps it, so the rising voice is not rebuilt. */
function grainAudioId(i) {
  if (!audioIds) return i + 1;
  const existing = audioIds[i];
  if (existing) return existing;
  const id = nextAudioId++;
  if (nextAudioId > 0x7ffffffe) nextAudioId = 1;
  audioIds[i] = id;
  return id;
}

const gridApi = {
  get: getCell,
  set: setCell,
  inBounds,
  getBudget,
  setBudget,
  getEffectClock,
  setEffectClock,
  getInfection,
  setInfection,
  getInfectionAge,
  setInfectionAge,
  getHoleShrink,
  setHoleShrink,
  setShrink,
  getShrink,
  getShrinkT,
  setRise,
  getRiseT,
  getRiseElapsed,
  getResting,
  getOnFloor,
  getSameAbove,
  getExtent,
  getPitch,
  cellCenter,
  getWorld,
  getPosY,
  setPosY,
  getPosX,
  setPosX,
  getPosZ,
  setPosZ,
  getEmitSize: getCellEmitSize,
  setEmitSize: setCellEmitSize,
  getLife,
  setLife,
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
  getAudioId,
  setAudioId,
};

function cellAtomSize(cellIndex) {
  if (emitSizes && emitSizes[cellIndex] > 0) return emitSizes[cellIndex];
  return atomSize;
}

function cellScale(x, y, z) {
  const i = idx(x, y, z);
  let scale = 1;
  if (shrinkFlags && shrinkFlags[i] === 1 && shrinkT) {
    const t = Math.min(1, Math.max(0, shrinkT[i]));
    scale = Math.max(0.02, 1 - t);
  }
  if (holeShrink && holeShrink[i] > 0) scale *= 0.5;
  return scale;
}

/** Drawn size while climbing. Full size at the start, gone at the end. */
function riseDrawScale(x, y, z) {
  const t = getRiseT(x, y, z);
  if (t <= 0) return 1;
  return Math.max(0.02, 1 - t);
}

function atomExtent(x, y, z, matIndex) {
  return cellAtomSize(idx(x, y, z)) * cellScale(x, y, z, matIndex);
}

/**
 * World lift for a rising grain. Step size is inverse to the grain's size, and
 * the climb rate is that grain's own lifetime, so neighbors peel off at
 * different speeds. The climb still speeds up the longer it has been rising.
 */
function riseOffset(x, y, z) {
  const i = idx(x, y, z);
  const elapsed = riseElapsed?.[i] || 0;
  if (elapsed <= 0) return 0;
  const extent = atomExtent(x, y, z, getCell(x, y, z));
  const units = extent > 1e-6 ? ATOM_SIZE / extent : 1;
  const life = lifeSpans?.[i] > 0 ? lifeSpans[i] : 1;
  const distance = elapsed * (1 + elapsed) * life;
  return distance * units * ATOM_SIZE;
}

function cellWorld(x, y, z, target, scale = 1) {
  const i = idx(x, y, z);
  const pitch = cellAtomSize(i);
  target.x = posX ? posX[i] : worldXForCell(x, pitch);
  target.y = posY ? posY[i] : (y + 0.5) * pitch;
  target.y += riseOffset(x, y, z);
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
  for (const mesh of fallingInstances.values()) {
    surface.remove(mesh);
  }
  fallingInstances.clear();
  for (const mesh of risingInstances.values()) {
    if (mesh.geometry !== blockGeo) mesh.geometry.dispose();
    surface.remove(mesh);
  }
  risingInstances.clear();
  resetLandedTracking();
  reconcileMeshes();
}

function rebuildSplashGeometry() {
  if (splashGeo) splashGeo.dispose();
  splashGeo = new THREE.RingGeometry(atomSize * 0.55, atomSize * 0.8, 28);
}

/**
 * 0 at the default camera distance.
 * `near` reaches 1 at the closest zoom; `far` reaches 1 at the farthest.
 */
function cameraPresence() {
  const nearSpan = CAMERA_DIST_DEFAULT - CAMERA_DIST_MIN;
  const farSpan = CAMERA_DIST_MAX - CAMERA_DIST_DEFAULT;
  return {
    near: nearSpan > 0 ? clamp01((CAMERA_DIST_DEFAULT - cameraDist) / nearSpan) : 0,
    far: farSpan > 0 ? clamp01((cameraDist - CAMERA_DIST_DEFAULT) / farSpan) : 0,
  };
}

function syncCamera() {
  if (!camera) return;
  const horizontal = Math.cos(CAMERA_PITCH) * cameraDist;
  camera.position.set(
    CAMERA_LOOK.x + Math.sin(CAMERA_YAW) * horizontal,
    CAMERA_LOOK.y + Math.sin(CAMERA_PITCH) * cameraDist,
    CAMERA_LOOK.z + Math.cos(CAMERA_YAW) * horizontal,
  );
  camera.lookAt(CAMERA_LOOK);
  syncViewBrightness();
}

/** Closest distance that still keeps the camera above the emitter. */
function emitterClearanceDist() {
  const rise = emitWorldY() - CAMERA_LOOK.y;
  if (rise <= 0.05) return CAMERA_DIST_MIN;
  return (rise + 0.05) / Math.sin(CAMERA_PITCH);
}

/** Default distance stays at full picture brightness. Pulling back darkens the view. */
function syncViewBrightness() {
  if (!canvas) return;
  const { far } = cameraPresence();
  if (far < 0.001) {
    canvas.style.filter = "";
    return;
  }
  const brightness = 1 - Math.pow(far, 0.85) * 0.55;
  canvas.style.filter = `brightness(${brightness.toFixed(3)})`;
}

/** True when every corner of the surface grid is inside the viewport. */
function gridCornersFit() {
  if (!camera) return true;
  camera.updateMatrixWorld(true);
  const half = PLAYFIELD_HALF;
  const corners = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  for (let i = 0; i < corners.length; i += 1) {
    const world = surfaceYawXZ(corners[i][0], corners[i][1]);
    emitterNdc.set(world.x, 0, world.z);
    emitterNdc.project(camera);
    if (
      emitterNdc.z > 1 ||
      Math.abs(emitterNdc.x) > GRID_NDC_LIMIT ||
      Math.abs(emitterNdc.y) > GRID_NDC_LIMIT
    ) {
      return false;
    }
  }
  return true;
}

/** Closest camera distance that still shows the whole grid. Depends on aspect and yaw. */
function closestGridDist() {
  const saved = cameraDist;
  let lo = CAMERA_DIST_MIN;
  let hi = CAMERA_DIST_MAX;
  cameraDist = hi;
  syncCamera();
  if (!gridCornersFit()) {
    cameraDist = saved;
    syncCamera();
    return CAMERA_DIST_MAX;
  }
  for (let i = 0; i < 14; i += 1) {
    const mid = (lo + hi) * 0.5;
    cameraDist = mid;
    syncCamera();
    if (gridCornersFit()) hi = mid;
    else lo = mid;
  }
  cameraDist = saved;
  syncCamera();
  return hi;
}

function setCameraDist(next) {
  gridFitDist = closestGridDist();
  const minDist = Math.max(
    CAMERA_DIST_MIN,
    gridFitDist * CAMERA_ZOOM_PAST_FIT,
    emitterClearanceDist(),
  );
  const clamped = Math.min(CAMERA_DIST_MAX, Math.max(minDist, next));
  if (Math.abs(clamped - cameraDist) < 1e-4) return cameraDist;
  cameraDist = clamped;
  syncCamera();
  return cameraDist;
}

function zoomCamera(factor) {
  if (!Number.isFinite(factor) || factor <= 0) return cameraDist;
  const next = Math.min(CAMERA_DIST_MAX, Math.max(CAMERA_DIST_MIN, cameraDist * factor));
  if (Math.abs(next - cameraDist) < 1e-6 && next >= cameraDist) return cameraDist;
  return setCameraDist(next);
}

/** Put the ground target on the screen center without changing the pour cell. */
function holdTargetAtCenter() {
  const focus = groundFocus();
  if (!focus) return;
  glideCouple(focus.x - aimWorldX, focus.z - aimWorldZ);
}

function viewIsClose() {
  return gridFitDist > 0 && cameraDist < gridFitDist * TRAVEL_FIT;
}

function viewIsWide() {
  return gridFitDist > 0 && cameraDist > gridFitDist;
}

/** Screen position of the ground target. That point is the zoom and pan focal. */
function projectTarget() {
  camera.updateMatrixWorld(true);
  emitterNdc.set(aimWorldX, 0, aimWorldZ);
  emitterNdc.project(camera);
  return { x: emitterNdc.x, y: emitterNdc.y, z: emitterNdc.z };
}

/** World XZ where a screen point meets a horizontal plane. */
function worldOnPlane(ndcX, ndcY, y) {
  emitterPlane.constant = -y;
  pointerNdc.set(ndcX, ndcY);
  raycaster.setFromCamera(pointerNdc, camera);
  if (!raycaster.ray.intersectPlane(emitterPlane, hitPoint)) return null;
  if (!Number.isFinite(hitPoint.x) || !Number.isFinite(hitPoint.z)) return null;
  return { x: hitPoint.x, z: hitPoint.z };
}

/** Ground point at the center of the screen. Zoom and panning keep the target here. */
function groundFocus() {
  return worldOnPlane(0, 0, 0);
}

/** Emitter and the ground target share this XZ. Pointer aim keeps the emitter on the view ray. */
function emitterDrawXZ() {
  return { x: aimWorldX, z: aimWorldZ };
}

/** Move the emitter and the ground by the same world delta so the cell stays put. */
function glideCouple(dx, dz) {
  if (!surface || !dx && !dz) return;
  surface.position.x += dx;
  surface.position.z += dz;
  aimWorldX += dx;
  aimWorldZ += dz;
}

/**
 * Slide the ground under the screen center. dx/dz is the aim's world step.
 * The cell currently at the center stays with that step, then the step pans.
 * A step past the playfield stops at the edge instead of jumping there.
 */
function slideGround(dx, dz) {
  if (!surface) return;
  const focus = groundFocus();
  if (!focus) return;
  let nx = surface.position.x + (focus.x - aimWorldX) - dx;
  let nz = surface.position.z + (focus.z - aimWorldZ) - dz;
  const sy = surface.rotation.y;
  const c = Math.cos(sy);
  const s = Math.sin(sy);
  let lx = c * (focus.x - nx) - s * (focus.z - nz);
  let lz = s * (focus.x - nx) + c * (focus.z - nz);
  const limit = PLAYFIELD_HALF - 0.001;
  if (Math.abs(lx) > limit || Math.abs(lz) > limit) {
    const clampedX = Math.min(limit, Math.max(-limit, lx));
    const clampedZ = Math.min(limit, Math.max(-limit, lz));
    const yawed = surfaceYawXZ(clampedX, clampedZ);
    nx = focus.x - yawed.x;
    nz = focus.z - yawed.z;
  }
  surface.position.x = nx;
  surface.position.z = nz;
  aimWorldX = focus.x;
  aimWorldZ = focus.z;
}

/**
 * Move the ground with this pointer drag, in the same sample.
 * The plane follows the hand 1:1, so the ground under the cursor stays with it.
 * The emitter stays on its cell and is not pulled back to the center of the screen.
 */
const DRAG_GAIN = 1;

function dragGround(dx, dz) {
  if (!surface || (!dx && !dz)) return;
  const localAim = worldToSurfaceXZ(aimWorldX, aimWorldZ);
  surface.position.x += dx;
  surface.position.z += dz;
  const world = surfaceToWorldXZ(localAim.x, localAim.z);
  aimWorldX = world.x;
  aimWorldZ = world.z;
}

/** Pour point sits on the screen-center ground point. The field stays put. */
function pinEmitterAtScreenCenter() {
  const focus = groundFocus();
  if (!focus) return;
  aimWorldX = focus.x;
  aimWorldZ = focus.z;
}

/**
 * One-finger pan. The ground under the finger follows the finger, then the
 * pour point returns to screen center. The center cell cannot leave the bed.
 * @param {{ from: { x: number, y: number }, to: { x: number, y: number } }} pan
 */
function panBedUnderEmitter(pan) {
  if (!surface || !canvas || !pan) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const from = groundAtPixels(pan.from.x - rect.left, pan.from.y - rect.top, rect);
  const to = groundAtPixels(pan.to.x - rect.left, pan.to.y - rect.top, rect);
  if (!from || !to) return;
  const focus = groundFocus();
  if (!focus) return;
  let nx = surface.position.x + (to.x - from.x);
  let nz = surface.position.z + (to.z - from.z);
  const sy = surface.rotation.y;
  const c = Math.cos(sy);
  const s = Math.sin(sy);
  let lx = c * (focus.x - nx) - s * (focus.z - nz);
  let lz = s * (focus.x - nx) + c * (focus.z - nz);
  const limit = PLAYFIELD_HALF - 0.001;
  if (Math.abs(lx) > limit || Math.abs(lz) > limit) {
    const clampedX = Math.min(limit, Math.max(-limit, lx));
    const clampedZ = Math.min(limit, Math.max(-limit, lz));
    const yawed = surfaceYawXZ(clampedX, clampedZ);
    nx = focus.x - yawed.x;
    nz = focus.z - yawed.z;
  }
  surface.position.x = nx;
  surface.position.z = nz;
  pinEmitterAtScreenCenter();
}

function slidePointer(dx, dy, pointer) {
  if ((!dx && !dy) || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const x1 = pointer ? pointer.x - rect.left : rect.width / 2;
  const y1 = pointer ? pointer.y - rect.top : rect.height / 2;
  const from = groundAtPixels(x1 - dx, y1 - dy, rect);
  const to = groundAtPixels(x1, y1, rect);
  if (!from || !to) return;
  dragGround((to.x - from.x) * DRAG_GAIN, (to.z - from.z) * DRAG_GAIN);
}

/** Ground point under a canvas pixel. */
function groundAtPixels(px, py, rect) {
  const ndcX = (px / rect.width) * 2 - 1;
  const ndcY = 1 - (py / rect.height) * 2;
  return worldOnPlane(ndcX, ndcY, 0);
}

/** Put the emitter on a world XZ point, clamped to the playfield. The grid stays put. */
function placeEmitterAtWorld(wx, wz) {
  if (!surface) return;
  const limit = PLAYFIELD_HALF - 0.001;
  let { x: lx, z: lz } = worldToSurfaceXZ(wx, wz);
  lx = Math.min(limit, Math.max(-limit, lx));
  lz = Math.min(limit, Math.max(-limit, lz));
  const world = surfaceToWorldXZ(lx, lz);
  aimWorldX = world.x;
  aimWorldZ = world.z;
}

/**
 * Put the emitter plane under the pointer. The ground target shares that cell,
 * so the pour stays visible beside the finger instead of under it.
 * liftPx shifts the aim down the screen, leaving the contact above the plane.
 */
function placeEmitterAtPointer(pointer, liftPx = 0) {
  if (!canvas || !pointer || !surface) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const px = pointer.x - rect.left;
  const py = pointer.y - rect.top + liftPx;
  const ndcX = (px / rect.width) * 2 - 1;
  const ndcY = 1 - (py / rect.height) * 2;
  const hit = worldOnPlane(ndcX, ndcY, emitWorldY());
  if (!hit) return;
  placeEmitterAtWorld(hit.x, hit.z);
}

/** Yaw the playfield around the emitter target. Mouse and stick use this. */
function rotateSurface(deltaYaw) {
  if (!surface || !deltaYaw) return;
  setSurfaceYaw(surface.rotation.y + deltaYaw);
}

function setSurfaceYaw(nextYaw) {
  if (!surface) return;
  const applied = nextYaw - surface.rotation.y;
  if (!yawAbout(applied, { x: aimWorldX, z: aimWorldZ })) return;
  setAimFromWorld();
  syncEmitter();
  syncSceneBackground();
}

/**
 * Yaw the playfield and the emitter about a world XZ pivot.
 * Positive yaw is clockwise from above. The emitter stays on its cell.
 * @returns {boolean}
 */
function yawAbout(applied, pivot) {
  if (!surface || !applied || Math.abs(applied) < 1e-8) return false;
  const c = Math.cos(applied);
  const s = Math.sin(applied);
  const vx = pivot.x - surface.position.x;
  const vz = pivot.z - surface.position.z;
  surface.position.x = pivot.x - (c * vx + s * vz);
  surface.position.z = pivot.z - (-s * vx + c * vz);
  surface.rotation.y += applied;
  const ax = aimWorldX - pivot.x;
  const az = aimWorldZ - pivot.z;
  aimWorldX = pivot.x + (c * ax + s * az);
  aimWorldZ = pivot.z + (-s * ax + c * az);
  return true;
}

/**
 * Two-finger chord, in client pixels. Yaw matches the ground heading of that
 * chord and turns about the screen-center emitter. Zoom stays on the screen span.
 * @param {{ a0: { x: number, y: number }, b0: { x: number, y: number }, a1: { x: number, y: number }, b1: { x: number, y: number } }} chord
 */
function twistGround(chord) {
  if (!surface || !canvas || !chord) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const ground = (p) => groundAtPixels(p.x - rect.left, p.y - rect.top, rect);
  const a0 = ground(chord.a0);
  const b0 = ground(chord.b0);
  const a1 = ground(chord.a1);
  const b1 = ground(chord.b1);
  if (!a0 || !b0 || !a1 || !b1) return;
  const focus = groundFocus();
  if (!focus) return;
  const dx0 = b0.x - a0.x;
  const dz0 = b0.z - a0.z;
  const dx1 = b1.x - a1.x;
  const dz1 = b1.z - a1.z;
  if (dx0 * dx0 + dz0 * dz0 > 1e-8 && dx1 * dx1 + dz1 * dz1 > 1e-8) {
    const applied = -wrapAngle(Math.atan2(dz1, dx1) - Math.atan2(dz0, dx0));
    if (yawAbout(applied, { x: focus.x, z: focus.z })) syncSceneBackground();
  }
  pinEmitterAtScreenCenter();
}

/**
 * @param {number} delta
 */
function wrapAngle(delta) {
  const turn = Math.PI * 2;
  let wrapped = delta % turn;
  if (wrapped > Math.PI) wrapped -= turn;
  if (wrapped < -Math.PI) wrapped += turn;
  return wrapped;
}

function syncSceneBackground() {
  if (!scene) return;
  scratchBg.setHex(SCENE_BG);
  scene.background.copy(scratchBg);
  renderer?.setClearColor(scratchBg, 1);
}

/** Yaw only. Ignores the ground offset so the full-grid fit test stays stable. */
function surfaceYawXZ(lx, lz) {
  const sy = surface ? surface.rotation.y : 0;
  const c = Math.cos(sy);
  const s = Math.sin(sy);
  return { x: c * lx + s * lz, z: -s * lx + c * lz };
}

/**
 * World XZ → surface-local XZ.
 * Inverse of position + Y rotation: world = position + R · local.
 */
function worldToSurfaceXZ(wx, wz) {
  const px = surface ? surface.position.x : 0;
  const pz = surface ? surface.position.z : 0;
  const sy = surface ? surface.rotation.y : 0;
  const c = Math.cos(sy);
  const s = Math.sin(sy);
  const dx = wx - px;
  const dz = wz - pz;
  return { x: c * dx - s * dz, z: s * dx + c * dz };
}

/** Surface-local XZ → world XZ, including the ground offset. */
function surfaceToWorldXZ(lx, lz) {
  const yawed = surfaceYawXZ(lx, lz);
  return {
    x: yawed.x + (surface ? surface.position.x : 0),
    z: yawed.z + (surface ? surface.position.z : 0),
  };
}

/**
 * Resolve world aim → playfield cell. Emitter stays in world space; the
 * rotating surface only affects which grid cell sits under it.
 */
function setAimFromWorld() {
  const limit = PLAYFIELD_HALF - 0.001;
  let { x: lx, z: lz } = worldToSurfaceXZ(aimWorldX, aimWorldZ);
  lx = Math.min(limit, Math.max(-limit, lx));
  lz = Math.min(limit, Math.max(-limit, lz));
  let ix = Math.floor((lx + PLAYFIELD_HALF) / atomSize);
  let iz = Math.floor((lz + PLAYFIELD_HALF) / atomSize);
  ix = Math.min(gridXZ - 1, Math.max(0, ix));
  iz = Math.min(gridXZ - 1, Math.max(0, iz));
  aim = { ix, iz };
}

/**
 * True when every playfield corner is inside the viewport.
 * Uses the ground offset, so a panned plane does not count as fitting.
 */
function playfieldFitsView() {
  if (!camera || !surface) return true;
  camera.updateMatrixWorld(true);
  const half = PLAYFIELD_HALF;
  const corners = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  for (let i = 0; i < corners.length; i += 1) {
    const world = surfaceToWorldXZ(corners[i][0], corners[i][1]);
    emitterNdc.set(world.x, 0, world.z);
    emitterNdc.project(camera);
    if (
      emitterNdc.z > 1 ||
      Math.abs(emitterNdc.x) > 0.98 ||
      Math.abs(emitterNdc.y) > 0.98
    ) {
      return false;
    }
  }
  return true;
}

/**
 * If the ground target is outside the view, move it and the plane together
 * until the target sits on the view edge. The cell under the emitter stays put.
 * A fully framed playfield is left alone so the emitter can still sit on any cell.
 */
function pullEmitterIntoView() {
  if (!camera || !surface || playfieldFitsView()) return;
  const ndc = projectTarget();
  if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)) return;
  const behind = ndc.z > 1;
  const nx = behind ? 0 : Math.min(AIM_VIEW_LIMIT, Math.max(-AIM_VIEW_LIMIT, ndc.x));
  const ny = behind ? 0 : Math.min(AIM_VIEW_LIMIT, Math.max(-AIM_VIEW_LIMIT, ndc.y));
  if (!behind && nx === ndc.x && ny === ndc.y) return;
  const hit = worldOnPlane(nx, ny, 0);
  if (!hit) return;
  glideCouple(hit.x - aimWorldX, hit.z - aimWorldZ);
}

/**
 * Move the emitter across the plane above the grid.
 * +lx = right on screen, +ly = up on screen.
 * Inside the view the plane stays put. Past the edge of the view, the leftover
 * motion scrolls the plane so the rest of the surface can come under the emitter.
 */
function moveAim(lx, ly, dt) {
  if (dt <= 0 || (!lx && !ly)) return;
  const camSin = Math.sin(CAMERA_YAW);
  const camCos = Math.cos(CAMERA_YAW);
  const step = AIM_SPEED * dt;
  const dx = (camCos * lx - camSin * ly) * step;
  const dz = (-camSin * lx - camCos * ly) * step;
  placeEmitterAtWorld(aimWorldX + dx, aimWorldZ + dz);
  pullEmitterIntoView();
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

  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  setCameraDist(cameraDist);
  return true;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Eased trigger amount 0…1. Zero is the thin-stream end; one is the wide field.
 * RT uses the curve as-is. LT passes invert so a hard pull is the thin stream.
 */
function triggerAmount(amount, invert) {
  const threshold = inputBindings.gamepad.emitAnalogThreshold ?? 0.08;
  const span = 1 - threshold;
  const linear = span > 0 ? clamp01((clamp01(amount) - threshold) / span) : 1;
  const t = Math.pow(linear, BRUSH_RT_GAMMA);
  return invert ? 1 - t : t;
}

/**
 * Map analog 0…1 → odd brush edge 1…BRUSH_MAX.
 */
function brushSizeFromTrigger(amount, invert) {
  const t = triggerAmount(amount, invert);
  const steps = ((BRUSH_MAX - 1) >> 1) + 1;
  const i = Math.min(steps - 1, Math.floor(t * steps));
  return 1 + i * 2;
}

/**
 * Map the same curve onto atom scale. The thin-stream end is ATOM_SCALE_MIN;
 * the wide end is full size. Never goes below the minimum.
 */
function emitScaleFromTrigger(amount, invert) {
  const t = triggerAmount(amount, invert);
  return ATOM_SCALE_MIN + t * (1 - ATOM_SCALE_MIN);
}

function brushSizeFromMode(mode, analog, invert) {
  if (mode === "single") return 1;
  if (mode === "max") return BRUSH_MAX;
  return brushSizeFromTrigger(analog, invert);
}

function emitScaleFromMode(mode, analog, invert) {
  if (mode === "max") return 1;
  if (mode === "single") return ATOM_SCALE_MIN;
  return emitScaleFromTrigger(analog, invert);
}

/** Coarse enough that analog noise does not keep resetting the settle wait. */
function quantSizeKey(brush, scale) {
  return brush * 1000 + Math.round(scale * 40);
}

/**
 * Apply the emitter footprint immediately. Returns true once that size has
 * held still long enough to pour.
 */
function emitterSizeSettled(dt, brush, scale) {
  setBrushN(brush);
  setEmitScale(scale);
  const key = quantSizeKey(brushN, emitScale);
  if (key !== emitSizeKey) {
    emitSizeKey = key;
    emitSizeHold = 0;
    return false;
  }
  emitSizeHold += dt;
  return emitSizeHold >= EMIT_SIZE_SETTLE;
}

function setBrushN(n) {
  const odd = Math.max(1, Math.min(BRUSH_MAX, n | 0));
  const next = odd % 2 === 0 ? odd - 1 : odd;
  if (next === brushN) return;
  brushN = next;
  rebuildEmitterGeometry();
}

function setEmitScale(scale) {
  const next = Math.min(1, Math.max(ATOM_SCALE_MIN, scale));
  if (Math.abs(next - emitScale) < 1e-4) return;
  emitScale = next;
  rebuildEmitterGeometry();
}

function emitterBoxSize() {
  // Footprint matches the packed stream: N atoms of the current emit size, no gaps.
  const edge = atomSize * emitScale;
  return {
    x: brushN * edge,
    y: edge * 0.35,
    z: brushN * edge,
  };
}

function rebuildEmitterGeometry() {
  if (!emitterFill || !emitterEdge || !emitterMark) return;
  const size = emitterBoxSize();
  emitterFill.geometry.dispose();
  emitterFill.geometry = new THREE.PlaneGeometry(size.x, size.z);

  const hx = size.x / 2;
  const hz = size.z / 2;
  const y = 0.012;
  emitterEdge.geometry.dispose();
  const edge = new THREE.BufferGeometry();
  edge.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        -hx, y, -hz, hx, y, -hz,
        hx, y, -hz, hx, y, hz,
        hx, y, hz, -hx, y, hz,
        -hx, y, hz, -hx, y, -hz,
      ],
      3,
    ),
  );
  emitterEdge.geometry = edge;

  const arm = Math.min(0.15, Math.min(size.x, size.z) * 0.36);
  const my = y + 0.008;
  emitterMark.geometry.dispose();
  const mark = new THREE.BufferGeometry();
  mark.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [-arm, my, 0, arm, my, 0, 0, my, -arm, 0, my, arm],
      3,
    ),
  );
  emitterMark.geometry = mark;
}

function syncEmitterStem() {
  if (!emitterStem) return;
  const down = Math.max(0.15, emitWorldY() - 0.02);
  const up = 0.28;
  const pos = emitterStem.geometry.attributes.position;
  pos.setXYZ(0, 0, up, 0);
  pos.setXYZ(1, 0, -down, 0);
  pos.needsUpdate = true;
}

function syncEmitter() {
  if (!emitter) return;
  const draw = emitterDrawXZ();
  emitter.position.set(draw.x, emitWorldY(), draw.z);
  // Footprint follows the grid yaw so the plane covers the cells pourBrush fills.
  emitter.rotation.y = surface ? surface.rotation.y : 0;
  if (emitterFill) emitterFill.material.opacity = emitting ? 0.14 : 0.08;
  if (emitterEdge) emitterEdge.material.opacity = emitting ? 0.95 : 0.78;
  syncEmitterStem();
  emitter.visible = true;
}

function materialColor(matIndex) {
  const id = catalog?.idByIndex[matIndex];
  const def = id ? catalog.byId.get(id) : null;
  return def?.color || "#cccccc";
}

function materialMeshMat(matIndex, receiveTarget = true, fade = false) {
  const key = fade ? `fade:${matIndex}` : receiveTarget ? matIndex : -matIndex - 1;
  let mat = matCache.get(key);
  if (mat) return mat;
  const id = catalog?.idByIndex[matIndex];
  const def = id ? catalog.byId.get(id) : null;
  const opacity = def?.opacity ?? 1;
  const transparent = fade || opacity < 1;
  mat = new THREE.MeshPhongMaterial({
    color: new THREE.Color(materialColor(matIndex)),
    specular: 0x222222,
    shininess: 18,
    transparent,
    opacity,
    depthWrite: !transparent,
  });
  if (fade) mat.onBeforeCompile = compileRiseFade;
  else if (receiveTarget) attachLandingTarget(mat);
  matCache.set(key, mat);
  return mat;
}

function isPlayStationPad(pad) {
  return /dualsense|dualshock|wireless controller|playstation/i.test(pad?.id || "");
}

function connectedPad() {
  const pads = navigator.getGamepads?.();
  if (!pads) return null;
  let fallback = null;
  for (let i = 0; i < pads.length; i += 1) {
    const pad = pads[i];
    if (!pad) continue;
    if (isPlayStationPad(pad)) return pad;
    if (!fallback) fallback = pad;
  }
  return fallback;
}

/** PlayStation glyphs only while that pad is the device being used. */
function syncControllerGlyphs() {
  document.body.classList.toggle("has-dualsense", fallingInput.showPadGlyphs);
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
  const mat = catalog?.byId.get(activeMaterialId);
  const emitBtn = document.querySelector("[data-falling-touch-emit]");
  if (emitBtn && mat?.color) emitBtn.style.setProperty("--emit-fill", mat.color);
  if (!paletteEl) return;
  let label = "";
  for (const btn of paletteEl.querySelectorAll("[data-material]")) {
    const on = btn.getAttribute("data-material") === activeMaterialId;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    if (on) label = btn.getAttribute("aria-label") || "";
  }
  const nameEl = document.querySelector("[data-falling-material-name]");
  if (nameEl) nameEl.textContent = label;
}

function syncShoulderGlyphs(prevHeld, nextHeld) {
  const prev = document.querySelector("[data-falling-shoulder='prev']");
  const next = document.querySelector("[data-falling-shoulder='next']");
  prev?.classList.toggle("is-lit", !!prevHeld);
  next?.classList.toggle("is-lit", !!nextHeld);
}

function syncTriggerLabels(ltHeld, rtHeld) {
  const lt = document.querySelector("[data-falling-trigger='lt']");
  const rt = document.querySelector("[data-falling-trigger='rt']");
  lt?.classList.toggle("is-pressed", !!ltHeld);
  rt?.classList.toggle("is-pressed", !!rtHeld);
}

function syncClearLabel(held) {
  document.querySelector("[data-falling-clear]")?.classList.toggle("is-pressed", !!held);
}


/** Line icons. Color is applied only on the selected glyph, via currentColor. */
const MATERIAL_GLYPHS = {
  block:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2 20.2 7.6 12 12 3.8 7.6Z M3.8 7.6V16.4L12 20.8V12 M20.2 7.6V16.4L12 20.8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>',
  sand:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="13.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="13.5" y="13.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="8.5" y="4.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  diffuse:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="1.15" fill="currentColor"/><circle cx="15.5" cy="6.5" r="1.15" fill="currentColor"/><circle cx="12" cy="12" r="1.15" fill="currentColor"/><circle cx="7" cy="16" r="1.15" fill="currentColor"/><circle cx="16.5" cy="15.5" r="1.15" fill="currentColor"/></svg>',
  erode:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5V11 M12 15.5C8.2 14.4 6 10.6 8 7.2 M12 14.2C15.8 12.6 18.2 8.6 15.4 5.2 M12 12.4C11 8.8 13.2 6.2 12 3.8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
};

function materialGlyph(id) {
  return MATERIAL_GLYPHS[id] || MATERIAL_GLYPHS.block;
}

function materialSwatchFrom(target) {
  if (!(target instanceof Element)) return null;
  const swatch = target.closest("[data-falling-palette] .falling-material-swatch");
  if (!(swatch instanceof HTMLElement)) return null;
  return swatch;
}

function buildPalette() {
  paletteEl = document.querySelector("[data-falling-palette]");
  if (!paletteEl || !catalog) return;
  if (paletteEl.dataset.bound !== "1") {
    paletteEl.dataset.bound = "1";
    // A touch click can land on the previously selected swatch after iOS
    // retargets it. Swallow those clicks; the press already chose the material.
    let swallowClicksUntil = 0;
    paletteEl.addEventListener("touchstart", (event) => {
      const btn = materialSwatchFrom(event.target);
      if (!btn) return;
      swallowClicksUntil = performance.now() + 800;
      setActiveMaterial(btn.dataset.material);
    }, { passive: false });
    paletteEl.addEventListener("pointerdown", (event) => {
      const btn = materialSwatchFrom(event.target);
      if (!btn) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.stopPropagation();
      if (event.pointerType === "touch") swallowClicksUntil = performance.now() + 800;
      setActiveMaterial(btn.dataset.material);
    });
    paletteEl.addEventListener("click", (event) => {
      const btn = materialSwatchFrom(event.target);
      if (!btn) return;
      event.stopPropagation();
      if (performance.now() < swallowClicksUntil) {
        event.preventDefault();
        return;
      }
      setActiveMaterial(btn.dataset.material);
    });
    paletteEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const btn = materialSwatchFrom(event.target);
      if (!btn) return;
      event.preventDefault();
      setActiveMaterial(btn.dataset.material);
    });
  }
  paletteEl.replaceChildren();
  for (const mat of catalog.list) {
    const btn = document.createElement("div");
    btn.dataset.material = mat.id;
    btn.className = "falling-material-swatch";
    btn.setAttribute("role", "button");
    btn.tabIndex = 0;
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("aria-label", mat.label);
    btn.title = mat.label;
    btn.style.setProperty("--swatch", mat.color);
    const glyph = document.createElement("span");
    glyph.className = "falling-material-glyph";
    glyph.innerHTML = materialGlyph(mat.id);
    btn.append(glyph);
    paletteEl.appendChild(btn);
  }
  for (const line of document.querySelectorAll(".falling-about-materials [data-material]")) {
    const mat = catalog.byId.get(line.getAttribute("data-material"));
    if (mat) line.style.setProperty("--swatch", mat.color);
  }
  syncPaletteUi();
  bindClearUi();
}

/** Wipe all atoms, splashes, and surface transform. */
export function clearBoard() {
  if (cells) cells.fill(0);
  if (budgets) budgets.fill(0);
  for (const clocks of effectClocks) clocks.fill(0);
  if (infection) infection.fill(0);
  if (infectionAge) infectionAge.fill(0);
  if (holeShrink) holeShrink.fill(0);
  if (shrinkFlags) shrinkFlags.fill(0);
  if (shrinkT) shrinkT.fill(0);
  if (riseT) riseT.fill(0);
  if (riseElapsed) riseElapsed.fill(0);
  if (restingFlags) restingFlags.fill(0);
  if (onFloorFlags) onFloorFlags.fill(0);
  if (sameAboveFlags) sameAboveFlags.fill(0);
  if (aboveFlags) aboveFlags.fill(0);
  if (blockAboveFlags) blockAboveFlags.fill(0);
  if (posY) posY.fill(0);
  if (posX) posX.fill(0);
  if (posZ) posZ.fill(0);
  if (emitSizes) emitSizes.fill(0);
  if (lifeSpans) lifeSpans.fill(0);
  resetEmitLife();
  if (shuffleCounts) shuffleCounts.fill(0);
  if (shuffleOriginX) shuffleOriginX.fill(0);
  if (shuffleOriginZ) shuffleOriginZ.fill(0);
  if (flowDx) flowDx.fill(0);
  if (flowDz) flowDz.fill(0);
  occupied.clear();
  audioSplash = 0;
  audioSplashAt.length = 0;
  audioEngine.clearFieldActivity();

  for (const splash of splashes) {
    surface?.remove(splash.mesh);
    splash.mesh.material.dispose();
  }
  splashes = [];

  for (const mesh of instances.values()) {
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
  }
  for (const mesh of fallingInstances.values()) {
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
  }
  for (const mesh of risingInstances.values()) {
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  if (surface) {
    surface.position.set(0, 0, 0);
    surface.rotation.set(0, 0, 0);
  }

  aimWorldX = 0;
  aimWorldZ = 0;
  stickAimPointer = null;
  syncCamera();
  holdTargetAtCenter();
  emitting = false;
  emitAcc = 0;
  setAimFromWorld();
  syncEmitter();
  syncSceneBackground();
  reconcileMeshes();
}

/**
 * The playfield calls preventDefault on touchstart, so a tap never becomes a click.
 * Act on the press. A mouse still emits click afterward; ignore that one.
 * Keyboard activation has no preceding press, so the click still runs.
 * @param {HTMLElement} el
 * @param {(event: Event) => void} onPress
 */
export function onFieldPress(el, onPress) {
  let swallowClicksUntil = 0;
  el.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.stopPropagation();
    swallowClicksUntil = performance.now() + 800;
    onPress(event);
  });
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    if (performance.now() < swallowClicksUntil) {
      event.preventDefault();
      return;
    }
    onPress(event);
  });
}

function bindFpsUi() {
  const btn = document.querySelector("[data-falling-fps-toggle]");
  if (!(btn instanceof HTMLButtonElement) || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  const setOpen = (open) => {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  onFieldPress(btn, () => {
    setOpen(btn.getAttribute("aria-expanded") !== "true");
  });
}

function bindSettingsUi() {
  const btn = document.querySelector("[data-falling-settings]");
  const panel = document.querySelector("[data-falling-settings-panel]");
  if (!(btn instanceof HTMLButtonElement) || !(panel instanceof HTMLElement)) return;
  if (btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  const setOpen = (open) => {
    panel.toggleAttribute("hidden", !open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  onFieldPress(btn, () => {
    setOpen(panel.hasAttribute("hidden"));
  });
  document.addEventListener("pointerdown", (event) => {
    if (panel.hasAttribute("hidden")) return;
    const target = event.target;
    if (target instanceof Node && (panel.contains(target) || btn.contains(target))) return;
    setOpen(false);
    if (document.activeElement === btn) btn.blur();
  });
}

function bindAboutUi() {
  const btn = document.querySelector("[data-falling-about]");
  const dialog = document.querySelector("[data-falling-about-dialog]");
  if (!(btn instanceof HTMLButtonElement) || !(dialog instanceof HTMLDialogElement)) return;
  if (btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  const selectNav = bindAboutNav(dialog);
  onFieldPress(btn, () => {
    if (dialog.open) return;
    selectNav(aboutNavPanelId(fallingInput.navMode));
    dialog.showModal();
    dialog.focus({ preventScroll: true });
  });
  const closeBtn = dialog.querySelector(".falling-about-close");
  if (closeBtn instanceof HTMLButtonElement) {
    onFieldPress(closeBtn, () => {
      if (dialog.open) dialog.close();
    });
  }
  dialog.addEventListener("pointerdown", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

/** @param {"mouse" | "touch" | "pad"} mode */
function aboutNavPanelId(mode) {
  if (mode === "touch") return "falling-nav-touch";
  if (mode === "pad") return "falling-nav-pad";
  return "falling-nav-mouse";
}

/** @type {(id: string) => void} */
let selectAboutNav = () => {};

/** @param {HTMLDialogElement} dialog @returns {(id: string) => void} */
function bindAboutNav(dialog) {
  const root = dialog.querySelector("[data-falling-nav]");
  if (!(root instanceof HTMLElement)) return selectAboutNav;
  if (root.dataset.bound === "1") return selectAboutNav;
  root.dataset.bound = "1";
  const tabs = [...root.querySelectorAll("[role='tab']")];
  const panels = [...root.querySelectorAll("[role='tabpanel']")];
  const select = (id) => {
    for (const tab of tabs) {
      const on = tab.getAttribute("aria-controls") === id;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
    }
    for (const panel of panels) {
      if (!(panel instanceof HTMLElement)) continue;
      panel.toggleAttribute("hidden", panel.id !== id);
    }
  };
  selectAboutNav = select;
  for (const tab of tabs) {
    if (!(tab instanceof HTMLButtonElement)) continue;
    tab.addEventListener("click", () => {
      const id = tab.getAttribute("aria-controls");
      if (id) select(id);
    });
  }
  return select;
}

function bindClearUi() {
  const btn = document.querySelector("[data-falling-clear]");
  if (!(btn instanceof HTMLButtonElement) || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  onFieldPress(btn, () => {
    clearBoard();
  });
}

/** @type {(() => void) | null} */
let audioToggleHandler = null;

/** Square toggles field audio. The handler lives with the audio engine. */
export function onFallingAudioToggle(fn) {
  audioToggleHandler = fn;
}

/**
 * Spawn row for this emitter height. Counted in shortest-atom steps so a
 * column of small blocks has a slot for every step up to the plane.
 */
function emitY() {
  const row = Math.round(emitHeightU / ATOM_MIN_EXTENT - 0.5);
  return Math.min(MAX_Y - 1, Math.max(0, row));
}

/** Drawn height of the atom the brush is about to drop. */
function pourAtomExtent() {
  return emitScale < 1 - 1e-4 ? atomSize * emitScale : atomSize;
}

/** Top of the flush stack already in this column, world units. */
function columnPackedTop(x, z) {
  let top = 0;
  for (let y = 0; y < MAX_Y; y += 1) {
    const mat = getCell(x, y, z);
    if (mat <= 0) continue;
    top += atomExtent(x, y, z, mat);
  }
  return top;
}

function emitWorldY() {
  return emitHeightU;
}

function applyInput(dt) {
  if (!camera || dt <= 0) return;

  const frame = fallingInput.sample(dt, controller, connectedPad());

  const stickAim = !!(frame.aimStickX || frame.aimStickY);
  const dragging = !!frame.pointerDelta;
  const twisting = !!frame.touchTwist;
  const aim = frame.aimAt;

  if (stickAim) {
    stickAimPointer = aim ? { x: aim.x, y: aim.y } : stickAimPointer;
  } else if (
    stickAimPointer &&
    aim &&
    (aim.x !== stickAimPointer.x || aim.y !== stickAimPointer.y)
  ) {
    stickAimPointer = null;
  }
  if (dragging || twisting) stickAimPointer = null;

  // A bare move places the emitter on the emit-height plane. Right-drag slides the grid.
  // One finger pans the field under the screen-center emitter. Two fingers yaw
  // about that point. Stick and D-pad move the emitter and are not snapped back
  // to a resting cursor, and a screen finger does not pull a stick aim to center.
  const stickHoldsAim = stickAim || !!stickAimPointer;
  if (aim && !dragging && !twisting && !stickHoldsAim) {
    placeEmitterAtPointer(aim, frame.fingerAim ? FINGER_ABOVE_PLANE_PX : 0);
  }
  if (dragging && !twisting) slidePointer(frame.pointerDelta.x, frame.pointerDelta.y, frame.pointerAt);
  if (!stickHoldsAim && frame.touchPan) panBedUnderEmitter(frame.touchPan);
  if (twisting && !stickHoldsAim) twistGround(frame.touchTwist);
  if (stickAim) moveAim(frame.aimStickX, frame.aimStickY, dt);
  if (frame.orbitDelta) rotateSurface(frame.orbitDelta);
  if (frame.zoomFactor !== 1) zoomCamera(frame.zoomFactor);
  if (!stickHoldsAim && frame.touchZoom !== 1) pinEmitterAtScreenCenter();

  setAimFromWorld();
  syncEmitter();

  // Shift and LT preview a single stream. RT resizes with pressure.
  // Atoms wait until that footprint stops changing.
  shiftStream = !!frame.shiftHeld;
  let brush = BRUSH_MAX;
  let scale = 1;
  if (frame.shiftHeld || frame.ltSingle) {
    brush = 1;
    scale = ATOM_SCALE_MIN;
  } else if (frame.rtHeld) {
    brush = brushSizeFromTrigger(frame.analog, false);
    scale = emitScaleFromTrigger(frame.analog, false);
  } else if (frame.emit) {
    brush = brushSizeFromMode(frame.brushMode, frame.analog, frame.curveInvert);
    scale = emitScaleFromMode(frame.brushMode, frame.analog, frame.curveInvert);
  } else if (frame.emitSizing) {
    brush = brushSizeFromTrigger(frame.analog, false);
    scale = emitScaleFromTrigger(frame.analog, false);
  }
  const settled = emitterSizeSettled(dt, brush, scale);
  // A pressed Emit button keeps pouring. Navigation must not pause it, and
  // neither does the footprint-settle wait that gates a trigger sweep.
  updateEmitStream(dt, frame.emit && (settled || frame.touchPour));

  syncShoulderGlyphs(frame.cyclePrevHeld, frame.cycleNextHeld);
  syncTriggerLabels(frame.ltHeld, frame.rtHeld);
  syncClearLabel(frame.clearHeld);
  if (frame.cycleDelta) cycleMaterial(frame.cycleDelta);
  if (frame.clearEdge) clearBoard();
  if (frame.audioEdge) audioToggleHandler?.();
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
 * Brush edge and atom size follow RT. A light RT pull emits half-size atoms
 * in a single stream; a full RT pull emits full-size atoms across the wide
 * field. LT emits that same single stream at any pull. Left click always
 * uses the largest emitter. Shift+left click always uses the smallest.
 * Shift+right-drag and Alt+right-drag yaw the view.
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
      // The plane is the ceiling. Full-pitch slots used to fill first, so a
      // half-size stream stopped at about half the emitter height.
      if (columnPackedTop(x, z) + pourAtomExtent() > emitHeightU + 1e-3) continue;
      setCell(x, y, z, matIndex);
      if (posY) posY[idx(x, y, z)] = emitWorldY();
      if (emitScale < 1 - 1e-4) setCellEmitSize(x, y, z, atomSize * emitScale);
      if (materialSonifies(matIndex)) {
        const life = sampleEmitLife();
        setLife(x, y, z, life);
      }
      placed += 1;
    }
  }

  if (placed && materialSonifies(matIndex)) {
    audioPour += placed;
    reconcileMeshes();
  } else if (placed) {
    reconcileMeshes();
  }
}

/** Ground-plane ripple. Sits just above the floor mesh for every settled arrival. */
const SPLASH_PLANE_Y = 0.02;

/**
 * World XZ where a landing ring belongs.
 * A cleared cell stores position 0, and 0,0 is the center of the ground, so an
 * empty cell uses its grid center instead of that cleared origin.
 */
function splashAnchor(x, y, z) {
  const i = idx(x, y, z);
  const pitch = cellAtomSize(i);
  const centerX = worldXForCell(x, pitch);
  const centerZ = worldZForCell(z, pitch);
  if (getCell(x, y, z) <= 0 || !posX || !posZ) return { wx: centerX, wz: centerZ };
  const px = posX[i];
  const pz = posZ[i];
  if (!Number.isFinite(px) || !Number.isFinite(pz)) return { wx: centerX, wz: centerZ };
  return { wx: px, wz: pz };
}

function spawnSplash(x, z, wx, wz) {
  if (!surface || !splashGeo) return;
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(splashGeo, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(wx, SPLASH_PLANE_Y, wz);
  const sz = cellAtomSize(idx(x, 0, z));
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
    list.push({ x, y, z, mat, i });
  }
  return list;
}

function markXform(i) {
  if (xformStamp) xformStamp[i] = xformGen;
}

function bumpXformGen() {
  xformGen = (xformGen + 1) >>> 0;
  if (xformGen === 0) {
    xformStamp?.fill(0);
    xformGen = 1;
  }
}

/** Group occupied cells by column and sort each column bottom-to-top once. */
function buildColumns() {
  columnKeys.length = 0;
  for (const list of columns.values()) list.length = 0;
  if (!cells || occupied.size === 0) return;
  for (const i of occupied) {
    if (cells[i] <= 0) {
      occupied.delete(i);
      continue;
    }
    const x = i % GRID_MAX;
    const rest = (i / GRID_MAX) | 0;
    const z = rest % GRID_MAX;
    const key = z * GRID_MAX + x;
    let list = columns.get(key);
    if (!list) {
      list = [];
      columns.set(key, list);
    }
    if (list.length === 0) columnKeys.push(key);
    list.push(i);
  }
  for (let k = 0; k < columnKeys.length; k += 1) {
    const list = columns.get(columnKeys[k]);
    list.sort((a, b) => (posY[a] || 0) - (posY[b] || 0) || a - b);
  }
}

function riseGeometry(capacity, previous) {
  const geo = blockGeo.clone();
  const data = new Float32Array(capacity);
  data.fill(1);
  const src = previous?.geometry?.getAttribute?.("instanceOpacity");
  if (src?.array) data.set(src.array.subarray(0, Math.min(src.array.length, data.length)));
  const opacity = new THREE.InstancedBufferAttribute(data, 1);
  opacity.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("instanceOpacity", opacity);
  return geo;
}

function ensureKind(matIndex, count, kind) {
  const map = kind === "rise" ? risingInstances : kind === "fall" ? fallingInstances : instances;
  let mesh = map.get(matIndex);
  const capacity = mesh ? mesh.instanceMatrix.count : 0;
  if (!mesh || capacity < count) {
    const nextCap = Math.max(count, capacity * 2 || 4096);
    const geometry = kind === "rise" ? riseGeometry(nextCap, mesh) : blockGeo;
    const next = new THREE.InstancedMesh(geometry, materialMeshMat(matIndex, kind === "land", kind === "rise"), nextCap);
    next.frustumCulled = false;
    next.castShadow = true;
    next.receiveShadow = true;
    if (kind === "rise") next.renderOrder = 2;
    if (mesh) {
      const keep = mesh.count;
      for (let s = 0; s < keep; s += 1) {
        mesh.getMatrixAt(s, scratchMat4);
        next.setMatrixAt(s, scratchMat4);
      }
      next.count = keep;
      next.instanceMatrix.needsUpdate = true;
      if (mesh.geometry !== blockGeo) mesh.geometry.dispose();
      surface?.remove(mesh);
    } else {
      next.count = 0;
    }
    surface.add(next);
    map.set(matIndex, next);
    mesh = next;
  }
  return mesh;
}

function ensureInstanced(matIndex, count, receiveTarget) {
  return ensureKind(matIndex, count, receiveTarget ? "land" : "fall");
}

function cellOpacity(x, y, z) {
  const t = getRiseT(x, y, z);
  return t > 0 ? Math.max(0, 1 - t) : 1;
}

function paintInstances(mesh, coords, matIndex) {
  const n = (coords.length / 3) | 0;
  const opacity = mesh.geometry.getAttribute("instanceOpacity");
  for (let k = 0; k < n; k += 1) {
    const o = k * 3;
    const x = coords[o];
    const y = coords[o + 1];
    const z = coords[o + 2];
    const scale = cellScale(x, y, z, matIndex) * cellAtomSize(idx(x, y, z)) * riseDrawScale(x, y, z);
    cellWorld(x, y, z, scratchPos, scale);
    scratchScale.set(scale, scale, scale);
    scratchMat4.compose(scratchPos, scratchQuat, scratchScale);
    mesh.setMatrixAt(k, scratchMat4);
    if (opacity) opacity.setX(k, cellOpacity(x, y, z));
  }
  if (opacity) opacity.needsUpdate = true;
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
}

function fillKind(matIndex, coords, kind) {
  const map = kind === "rise" ? risingInstances : fallingInstances;
  const n = (coords.length / 3) | 0;
  if (n <= 0) {
    const mesh = map.get(matIndex);
    if (mesh) {
      mesh.count = 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
    return;
  }
  const mesh = ensureKind(matIndex, n, kind);
  paintInstances(mesh, coords, matIndex);
}

function fillInstanced(matIndex, coords, receiveTarget) {
  fillKind(matIndex, coords, receiveTarget ? "land" : "fall");
}

function resetLandedTracking() {
  wasScaled.clear();
  for (const order of landedOrder.values()) {
    if (landedSlot) {
      for (const i of order) {
        landedSlot[i] = -1;
        if (landedMatOf) landedMatOf[i] = 0;
      }
    }
    order.length = 0;
  }
}

function writeInstance(mesh, slot, i, mat) {
  const { x, y, z } = decodeCell(i);
  const scale = cellScale(x, y, z, mat) * cellAtomSize(i);
  cellWorld(x, y, z, scratchPos, scale);
  scratchScale.set(scale, scale, scale);
  scratchMat4.compose(scratchPos, scratchQuat, scratchScale);
  mesh.setMatrixAt(slot, scratchMat4);
}

function landedOrderFor(mat) {
  let order = landedOrder.get(mat);
  if (!order) {
    order = [];
    landedOrder.set(mat, order);
  }
  return order;
}

function addLanded(i, mat) {
  const order = landedOrderFor(mat);
  const slot = order.length;
  order.push(i);
  landedSlot[i] = slot;
  landedMatOf[i] = mat;
  const mesh = ensureInstanced(mat, slot + 1, true);
  writeInstance(mesh, slot, i, mat);
  mesh.count = order.length;
  mesh.instanceMatrix.needsUpdate = true;
}

function removeLanded(i) {
  if (!landedSlot || !landedMatOf || landedSlot[i] < 0) return;
  const mat = landedMatOf[i];
  const order = landedOrder.get(mat);
  const slot = landedSlot[i];
  if (!order || slot >= order.length || order[slot] !== i) {
    landedSlot[i] = -1;
    landedMatOf[i] = 0;
    return;
  }
  const mesh = instances.get(mat);
  const last = order.length - 1;
  if (slot !== last) {
    const moved = order[last];
    order[slot] = moved;
    landedSlot[moved] = slot;
    if (mesh) writeInstance(mesh, slot, moved, mat);
  }
  order.pop();
  landedSlot[i] = -1;
  landedMatOf[i] = 0;
  if (mesh) {
    mesh.count = order.length;
    mesh.instanceMatrix.needsUpdate = true;
  }
}

function refreshLanded(i, mat) {
  const slot = landedSlot[i];
  if (slot < 0) return;
  const mesh = instances.get(mat);
  if (!mesh) return;
  writeInstance(mesh, slot, i, mat);
  mesh.instanceMatrix.needsUpdate = true;
}

function fallingBucket(mat) {
  let coords = fallingBuckets.get(mat);
  if (!coords) {
    coords = [];
    fallingBuckets.set(mat, coords);
  }
  return coords;
}

function writeFallingMeshes() {
  /** @type {Set<number>} */
  const used = new Set();
  for (const [mat, coords] of fallingBuckets) {
    if (coords.length === 0) continue;
    used.add(mat);
    fillInstanced(mat, coords, false);
  }
  for (const [mat, mesh] of fallingInstances) {
    if (used.has(mat) || mesh.count === 0) continue;
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
  }
}

function risingBucket(mat) {
  let coords = risingBuckets.get(mat);
  if (!coords) {
    coords = [];
    risingBuckets.set(mat, coords);
  }
  return coords;
}

function writeRisingMeshes() {
  /** @type {Set<number>} */
  const used = new Set();
  for (const [mat, coords] of risingBuckets) {
    if (coords.length === 0) continue;
    used.add(mat);
    fillKind(mat, coords, "rise");
  }
  for (const [mat, mesh] of risingInstances) {
    if (used.has(mat) || mesh.count === 0) continue;
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Upload falling atoms every call. Landed slots change only when a cell
 * lands, leaves, or its transform/scale was marked this frame.
 * @param {boolean} resize
 */
function writeMeshesFromColumns(resize) {
  if (!surface || !blockGeo || !landedSlot || !classStamp || !landedMatOf) return;

  if (resize) {
    for (const i of wasScaled) markXform(i);
    wasScaled.clear();
    for (const i of occupied) {
      if (shrinkFlags?.[i] === 1) {
        markXform(i);
        wasScaled.add(i);
      }
    }
  }

  classGen = (classGen + 1) >>> 0;
  if (classGen === 0) {
    classStamp.fill(0);
    classGen = 1;
  }

  for (const coords of fallingBuckets.values()) coords.length = 0;
  for (const coords of risingBuckets.values()) coords.length = 0;

  for (let k = 0; k < columnKeys.length; k += 1) {
    const list = columns.get(columnKeys[k]);
    let floorTop = 0;
    for (let n = 0; n < list.length; n += 1) {
      const i = list[n];
      if (cells[i] <= 0) continue;
      const mat = cells[i];
      const { x, y, z } = decodeCell(i);
      const size = atomExtent(x, y, z, mat);
      const restCenter = floorTop + size * 0.5;
      const yCenter = posY[i] > 0 ? posY[i] : restCenter;
      const landed = yCenter <= restCenter + 1e-3;
      floorTop += size;
      if (catalog?.idByIndex[mat] === "block-exp") continue;
      if ((riseT?.[i] || 0) > 0) {
        fallingBucket(mat).push(x, y, z);
      } else if (landed) {
        classStamp[i] = classGen;
        if (landedSlot[i] >= 0 && landedMatOf[i] !== mat) removeLanded(i);
        if (landedSlot[i] < 0) addLanded(i, mat);
        else if (xformStamp?.[i] === xformGen) refreshLanded(i, mat);
      } else {
        fallingBucket(mat).push(x, y, z);
      }
    }
  }

  for (const order of landedOrder.values()) {
    for (let s = 0; s < order.length; ) {
      const i = order[s];
      if (classStamp[i] === classGen) {
        s += 1;
        continue;
      }
      removeLanded(i);
    }
  }

  writeFallingMeshes();
  writeRisingMeshes();
  syncBlockExpSurface();
  syncEmitter();
}

function syncBlockExpSurface() {
  if (!surface) return;
  if (!blockExpSurface) blockExpSurface = createBlockExpSurface();
  const mat = catalog?.indexById.get("block-exp") || 0;
  blockExpPoints.length = 0;
  blockExpHalf.length = 0;
  if (mat > 0 && cells) {
    for (const i of occupied) {
      if (cells[i] !== mat) continue;
      const { x, y, z } = decodeCell(i);
      cellWorld(x, y, z, scratchPos);
      blockExpPoints.push(scratchPos.x, scratchPos.y, scratchPos.z);
      blockExpHalf.push(atomExtent(x, y, z) * 0.5);
    }
  }
  blockExpSurface.update(surface, blockExpPoints, mat > 0 ? materialColor(mat) : "#3d7ec4", blockExpHalf);
}

function reconcileMeshes() {
  buildColumns();
  writeMeshesFromColumns(false);
}

const columnQueries = {
  resting(i) {
    return restingFlags?.[i] === 1;
  },
  onFloor(i) {
    return onFloorFlags?.[i] === 1;
  },
  sameAbove(i) {
    return sameAboveFlags?.[i] === 1;
  },
  above(i) {
    return aboveFlags?.[i] === 1;
  },
  blockAbove(i) {
    return blockAboveFlags?.[i] === 1;
  },
};

/** Resting / floor / same-material-above flags from continuous column positions. */
function rebuildColumnFlags() {
  if (restingFlags) restingFlags.fill(0);
  if (onFloorFlags) onFloorFlags.fill(0);
  if (sameAboveFlags) sameAboveFlags.fill(0);
  if (aboveFlags) aboveFlags.fill(0);
  if (blockAboveFlags) blockAboveFlags.fill(0);
  if (!cells || !posY || !restingFlags || occupied.size === 0) return;

  for (let c = 0; c < columnKeys.length; c += 1) {
    const list = columns.get(columnKeys[c]);
    let floorTop = 0;
    for (let n = 0; n < list.length; n += 1) {
      const i = list[n];
      const { x, y, z } = decodeCell(i);
      const mat = cells[i];
      const size = atomExtent(x, y, z, mat);
      const restCenter = floorTop + size * 0.5;
      const yCenter = posY[i] > 0 ? posY[i] : restCenter;
      const resting = yCenter <= restCenter + 0.05;
      const onGround = floorTop <= 1e-4;
      const blockMat = catalog?.indexById.get("block") || 0;
      let sameAbove = false;
      let blockAbove = false;
      for (let k = n + 1; k < list.length; k += 1) {
        const aboveMat = cells[list[k]];
        if (aboveMat === mat) sameAbove = true;
        if (blockMat > 0 && aboveMat === blockMat) blockAbove = true;
        if (sameAbove && blockAbove) break;
      }
      if (resting) restingFlags[i] = 1;
      if (onGround) onFloorFlags[i] = 1;
      if (sameAbove) sameAboveFlags[i] = 1;
      if (blockAbove && blockAboveFlags) blockAboveFlags[i] = 1;
      if (n + 1 < list.length && aboveFlags) aboveFlags[i] = 1;
      const placed = yCenter > restCenter + 1e-4 ? yCenter : restCenter;
      floorTop = placed + size * 0.5;
    }
  }
}
/**
 * Recompute contact each tick from current atom sizes: fall until resting on
 * the ground plane or the atom below in the same column.
 * @returns {boolean}
 */
function settleGravity(dt) {
  if (!cells || !posY || dt <= 0 || occupied.size === 0) return false;

  let moved = false;
  const fall = GRAVITY * dt;

  for (let c = 0; c < columnKeys.length; c += 1) {
    const list = columns.get(columnKeys[c]);
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

      if (Math.abs(posY[i] - yCenter) > 1e-5) {
        moved = true;
        markXform(i);
      }
      posY[i] = yCenter;
      floorTop = yCenter + size * 0.5;
    }
  }

  return moved;
}

/** True when an effect marked this cell as shrinking. */
function isShrinking(cellIndex) {
  return shrinkFlags?.[cellIndex] === 1;
}

/**
 * True when this atom should leave the grid pitch and sit flush against
 * neighbors: a shrink effect, or an emit size below the grid pitch.
 * Slide-open shrink stays on the grid unless the baked emit size is already small.
 */
function packsFlush(cellIndex, mat) {
  if (mat <= 0) return false;
  if (cellAtomSize(cellIndex) < ATOM_SIZE - 1e-4) return true;
  return isShrinking(cellIndex) && !materialSlidesOpen(mat);
}

/**
 * Keep full-size atoms easing toward their grid cell centers in XZ
 * (smooths slide/flow hops instead of teleporting each rule tick).
 * Undersized atoms are packed flush instead, so this does not pull them apart.
 * @returns {boolean}
 */
function settleLateral(dt) {
  if (!cells || !posX || !posZ || dt <= 0 || occupied.size === 0) return false;

  let moved = false;
  for (const i of occupied) {
    const mat = cells[i];
    if (mat <= 0 || packsFlush(i, mat)) continue;
    const x = i % GRID_MAX;
    const rest = (i / GRID_MAX) | 0;
    const z = rest % GRID_MAX;
    const tx = worldXForCell(x, ATOM_SIZE);
    const tz = worldZForCell(z, ATOM_SIZE);
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
        markXform(i);
      }
      continue;
    }
    // Ease toward the cell; slightly under one-cell/tick so hops don't look frantic.
    const maxStep = ATOM_SIZE * RULE_HZ * 0.85 * dt;
    if (dist <= maxStep) {
      posX[i] = tx;
      posZ[i] = tz;
    } else {
      const s = maxStep / dist;
      posX[i] = px + dx * s;
      posZ[i] = pz + dz * s;
    }
    moved = true;
    markXform(i);
  }
  return moved;
}

/**
 * Keep connected undersized atoms flush: contract each cluster in XZ so
 * neighbors stay in contact. Full-size atoms ease onto the grid via settleLateral.
 * Lattice is the fixed grid pitch; scale is each atom's drawn size over that pitch,
 * so a half-size brush closes up instead of sitting on full-pitch centers.
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
    if (startMat <= 0 || visited.has(start) || !packsFlush(start, startMat)) {
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
        if (!packsFlush(ni, cells[ni])) continue;
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
      const ext = atomExtent(x, y, z, mat);
      const s = ATOM_SIZE > 1e-6 ? ext / ATOM_SIZE : 1;
      const wx = worldXForCell(x, ATOM_SIZE);
      const wz = worldZForCell(z, ATOM_SIZE);
      sumS += s;
      cX += wx;
      cZ += wz;
      members.push({ i, x, y, z, ext, wx, wz });
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
        markXform(m.i);
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
              markXform(m.i);
              markXform(ni);
            }
          } else {
            const sep = posZ[ni] - posZ[m.i];
            const gap = sep - desired;
            if (Math.abs(gap) > 1e-5) {
              posZ[m.i] += gap * 0.5;
              posZ[ni] -= gap * 0.5;
              moved = true;
              markXform(m.i);
              markXform(ni);
            }
          }
        }
      }
    }
  }

  return moved;
}

function runRules() {
  if (!catalog) return false;
  const occupiedList = collectOccupied();
  const { splashes: splashCells, moves } = stepWorld(gridApi, occupiedList, catalog);
  // Later steps can delete the landing grain and zero its position. Read the
  // landing spot first so the ring does not fall back to the ground origin.
  for (let s = 0; s < splashCells.length; s += 1) {
    const cell = splashCells[s];
    const anchor = splashAnchor(cell.x, cell.y, cell.z);
    cell.wx = anchor.wx;
    cell.wz = anchor.wz;
  }
  let flowAtoms = 0;
  for (let m = 0; m < moves.length; m += 1) {
    const move = moves[m];
    if (move.to.y < move.from.y && materialSonifies(move.mat)) audioFall += 1;
    if (materialSpreads(move.mat) && (move.to.x !== move.from.x || move.to.z !== move.from.z)) {
      flowAtoms += 1;
    }
  }
  const culledShuffle = applyPostMoves(gridApi, moves, catalog);
  const vacuumed = applyVacuum(gridApi, collectOccupied(), catalog);
  const converted = applyConvert(gridApi, collectOccupied(), catalog, moves);

  consumeOutOfBounds();
  reconcileMeshes();
  let splashEvents = 0;
  for (const cell of splashCells) {
    const wx = cell.wx;
    const wz = cell.wz;
    const cellPitch = cellAtomSize(idx(cell.x, cell.y, cell.z));
    // The ring sits on the floor. Test the landing point at the cell's own
    // height so the floor plane itself is not treated as outside the sim.
    const wy = (cell.y + 0.5) * cellPitch;
    if (!isDrawnInSim(wx, wy, wz, cellPitch * 0.5)) continue;
    // One landing is one splash, counted here, before any voice starts.
    audioSplash += 1;
    splashEvents += 1;
    audioSplashAt.push({
      x: cell.x,
      z: cell.z,
      life: SPLASH_LIFE,
    });
    spawnSplash(cell.x, cell.z, wx, wz);
  }
  if (splashEvents || flowAtoms) audioEngine.noteFieldEvents(splashEvents, flowAtoms);
  return culledShuffle || vacuumed || converted;
}

function step(dt) {
  bumpXformGen();
  advanceEmitLife(dt);
  applyInput(dt);

  let infected = applyInfect(gridApi, collectOccupied(), catalog);

  ruleAcc += dt;
  const interval = 1 / RULE_HZ;
  let ruled = false;
  while (ruleAcc >= interval) {
    ruleAcc -= interval;
    if (runRules()) ruled = true;
  }

  infected = applyInfect(gridApi, collectOccupied(), catalog) || infected;

  buildColumns();
  let columnOccupancy = occupied.size;
  const heardBefore = countSonifying();
  rebuildColumnFlags();
  const effected = tickEffects(gridApi, collectOccupied(), catalog, columnQueries, dt);
  audioDeath += Math.max(0, heardBefore - countSonifying());
  if (occupied.size !== columnOccupancy) {
    buildColumns();
    columnOccupancy = occupied.size;
  }
  const settled = settleGravity(dt);
  const lateral = settleLateral(dt);
  const packed = packStickTogether();
  const culled = consumeOutOfBounds();
  if (occupied.size !== columnOccupancy) buildColumns();
  if (infected || effected || ruled || settled || lateral || packed || culled) {
    writeMeshesFromColumns(effected);
  }
  rebuildColumnFlags();
  captureAudioSnapshot(dt);

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
    syncControllerGlyphs();
    syncLandingTarget();
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

/** Chip name from the unmasked WebGL renderer string. */
function shortenGpuName(raw) {
  let s = String(raw || "");
  const lower = s.toLowerCase();
  if (/swiftshader|llvmpipe|softpipe|microsoft basic render|gdi generic|cpu rasterizer/.test(lower)) {
    return "CPU fallback";
  }
  const angle = s.match(/ANGLE\s*\(([\s\S]+)\)\s*$/i);
  if (angle) s = angle[1];
  s = s
    .replace(/Google Inc\.\s*(\([^)]*\))?/gi, "")
    .replace(/Direct3D[0-9.]*/gi, "")
    .replace(/D3D[0-9]+/gi, "")
    .replace(/OpenGL[\w.]*/gi, "")
    .replace(/Metal/gi, "")
    .replace(/vs_\d+_\d+/gi, "")
    .replace(/ps_\d+_\d+/gi, "")
    .replace(/\(0x[0-9a-f]+\)/gi, "")
    .replace(/\(R\)|\(TM\)/gi, "")
    .replace(/\bANGLE\b/gi, "")
    .replace(/Renderer:?/gi, "")
    .replace(/Unspecified Version/gi, "")
    .replace(/\b(NVIDIA|AMD|Intel|Microsoft|Apple|Corporation|Inc\.?)\b,?/gi, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || "GPU";
}

function readGpuLabel() {
  if (!renderer) return "";
  const gl = renderer.getContext();
  if (!gl) return "";
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const raw = dbg
    ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  const name = shortenGpuName(raw);
  if (!name || name === "CPU fallback") return name || "";
  const api = renderer.capabilities?.isWebGL2 ? "WebGL2" : "WebGL";
  return `${name} · ${api}`;
}

function syncGpuLabel() {
  if (!gpuEl || !renderer || gpuLabel) return;
  gpuLabel = readGpuLabel();
  if (gpuLabel) gpuEl.textContent = gpuLabel;
}

function setHudText(el, prev, text) {
  if (prev === text) return prev;
  el.textContent = text;
  return text;
}

function updateHud(now) {
  if (!fpsEl || !atomsEl || !trisEl) return;
  fpsFrames += 1;
  if (!fpsLastAt) fpsLastAt = now;
  const elapsed = now - fpsLastAt;
  if (elapsed >= 500) {
    const fpsText = String(Math.round((fpsFrames * 1000) / elapsed));
    hudFpsText = setHudText(fpsEl, hudFpsText, fpsText);
    fpsFrames = 0;
    fpsLastAt = now;
  }
  hudAtomsText = setHudText(atomsEl, hudAtomsText, formatCount(occupied.size));
  const tris = renderer?.info?.render?.triangles;
  const trisText = Number.isFinite(tris) ? formatCount(tris) : "--";
  hudTrisText = setHudText(trisEl, hudTrisText, trisText);
  syncGpuLabel();
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
  const res = await fetch(`/materials.json?v=87`);
  if (!res.ok) throw new Error(`materials.json ${res.status}`);
  const prev = activeMaterialId;
  catalog = compileMaterials(parseMaterialsJson(await res.text()));
  activeMaterialId = catalog.byId.has(prev)
    ? prev
    : catalog.defaultId || catalog.list[0]?.id || "block";
  if (cells && effectClocks.length !== (catalog?.clockCount || 0)) ensureEffectStorage();
  buildPalette();
}

function ensureEffectStorage() {
  const n = GRID_MAX * GRID_MAX * MAX_Y;
  const channels = catalog?.clockCount || 0;
  effectClocks = Array.from({ length: channels }, () => new Float32Array(n));
  infection = new Float32Array(n);
  infectionAge = new Float32Array(n);
  holeShrink = new Float32Array(n);
  shrinkFlags = new Uint8Array(n);
  shrinkT = new Float32Array(n);
  riseT = new Float32Array(n);
  riseElapsed = new Float32Array(n);
  restingFlags = new Uint8Array(n);
  onFloorFlags = new Uint8Array(n);
  sameAboveFlags = new Uint8Array(n);
  aboveFlags = new Uint8Array(n);
  blockAboveFlags = new Uint8Array(n);
}

/** Faint lattice outside the playfield, and a dotted grid on the surface. */
function addFieldGrid() {
  if (!surface) return;
  const y = 0.01;
  const extent = 32;
  const bgStep = 1;
  const half = PLAYFIELD_HALF;
  const bg = [];
  for (let x = -extent; x <= extent + 1e-6; x += bgStep) {
    const onEdge = Math.abs(Math.abs(x) - half) < 1e-4;
    const inside = Math.abs(x) < half - 1e-4;
    if (onEdge) continue;
    if (!inside) {
      bg.push(x, y, -extent, x, y, extent);
    } else {
      bg.push(x, y, -extent, x, y, -half, x, y, half, x, y, extent);
    }
  }
  for (let z = -extent; z <= extent + 1e-6; z += bgStep) {
    const onEdge = Math.abs(Math.abs(z) - half) < 1e-4;
    const inside = Math.abs(z) < half - 1e-4;
    if (onEdge) continue;
    if (!inside) {
      bg.push(-extent, y, z, extent, y, z);
    } else {
      bg.push(-extent, y, z, -half, y, z, half, y, z, extent, y, z);
    }
  }
  const bgGeo = new THREE.BufferGeometry();
  bgGeo.setAttribute("position", new THREE.Float32BufferAttribute(bg, 3));
  const bgLines = new THREE.LineSegments(
    bgGeo,
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.07,
      depthWrite: false,
    }),
  );
  bgLines.renderOrder = 1;
  surface.add(bgLines);

  const step = 2;
  const lineY = 0.02;
  const lines = [];
  const dots = [];
  for (let x = -half; x <= half + 1e-6; x += step) {
    lines.push(x, lineY, -half, x, lineY, half);
  }
  for (let z = -half; z <= half + 1e-6; z += step) {
    lines.push(-half, lineY, z, half, lineY, z);
  }
  for (let x = -half; x <= half + 1e-6; x += step) {
    for (let z = -half; z <= half + 1e-6; z += step) {
      dots.push(x, lineY + 0.01, z);
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
  const surfaceLines = new THREE.LineSegments(
    lineGeo,
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
    }),
  );
  surfaceLines.renderOrder = 2;
  surface.add(surfaceLines);

  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute("position", new THREE.Float32BufferAttribute(dots, 3));
  const dotCanvas = document.createElement("canvas");
  dotCanvas.width = 32;
  dotCanvas.height = 32;
  const dotCtx = dotCanvas.getContext("2d");
  if (dotCtx) {
    dotCtx.fillStyle = "#fff";
    dotCtx.beginPath();
    dotCtx.arc(16, 16, 5, 0, Math.PI * 2);
    dotCtx.fill();
  }
  const dotMap = new THREE.CanvasTexture(dotCanvas);
  dotMap.colorSpace = THREE.SRGBColorSpace;
  const surfaceDots = new THREE.Points(
    dotGeo,
    new THREE.PointsMaterial({
      color: 0xffffff,
      map: dotMap,
      size: 7,
      sizeAttenuation: false,
      transparent: true,
      alphaTest: 0.4,
      opacity: 1,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  surfaceDots.renderOrder = 3;
  surface.add(surfaceDots);
}

/** Cross on the playfield: the four quadrants are the four sample beds. */
function addQuadrantAxes() {
  if (!surface) return;
  addQuadrantLabels();
}

/**
 * Row-major bed order, matching the pad and the readout columns.
 * 1 TL · 2 TR · 3 BL · 4 BR.
 * x0/z0 are the quadrant's upper-left corner, in playfield-half units
 * (low X is left, low Z is up).
 */
const QUAD_MARKS = [
  { id: "tl", n: "1", x0: -1, z0: -1 },
  { id: "tr", n: "2", x0: 0, z0: -1 },
  { id: "bl", n: "3", x0: -1, z0: 0 },
  { id: "br", n: "4", x0: 0, z0: 0 },
];
/** World size of the label strip painted along each quadrant's top edge. */
const QUAD_LABEL_W = 5.4;
const QUAD_LABEL_H = 0.72;
const QUAD_LABEL_INSET = 0.16;

/** @type {{ id: string, n: string, canvas: HTMLCanvasElement, texture: THREE.CanvasTexture }[] | null} */
let quadLabels = null;
let quadLabelKey = "";
let unsubQuadLabels = null;

function ellipsizeLabel(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return cut.length < text.length ? `${cut}…` : cut;
}

function paintQuadLabel(canvas, number, sample) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const name = String(sample || "").trim();
  const text = name ? `${number}  ${name}` : number;
  let size = Math.floor(h * 0.78);
  const maxW = w - 16;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.font = `500 ${size}px "Segoe UI", system-ui, sans-serif`;
  while (size > 28 && ctx.measureText(text).width > maxW) {
    size -= 2;
    ctx.font = `500 ${size}px "Segoe UI", system-ui, sans-serif`;
  }
  const drawn = ellipsizeLabel(ctx, text, maxW);
  ctx.fillStyle = "rgba(255, 255, 255, 0.62)";
  ctx.fillText(drawn, 8, h / 2);
}

function quadLabelSignature() {
  return QUAD_MARKS.map((mark) => `${mark.n}:${STEM_CORNERS[mark.id]?.label || ""}`).join("|");
}

function syncQuadLabels() {
  if (!quadLabels) return;
  const key = quadLabelSignature();
  if (key === quadLabelKey) return;
  quadLabelKey = key;
  for (const entry of quadLabels) {
    paintQuadLabel(entry.canvas, entry.n, STEM_CORNERS[entry.id]?.label || "");
    entry.texture.needsUpdate = true;
  }
}

/**
 * Number and sample name as a flat texture on the upper-left edge of each
 * quadrant. Reads left-to-right along that edge and yaws with the grid.
 */
function addQuadrantLabels() {
  if (!surface) return;
  const entries = [];
  const geo = new THREE.PlaneGeometry(QUAD_LABEL_W, QUAD_LABEL_H);
  const y = 0.03;
  for (const mark of QUAD_MARKS) {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 128;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer?.capabilities.getMaxAnisotropy() || 1;
    texture.generateMipmaps = true;
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    const xMin = mark.x0 * PLAYFIELD_HALF;
    const zMin = mark.z0 * PLAYFIELD_HALF;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(
      xMin + QUAD_LABEL_INSET + QUAD_LABEL_W / 2,
      y,
      zMin + QUAD_LABEL_INSET + QUAD_LABEL_H / 2,
    );
    mesh.renderOrder = 2;
    surface.add(mesh);
    entries.push({ id: mark.id, n: mark.n, canvas, texture });
  }
  quadLabels = entries;
  quadLabelKey = "";
  syncQuadLabels();
  if (!unsubQuadLabels) unsubQuadLabels = subscribe(() => syncQuadLabels());
}

function initScene(nextCanvas) {
  canvas = nextCanvas;
  wrap = canvas.parentElement;
  canvas.style.touchAction = "none";
  fpsEl = document.querySelector("[data-falling-fps]");
  atomsEl = document.querySelector("[data-falling-atoms]");
  trisEl = document.querySelector("[data-falling-tris]");
  gpuEl = document.querySelector("[data-falling-gpu]");
  fpsFrames = 0;
  fpsLastAt = 0;

  cells = new Uint8Array(GRID_MAX * GRID_MAX * MAX_Y);
  budgets = new Uint8Array(GRID_MAX * GRID_MAX * MAX_Y);
  posY = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  posX = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  posZ = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  emitSizes = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  lifeSpans = new Float32Array(GRID_MAX * GRID_MAX * MAX_Y);
  shuffleCounts = new Uint8Array(GRID_MAX * GRID_MAX * MAX_Y);
  shuffleOriginX = new Uint16Array(GRID_MAX * GRID_MAX * MAX_Y);
  shuffleOriginZ = new Uint16Array(GRID_MAX * GRID_MAX * MAX_Y);
  flowDx = new Int8Array(GRID_MAX * GRID_MAX * MAX_Y);
  flowDz = new Int8Array(GRID_MAX * GRID_MAX * MAX_Y);
  audioIds = new Uint32Array(GRID_MAX * GRID_MAX * MAX_Y);
  nextAudioId = 1;
  const gridN = GRID_MAX * GRID_MAX * MAX_Y;
  landedSlot = new Int32Array(gridN);
  landedSlot.fill(-1);
  landedMatOf = new Uint8Array(gridN);
  xformStamp = new Uint32Array(gridN);
  classStamp = new Uint32Array(gridN);
  resetLandedTracking();
  ensureEffectStorage();
  occupied.clear();
  for (const mesh of instances.values()) {
    surface?.remove(mesh);
  }
  instances.clear();
  for (const mesh of fallingInstances.values()) {
    surface?.remove(mesh);
  }
  fallingInstances.clear();
  for (const mesh of risingInstances.values()) {
    if (mesh.geometry !== blockGeo) mesh.geometry.dispose();
    surface?.remove(mesh);
  }
  risingInstances.clear();
  splashes = [];
  ruleAcc = 0;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(SCENE_BG);

  surface = new THREE.Group();
  scene.add(surface);

  // A fresh field always starts with the emitter over the grid's center.
  surface.position.set(0, 0, 0);
  surface.rotation.set(0, 0, 0);
  aimWorldX = 0;
  aimWorldZ = 0;
  stickAimPointer = null;
  cameraDist = CAMERA_DIST_DEFAULT;

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
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;
  syncSceneBackground();

  scene.add(new THREE.AmbientLight(0xffffff, 0.42));
  scene.add(new THREE.HemisphereLight(0xb7c0c8, 0x000000, 0.28));
  const key = new THREE.DirectionalLight(0xfff6ee, 1.15);
  // 30° above the ground so cast shadows stretch. Same compass heading as before.
  const keyElevation = (30 * Math.PI) / 180;
  const keyHeading = Math.atan2(6, 8);
  const keyDistance = 20;
  key.target.position.set(0, 4, 0);
  key.position.set(
    Math.cos(keyElevation) * Math.cos(keyHeading) * keyDistance,
    key.target.position.y + Math.sin(keyElevation) * keyDistance,
    Math.cos(keyElevation) * Math.sin(keyHeading) * keyDistance,
  );
  key.castShadow = true;
  // One 1024 map, fitted to the 16×16 playfield and piles up to about 12 tall.
  // Wider than the field because the low light looks across it at an angle.
  const shadowReach = 16;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 48;
  key.shadow.camera.left = -shadowReach;
  key.shadow.camera.right = shadowReach;
  key.shadow.camera.top = shadowReach;
  key.shadow.camera.bottom = -shadowReach;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  scene.add(key.target);
  const fill = new THREE.DirectionalLight(0xd6e2ea, 0.32);
  fill.position.set(-7, 6, -5);
  scene.add(fill);

  const groundMat = new THREE.MeshStandardMaterial({ color: SCENE_BG, roughness: 1, metalness: 0 });
  attachLandingTarget(groundMat, true);
  groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_PLANE_SIZE, GROUND_PLANE_SIZE),
    groundMat,
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.position.y = -0.02;
  groundMesh.receiveShadow = true;
  surface.add(groundMesh);
  addFieldGrid();
  addQuadrantAxes();

  blockGeo = new THREE.BoxGeometry(1, 1, 1);
  splashGeo = new THREE.RingGeometry(atomSize * 0.55, atomSize * 0.8, 28);

  const size = emitterBoxSize();
  emitter = new THREE.Group();
  emitterFill = new THREE.Mesh(
    new THREE.PlaneGeometry(size.x, size.z),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    }),
  );
  emitterFill.rotation.x = -Math.PI / 2;
  emitterFill.renderOrder = 4;
  emitter.add(emitterFill);

  emitterEdge = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      depthTest: false,
    }),
  );
  emitterEdge.renderOrder = 5;
  emitter.add(emitterEdge);

  emitterMark = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: false,
    }),
  );
  emitterMark.renderOrder = 6;
  emitter.add(emitterMark);

  const stemGeo = new THREE.BufferGeometry();
  stemGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0.28, 0, 0, -1, 0], 3));
  emitterStem = new THREE.LineSegments(
    stemGeo,
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      depthTest: false,
    }),
  );
  emitterStem.renderOrder = 5;
  emitter.add(emitterStem);
  rebuildEmitterGeometry();
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

function installSimHook() {
  if (!new URLSearchParams(location.search).has("sim")) return;
  window.__fallingSim = {
    setMaterial(id) {
      setActiveMaterial(id);
      return activeMaterialId;
    },
    placeColumn(count) {
      clearBoard();
      const matIndex =
        catalog?.indexById.get(activeMaterialId) || catalog?.indexById.get("block") || 0;
      if (!matIndex) return;
      const x = (GRID_MAX / 2) | 0;
      const z = x;
      const n = Math.max(1, count | 0);
      for (let k = 0; k < n; k += 1) setCell(x, k, z, matIndex);
      reconcileMeshes();
      rebuildColumnFlags();
    },
    placeCells(list) {
      clearBoard();
      const matIndex =
        catalog?.indexById.get(activeMaterialId) || catalog?.indexById.get("block") || 0;
      if (!matIndex) return;
      for (const p of list) setCell(p.x, p.y, p.z, matIndex);
      reconcileMeshes();
      rebuildColumnFlags();
    },
    setEmitHeight(units) {
      emitHeightU = Math.min(EMIT_HEIGHT_MAX_U, Math.max(0.5, Number(units) || EMIT_HEIGHT_DEFAULT_U));
      setCameraDist(cameraDist);
      syncEmitter();
      return emitHeightU;
    },
    view() {
      const ndc = camera ? projectTarget() : { x: 0, y: 0, z: 0 };
      let lookX = 0;
      let lookZ = 0;
      if (camera) {
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        if (Math.abs(dir.y) > 1e-6) {
          const t = (CAMERA_LOOK.y - camera.position.y) / dir.y;
          lookX = camera.position.x + dir.x * t;
          lookZ = camera.position.z + dir.z * t;
        }
      }
      const local = worldToSurfaceXZ(aimWorldX, aimWorldZ);
      return {
        cameraDist,
        gridFitDist,
        clearance: emitterClearanceDist(),
        lookX,
        lookZ,
        cameraY: camera ? camera.position.y : 0,
        surfaceX: surface ? surface.position.x : 0,
        surfaceZ: surface ? surface.position.z : 0,
        yaw: surface ? surface.rotation.y : 0,
        aimX: aimWorldX,
        aimZ: aimWorldZ,
        localX: local.x,
        localZ: local.z,
        cellX: aim ? aim.ix : -1,
        cellZ: aim ? aim.iz : -1,
        ndcX: ndc.x,
        ndcY: ndc.y,
        close: viewIsClose(),
        wide: viewIsWide(),
      };
    },
    state() {
      const samples = [];
      for (const i of occupied) {
        const { x, y, z } = decodeCell(i);
        samples.push({
          x,
          y,
          z,
          scale: cellScale(x, y, z),
          shrinking: shrinkFlags?.[i] === 1,
          rise: riseT?.[i] || 0,
          riseElapsed: riseElapsed?.[i] || 0,
          yDraw: (posY?.[i] || 0) + riseOffset(x, y, z),
          onFloor: onFloorFlags?.[i] === 1,
          sameAbove: sameAboveFlags?.[i] === 1,
          resting: restingFlags?.[i] === 1,
          flowDx: flowDx?.[i] ?? 0,
          flowDz: flowDz?.[i] ?? 0,
          clocks: effectClocks.map((channel) => channel[i]),
        });
      }
      samples.sort((a, b) => a.y - b.y);
      return { atoms: occupied.size, samples };
    },
    clear() {
      clearBoard();
      reconcileMeshes();
    },
    infectionCase() {
      /** @type {Map<string, number>} */
      const occ = new Map();
      /** @type {Map<string, number>} */
      const infected = new Map();
      /** @type {Map<string, number>} */
      const infectedAge = new Map();
      /** @type {Map<string, number>} */
      const clocks = new Map();
      /** @type {{ shrinking: boolean, t: number } | null} */
      let shrink = null;
      const key = (x, y, z) => `${x},${y},${z}`;
      const grid = {
        get: (x, y, z) => occ.get(key(x, y, z)) || 0,
        set: (x, y, z, v) => {
          if (!v) occ.delete(key(x, y, z));
          else occ.set(key(x, y, z), v);
        },
        inBounds: () => true,
        getInfection: (x, y, z) => infected.get(key(x, y, z)) || 0,
        setInfection: (x, y, z, v) => infected.set(key(x, y, z), v),
        getInfectionAge: (x, y, z) => infectedAge.get(key(x, y, z)) || 0,
        setInfectionAge: (x, y, z, v) => infectedAge.set(key(x, y, z), v),
        getEffectClock: (x, y, z, channel) => clocks.get(`${key(x, y, z)}:${channel}`) || 0,
        setEffectClock: (x, y, z, channel, v) => clocks.set(`${key(x, y, z)}:${channel}`, v),
        setShrink: (_x, _y, _z, shrinking, t) => {
          shrink = { shrinking, t };
        },
      };
      const catalog = {
        floor: "liquid",
        clockCount: 2,
        idByIndex: ["", "block", "erode", "water"],
        byId: new Map([
          [
            "block",
            {
              id: "block",
              surface: "solid",
              effects: [
                {
                  kind: "age",
                  seconds: 3.5,
                  visual: "shrink",
                  thenClear: true,
                  clockId: 0,
                  when: { resting: true, onFloor: true, sameAbove: false },
                },
                {
                  kind: "age",
                  seconds: 3.5,
                  visual: null,
                  thenClear: true,
                  clockId: 1,
                  when: { resting: true, onFloor: true, sameAbove: true },
                },
              ],
            },
          ],
          [
            "erode",
            {
              id: "erode",
              surface: "solid",
              effects: [{ kind: "infect", seconds: 6, skipSurface: "liquid", when: {} }],
            },
          ],
          ["water", { id: "water", surface: "liquid", effects: [] }],
        ]),
        indexById: new Map([
          ["block", 1],
          ["erode", 2],
          ["water", 3],
        ]),
      };
      occ.set(key(0, 0, 0), 2);
      occ.set(key(1, 0, 0), 1);
      occ.set(key(0, 0, 1), 3);
      applyInfect(
        grid,
        [
          { x: 0, y: 0, z: 0, mat: 2 },
          { x: 1, y: 0, z: 0, mat: 1 },
          { x: 0, y: 0, z: 1, mat: 3 },
        ],
        catalog,
      );
      const tagged = {
        block: grid.getInfection(1, 0, 0),
        water: grid.getInfection(0, 0, 1),
        erode: grid.getInfection(0, 0, 0),
      };
      // Stack support matches crush (no shrink) even while infected.
      tickEffects(
        grid,
        [{ x: 1, y: 0, z: 0, mat: 1, i: 0 }],
        catalog,
        {
          resting: () => true,
          onFloor: () => true,
          sameAbove: () => true,
        },
        0.5,
      );
      const stacked = { present: grid.get(1, 0, 0), shrink };
      // A block with no matching age rule shrinks on the infection clock.
      shrink = null;
      occ.set(key(2, 1, 0), 1);
      infected.set(key(2, 1, 0), 6);
      tickEffects(
        grid,
        [{ x: 2, y: 1, z: 0, mat: 1, i: 1 }],
        catalog,
        {
          resting: () => false,
          onFloor: () => false,
          sameAbove: () => false,
        },
        0.5,
      );
      return { tagged, stacked, airborne: { present: grid.get(2, 1, 0), shrink } };
    },
  };
}

/**
 * Activity weight for the field centroid. Motion and aging pull harder than a lone floor atom.
 * @param {boolean} resting
 * @param {boolean} onFloor
 * @param {boolean} sameAbove
 * @param {number} dying
 */
function activityWeight(resting, onFloor, sameAbove, dying) {
  if (!resting) return 1;
  if (onFloor && dying > 0.001) return 0.7;
  if (sameAbove || !onFloor) return 0.35;
  return 0.05;
}

/** Age-clock progress 0..1 for this cell, across compiled effect channels. */
function clockProgress(i) {
  if (!effectClocks.length || !cells || !catalog) return 0;
  const id = catalog.idByIndex[cells[i]];
  const material = id ? catalog.byId.get(id) : null;
  let limit = 0;
  const effects = material?.effects || [];
  for (let e = 0; e < effects.length; e += 1) {
    const effect = effects[e];
    if (effect.kind === "age" && effect.seconds > limit) limit = effect.seconds;
  }
  if (lifeSpans && lifeSpans[i] > 0) limit = lifeSpans[i];
  let scale = 1;
  for (let e = 0; e < effects.length; e += 1) {
    const effect = effects[e];
    if (effect.kind === "age" && effect.visual !== "rise" && effect.lifeScale > scale) {
      scale = effect.lifeScale;
    }
  }
  limit *= scale;
  if (!(limit > 0)) return 0;
  let clock = 0;
  for (let c = 0; c < effectClocks.length; c += 1) {
    const value = effectClocks[c][i];
    if (value > clock) clock = value;
  }
  return Math.min(1, clock / limit);
}

/** Corner of a quadrant stays at the sample's pitch. Its center is an octave up. */
const CENTER_PITCH = 2;
/** Separate piles in one quadrant that each keep their own note. */
const PILE_NOTE_CAP = 8;
/** Previous pile centers, so a note keeps its voice while that mass moves. */
const pileMemory = { tl: [], tr: [], bl: [], br: [] };
let pileSerial = 1;

/** Playback rate from distance to the center of the point's quadrant. */
function pitchForWorld(wx, wz) {
  const half = PLAYFIELD_HALF * 0.5;
  const qx = wx < 0 ? -half : half;
  const qz = wz < 0 ? -half : half;
  const dist = Math.hypot(wx - qx, wz - qz);
  const maxDist = half * Math.SQRT2;
  const closeness = maxDist > 0 ? 1 - Math.min(1, dist / maxDist) : 0;
  return CENTER_PITCH ** closeness;
}

/**
 * Stereo pan (−1 left … 1 right) of a point on the playfield after yaw.
 * Azimuth around the camera, so a pile anywhere off the plane center swings
 * fully left and right as the surface turns. Screen-right matches moveAim.
 * Where the plane sits in the viewport is added separately.
 */
function screenPan(lx, lz, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const wx = c * lx + s * lz;
  const wz = -s * lx + c * lz;
  const camC = Math.cos(CAMERA_YAW);
  const camS = Math.sin(CAMERA_YAW);
  const screenX = wx * camC - wz * camS;
  const screenDepth = -wx * camS - wz * camC;
  const mag = Math.hypot(screenX, screenDepth);
  if (mag < 1e-4) return 0;
  return Math.min(1, Math.max(-1, screenX / mag));
}

/** Screen X of the plane center. −1 is the left edge of the view, 1 the right. */
function planeViewportPan() {
  if (!camera || !surface) return 0;
  camera.updateMatrixWorld(true);
  emitterNdc.set(surface.position.x, 0, surface.position.z);
  emitterNdc.project(camera);
  if (!Number.isFinite(emitterNdc.x)) return 0;
  return Math.min(1, Math.max(-1, emitterNdc.x));
}

/**
 * Drawn altitude that should drive the diffuse reverb.
 * Rising atoms are grouped by columns that touch. The group with the most atoms wins,
 * and the altitude is their size-weighted average. One grain that has climbed ahead of that group does not set it.
 * @param {{ corner: string, key: number, scale: number, tip: number }[]} atoms
 * @param {string} corner
 */
function crowdedRiseHeight(atoms, corner) {
  /** @type {Map<number, { scale: number, count: number, sum: number }>} */
  const byKey = new Map();
  for (let i = 0; i < atoms.length; i += 1) {
    const atom = atoms[i];
    if (atom.corner !== corner) continue;
    const scale = atom.scale > 0 ? atom.scale : 0;
    const tip = atom.tip > 0 ? atom.tip : 0;
    let group = byKey.get(atom.key);
    if (!group) {
      group = { scale: 0, count: 0, sum: 0 };
      byKey.set(atom.key, group);
    }
    group.scale += scale;
    group.count += 1;
    group.sum += tip * scale;
  }
  if (!byKey.size) return 0;
  const keys = [...byKey.keys()];
  const seen = new Set();
  let bestAvg = 0;
  let bestCount = -1;
  let bestScale = -1;
  for (let i = 0; i < keys.length; i += 1) {
    if (seen.has(keys[i])) continue;
    const stack = [keys[i]];
    seen.add(keys[i]);
    let count = 0;
    let scale = 0;
    let sum = 0;
    while (stack.length) {
      const key = stack.pop();
      const group = byKey.get(key);
      count += group.count;
      scale += group.scale;
      sum += group.sum;
      const x = key % GRID_MAX;
      const z = (key / GRID_MAX) | 0;
      const next = [];
      if (x > 0) next.push(key - 1);
      if (x + 1 < GRID_MAX) next.push(key + 1);
      if (z > 0) next.push(key - GRID_MAX);
      if (z + 1 < GRID_MAX) next.push(key + GRID_MAX);
      for (let n = 0; n < next.length; n += 1) {
        const nk = next[n];
        if (seen.has(nk) || !byKey.has(nk)) continue;
        seen.add(nk);
        stack.push(nk);
      }
    }
    if (count > bestCount || (count === bestCount && scale > bestScale)) {
      bestCount = count;
      bestScale = scale;
      bestAvg = scale > 0 ? sum / scale : 0;
    }
  }
  return bestAvg;
}

/**
 * One quadrant's audio measures.
 * `rise` is the average drawn altitude of the rising cluster that holds the most grains, in world units.
 * The tallest grain still counts in `peak` and `height`. It does not set `rise` by itself.
 * `riseMass` is the sum of those grains' drawn scales. One full-size atom is 1.
 */
function quadAudio(cells, peak, rise, stack, rate, quadCells, riseMass) {
  const top = Math.max(peak, rise);
  return {
    coverage: cells / quadCells,
    height: Math.min(1, Math.max(0, top / EMIT_HEIGHT_MAX_U)),
    stack: Math.min(1, Math.max(0, stack / EMIT_HEIGHT_MAX_U)),
    cells,
    peak: top,
    rise,
    riseMass: Math.max(0, riseMass || 0),
    rate: rate > 0 ? rate : 1,
  };
}

/**
 * Face-adjacent columns in one quadrant are one pile.
 * A gap splits them. The quadrant edge splits them too, because each side has its own sample.
 * @param {{ key: number, x: number, z: number, wx: number, wz: number }[]} entries
 */
function pilesInQuadrant(entries) {
  const byKey = new Map();
  for (let i = 0; i < entries.length; i += 1) byKey.set(entries[i].key, entries[i]);
  const seen = new Set();
  const piles = [];
  for (let i = 0; i < entries.length; i += 1) {
    const start = entries[i];
    if (seen.has(start.key)) continue;
    const stack = [start];
    seen.add(start.key);
    let sx = 0;
    let sz = 0;
    let n = 0;
    const keys = [];
    while (stack.length) {
      const cur = stack.pop();
      keys.push(cur.key);
      sx += cur.wx;
      sz += cur.wz;
      n += 1;
      const next = [];
      if (cur.x > 0) next.push(cur.key - 1);
      if (cur.x + 1 < GRID_MAX) next.push(cur.key + 1);
      if (cur.z > 0) next.push(cur.key - GRID_MAX);
      if (cur.z + 1 < GRID_MAX) next.push(cur.key + GRID_MAX);
      for (let k = 0; k < next.length; k += 1) {
        const key = next[k];
        if (seen.has(key) || !byKey.has(key)) continue;
        seen.add(key);
        stack.push(byKey.get(key));
      }
    }
    const cx = sx / n;
    const cz = sz / n;
    piles.push({ cx, cz, cells: n, rate: pitchForWorld(cx, cz), keys });
  }
  piles.sort((a, b) => b.cells - a.cells || a.rate - b.rate);
  if (piles.length > PILE_NOTE_CAP) piles.length = PILE_NOTE_CAP;
  return piles;
}

/**
 * Each landing uses the pitch of the connected pile that contains it.
 * The cell's own place on the map is not a separate note.
 * @param {{ tl: { x: number, z: number, life: number }[], tr: { x: number, z: number, life: number }[], bl: { x: number, z: number, life: number }[], br: { x: number, z: number, life: number }[] }} pending
 * @param {Record<string, { keys: number[], cx: number, cz: number, rate: number }[]>} rawPiles
 * @param {Record<string, { id: number, rate: number }[]>} tracked
 */
function splashAtPilePitch(pending, rawPiles, tracked) {
  const splash = { tl: [], tr: [], bl: [], br: [] };
  const corners = ["tl", "tr", "bl", "br"];
  for (let c = 0; c < corners.length; c += 1) {
    const id = corners[c];
    const raw = rawPiles[id] || [];
    const notes = tracked[id] || [];
    const byKey = new Map();
    for (let i = 0; i < raw.length; i += 1) {
      const pile = raw[i];
      const note = notes[i];
      const rate = note?.rate > 0 ? note.rate : pile.rate;
      const pileId = note?.id;
      const keys = pile.keys || [];
      for (let k = 0; k < keys.length; k += 1) byKey.set(keys[k], { id: pileId, rate });
    }
    const hits = pending[id] || [];
    for (let i = 0; i < hits.length; i += 1) {
      const hit = hits[i];
      const key = hit.x + hit.z * GRID_MAX;
      let pile = byKey.get(key);
      if (!pile && raw.length) {
        const wx = worldXForCell(hit.x, ATOM_SIZE);
        const wz = worldZForCell(hit.z, ATOM_SIZE);
        let best = 0;
        let bestD = Infinity;
        for (let p = 0; p < raw.length; p += 1) {
          const d = Math.hypot(raw[p].cx - wx, raw[p].cz - wz);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        const note = notes[best];
        pile = { id: note?.id, rate: note?.rate > 0 ? note.rate : raw[best].rate };
      }
      splash[id].push({
        life: hit.life > 0 ? hit.life : 5,
        rate: pile?.rate > 0 ? pile.rate : 1,
        pileId: pile?.id,
        x: hit.x,
        z: hit.z,
      });
    }
  }
  return splash;
}

/**
 * Column key → playback rate of the pile that contains it.
 * @param {{ keys?: number[], rate: number }[]} raw
 * @param {{ rate: number }[]} tracked
 */
function pileRateByColumn(raw, tracked) {
  const map = new Map();
  for (let p = 0; p < raw.length; p += 1) {
    const rate = tracked[p]?.rate > 0 ? tracked[p].rate : raw[p].rate;
    const keys = raw[p].keys || [];
    for (let k = 0; k < keys.length; k += 1) map.set(keys[k], rate > 0 ? rate : 1);
  }
  return map;
}

/**
 * Keep a pile's note id while its center stays the nearest match.
 * A split leaves the nearer piece on the old note and starts a new one.
 * A join keeps one note and drops the other.
 * @param {string} corner
 * @param {{ cx: number, cz: number, cells: number, rate: number }[]} piles
 */
function trackPiles(corner, piles) {
  const prev = pileMemory[corner];
  const pairs = [];
  for (let i = 0; i < piles.length; i += 1) {
    for (let j = 0; j < prev.length; j += 1) {
      pairs.push({
        i,
        j,
        d: Math.hypot(piles[i].cx - prev[j].cx, piles[i].cz - prev[j].cz),
      });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const takenNew = new Set();
  const takenOld = new Set();
  const ids = new Array(piles.length);
  for (let p = 0; p < pairs.length; p += 1) {
    const pair = pairs[p];
    if (takenNew.has(pair.i) || takenOld.has(pair.j)) continue;
    ids[pair.i] = prev[pair.j].id;
    takenNew.add(pair.i);
    takenOld.add(pair.j);
  }
  let cells = 0;
  for (let i = 0; i < piles.length; i += 1) cells += piles[i].cells;
  const tracked = [];
  for (let i = 0; i < piles.length; i += 1) {
    const id = ids[i] || pileSerial++;
    tracked.push({
      id,
      cx: piles[i].cx,
      cz: piles[i].cz,
      rate: piles[i].rate,
      share: cells > 0 ? piles[i].cells / cells : 1,
    });
  }
  pileMemory[corner] = tracked.map((pile) => ({ id: pile.id, cx: pile.cx, cz: pile.cz }));
  return tracked.map((pile) => ({ id: pile.id, rate: pile.rate, share: pile.share }));
}

/** Describe the grid for sonification. Does not change the simulation. */
function captureAudioSnapshot(dt) {
  const pour = audioPour;
  const fallRate = audioFall;
  const deathRate = audioDeath;
  const splashHits = audioSplashAt.splice(0, audioSplashAt.length);
  audioPour = 0;
  audioFall = 0;
  audioDeath = 0;
  audioSplash = 0;
  audioGen += 1;

  const yaw = surface ? surface.rotation.y : 0;
  const viewPan = planeViewportPan();
  const splashPending = { tl: [], tr: [], bl: [], br: [] };
  const splashMid = GRID_MAX >> 1;
  for (let i = 0; i < splashHits.length; i += 1) {
    const hit = splashHits[i];
    const id = hit.x < splashMid ? (hit.z < splashMid ? "tl" : "bl") : hit.z < splashMid ? "tr" : "br";
    splashPending[id].push(hit);
  }
  const zoomSpan = CAMERA_DIST_MAX - CAMERA_DIST_MIN;
  const zoom = zoomSpan > 0 ? (cameraDist - CAMERA_DIST_MIN) / zoomSpan : 0;
  const presence = cameraPresence();

  let sumW = 0;
  let sumX = 0;
  let sumZ = 0;
  let sumXX = 0;
  let sumZZ = 0;
  let sumH = 0;
  let count = 0;
  let fallingN = 0;
  let settledN = 0;
  let floorN = 0;
  let dieSum = 0;
  let maxTop = 0;
  let stackedN = 0;
  const mid = GRID_MAX >> 1;
  const quadCells = mid * mid;
  const fp = { tl: 0, tr: 0, bl: 0, br: 0 };
  const peak = { tl: 0, tr: 0, bl: 0, br: 0 };
  /** Tallest resting column, world units. Rising grains are not included. */
  const stackPeak = { tl: 0, tr: 0, bl: 0, br: 0 };
  const panSum = { tl: 0, tr: 0, bl: 0, br: 0 };
  const pileCols = { tl: [], tr: [], bl: [], br: [] };
  /** Drawn scale of every grain that is currently rising. One full-size atom is 1. */
  const riseMass = { tl: 0, tr: 0, bl: 0, br: 0 };
  /** @type {{ id: number, corner: string, x: number, z: number, key: number, scale: number, t: number, pan: number, rate?: number }[]} */
  const riseAtoms = [];

  if (cells && occupied.size > 0 && posX && posZ && posY) {
    for (let c = 0; c < columnKeys.length; c += 1) {
      const list = columns.get(columnKeys[c]);
      const key = columnKeys[c];
      const colX = key % GRID_MAX;
      const colZ = (key / GRID_MAX) | 0;
      const id = colX < mid ? (colZ < mid ? "tl" : "bl") : (colZ < mid ? "tr" : "br");
      let n = 0;
      let top = 0;
      let stackTop = 0;
      for (let k = 0; k < list.length; k += 1) {
        const i = list[k];
        if (cells[i] <= 0 || !materialSonifies(cells[i])) continue;
        n += 1;
        const decoded = decodeCell(i);
        const half = atomExtent(decoded.x, decoded.y, decoded.z, cells[i]) * 0.5;
        const yCenter = posY[i] > 0 ? posY[i] : half;
        // Rising grains (diffuse blow) count at the height they are drawn, not the cell they left.
        const lift = (riseT?.[i] || 0) > 0 ? riseOffset(decoded.x, decoded.y, decoded.z) : 0;
        const restTip = yCenter + half;
        const tip = restTip + lift;
        if (tip > top) top = tip;
        if (lift <= 0 && restTip > stackTop) stackTop = restTip;
      }
      if (top > maxTop) maxTop = top;
      if (n > 1) stackedN += n;
      if (n > 0) {
        fp[id] += 1;
        if (top > peak[id]) peak[id] = top;
        if (stackTop > stackPeak[id]) stackPeak[id] = stackTop;
        const colXw = worldXForCell(colX, ATOM_SIZE);
        const colZw = worldZForCell(colZ, ATOM_SIZE);
        panSum[id] += screenPan(colXw, colZw, yaw);
        pileCols[id].push({ key, x: colX, z: colZ, wx: colXw, wz: colZw });
      }
    }

    for (const i of occupied) {
      if (cells[i] <= 0 || !materialSonifies(cells[i])) continue;
      const resting = restingFlags?.[i] === 1;
      const onFloor = onFloorFlags?.[i] === 1;
      const sameAbove = sameAboveFlags?.[i] === 1;
      const dying = onFloor ? clockProgress(i) : 0;
      const ax = i % GRID_MAX;
      const az = ((i / GRID_MAX) | 0) % GRID_MAX;
      const aid = ax < mid ? (az < mid ? "tl" : "bl") : az < mid ? "tr" : "br";
      const risingNow = (riseT?.[i] || 0) > 0;
      if (risingNow) {
        const t = Math.min(1, riseT[i]);
        const visual = Math.max(0.02, 1 - t);
        const poured = cellAtomSize(i) / ATOM_SIZE;
        const scale = visual * (poured > 0 ? poured : 1);
        riseMass[aid] += scale;
        const wx = posX[i];
        const wz = posZ[i];
        const decoded = decodeCell(i);
        const half = atomExtent(decoded.x, decoded.y, decoded.z, cells[i]) * 0.5;
        const yCenter = posY[i] > 0 ? posY[i] : half;
        const tip = yCenter + half + riseOffset(decoded.x, decoded.y, decoded.z);
        riseAtoms.push({
          id: grainAudioId(i),
          corner: aid,
          x: ax,
          z: az,
          key: ax + az * GRID_MAX,
          scale,
          t,
          tip,
          pan: Math.min(1, Math.max(-1, screenPan(wx, wz, yaw) + viewPan)),
        });
      }
      const w = activityWeight(resting, onFloor, sameAbove, dying);
      const x = posX[i];
      const z = posZ[i];
      const yCenter = posY[i] > 0 ? posY[i] : 0;
      sumW += w;
      sumX += w * x;
      sumZ += w * z;
      sumXX += w * x * x;
      sumZZ += w * z * z;
      sumH += yCenter;
      count += 1;
      if (!resting) fallingN += 1;
      if (onFloor && resting && !sameAbove) settledN += 1;
      if (onFloor) {
        floorN += 1;
        dieSum += dying;
      }
    }
  }

  let fieldX = 0.5;
  let fieldZ = 0.5;
  let spread = 0;
  if (sumW > 0) {
    const cx = sumX / sumW;
    const cz = sumZ / sumW;
    fieldX = (cx + PLAYFIELD_HALF) / PLAYFIELD_SPAN;
    fieldZ = (cz + PLAYFIELD_HALF) / PLAYFIELD_SPAN;
    const radial = sumXX + sumZZ - sumW * (cx * cx + cz * cz);
    const rms = Math.sqrt(Math.max(0, radial) / sumW);
    spread = Math.min(1, rms / (PLAYFIELD_HALF * Math.SQRT2));
  }

  const rawPiles = {
    tl: pilesInQuadrant(pileCols.tl),
    tr: pilesInQuadrant(pileCols.tr),
    bl: pilesInQuadrant(pileCols.bl),
    br: pilesInQuadrant(pileCols.br),
  };
  const piles = {
    tl: trackPiles("tl", rawPiles.tl),
    tr: trackPiles("tr", rawPiles.tr),
    bl: trackPiles("bl", rawPiles.bl),
    br: trackPiles("br", rawPiles.br),
  };
  const splash = splashAtPilePitch(splashPending, rawPiles, piles);
  const crowdRise = {
    tl: crowdedRiseHeight(riseAtoms, "tl"),
    tr: crowdedRiseHeight(riseAtoms, "tr"),
    bl: crowdedRiseHeight(riseAtoms, "bl"),
    br: crowdedRiseHeight(riseAtoms, "br"),
  };
  const pileRate = (list) => (list.length ? list[0].rate : 1);
  const riseRates = {
    tl: pileRateByColumn(rawPiles.tl, piles.tl),
    tr: pileRateByColumn(rawPiles.tr, piles.tr),
    bl: pileRateByColumn(rawPiles.bl, piles.bl),
    br: pileRateByColumn(rawPiles.br, piles.br),
  };
  for (let r = 0; r < riseAtoms.length; r += 1) {
    const atom = riseAtoms[r];
    const rate = riseRates[atom.corner]?.get(atom.key);
    atom.rate = rate > 0 ? rate : 1;
    atom.crowd = crowdRise[atom.corner] || 0;
  }

  audioSnap = {
    field: {
      x: Math.min(1, Math.max(0, fieldX)),
      z: Math.min(1, Math.max(0, fieldZ)),
    },
    spread,
    height: Math.min(1, Math.max(0, maxTop / EMIT_HEIGHT_MAX_U)),
    meanHeight: count > 0 ? Math.min(1, Math.max(0, sumH / count / EMIT_HEIGHT_MAX_U)) : 0,
    stacked: count > 0 ? stackedN / count : 0,
    falling: count > 0 ? fallingN / count : 0,
    dying: floorN > 0 ? dieSum / floorN : 0,
    settled: count > 0 ? settledN / count : 0,
    pour,
    fallRate,
    deathRate,
    weight: sumW,
    mass: count,
    quads: {
      tl: quadAudio(fp.tl, peak.tl, crowdRise.tl, stackPeak.tl, pileRate(piles.tl), quadCells, riseMass.tl),
      tr: quadAudio(fp.tr, peak.tr, crowdRise.tr, stackPeak.tr, pileRate(piles.tr), quadCells, riseMass.tr),
      bl: quadAudio(fp.bl, peak.bl, crowdRise.bl, stackPeak.bl, pileRate(piles.bl), quadCells, riseMass.bl),
      br: quadAudio(fp.br, peak.br, crowdRise.br, stackPeak.br, pileRate(piles.br), quadCells, riseMass.br),
    },
    piles,
    rises: riseAtoms,
    pans: {
      tl: fp.tl > 0 ? Math.min(1, Math.max(-1, panSum.tl / fp.tl + viewPan)) : 0,
      tr: fp.tr > 0 ? Math.min(1, Math.max(-1, panSum.tr / fp.tr + viewPan)) : 0,
      bl: fp.bl > 0 ? Math.min(1, Math.max(-1, panSum.bl / fp.bl + viewPan)) : 0,
      br: fp.br > 0 ? Math.min(1, Math.max(-1, panSum.br / fp.br + viewPan)) : 0,
    },
    splash,
    view: {
      yaw,
      zoom: Math.min(1, Math.max(0, zoom)),
      near: presence.near,
      far: presence.far,
    },
    gen: audioGen,
  };
}

const GRID_SNAP_IDLE = {
  field: { x: 0.5, z: 0.5 },
  spread: 0,
  height: 0,
  meanHeight: 0,
  stacked: 0,
  falling: 0,
  dying: 0,
  settled: 0,
  pour: 0,
  fallRate: 0,
  deathRate: 0,
  weight: 0,
  mass: 0,
  quads: {
    tl: { coverage: 0, height: 0, cells: 0, peak: 0, rise: 0, riseMass: 0, rate: 1 },
    tr: { coverage: 0, height: 0, cells: 0, peak: 0, rise: 0, riseMass: 0, rate: 1 },
    bl: { coverage: 0, height: 0, cells: 0, peak: 0, rise: 0, riseMass: 0, rate: 1 },
    br: { coverage: 0, height: 0, cells: 0, peak: 0, rise: 0, riseMass: 0, rate: 1 },
  },
  piles: { tl: [], tr: [], bl: [], br: [] },
  rises: [],
  pans: { tl: 0, tr: 0, bl: 0, br: 0 },
  splash: { tl: [], tr: [], bl: [], br: [] },
  view: {
    yaw: 0,
    zoom: (CAMERA_DIST_DEFAULT - CAMERA_DIST_MIN) / (CAMERA_DIST_MAX - CAMERA_DIST_MIN),
    near: 0,
    far: 0,
  },
  gen: 0,
};

/** Latest grid description for the audio adapter. Idle until the sim has stepped. */
export function readGridSnapshot() {
  return audioSnap || GRID_SNAP_IDLE;
}

export async function showFallingBlocks(nextCanvas, isCurrent = () => true) {
  try {
    await loadCatalog();
    // A tab switch during the catalog load must not attach over a newer show or a hide.
    if (!isCurrent()) return;
    if (!scene) initScene(nextCanvas);
    else {
      canvas = nextCanvas;
      wrap = canvas.parentElement;
      buildPalette();
      fpsEl = document.querySelector("[data-falling-fps]");
      atomsEl = document.querySelector("[data-falling-atoms]");
      trisEl = document.querySelector("[data-falling-tris]");
      gpuEl = document.querySelector("[data-falling-gpu]");
      fpsFrames = 0;
      fpsLastAt = 0;
    }
    bindAboutUi();
    bindFpsUi();
    bindSettingsUi();
    bindClearUi();
    fallingInput.attach(canvas);
    installSimHook();
    running = true;
    sizeTries = 0;
    canvas.tabIndex = -1;
    if (!document.querySelector("dialog[open]")) canvas.focus({ preventScroll: true });
    startRenderLoop();
  } catch (err) {
    console.error("EchoScape falling blocks init failed:", err);
    showError(`3D view failed to start: ${err.message}`);
  }
}

export function hideFallingBlocks() {
  running = false;
  document.body.classList.remove("has-dualsense");
  if (canvas) canvas.style.filter = "";
  fallingInput.detach();
  emitting = false;
  shiftStream = false;
  canvas?.classList.remove("is-emitting", "is-single-stream");
  emitAcc = 0;
  if (rafId) window.cancelAnimationFrame(rafId);
  rafId = 0;
  fpsFrames = 0;
  fpsLastAt = 0;
}
