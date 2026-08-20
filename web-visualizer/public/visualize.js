import * as THREE from "three";
import { controller, mix, state } from "./mixer-core.js?v=59";

const QUADS = [
  { key: "tl", name: "Forest", terrain: "Ridges", color: 0x5a5058 },
  { key: "tr", name: "Beach", terrain: "Terraces", color: 0x454e5c },
  { key: "bl", name: "Meditation", terrain: "Craters", color: 0x4a5c64 },
  { key: "br", name: "River", terrain: "Canals", color: 0x4a574e },
];

const FX = {
  cross: { label: "X", color: 0xadb2ba, effect: "ripple" },
  square: { label: "Square", color: 0xbdb5ad, effect: "waves" },
  triangle: { label: "Triangle", color: 0xb5adb8, effect: "drift" },
  circle: { label: "Circle", color: 0xf0f0f0, effect: "rings" },
};

const STYLE_KEYS = ["tl", "tr", "bl", "br"];
const STYLE_LOOK = {
  tl: { meshOpacity: 0.42 },
  tr: { meshOpacity: 0.4 },
  bl: { meshOpacity: 0.44 },
  br: { meshOpacity: 0.43 },
};

const SCENE_BG = 0x000000;
const STICK_DEADZONE = 0.1;
const SPHERE_RADIUS = 14;
const SPHERE_W = 256;
const SPHERE_H = 192;
const CAMERA_SPAN = 42;
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 2.6;
const ZOOM_DEFAULT = 1.15;
const MIX_GAMMA = 2.35;
const HEIGHT_SCALE = 1.35;

let scene = null;
let renderer = null;
let camera = null;
let landscape = null;
let terrainGeo = null;
let occluder = null;
let meshLines = null;
let particlePoints = null;
let canvas = null;
let wrap = null;
let rafId = 0;
let running = false;
let clock = 0;
let lastNow = 0;
let resizeObserver = null;
let unsubscribe = null;
let sizeTries = 0;
let heightFields = null;
let fpsFrames = 0;
let fpsLastAt = 0;
let fpsEl = null;
let vertsEl = null;
let flagsEl = null;
let displaceHooked = false;
const styleMix = {
  tl: 0.25,
  tr: 0.25,
  bl: 0.25,
  br: 0.25,
};

const stickOrbit = {
  yaw: 0,
  pitch: 0,
  zoom: ZOOM_DEFAULT,
};

function readStick(value) {
  const mag = Math.abs(value);
  if (mag < STICK_DEADZONE) return 0;
  const sign = Math.sign(value);
  return sign * ((mag - STICK_DEADZONE) / (1 - STICK_DEADZONE));
}

const STICK_FX_TAU = 0.11;
const stickFx = {
  x: 0,
  y: 0,
  mag: 0,
  drive: 0,
  amp: 0,
  rate: 0.08,
  spread: 0.2,
  lift: 0.2,
};
const latchedFx = {
  x: 0,
  y: 0,
  mag: 0,
  drive: 0,
  amp: 0,
  rate: 0.08,
  spread: 0.2,
  lift: 0.2,
};
let stickFxOwner = null;
const fxPhase = {
  ripple: 0,
  waveA: 0,
  waveB: 0,
  waveC: 0,
  drift: 0,
  rings: 0,
  swirl: 0,
};

function smoothToward(current, target, dt, tau) {
  if (!(dt > 0)) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

function resetStickFx() {
  stickFx.x = 0;
  stickFx.y = 0;
  stickFx.mag = 0;
  stickFx.drive = 0;
  stickFx.amp = 0;
  stickFx.rate = 0.08;
  stickFx.spread = 0.2;
  stickFx.lift = 0.2;
  latchedFx.x = 0;
  latchedFx.y = 0;
  latchedFx.mag = 0;
  latchedFx.drive = 0;
  latchedFx.amp = 0;
  latchedFx.rate = 0.08;
  latchedFx.spread = 0.2;
  latchedFx.lift = 0.2;
}

function copyStickFx(from, to) {
  to.x = from.x;
  to.y = from.y;
  to.mag = from.mag;
  to.drive = from.drive;
  to.amp = from.amp;
  to.rate = from.rate;
  to.spread = from.spread;
  to.lift = from.lift;
}

function leftStickParams(ctrl, dt = 0) {
  // Face-button change clears latched stick FX.
  // Most FX latch on stick release; Triangle always follows the stick so it can recompose.
  if (stickFxOwner !== ctrl.activeFx) {
    stickFxOwner = ctrl.activeFx;
    resetStickFx();
  }

  const x = readStick(ctrl.rawX);
  const y = readStick(ctrl.rawY);
  const mag = Math.min(1, Math.hypot(x, y));
  const engaged = mag > 0.001;
  const isTriangle = ctrl.activeFx === "triangle";

  if (engaged || isTriangle) {
    const drive = mag * mag;
    const target = {
      x,
      y,
      mag,
      drive,
      amp: drive * (0.55 + ((y + 1) * 0.5) * 2.1),
      rate: 0.08 + ((x + 1) * 0.5) * 2.7,
      spread: 0.2 + ((x + 1) * 0.5) * 1.4,
      lift: 0.2 + ((y + 1) * 0.5) * 1.6,
    };
    const tau = isTriangle && !engaged ? STICK_FX_TAU * 0.65 : STICK_FX_TAU;
    stickFx.x = smoothToward(stickFx.x, target.x, dt, tau);
    stickFx.y = smoothToward(stickFx.y, target.y, dt, tau);
    stickFx.mag = smoothToward(stickFx.mag, target.mag, dt, tau);
    stickFx.drive = smoothToward(stickFx.drive, target.drive, dt, tau);
    stickFx.amp = smoothToward(stickFx.amp, target.amp, dt, tau);
    stickFx.rate = smoothToward(stickFx.rate, target.rate, dt, tau);
    stickFx.spread = smoothToward(stickFx.spread, target.spread, dt, tau);
    stickFx.lift = smoothToward(stickFx.lift, target.lift, dt, tau);
    if (engaged && !isTriangle) copyStickFx(stickFx, latchedFx);
  } else {
    copyStickFx(latchedFx, stickFx);
  }

  return stickFx;
}

function advanceFxPhase(fx, dt) {
  if (!(dt > 0)) return;
  fxPhase.ripple += (0.22 + fx.rate * 2.8) * dt;
  fxPhase.waveA += (0.18 + fx.rate * 1.8) * dt;
  fxPhase.waveB += (0.14 + fx.rate * 1.4) * dt;
  fxPhase.waveC += (0.1 + fx.rate) * dt;
  fxPhase.drift += (0.12 + fx.rate * 1.2) * dt;
  fxPhase.rings += (0.28 + fx.rate * 3.2) * dt;
  fxPhase.swirl += (0.08 + fx.rate * 1.1) * dt;
}

const FX_MODE = { ripple: 1, waves: 2, rings: 3, drift: 4 };

const gpuShared = {
  uMix: { value: new THREE.Vector4(0.25, 0.25, 0.25, 0.25) },
  uFxMode: { value: 1 },
  uLive: { value: 0 },
  uStick: { value: new THREE.Vector2() },
  uMag: { value: 0 },
  uAmp: { value: 0 },
  uPulse: { value: 0 },
  uRate: { value: 0.08 },
  uLift: { value: 0.2 },
  uPhase: { value: new THREE.Vector4() },
  uPhase2: { value: new THREE.Vector2() },
  uState: { value: new THREE.Vector2(0.5, 0.5) },
  uRadius: { value: SPHERE_RADIUS },
  uPointSize: { value: 1.35 },
};

const TERRAIN_VERT = `
attribute float hTl;
attribute float hTr;
attribute float hBl;
attribute float hBr;
uniform vec4 uMix;
uniform float uFxMode;
uniform float uLive;
uniform vec2 uStick;
uniform float uMag;
uniform float uAmp;
uniform float uPulse;
uniform float uRate;
uniform float uLift;
uniform vec4 uPhase;
uniform vec2 uPhase2;
uniform vec2 uState;
uniform float uRadius;
uniform float uPointSize;
varying float vEchoH;
varying highp vec3 vWorld;

float echoHash(float i) {
  return fract(sin(i * 127.1 + 311.7) * 43758.5453);
}

vec3 stateDir(vec2 st) {
  float lon = (st.x - 0.5) * 6.2831853;
  float lat = (0.5 - st.y) * 3.14159265;
  float cl = cos(lat);
  return normalize(vec3(sin(lon) * cl, sin(lat), cos(lon) * cl));
}

vec3 stickDir(vec2 st) {
  // Aim across the facing hemisphere from stick
  return normalize(vec3(st.x * 1.35, st.y * 1.35, 1.15));
}

vec3 echoDisplace(vec3 pos) {
  vec3 nrm = normalize(pos);
  float bump = hTl * uMix.x + hTr * uMix.y + hBl * uMix.z + hBr * uMix.w;
  float r = uRadius + bump;
  vec3 tang = vec3(0.0);

  if (uLive > 0.5) {
    if (uFxMode < 1.5) {
      vec3 m = stateDir(uState);
      float dist = acos(clamp(dot(nrm, m), -1.0, 1.0)) * uRadius;
      float rings = 0.22 + uRate * 0.38;
      float ripple = sin(dist * rings - uPhase.x);
      float falloff = exp(-dist * 0.035);
      bump += ripple * uAmp * falloff * (0.5 + uLift * 0.75);
    } else if (uFxMode < 2.5) {
      float lon = atan(nrm.x, nrm.z);
      float lat = asin(clamp(nrm.y, -1.0, 1.0));
      float freq = 0.18 + uRate * 0.38;
      float wave =
        sin(lon * (6.0 + freq * 8.0) + uPhase.y) * 0.55 +
        cos(lat * (8.0 + freq * 6.0) - uPhase.z) * 0.4 +
        sin((lon + lat) * (5.0 + freq * 5.0) + uPhase.w) * 0.7;
      bump += wave * uAmp;
    } else if (uFxMode < 3.5) {
      vec3 m = stickDir(uStick);
      float dist = acos(clamp(dot(nrm, m), -1.0, 1.0)) * uRadius;
      float freq = 0.26 + uRate * 0.55;
      float wave = sin(dist * freq - uPhase2.y);
      float falloff = exp(-dist * (0.02 + (1.0 - uMag) * 0.016));
      bump += wave * uAmp * falloff * (0.75 + uLift * 0.95) * (1.0 + uPulse * 0.55);
    } else {
      float motion = min(1.0, uMag + uPulse * 0.65);
      if (motion > 0.001) {
        float n = echoHash(nrm.x * 17.3 + nrm.z * 91.7 + 3.0);
        float n2 = echoHash(nrm.x * 41.1 + nrm.y * 13.9 + 19.0);
        vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), nrm));
        if (length(east) < 0.001) east = vec3(1.0, 0.0, 0.0);
        vec3 north = normalize(cross(nrm, east));
        float ampK = 1.15 + uAmp * 3.4 + uPulse * 1.2;
        float rise = uStick.y * (2.4 + n * 6.5) * (0.4 + uMag * 2.1) * ampK;
        float bob = sin(uPhase2.x + n * 12.0) * abs(uStick.y) * 0.55 * ampK;
        float fallPull = uStick.y < 0.0 ? uStick.y * (1.6 + n2 * 4.0) * (0.55 + uMag) * ampK : 0.0;
        float sway = uStick.x * (1.1 + n2 * 3.4) * (0.35 + uMag) * ampK;
        float wander = sin(uPhase2.x * 0.7 + n2 * 9.0) * abs(uStick.x) * 1.35 * ampK;
        bump += (rise + bob + fallPull + uPulse * (0.45 + n * 0.9) * ampK) * motion;
        tang += (east * (sway + wander) + north * cos(uPhase2.x + n * 7.0) * abs(uStick.x) * 1.4 * ampK) * motion;
      }
    }
  }

  r = uRadius + bump;
  vec3 p = nrm * r + tang;
  vEchoH = bump;
  return p;
}

void main() {
  vec3 p = echoDisplace(position);
  vWorld = p;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uPointSize * (0.75 + uMag * 0.3) * (42.0 / max(2.0, -mv.z));
}
`;

const TERRAIN_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uDoFlat;
varying float vEchoH;
varying highp vec3 vWorld;

void main() {
  vec3 c = uColor;
  if (uDoFlat > 0.5) {
    // Soft Lambert — prefer outward-facing normals on the sphere
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (dot(n, vWorld) < 0.0) n = -n;
    vec3 lightDir = normalize(vec3(0.42, 0.82, 0.38));
    float ndl = clamp(dot(n, lightDir), 0.0, 1.0);
    float shade = 0.34 + 0.66 * ndl;
    c *= shade;
  }
  gl_FragColor = vec4(c, uOpacity);
  #include <colorspace_fragment>
}
`;

const POINT_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  if (dot(p, p) > 0.25) discard;
  gl_FragColor = vec4(uColor, uOpacity);
  #include <colorspace_fragment>
}
`;

function sharedTerrainUniforms(extra) {
  return Object.assign(
    {
      uMix: gpuShared.uMix,
      uFxMode: gpuShared.uFxMode,
      uLive: gpuShared.uLive,
      uStick: gpuShared.uStick,
      uMag: gpuShared.uMag,
      uAmp: gpuShared.uAmp,
      uPulse: gpuShared.uPulse,
      uRate: gpuShared.uRate,
      uLift: gpuShared.uLift,
      uPhase: gpuShared.uPhase,
      uPhase2: gpuShared.uPhase2,
      uState: gpuShared.uState,
      uRadius: gpuShared.uRadius,
      uPointSize: gpuShared.uPointSize,
      uDoFlat: { value: 0 },
      uColor: { value: new THREE.Color(0x666666) },
      uOpacity: { value: 1 },
    },
    extra,
  );
}

function makeTerrainMaterial(opts) {
  const uniforms = sharedTerrainUniforms({
    uDoFlat: { value: opts.flatShade ? 1 : 0 },
    uColor: { value: new THREE.Color(opts.color) },
    uOpacity: { value: opts.opacity ?? 1 },
  });
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    wireframe: !!opts.wireframe,
    transparent: !!opts.transparent,
    depthTest: true,
    depthWrite: opts.depthWrite !== false,
    fog: false,
    toneMapped: false,
    side: THREE.FrontSide,
    polygonOffset: !!opts.polygonOffset,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 2,
  });
  displaceHooked = true;
  return mat;
}

function makeParticleMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: sharedTerrainUniforms({
      uColor: { value: new THREE.Color(0xf0f0f0) },
      uOpacity: { value: 0.9 },
    }),
    vertexShader: TERRAIN_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });
}

const _lookAt = new THREE.Vector3();

function showVizError(message) {
  const el = document.querySelector("[data-viz-error]");
  if (el) {
    el.hidden = false;
    el.textContent = message;
  }
}

function clearVizError() {
  const el = document.querySelector("[data-viz-error]");
  if (el) el.hidden = true;
}

function blendColor(weights) {
  const c = new THREE.Color(0, 0, 0);
  for (const quad of QUADS) {
    const w = weights[quad.key] || 0;
    if (w <= 0) continue;
    const part = new THREE.Color(quad.color);
    c.r += part.r * w;
    c.g += part.g * w;
    c.b += part.b * w;
  }
  return c;
}

function wrapMod(value, size) {
  return ((value % size) + size) % size;
}

function sphereSurf(x, y, z) {
  // Arc-length-ish lon/lat so lattice periods sit evenly on the globe
  const nx = x / SPHERE_RADIUS;
  const ny = y / SPHERE_RADIUS;
  const nz = z / SPHERE_RADIUS;
  const lon = Math.atan2(nx, nz);
  const lat = Math.asin(Math.max(-1, Math.min(1, ny)));
  return { s: lon * SPHERE_RADIUS, t: lat * SPHERE_RADIUS };
}

function heightCross(s, t) {
  // Ridge lattice wrapping the sphere (Forest)
  const period = 8;
  const lx = wrapMod(s + period * 0.5, period) - period * 0.5;
  const lz = wrapMod(t + period * 0.5, period) - period * 0.5;
  const ridgeX = Math.exp(-lx * lx * 0.42);
  const ridgeZ = Math.exp(-lz * lz * 0.42);
  const node = Math.exp(-(lx * lx + lz * lz) * 0.28);
  const weave =
    Math.sin((s / period) * Math.PI * 2) * Math.sin((t / period) * Math.PI * 2) * 0.28;
  return ridgeX * 1.45 + ridgeZ * 1.45 + node * 1.05 + weave - 0.4;
}

function heightSquare(s, t) {
  // Even stepped terraces (Beach)
  const cell = 12;
  const lx = wrapMod(s + cell * 0.5, cell) - cell * 0.5;
  const lz = wrapMod(t + cell * 0.5, cell) - cell * 0.5;
  const cheb = Math.max(Math.abs(lx), Math.abs(lz));
  const half = cell * 0.38;
  if (cheb > half) return -0.15;
  const steps = 5;
  const u = 1 - cheb / half;
  const leveled = Math.floor(u * steps) / steps;
  const soft = leveled + (u * steps - Math.floor(u * steps)) * 0.12;
  return soft * 2.2 - 0.2;
}

function heightTriangle(s, t) {
  // Hex peaks / bowls (Meditation)
  const cell = 5.2;
  const q = ((Math.sqrt(3) / 3) * s - t / 3) / cell;
  const r = ((2 / 3) * t) / cell;
  const qn = Math.round(q);
  const rn = Math.round(r);
  const cx = cell * (Math.sqrt(3) * qn + (Math.sqrt(3) / 2) * rn);
  const cz = cell * (1.5 * rn);
  const d = Math.hypot(s - cx, t - cz);
  const peak = Math.exp(-d * d * 0.22) * 2.35;
  const crater =
    Math.tanh((d - 1.15) * 2.4) * 0.75 - Math.exp(-d * d * 1.35) * 1.35;
  return (qn + rn) & 1 ? peak : crater * 1.05;
}

function heightCircle(s, t) {
  // Diamond canals (River)
  const u = (s + t) * 0.7071;
  const v = (t - s) * 0.7071;
  const cell = 7.2;
  const lu = wrapMod(u, cell) - cell * 0.5;
  const lv = wrapMod(v, cell) - cell * 0.5;
  const diamond = Math.abs(lu) + Math.abs(lv);
  const canal = Math.max(0, 1.1 - diamond * 0.5);
  const ridge = Math.max(0, diamond - 1.55) * 0.32;
  const iu = Math.floor(wrapMod(u + cell * 50, cell * 100) / cell);
  const iv = Math.floor(wrapMod(v + cell * 50, cell * 100) / cell);
  const bank = ((iu + iv) & 1) === 0 ? 0.4 : -0.2;
  return canal * 2.0 + ridge + bank;
}

const HEIGHT_FNS = {
  tl: heightCross,
  tr: heightSquare,
  bl: heightTriangle,
  br: heightCircle,
};

function dominantStyle() {
  let best = "tl";
  let bestW = -1;
  for (const key of STYLE_KEYS) {
    if (styleMix[key] > bestW) {
      bestW = styleMix[key];
      best = key;
    }
  }
  return best;
}

function syncStyleMix(weights) {
  let sum = 0;
  for (const key of STYLE_KEYS) {
    const boosted = Math.pow(Math.max(0, weights[key] || 0), MIX_GAMMA);
    styleMix[key] = boosted;
    sum += boosted;
  }
  if (sum <= 1e-6) {
    for (const key of STYLE_KEYS) styleMix[key] = 0.25;
    return;
  }
  for (const key of STYLE_KEYS) styleMix[key] /= sum;
}

function bakeHeightFields(geo) {
  const pos = geo.attributes.position;
  const count = pos.count;
  heightFields = {
    tl: new Float32Array(count),
    tr: new Float32Array(count),
    bl: new Float32Array(count),
    br: new Float32Array(count),
  };
  for (let i = 0; i < count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const { s, t } = sphereSurf(x, y, z);
    heightFields.tl[i] = heightCross(s, t) * HEIGHT_SCALE;
    heightFields.tr[i] = heightSquare(s, t) * HEIGHT_SCALE;
    heightFields.bl[i] = heightTriangle(s, t) * HEIGHT_SCALE;
    heightFields.br[i] = heightCircle(s, t) * HEIGHT_SCALE;
  }
  geo.setAttribute("hTl", new THREE.BufferAttribute(heightFields.tl, 1));
  geo.setAttribute("hTr", new THREE.BufferAttribute(heightFields.tr, 1));
  geo.setAttribute("hBl", new THREE.BufferAttribute(heightFields.bl, 1));
  geo.setAttribute("hBr", new THREE.BufferAttribute(heightFields.br, 1));
}

function syncTerrainUniforms(ctrl, dt) {
  const effect = FX[ctrl.activeFx]?.effect || "ripple";
  const pulse = ctrl.pulse || 0;
  const fx = leftStickParams(ctrl, dt);
  advanceFxPhase(fx, dt);
  const isDrift = effect === "drift";
  const liveFx = isDrift || fx.drive > 0.002 || pulse > 0.02;
  gpuShared.uMix.value.set(styleMix.tl, styleMix.tr, styleMix.bl, styleMix.br);
  gpuShared.uFxMode.value = FX_MODE[effect] || 1;
  gpuShared.uLive.value = liveFx ? 1 : 0;
  gpuShared.uStick.value.set(fx.x, fx.y);
  gpuShared.uMag.value = fx.mag;
  gpuShared.uAmp.value = fx.amp * (1 + pulse * 0.85);
  gpuShared.uPulse.value = pulse;
  gpuShared.uRate.value = fx.rate;
  gpuShared.uLift.value = fx.lift;
  gpuShared.uPhase.value.set(fxPhase.ripple, fxPhase.waveA, fxPhase.waveB, fxPhase.waveC);
  gpuShared.uPhase2.value.set(fxPhase.drift, fxPhase.rings);
  gpuShared.uState.value.set(state.x, state.y);
  return { effect, pulse, fx, flying: isDrift && (fx.drive > 0.02 || pulse > 0.05) };
}

function buildLandscape() {
  const group = new THREE.Group();
  terrainGeo = new THREE.SphereGeometry(SPHERE_RADIUS, SPHERE_W, SPHERE_H);
  bakeHeightFields(terrainGeo);
  syncStyleMix(mix(state.x, state.y));
  syncTerrainUniforms(controller, 0);

  occluder = new THREE.Mesh(
    terrainGeo,
    makeTerrainMaterial({
      color: 0xb0b0b0,
      opacity: 1,
      flatShade: true,
      polygonOffset: true,
      depthWrite: true,
    }),
  );
  occluder.renderOrder = 0;

  meshLines = new THREE.Mesh(
    terrainGeo,
    makeTerrainMaterial({
      color: 0x6a6a6a,
      opacity: 0.55,
      wireframe: true,
      transparent: true,
      depthWrite: false,
    }),
  );
  meshLines.renderOrder = 1;

  particlePoints = new THREE.Points(terrainGeo, makeParticleMaterial());
  particlePoints.frustumCulled = false;
  particlePoints.renderOrder = 3;
  particlePoints.visible = false;

  group.add(occluder, meshLines, particlePoints);
  return group;
}

function syncCamera(ctrl, dt) {
  if (!camera) return;

  const rx = readStick(ctrl.rightX);
  const ry = readStick(ctrl.rightY);
  if (rx !== 0) stickOrbit.yaw -= rx * 1.45 * dt;
  if (ry !== 0) {
    stickOrbit.zoom = THREE.MathUtils.clamp(
      stickOrbit.zoom * Math.exp(-ry * 1.15 * dt),
      ZOOM_MIN,
      ZOOM_MAX,
    );
  }

  const radius = CAMERA_SPAN * stickOrbit.zoom;
  const yaw = stickOrbit.yaw;
  const pitch = THREE.MathUtils.clamp(0.42 + stickOrbit.pitch, 0.12, 1.35);
  const cosPitch = Math.cos(pitch);

  _lookAt.set(0, 0, 0);
  camera.position.set(
    radius * cosPitch * Math.sin(yaw),
    radius * Math.sin(pitch),
    radius * cosPitch * Math.cos(yaw),
  );
  camera.lookAt(_lookAt);
}

function applyScene(weights, ctrl, dt) {
  if (!camera || !landscape) return;

  syncStyleMix(weights);
  const { pulse, fx, flying } = syncTerrainUniforms(ctrl, dt);
  syncCamera(ctrl, dt);

  const tint = blendColor(weights);
  const look = STYLE_LOOK[dominantStyle()];

  if (occluder) {
    occluder.visible = !flying;
    occluder.material.uniforms.uColor.value.copy(tint).lerp(new THREE.Color(0xd0d0d0), 0.5);
  }
  if (meshLines) {
    meshLines.visible = true;
    meshLines.material.uniforms.uColor.value.copy(tint).lerp(new THREE.Color(0xffffff), flying ? 0.82 : 0.7);
    meshLines.material.uniforms.uOpacity.value = Math.min(
      1,
      (flying ? look.meshOpacity + 0.2 : look.meshOpacity) + fx.mag * 0.06 + pulse * 0.08,
    );
  }
  if (particlePoints) {
    particlePoints.visible = flying;
    particlePoints.material.uniforms.uColor.value.copy(tint).lerp(new THREE.Color(0xffffff), 0.45);
    particlePoints.material.uniforms.uOpacity.value = 0.88 + pulse * 0.1;
  }
}

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
    .replace(/Direct3D[0-9.]+/gi, "")
    .replace(/D3D[0-9]+/gi, "")
    .replace(/vs_\d+_\d+/gi, "")
    .replace(/ps_\d+_\d+/gi, "")
    .replace(/\(0x[0-9a-f]+\)/gi, "")
    .replace(/\b(NVIDIA|AMD|Intel|Microsoft|Apple)\b,?/gi, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 22) s = `${s.slice(0, 20).trim()}…`;
  return s || "GPU";
}

function readGpuLabel() {
  if (!renderer) return "";
  const gl = renderer.getContext();
  if (!gl) return "";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  return shortenGpuName(gpu);
}

function formatVerts(n) {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function hudFlags() {
  const bits = [];
  const gpuName = readGpuLabel();
  bits.push(gpuName === "CPU fallback" ? "CPU" : "GPU");
  if (renderer?.capabilities?.isWebGL2) bits.push("GL2");
  bits.push(displaceHooked ? "SHADER" : "CPU-VERT");
  if (particlePoints?.visible) bits.push("POINTS");
  if (gpuShared.uLive.value > 0.5) {
    const mode = gpuShared.uFxMode.value;
    bits.push(mode < 1.5 ? "RIPPLE" : mode < 2.5 ? "WAVES" : mode < 3.5 ? "RINGS" : "DRIFT");
  }
  return bits.join(" · ");
}

function updateHud(now) {
  if (!fpsEl || !vertsEl) return;
  fpsFrames += 1;
  if (!fpsLastAt) fpsLastAt = now;
  const elapsed = now - fpsLastAt;
  if (elapsed >= 500) {
    const fps = Math.round((fpsFrames * 1000) / elapsed);
    fpsEl.textContent = String(fps);
    fpsFrames = 0;
    fpsLastAt = now;
    if (flagsEl) flagsEl.textContent = hudFlags();
  }
  const verts = terrainGeo?.attributes?.position?.count;
  if (Number.isFinite(verts)) vertsEl.textContent = formatVerts(verts);
}

function renderFrame(now) {
  if (!running || !renderer || !scene || !camera) return;

  try {
    const dt = lastNow ? Math.min(0.05, (now - lastNow) / 1000) : 0.016;
    lastNow = now;
    clock = now * 0.001;
    applyScene(mix(state.x, state.y), controller, dt);
    renderer.render(scene, camera);
    updateHud(now);
  } catch (err) {
    console.error("EchoScape visualize frame failed:", err);
    showVizError(`3D render error: ${err.message}`);
    running = false;
    return;
  }

  rafId = window.requestAnimationFrame(renderFrame);
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

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  return true;
}

function startRenderLoop() {
  if (rafId) window.cancelAnimationFrame(rafId);
  rafId = 0;

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
    showVizError(`3D view has no size yet (${width}×${height}). Try resizing the window.`);
    return;
  }

  sizeTries = 0;
  lastNow = 0;
  clearVizError();
  renderFrame(performance.now());
}

function initVisualize(nextCanvas) {
  if (scene) return;

  canvas = nextCanvas;
  wrap = canvas.parentElement;
  fpsEl = document.querySelector("[data-viz-fps]");
  vertsEl = document.querySelector("[data-viz-verts]");
  flagsEl = document.querySelector("[data-viz-flags]");
  fpsFrames = 0;
  fpsLastAt = 0;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(SCENE_BG);
  scene.fog = null;

  camera = new THREE.PerspectiveCamera(42, 1, 0.2, 400);

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(SCENE_BG, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.sortObjects = true;
  renderer.debug.checkShaderErrors = true;
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const vsLog = gl.getShaderInfoLog(vs);
    const fsLog = gl.getShaderInfoLog(fs);
    const pLog = gl.getProgramInfoLog(program);
    showVizError(`Terrain shader failed: ${(vsLog || fsLog || pLog || "unknown").trim()}`);
  };

  landscape = buildLandscape();
  scene.add(landscape);
  syncStyleMix(mix(state.x, state.y));
  syncCamera(controller, 0);

  resizeObserver = new ResizeObserver(() => {
    resizeCanvas();
  });
  resizeObserver.observe(wrap);
  window.addEventListener("resize", resizeCanvas);

  unsubscribe = null;

  clearVizError();
}

export function showVisualize(nextCanvas) {
  try {
    initVisualize(nextCanvas);
    running = true;
    sizeTries = 0;
    startRenderLoop();
  } catch (err) {
    console.error("EchoScape visualize init failed:", err);
    showVizError(`3D view failed to start: ${err.message}`);
  }
}

export function hideVisualize() {
  running = false;
  if (rafId) window.cancelAnimationFrame(rafId);
  rafId = 0;
}

export function disposeVisualize() {
  hideVisualize();
  unsubscribe?.();
  unsubscribe = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener("resize", resizeCanvas);
  meshLines?.material?.dispose();
  particlePoints?.material?.dispose();
  occluder?.material?.dispose();
  terrainGeo?.dispose();
  heightFields = null;
  renderer?.dispose();
  scene = null;
  renderer = null;
  camera = null;
  landscape = null;
  terrainGeo = null;
  occluder = null;
  meshLines = null;
  particlePoints = null;
  fpsEl = null;
  vertsEl = null;
  flagsEl = null;
  displaceHooked = false;
  fpsFrames = 0;
  fpsLastAt = 0;
  canvas = null;
  wrap = null;
}
