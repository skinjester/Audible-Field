import { chromium } from "playwright";

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
const reach = Math.min(box.width, box.height) * 0.5;

function localSpan(v) {
  return Math.hypot(v.localX, v.localZ);
}

async function zoomBy(steps, out) {
  await page.mouse.move(cx, cy);
  const n = Math.abs(steps);
  for (let i = 0; i < n; i += 1) {
    await page.mouse.wheel(0, out ? 500 : -400);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(160);
}

async function settle() {
  await page.waitForTimeout(100);
  let prev = await view();
  let quiet = 0;
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(40);
    const next = await view();
    const moved = Math.hypot(next.localX - prev.localX, next.localZ - prev.localZ);
    quiet = moved < 0.02 ? quiet + 1 : 0;
    prev = next;
    if (quiet >= 3) return next;
  }
  return prev;
}

/** One rightward stroke across the trackball. Stay at the end so the coast is not braked. */
async function strokeRight() {
  await page.mouse.move(cx - reach * 0.94, cy);
  await page.waitForTimeout(40);
  await page.mouse.move(cx + reach * 0.5, cy, { steps: 12 });
  return settle();
}

/** Return to the left start along the outside of the trackball, where motion does not pan. */
async function repositionOutside() {
  const r = reach * 0.94;
  await page.mouse.move(cx + r, cy, { steps: 3 });
  await page.mouse.move(cx, cy - r, { steps: 8 });
  await page.mouse.move(cx - r, cy, { steps: 8 });
  await page.waitForTimeout(60);
}

async function outsideNudge() {
  const y = cy - reach * 0.94;
  const before = await view();
  await page.mouse.move(cx - 40, y);
  await page.mouse.move(cx + 120, y, { steps: 6 });
  await page.waitForTimeout(200);
  const after = await view();
  return Math.hypot(after.localX - before.localX, after.localZ - before.localZ);
}

const report = { errors, reach, box: { w: box.width, h: box.height } };

async function measure(label, zoomSteps, zoomOut) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.click('[data-tab="falling-blocks"]');
  await page.waitForFunction(() => window.__fallingSim && window.__fallingSim.view().gridFitDist > 0, null, {
    timeout: 20000,
  });
  if (zoomSteps) await zoomBy(zoomSteps, zoomOut);
  await page.mouse.move(cx, cy);
  await settle();
  const atCenter = await view();
  await page.mouse.move(cx + 36, cy, { steps: 4 });
  const smallAfter = await settle();
  const small = Math.hypot(smallAfter.localX - atCenter.localX, smallAfter.localZ - atCenter.localZ);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.click('[data-tab="falling-blocks"]');
  await page.waitForFunction(() => window.__fallingSim && window.__fallingSim.view().gridFitDist > 0, null, {
    timeout: 20000,
  });
  if (zoomSteps) await zoomBy(zoomSteps, zoomOut);
  const samples = [await view()];
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) await repositionOutside();
    samples.push(await strokeRight());
  }
  const outside = await outsideNudge();
  const last = samples.at(-1);
  const base = samples[0];
  report[label] = {
    cameraDist: Number(base.cameraDist.toFixed(2)),
    fit: Number(base.gridFitDist.toFixed(2)),
    wide: base.wide,
    close: base.close,
    small: Number(small.toFixed(3)),
    strokes: samples.slice(1).map((v) => Number(localSpan(v).toFixed(2))),
    localX: Number(last.localX.toFixed(2)),
    ndc: [Number(last.ndcX.toFixed(3)), Number(last.ndcY.toFixed(3))],
    outside: Number(outside.toFixed(3)),
  };
  const edge = report[label].strokes[0] > 7;
  const proportional = small > 0.35 && small < 4;
  const chrome = outside < 0.2;
  const centered = Math.abs(last.ndcX) < 0.12 && Math.abs(last.ndcY) < 0.12;
  if (!edge || !proportional || !chrome || !centered) {
    errors.push(`${label} edge=${edge} proportional=${proportional} chrome=${chrome} centered=${centered} ${JSON.stringify(report[label])}`);
  }
}

await measure("wide", 0, false);
await measure("out", 10, true);
await measure("close", 24, false);

console.log(JSON.stringify(report, null, 2));
await browser.close();
if (errors.length) process.exit(1);
