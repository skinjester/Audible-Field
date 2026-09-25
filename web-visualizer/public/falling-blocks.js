import * as THREE from "three";
import { controller } from "./mixer-core.js?v=65";
import { compileMaterials, stepWorld } from "./rule-engine.js?v=2";

const GRID = 16;
const MAX_Y = 12;
const CELL = 1;
const BLOCK = 0.9;
const SCENE_BG = 0x000000;
const SPLASH_LIFE = 0.42;
const CLICK_SLOP = 6;
const RULE_HZ = 22;

const PITCH_MIN = 0.32;
const PITCH_MAX = 1.2;
const DIST_MIN = 9;
const DIST_MAX = 40;
const STICK_DEADZONE = 0.12;
const AIM_SPEED = 9;
const YAW_RATE = 1.15;
const PITCH_RATE = 0.65;
const RT_PRESS = 0.08;
const DROP_INTERVAL = 0.22;
const DROP_SIZE_MIN = 1;
const DROP_SIZE_MAX = 3;

let canvas = null;
let wrap = null;
let scene = null;
let camera = null;
let renderer = null;
let marker = null;
let blockGeo = null;
let splashGeo = null;
let resizeObserver = null;
let paletteEl = null;

let running = false;
let rafId = 0;
let sizeTries = 0;
let lastNow = 0;
let orbiting = false;
let yaw = 0.62;
let pitch = 0.82;
let distance = 20;
let ruleAcc = 0;

/** @type {Uint8Array | null} */
let cells = null;
/** @type {Map<string, THREE.Mesh>} */
const meshes = new Map();
/** @type {Map<number, THREE.MeshStandardMaterial>} */
const matCache = new Map();
/** @type {{ mesh: THREE.Mesh, age: number }[]} */
let splashes = [];
/** @type {{ ix: number, iz: number } | null} */
let aim = null;
/** @type {{ x: number, y: number, id: number } | null} */
let press = null;
let aimX = 0.5;
let aimZ = 0.5;
let l1WasDown = false;
let r1WasDown = false;
let rtHeld = false;
let rtDropAcc = 0;
let dropCharge = 0;

/** @type {ReturnType<typeof compileMaterials> | null} */
let catalog = null;
let activeMaterialId = "block";

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hitPoint = new THREE.Vector3();

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
  cells[idx(x, y, z)] = value;
}

const gridApi = {
  get: getCell,
  set: setCell,
  inBounds,
};

function cellWorld(x, y, z, target) {
  target.x = (x + 0.5 - GRID / 2) * CELL;
  target.y = y * CELL + BLOCK * 0.5;
  target.z = (z + 0.5 - GRID / 2) * CELL;
  return target;
}

function cellKey(x, y, z) {
  return `${x},${y},${z}`;
}

function syncCamera() {
  const horizontal = Math.cos(pitch) * distance;
  camera.position.set(Math.sin(yaw) * horizontal, Math.sin(pitch) * distance, Math.cos(yaw) * horizontal);
  camera.lookAt(0, 0.7, 0);
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

function sizeFromPressure(pressure) {
  const t = clamp01(pressure);
  const span = DROP_SIZE_MAX - DROP_SIZE_MIN;
  return DROP_SIZE_MIN + Math.round(t * span);
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

function surfaceY(ix, iz) {
  if (!cells || ix < 0 || iz < 0 || ix >= GRID || iz >= GRID) return 0.03;
  for (let y = MAX_Y - 1; y >= 0; y -= 1) {
    if (getCell(ix, y, iz) > 0) return (y + 1) * CELL + 0.04;
  }
  return 0.03;
}

function footprintSurfaceY(cx, cz, side) {
  const ox = cx - Math.floor((side - 1) / 2);
  const oz = cz - Math.floor((side - 1) / 2);
  let top = 0.03;
  for (let z = 0; z < side; z += 1) {
    for (let x = 0; x < side; x += 1) {
      top = Math.max(top, surfaceY(ox + x, oz + z));
    }
  }
  return top;
}

function syncDropMarker() {
  if (!marker || !aim) {
    if (marker) marker.visible = false;
    return;
  }
  const side = sizeFromPressure(dropCharge > 0 ? dropCharge : RT_PRESS);
  cellWorld(aim.ix, 0, aim.iz, marker.position);
  marker.position.y = footprintSurfaceY(aim.ix, aim.iz, side);
  marker.scale.set(side, side, 1);
  marker.visible = true;
  marker.material.opacity = dropCharge > 0 ? 0.28 + dropCharge * 0.45 : 0.42;
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

function setAimFromWorld() {
  const limit = (GRID * CELL) / 2 - 0.001;
  aimX = Math.min(limit, Math.max(-limit, aimX));
  aimZ = Math.min(limit, Math.max(-limit, aimZ));
  const ix = Math.floor(aimX / CELL + GRID / 2);
  const iz = Math.floor(aimZ / CELL + GRID / 2);
  if (ix < 0 || iz < 0 || ix >= GRID || iz >= GRID) return;
  setAim({ ix, iz });
}

function aimFromEvent(event) {
  if (!canvas || !camera) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);

  const meshHits = raycaster.intersectObjects([...meshes.values()], false);
  if (meshHits.length) {
    const point = meshHits[0].point;
    const ix = Math.floor(point.x / CELL + GRID / 2);
    const iz = Math.floor(point.z / CELL + GRID / 2);
    if (ix >= 0 && iz >= 0 && ix < GRID && iz < GRID) {
      aimX = (ix + 0.5 - GRID / 2) * CELL;
      aimZ = (iz + 0.5 - GRID / 2) * CELL;
      setAim({ ix, iz });
      return;
    }
  }

  if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return;
  const ix = Math.floor(hitPoint.x / CELL + GRID / 2);
  const iz = Math.floor(hitPoint.z / CELL + GRID / 2);
  if (ix < 0 || iz < 0 || ix >= GRID || iz >= GRID) return;
  aimX = hitPoint.x;
  aimZ = hitPoint.z;
  setAim({ ix, iz });
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
}

function applyController(dt) {
  if (!camera || dt <= 0) return;

  const lx = stickAxis(controller.rawX);
  const ly = stickAxis(controller.rawY);
  const rx = stickAxis(controller.rightX);
  const ry = stickAxis(controller.rightY);
  let cameraMoved = false;

  if (rx || ry) {
    yaw -= rx * YAW_RATE * dt;
    pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch + ry * PITCH_RATE * dt));
    cameraMoved = true;
  }

  if (lx || ly) {
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const step = AIM_SPEED * dt;
    aimX += (cos * lx - sin * ly) * step;
    aimZ += (-sin * lx - cos * ly) * step;
    setAimFromWorld();
  }

  if (cameraMoved) syncCamera();

  const pad = connectedPad();
  const buttons = pad?.buttons || [];
  const pressed = (i) => !!(buttons[i] && (buttons[i].pressed || buttons[i].value > 0.5));

  const rt = readRightTrigger(pad);
  if (rt >= RT_PRESS) {
    dropCharge = rt;
    syncDropMarker();
    if (!rtHeld) {
      rtHeld = true;
      rtDropAcc = 0;
      if (aim) dropAt(aim.ix, aim.iz, rt);
    } else {
      rtDropAcc += dt;
      if (rtDropAcc >= DROP_INTERVAL) {
        rtDropAcc -= DROP_INTERVAL;
        if (aim) dropAt(aim.ix, aim.iz, rt);
      }
    }
  } else if (rtHeld || dropCharge !== 0) {
    rtHeld = false;
    rtDropAcc = 0;
    dropCharge = 0;
    syncDropMarker();
  }

  const l1Down = !!(controller.l1 || pressed(4));
  if (l1Down && !l1WasDown) cycleMaterial(-1);
  l1WasDown = l1Down;

  const r1Down = !!(controller.r1 || pressed(5));
  if (r1Down && !r1WasDown) cycleMaterial(1);
  r1WasDown = r1Down;
}

function setAim(next) {
  aim = next;
  syncDropMarker();
}

function cubeFits(ox, oy, oz, side) {
  for (let y = 0; y < side; y += 1) {
    for (let z = 0; z < side; z += 1) {
      for (let x = 0; x < side; x += 1) {
        const wx = ox + x;
        const wy = oy + y;
        const wz = oz + z;
        if (!inBounds(wx, wy, wz) || getCell(wx, wy, wz) !== 0) return false;
      }
    }
  }
  return true;
}

function fillCube(ox, oy, oz, side, matIndex) {
  for (let y = 0; y < side; y += 1) {
    for (let z = 0; z < side; z += 1) {
      for (let x = 0; x < side; x += 1) {
        setCell(ox + x, oy + y, oz + z, matIndex);
      }
    }
  }
}

function dropAt(ix, iz, pressure = 0) {
  if (!cells || !catalog) return;
  const matIndex = catalog.indexById.get(activeMaterialId);
  if (!matIndex) return;

  const side = sizeFromPressure(pressure);
  const ox = ix - Math.floor((side - 1) / 2);
  const oz = iz - Math.floor((side - 1) / 2);

  for (let oy = MAX_Y - side; oy >= 0; oy -= 1) {
    if (!cubeFits(ox, oy, oz, side)) continue;
    fillCube(ox, oy, oz, side, matIndex);
    reconcileMeshes();
    return;
  }
}

function spawnSplash(x, y, z) {
  if (!scene || !splashGeo) return;
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
  mesh.position.y = y * CELL + 0.04;
  mesh.scale.setScalar(0.55);
  scene.add(mesh);
  splashes.push({ mesh, age: 0 });
}

function collectOccupied() {
  /** @type {{ x: number, y: number, z: number, mat: number }[]} */
  const list = [];
  if (!cells) return list;
  for (let y = 0; y < MAX_Y; y += 1) {
    for (let z = 0; z < GRID; z += 1) {
      for (let x = 0; x < GRID; x += 1) {
        const mat = getCell(x, y, z);
        if (mat > 0) list.push({ x, y, z, mat });
      }
    }
  }
  return list;
}

function reconcileMeshes() {
  if (!scene || !blockGeo) return;
  const live = new Set();

  for (let y = 0; y < MAX_Y; y += 1) {
    for (let z = 0; z < GRID; z += 1) {
      for (let x = 0; x < GRID; x += 1) {
        const mat = getCell(x, y, z);
        if (mat <= 0) continue;
        const key = cellKey(x, y, z);
        live.add(key);
        let mesh = meshes.get(key);
        if (!mesh) {
          mesh = new THREE.Mesh(blockGeo, materialMeshMat(mat));
          scene.add(mesh);
          meshes.set(key, mesh);
        } else if (mesh.material !== materialMeshMat(mat)) {
          mesh.material = materialMeshMat(mat);
        }
        cellWorld(x, y, z, mesh.position);
      }
    }
  }

  for (const [key, mesh] of meshes) {
    if (live.has(key)) continue;
    scene.remove(mesh);
    meshes.delete(key);
  }
  syncDropMarker();
}

function runRules() {
  if (!catalog) return;
  const occupied = collectOccupied();
  const { splashes: splashCells } = stepWorld(gridApi, occupied, catalog);
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

  for (let i = splashes.length - 1; i >= 0; i -= 1) {
    const splash = splashes[i];
    splash.age += dt;
    const t = splash.age / SPLASH_LIFE;
    if (t >= 1) {
      scene.remove(splash.mesh);
      splash.mesh.material.dispose();
      splashes.splice(i, 1);
      continue;
    }
    splash.mesh.scale.setScalar(0.55 + t * 2.8);
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
  } catch (err) {
    console.error("EchoScape falling blocks frame failed:", err);
    showError(`3D render error: ${err.message}`);
    running = false;
    return;
  }

  rafId = window.requestAnimationFrame(renderFrame);
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
  if (orbiting) {
    yaw -= event.movementX * 0.005;
    pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, pitch - event.movementY * 0.004));
    syncCamera();
  }
  aimFromEvent(event);
}

function onPointerDown(event) {
  if (event.button === 2) {
    orbiting = true;
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  press = { x: event.clientX, y: event.clientY, id: event.pointerId };
}

function onPointerUp(event) {
  if (event.button === 2) {
    orbiting = false;
    return;
  }
  if (event.button !== 0 || !press || press.id !== event.pointerId) return;
  const dx = event.clientX - press.x;
  const dy = event.clientY - press.y;
  press = null;
  if (dx * dx + dy * dy > CLICK_SLOP * CLICK_SLOP) return;
  aimFromEvent(event);
  if (!aim) return;
  dropAt(aim.ix, aim.iz, 0);
}

function onPointerCancel() {
  orbiting = false;
  press = null;
}

function onWheel(event) {
  event.preventDefault();
  distance = Math.min(DIST_MAX, Math.max(DIST_MIN, distance + event.deltaY * 0.012));
  syncCamera();
}

function onContextMenu(event) {
  event.preventDefault();
}

async function loadCatalog() {
  const res = await fetch(`/materials.json?v=3`);
  if (!res.ok) throw new Error(`materials.json ${res.status}`);
  catalog = compileMaterials(await res.json());
  activeMaterialId = catalog.defaultId || catalog.list[0]?.id || "block";
  buildPalette();
}

function initScene(nextCanvas) {
  canvas = nextCanvas;
  wrap = canvas.parentElement;
  canvas.style.cursor = "crosshair";
  canvas.style.touchAction = "none";

  cells = new Uint8Array(GRID * GRID * MAX_Y);
  meshes.clear();
  splashes = [];
  ruleAcc = 0;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(SCENE_BG);

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

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID * CELL + 10, GRID * CELL + 10),
    new THREE.MeshStandardMaterial({ color: 0x10181c, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);

  const gridHelper = new THREE.GridHelper(GRID * CELL, GRID, 0x314048, 0x28343a);
  gridHelper.position.y = 0.01;
  scene.add(gridHelper);

  blockGeo = new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK);
  splashGeo = new THREE.RingGeometry(0.42, 0.62, 28);

  marker = new THREE.Mesh(
    new THREE.PlaneGeometry(CELL * 0.9, CELL * 0.9),
    new THREE.MeshBasicMaterial({
      color: 0xf0e2d6,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.visible = false;
  marker.renderOrder = 1;
  scene.add(marker);
  setAimFromWorld();

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
    if (!scene) {
      await loadCatalog();
      initScene(nextCanvas);
    } else {
      buildPalette();
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
  orbiting = false;
  press = null;
  rtHeld = false;
  rtDropAcc = 0;
  dropCharge = 0;
  if (rafId) window.cancelAnimationFrame(rafId);
  rafId = 0;
}
