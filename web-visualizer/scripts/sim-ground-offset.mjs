import { chromium } from "playwright";

const fails = [];
function check(name, ok, detail) {
  if (!ok) fails.push(`${name}: ${detail}`);
}

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (err) => errors.push(err.stack || err.message));
page.on("response", (res) => {
  if (res.status() < 400) return;
  const url = res.url();
  if (/falling-blocks\.js|app\.js|falling-input\.js/.test(url)) errors.push(`${res.status()} ${url}`);
});

await page.goto("http://127.0.0.1:8080/?sim=1#falling-blocks", { waitUntil: "domcontentloaded" });
await page.click('[data-tab="falling-blocks"]');
await page.waitForFunction(() => window.__fallingSim && window.__fallingSim.view && window.__fallingSim.view().gridFitDist > 0, null, {
  timeout: 20000,
});

const view = () => page.evaluate(() => window.__fallingSim.view());
const canvas = page.locator("[data-falling-canvas]");
const box = await canvas.boundingBox();
if (!box) throw new Error("falling canvas has no box");
const cx = box.x + box.width * 0.5;
const cy = box.y + box.height * 0.5;

function lookLocked(v) {
  return Math.hypot(v.lookX, v.lookZ) < 0.08;
}

const rest = await view();
check("rest look-at", lookLocked(rest), JSON.stringify(rest));
check("rest target centered", Math.abs(rest.ndcX) < 0.12 && Math.abs(rest.ndcY) < 0.12, JSON.stringify(rest));
check(
  "rest pours the center cell",
  Math.hypot(rest.localX, rest.localZ) < 0.2,
  JSON.stringify(rest),
);
check("rest above emitter", rest.cameraDist + 1e-3 >= rest.clearance, JSON.stringify(rest));

await page.mouse.move(cx, cy);
for (let i = 0; i < 30; i += 1) {
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(20);
}
const zoomed = await view();
check("zoomed close", zoomed.close === true, JSON.stringify(zoomed));
check("zoom floor", zoomed.cameraDist + 1e-3 >= zoomed.clearance, JSON.stringify(zoomed));
check("zoom look-at", lookLocked(zoomed), JSON.stringify(zoomed));

function targetCentered(v) {
  return Math.abs(v.ndcX) < 0.12 && Math.abs(v.ndcY) < 0.12;
}

await page.mouse.move(cx + 4, cy);
await page.waitForTimeout(40);
const beforeNudge = await view();
await page.mouse.move(cx + 36, cy, { steps: 4 });
await page.waitForTimeout(80);
const afterNudge = await view();
const nudgeGround = Math.hypot(afterNudge.surfaceX - beforeNudge.surfaceX, afterNudge.surfaceZ - beforeNudge.surfaceZ);
check("small aim slides the ground", nudgeGround > 0.02, `moved ${nudgeGround.toFixed(4)}`);
check("target stays centered", targetCentered(afterNudge), JSON.stringify(afterNudge));
check(
  "pan does not stick to the plane edge",
  Math.abs(afterNudge.localX) < 7.2 && Math.abs(afterNudge.localZ) < 7.2,
  JSON.stringify(afterNudge),
);

const trail = [];
let px = cx + 36;
for (let i = 0; i < 36; i += 1) {
  px += 14;
  if (px > box.x + box.width - 8) break;
  await page.mouse.move(px, cy, { steps: 2 });
  await page.waitForTimeout(45);
  trail.push(await view());
}
const slid = trail.filter((v) => Math.hypot(v.surfaceX, v.surfaceZ) > 0.15);
check("drag slides the ground", slid.length > 3, `samples ${trail.length}, slid ${slid.length}, last ${JSON.stringify(trail.at(-1))}`);

let reversals = 0;
for (let i = 1; i < trail.length; i += 1) {
  const dx = trail[i].surfaceX - trail[i - 1].surfaceX;
  const dz = trail[i].surfaceZ - trail[i - 1].surfaceZ;
  const pdx = i > 1 ? trail[i - 1].surfaceX - trail[i - 2].surfaceX : dx;
  const pdz = i > 1 ? trail[i - 1].surfaceZ - trail[i - 2].surfaceZ : dz;
  const mag = Math.hypot(dx, dz);
  const pmag = Math.hypot(pdx, pdz);
  if (mag > 0.04 && pmag > 0.04 && dx * pdx + dz * pdz < 0) reversals += 1;
}
check("slide does not reverse", reversals === 0, `reversals ${reversals}`);

const ndcOver = trail.filter((v) => !targetCentered(v));
check("target stays centered while dragging", ndcOver.length === 0, JSON.stringify(ndcOver[0] || trail.at(-1)));

const beforeEdge = await view();
await page.mouse.move(box.x + box.width - 2, cy);
const edgeSamples = [];
for (let i = 0; i < 8; i += 1) {
  await page.waitForTimeout(50);
  edgeSamples.push(await view());
}
const edgeTravel = Math.hypot(edgeSamples.at(-1).surfaceX - beforeEdge.surfaceX, edgeSamples.at(-1).surfaceZ - beforeEdge.surfaceZ);
check("edge hold keeps panning", edgeTravel > 0.4, `traveled ${edgeTravel.toFixed(4)}`);
check("edge hold stays centered", edgeSamples.every(targetCentered), JSON.stringify(edgeSamples.at(-1)));

await page.mouse.move(cx, cy);
await page.waitForTimeout(80);
const parked = await view();
const still = [];
for (let i = 0; i < 8; i += 1) {
  await page.waitForTimeout(50);
  still.push(await view());
}
const coast = Math.max(
  ...still.map((v) => Math.hypot(v.surfaceX - parked.surfaceX, v.surfaceZ - parked.surfaceZ)),
);
const aimCoast = Math.max(...still.map((v) => Math.hypot(v.aimX - parked.aimX, v.aimZ - parked.aimZ)));
check("no coast after stop", coast < 0.04 && aimCoast < 0.04, `ground ${coast.toFixed(4)} aim ${aimCoast.toFixed(4)}`);

const preYaw = await view();
const preRadius = Math.hypot(preYaw.surfaceX, preYaw.surfaceZ);
await page.mouse.move(cx, cy);
await page.mouse.down({ button: "right" });
await page.mouse.move(cx + 90, cy, { steps: 6 });
await page.mouse.up({ button: "right" });
await page.waitForTimeout(80);
const postYaw = await view();
const postRadius = Math.hypot(postYaw.surfaceX, postYaw.surfaceZ);
check("yaw keeps offset length", Math.abs(postRadius - preRadius) < 0.08, `${preRadius.toFixed(3)} -> ${postRadius.toFixed(3)}`);
check("yaw leaves the emitter", Math.hypot(postYaw.aimX - preYaw.aimX, postYaw.aimZ - preYaw.aimZ) < 0.08, JSON.stringify({ preYaw, postYaw }));
check("yaw look-at", lookLocked(postYaw), JSON.stringify(postYaw));

for (let i = 0; i < 40; i += 1) {
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(16);
}
const wide = await view();
check("zoomed wide", wide.wide === true, JSON.stringify(wide));
check("wide target stays centered", targetCentered(wide), JSON.stringify(wide));
const wideLocal = { x: wide.localX, z: wide.localZ };
await page.waitForTimeout(500);
const heldWide = await view();
check(
  "zoom-out keeps the ground offset",
  Math.hypot(heldWide.surfaceX - wide.surfaceX, heldWide.surfaceZ - wide.surfaceZ) < 0.08,
  JSON.stringify({ wide, heldWide }),
);
check(
  "zoom-out keeps the pour cell",
  Math.hypot(heldWide.localX - wideLocal.x, heldWide.localZ - wideLocal.z) < 0.05,
  JSON.stringify({ wideLocal, heldWide }),
);
check("zoom-out keeps the target centered", targetCentered(heldWide), JSON.stringify(heldWide));

await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.38);
await page.waitForTimeout(80);
const beforeZoom = await view();
for (let i = 0; i < 24; i += 1) {
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(16);
}
let recentered = await view();
for (let i = 0; i < 20 && !targetCentered(recentered); i += 1) {
  await page.waitForTimeout(50);
  recentered = await view();
}
check("zoom-in brings the target to center", targetCentered(recentered) && recentered.close, JSON.stringify(recentered));
check(
  "zoom-in keeps the pour cell",
  Math.hypot(recentered.localX - beforeZoom.localX, recentered.localZ - beforeZoom.localZ) < 0.15,
  JSON.stringify({ beforeZoom, recentered }),
);
await page.mouse.move(cx, cy);
let settled = await view();
for (let i = 0; i < 20; i += 1) {
  await page.waitForTimeout(50);
  const next = await view();
  const moved = Math.hypot(next.surfaceX - settled.surfaceX, next.surfaceZ - settled.surfaceZ);
  settled = next;
  if (targetCentered(settled) && moved < 0.02) break;
}
const hold = [];
for (let i = 0; i < 8; i += 1) {
  await page.waitForTimeout(50);
  hold.push(await view());
}
const holdDrift = Math.max(...hold.map((v) => Math.hypot(v.surfaceX - settled.surfaceX, v.surfaceZ - settled.surfaceZ)));
check(
  "centered view holds still",
  holdDrift < 0.05 && hold.every(targetCentered),
  `drift ${holdDrift.toFixed(4)} close ${settled.close} dist ${settled.cameraDist.toFixed(2)} ndc ${settled.ndcX.toFixed(3)},${settled.ndcY.toFixed(3)}`,
);

await page.evaluate(() => window.__fallingSim.setEmitHeight(12));
for (let i = 0; i < 25; i += 1) {
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(16);
}
const high = await view();
check("camera stays above a tall emitter", high.cameraDist + 1e-2 >= high.clearance && high.cameraY > 12, JSON.stringify(high));
check("tall look-at", lookLocked(high), JSON.stringify(high));

await browser.close();

const report = {
  errors,
  fails,
  rest: { cameraDist: rest.cameraDist, gridFitDist: rest.gridFitDist },
  zoomed: { cameraDist: zoomed.cameraDist, close: zoomed.close, ndcX: zoomed.ndcX },
  nudgeGround,
  reversals,
  coast,
  edgeTravel,
  preRadius,
  postRadius,
  wide: {
    surfaceX: heldWide.surfaceX,
    surfaceZ: heldWide.surfaceZ,
    localX: heldWide.localX,
    localZ: heldWide.localZ,
    ndcX: heldWide.ndcX,
    ndcY: heldWide.ndcY,
  },
  high: { cameraDist: high.cameraDist, clearance: high.clearance, cameraY: high.cameraY },
};
console.log(JSON.stringify(report, null, 2));
if (report.errors.length || fails.length) process.exit(1);
