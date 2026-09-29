/**
 * Compare Playwright mouse motion with the events the page actually receives
 * and with what Falling Blocks applies (aim, pan, yaw, emit).
 *
 * Run: node scripts/test-mouse-events.mjs
 */
import { chromium } from "playwright";

const URL = "http://127.0.0.1:8080/?sim=1#falling-blocks";

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (err) => errors.push(err.stack || err.message));

await page.addInitScript(() => {
  window.__mouseLog = [];
  window.__frameLog = [];
  window.__sampling = false;
  const record = (event) => {
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const target = event.target;
    let name = "";
    if (target instanceof Element) {
      name =
        target.getAttribute("data-falling-canvas") != null
          ? "canvas"
          : `${target.tagName.toLowerCase()}${target.className ? "." + String(target.className).split(" ")[0] : ""}`;
    }
    window.__mouseLog.push({
      type: event.type,
      t: performance.now(),
      x: event.clientX,
      y: event.clientY,
      mx: event.movementX || 0,
      my: event.movementY || 0,
      button: event.button,
      buttons: event.buttons,
      target: name,
      coalesced: coalesced.length,
      coalMx: coalesced.reduce((sum, ev) => sum + (ev.movementX || 0), 0),
      coalMy: coalesced.reduce((sum, ev) => sum + (ev.movementY || 0), 0),
    });
  };
  for (const type of ["pointermove", "pointerdown", "pointerup", "pointerout", "pointerleave", "pointercancel", "lostpointercapture"]) {
    window.addEventListener(type, record, true);
  }
});

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.click('[data-tab="falling-blocks"]');
await page.waitForFunction(
  () => window.__fallingSim && window.__fallingSim.view && window.__fallingSim.view().gridFitDist > 0,
  null,
  { timeout: 20000 },
);

async function armPage() {
  await page.evaluate(() => {
    if (window.__mouseArmed) return;
    window.__mouseArmed = true;
    const canvas = document.querySelector("[data-falling-canvas]");
    canvas.addEventListener(
      "pointermove",
      () => {
        window.__canvasMoves = (window.__canvasMoves || 0) + 1;
      },
      true,
    );
    const sample = () => {
      if (window.__sampling && window.__fallingSim) {
        const view = window.__fallingSim.view();
        const state = window.__fallingSim.state();
        window.__frameLog.push({
          t: performance.now(),
          aimX: view.aimX,
          aimZ: view.aimZ,
          cellX: view.cellX,
          cellZ: view.cellZ,
          yaw: view.yaw,
          surfaceX: view.surfaceX,
          surfaceZ: view.surfaceZ,
          atoms: state.atoms,
        });
      }
      window.requestAnimationFrame(sample);
    };
    window.requestAnimationFrame(sample);
  });
}

await armPage();

const canvas = page.locator("[data-falling-canvas]");
const box = await canvas.boundingBox();
if (!box) throw new Error("falling canvas has no box");

function pt(u, v) {
  return { x: box.x + box.width * u, y: box.y + box.height * v };
}

async function resetLogs() {
  await page.evaluate(() => {
    window.__mouseLog.length = 0;
    window.__frameLog.length = 0;
    window.__canvasMoves = 0;
    window.__sampling = true;
  });
}

async function stopLogs() {
  await page.waitForTimeout(50);
  return page.evaluate(() => {
    window.__sampling = false;
    return {
      events: window.__mouseLog.slice(),
      frames: window.__frameLog.slice(),
      canvasMoves: window.__canvasMoves || 0,
    };
  });
}

function span(frames, key) {
  if (!frames.length) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const frame of frames) {
    lo = Math.min(lo, frame[key]);
    hi = Math.max(hi, frame[key]);
  }
  return hi - lo;
}

function uniqueCells(frames) {
  const cells = new Set();
  for (const frame of frames) cells.add(`${frame.cellX},${frame.cellZ}`);
  return cells.size;
}

function summarize(label, requestedSteps, data, extra = {}) {
  const moves = data.events.filter((event) => event.type === "pointermove");
  const canvasMoves = moves.filter((event) => event.target === "canvas");
  const outs = data.events.filter((event) => event.type === "pointerout" || event.type === "pointerleave" || event.type === "pointercancel");
  let clientDx = 0;
  let clientDy = 0;
  let zeroMovement = 0;
  let coalMismatch = 0;
  for (let i = 1; i < moves.length; i += 1) {
    const dx = moves[i].x - moves[i - 1].x;
    const dy = moves[i].y - moves[i - 1].y;
    clientDx += Math.abs(dx);
    clientDy += Math.abs(dy);
    if ((Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) && moves[i].mx === 0 && moves[i].my === 0) zeroMovement += 1;
  }
  for (const event of moves) {
    if (event.coalesced > 1 && (Math.abs(event.coalMx - event.mx) > 0.5 || Math.abs(event.coalMy - event.my) > 0.5)) {
      coalMismatch += 1;
    }
  }
  const moveSumX = moves.reduce((sum, event) => sum + event.mx, 0);
  const moveSumY = moves.reduce((sum, event) => sum + event.my, 0);
  const coalSumX = moves.reduce((sum, event) => sum + (event.coalesced ? event.coalMx : event.mx), 0);
  const targets = {};
  for (const event of moves) targets[event.target] = (targets[event.target] || 0) + 1;
  const aimSpan = Math.hypot(span(data.frames, "aimX"), span(data.frames, "aimZ"));
  const surfaceSpan = Math.hypot(span(data.frames, "surfaceX"), span(data.frames, "surfaceZ"));
  return {
    label,
    requestedSteps,
    pointerMoves: moves.length,
    canvasTargetMoves: canvasMoves.length,
    canvasListenerMoves: data.canvasMoves,
    deliveredRatio: requestedSteps > 0 ? Number((moves.length / requestedSteps).toFixed(3)) : null,
    clientTravel: Number(Math.hypot(clientDx, clientDy).toFixed(1)),
    movementTravel: Number(Math.hypot(moveSumX, moveSumY).toFixed(1)),
    coalescedTravel: Number(Math.hypot(coalSumX, moves.reduce((sum, event) => sum + (event.coalesced ? event.coalMy : event.my), 0)).toFixed(1)),
    movesWithZeroMovement: zeroMovement,
    coalescedMismatch: coalMismatch,
    boundaryEvents: outs.map((event) => `${event.type}@${event.target}`),
    targets,
    frames: data.frames.length,
    aimSpan: Number(aimSpan.toFixed(3)),
    surfaceSpan: Number(surfaceSpan.toFixed(3)),
    yawSpan: Number(span(data.frames, "yaw").toFixed(4)),
    cells: uniqueCells(data.frames),
    atoms: data.frames.length ? data.frames.at(-1).atoms : null,
    atomSpan: data.frames.length ? data.frames.at(-1).atoms - data.frames[0].atoms : null,
    ...extra,
  };
}

async function sweep(from, to, steps, pauseMs = 0) {
  await page.mouse.move(from.x, from.y);
  if (pauseMs) await page.waitForTimeout(pauseMs);
  await page.mouse.move(to.x, to.y, { steps });
}

const report = { errors, box: { x: box.x, y: box.y, w: box.width, h: box.height } };

const hits = await page.evaluate((rect) => {
  const rows = [0.08, 0.25, 0.5, 0.75, 0.92];
  const cols = [0.08, 0.25, 0.5, 0.75, 0.92];
  const samples = [];
  for (const v of rows) {
    for (const u of cols) {
      const x = rect.x + rect.w * u;
      const y = rect.y + rect.h * v;
      const hit = document.elementFromPoint(x, y);
      const name =
        hit?.getAttribute?.("data-falling-canvas") != null
          ? "canvas"
          : hit
            ? `${hit.tagName.toLowerCase()}${hit.className ? "." + String(hit.className).split(/\s+/)[0] : ""}`
            : "none";
      samples.push({ u, v, name });
    }
  }
  return samples;
}, { x: box.x, y: box.y, w: box.width, h: box.height });
report.hitMap = hits;

async function runHover(label, from, to, steps, pauseMs = 0) {
  await resetLogs();
  await sweep(from, to, steps, pauseMs);
  const data = await stopLogs();
  report[label] = summarize(label, steps, data);
}

const midLeft = pt(0.18, 0.55);
const midRight = pt(0.82, 0.55);
const mid = pt(0.5, 0.55);

await runHover("hoverSlow", midLeft, midRight, 24, 30);
await runHover("hoverFast", midLeft, midRight, 40, 0);

await resetLogs();
await page.mouse.move(midLeft.x, midLeft.y);
for (let i = 0; i < 6; i += 1) {
  const dest = i % 2 === 0 ? midRight : midLeft;
  await page.mouse.move(dest.x, dest.y, { steps: 12 });
}
report.hoverBackAndForth = summarize("hoverBackAndForth", 6 * 12, await stopLogs());

await runHover("hoverTopBand", pt(0.2, 0.06), pt(0.8, 0.06), 20, 16);
await runHover("hoverUpperQuarter", pt(0.2, 0.22), pt(0.8, 0.22), 20, 16);

const cdp = await page.context().newCDPSession(page);
await resetLogs();
await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: midLeft.x, y: midLeft.y });
for (let i = 1; i <= 30; i += 1) {
  const x = midLeft.x + ((midRight.x - midLeft.x) * i) / 30;
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: midLeft.y });
}
report.hoverCdpBurst = summarize("hoverCdpBurst", 30, await stopLogs());

async function drag(label, button, from, to, steps, modifiers = []) {
  await resetLogs();
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up({ button });
  for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
  const data = await stopLogs();
  report[label] = summarize(label, steps, data, { button, modifiers });
}

await drag("panRightShort", "right", mid, pt(0.5 + 40 / box.width, 0.55), 8);
await drag("panRightLong", "right", mid, pt(0.5 + 160 / box.width, 0.55), 24);

await resetLogs();
await page.mouse.move(midLeft.x, midLeft.y);
await page.mouse.down({ button: "right" });
for (let i = 0; i < 4; i += 1) {
  const dest = i % 2 === 0 ? midRight : midLeft;
  await page.mouse.move(dest.x, dest.y, { steps: 10 });
}
await page.mouse.up({ button: "right" });
report.panOscillate = summarize("panOscillate", 40, await stopLogs());

await page.reload({ waitUntil: "domcontentloaded" });
await page.click('[data-tab="falling-blocks"]');
await page.waitForFunction(() => window.__fallingSim && window.__fallingSim.view().gridFitDist > 0, null, {
  timeout: 20000,
});
await armPage();

await drag("yawMiddle", "middle", mid, pt(0.5 + 100 / box.width, 0.55), 20);
await drag("yawAltRight", "right", mid, pt(0.5 + 100 / box.width, 0.55), 20, ["Alt"]);
await drag("yawShiftRight", "right", mid, pt(0.5 - 80 / box.width, 0.55), 16, ["Shift"]);

await resetLogs();
await page.mouse.move(mid.x - 60, mid.y);
await page.mouse.down({ button: "middle" });
for (let i = 0; i < 4; i += 1) {
  const x = i % 2 === 0 ? mid.x + 60 : mid.x - 60;
  await page.mouse.move(x, mid.y, { steps: 8 });
}
await page.mouse.up({ button: "middle" });
report.yawOscillate = summarize("yawOscillate", 32, await stopLogs());

await page.reload({ waitUntil: "domcontentloaded" });
await page.click('[data-tab="falling-blocks"]');
await page.waitForFunction(() => window.__fallingSim && window.__fallingSim.view().gridFitDist > 0, null, {
  timeout: 20000,
});
await armPage();
await page.evaluate(() => window.__fallingSim.setMaterial("block"));

async function emitStroke(label, from, to, steps, shift) {
  await page.evaluate(() => window.__fallingSim.clear());
  await resetLogs();
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.waitForTimeout(40);
  await page.mouse.down();
  await page.waitForTimeout(220);
  await page.mouse.move(to.x, to.y, { steps });
  await page.waitForTimeout(80);
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
  const data = await stopLogs();
  const cells = await page.evaluate(() => {
    const seen = new Set();
    for (const sample of window.__fallingSim.state().samples) seen.add(`${sample.x},${sample.z}`);
    return seen.size;
  });
  report[label] = summarize(label, steps, data, { pouredColumns: cells, shift: !!shift });
}

await emitStroke("emitClumpStroke", midLeft, midRight, 18, false);
await emitStroke("emitStreamStroke", pt(0.3, 0.62), pt(0.7, 0.62), 18, true);

await resetLogs();
await page.evaluate(() => window.__fallingSim.clear());
await sweep(midLeft, midRight, 16, 20);
const hoverOnly = await stopLogs();
report.hoverDoesNotEmit = summarize("hoverDoesNotEmit", 16, hoverOnly);

await page.mouse.move(mid.x, mid.y);
await page.waitForTimeout(80);
const aimAtCenter = await page.evaluate(() => window.__fallingSim.view());
await page.mouse.move(mid.x + 70, mid.y + 40, { steps: 10 });
await page.waitForTimeout(80);
const aimAfter = await page.evaluate(() => window.__fallingSim.view());
report.aimFollowsRelease = {
  before: { cellX: aimAtCenter.cellX, cellZ: aimAtCenter.cellZ, aimX: aimAtCenter.aimX, aimZ: aimAtCenter.aimZ },
  after: { cellX: aimAfter.cellX, cellZ: aimAfter.cellZ, aimX: aimAfter.aimX, aimZ: aimAfter.aimZ },
  moved: aimAtCenter.cellX !== aimAfter.cellX || aimAtCenter.cellZ !== aimAfter.cellZ,
};

console.log(JSON.stringify(report, null, 2));
await browser.close();
