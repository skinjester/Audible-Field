import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (err) => errors.push(err.stack || err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`${msg.text()} @ ${msg.location().url}:${msg.location().lineNumber}`);
});

await page.goto("http://127.0.0.1:8080/?sim=1", { waitUntil: "domcontentloaded" });
await page.click('[data-tab="falling-blocks"]');
await page.waitForFunction(() => window.__fallingSim?.placeCells, null, { timeout: 20000 });
await page.click('[data-material="block-exp"]');

const scripts = await page.evaluate(() =>
  performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /app\.js|falling-blocks|rule-engine|materials\.json/.test(n)),
);

function summarize(state) {
  const floor = state.samples.filter((s) => s.y === 0);
  const byY = {};
  for (const s of state.samples) byY[s.y] = (byY[s.y] || 0) + 1;
  const uniq = new Set(state.samples.map((s) => `${s.x},${s.z}`));
  return {
    atoms: state.atoms,
    byY,
    columns: uniq.size,
    floor: floor
      .map((s) => `${s.x},${s.z}${s.onFloor ? "F" : ""}${s.resting ? "R" : ""} f${s.flowDx},${s.flowDz}`)
      .sort(),
    upper: state.samples
      .filter((s) => s.y > 0)
      .map((s) => `${s.x},${s.y},${s.z}${s.onFloor ? "F" : ""}${s.resting ? "R" : ""}`)
      .sort(),
  };
}

async function watch(label, place) {
  await page.evaluate(place);
  const snaps = [];
  for (const ms of [0, 120, 350, 800, 1600]) {
    if (ms) await page.waitForTimeout(ms - (snaps.at(-1)?.ms || 0));
    const state = await page.evaluate(() => window.__fallingSim.state());
    snaps.push({ ms, ...summarize(state) });
  }
  return { label, snaps };
}

const column = await watch("column-6", () => window.__fallingSim.placeColumn(6));

const carpet = await watch("carpet-3x3x3", () => {
  const cells = [];
  const x0 = 32;
  const z0 = 32;
  for (let y = 0; y < 3; y += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        cells.push({ x: x0 + dx, y, z: z0 + dz });
      }
    }
  }
  window.__fallingSim.placeCells(cells);
});

await browser.close();

const report = {
  errors: errors.filter((e) => !e.includes("favicon")),
  scripts,
  column,
  carpet,
};
console.log(JSON.stringify(report, null, 2));
