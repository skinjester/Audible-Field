import * as THREE from "three";
import { controller } from "./mixer-core.js?v=65";

const GRID = 16;
const CELL = 1;
const BLOCK = 0.9;
const STEP = 1;
const MAX_STACK = 12;
const DROP_CLEARANCE = 6.5;
const GRAVITY = 26;
const BLOCK_COLOR = 0xc4624e;
const SCENE_BG = 0x000000;
const SPLASH_LIFE = 0.42;
const CLICK_SLOP = 6;

const PITCH_MIN = 0.32;
const PITCH_MAX = 1.2;
const DIST_MIN = 9;
const DIST_MAX = 40;
const STICK_DEADZONE = 0.12;
const AIM_SPEED = 9;
const YAW_RATE = 1.15;
const PITCH_RATE = 0.65;

let canvas = null;
let wrap = null;
let scene = null;
let camera = null;
let renderer = null;
let marker = null;
let blockGeo = null;
let splashGeo = null;
let blockMat = null;
let resizeObserver = null;

let running = false;
let rafId = 0;
let sizeTries = 0;
let lastNow = 0;
let orbiting = false;
let yaw = 0.62;
let pitch = 0.82;
let distance = 20;

/** @type {Uint8Array | null} */
let heights = null;
/** @type {{ mesh: THREE.Mesh, vy: number, landY: number }[]} */
let fallers = [];
/** @type {{ mesh: THREE.Mesh, age: number }[]} */
let splashes = [];
/** @type {{ ix: number, iz: number } | null} */
let aim = null;
/** @type {{ x: number, y: number, id: number } | null} */
let press = null;
let aimX = 0.5;
let aimZ = 0.5;
let crossWasDown = false;

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

function cellIndex(ix, iz) {
  return iz * GRID + ix;
}

function cellOrigin(ix, iz, target) {
  target.x = (ix + 0.5 - GRID / 2) * CELL;
  target.z = (iz + 0.5 - GRID / 2) * CELL;
  return target;
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

  const cross = connectedPad()?.buttons?.[0];
  const crossDown = !!(cross && (cross.pressed || cross.value > 0.5));
  if (crossDown && !crossWasDown && aim) dropAt(aim.ix, aim.iz);
  crossWasDown = crossDown;
}

function setAim(next) {
  aim = next;
  if (!marker) return;
  if (!aim) {
    marker.visible = false;
    return;
  }
  cellOrigin(aim.ix, aim.iz, marker.position);
  marker.position.y = 0.03;
  marker.visible = true;
}

function dropAt(ix, iz) {
  if (!heights || !scene || !blockGeo || !blockMat) return;
  const h = heights[cellIndex(ix, iz)];
  if (h >= MAX_STACK) return;

  const mesh = new THREE.Mesh(blockGeo, blockMat);
  cellOrigin(ix, iz, mesh.position);
  const landY = h * STEP + BLOCK * 0.5;
  mesh.position.y = landY + DROP_CLEARANCE;
  scene.add(mesh);
  fallers.push({
    mesh,
    vy: 0,
    landY,
  });
  heights[cellIndex(ix, iz)] = h + 1;
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
  mesh.position.set(x, y, z);
  mesh.scale.setScalar(0.55);
  scene.add(mesh);
  splashes.push({ mesh, age: 0 });
}

function step(dt) {
  applyController(dt);

  for (let i = fallers.length - 1; i >= 0; i -= 1) {
    const faller = fallers[i];
    faller.vy -= GRAVITY * dt;
    faller.mesh.position.y += faller.vy * dt;
    if (faller.mesh.position.y > faller.landY) continue;
    faller.mesh.position.y = faller.landY;
    spawnSplash(faller.mesh.position.x, faller.landY - BLOCK * 0.5 + 0.03, faller.mesh.position.z);
    fallers.splice(i, 1);
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
    const scale = 0.55 + t * 2.8;
    splash.mesh.scale.setScalar(scale);
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
  dropAt(aim.ix, aim.iz);
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

function initFallingBlocks(nextCanvas) {
  if (scene) return;

  canvas = nextCanvas;
  wrap = canvas.parentElement;
  canvas.style.cursor = "crosshair";
  canvas.style.touchAction = "none";

  heights = new Uint8Array(GRID * GRID);
  fallers = [];
  splashes = [];

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

  const grid = new THREE.GridHelper(GRID * CELL, GRID, 0x314048, 0x28343a);
  grid.position.y = 0.01;
  scene.add(grid);

  blockGeo = new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK);
  blockMat = new THREE.MeshStandardMaterial({
    color: BLOCK_COLOR,
    roughness: 0.76,
    metalness: 0.02,
  });
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

export function showFallingBlocks(nextCanvas) {
  try {
    initFallingBlocks(nextCanvas);
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
  if (rafId) window.cancelAnimationFrame(rafId);
  rafId = 0;
}
