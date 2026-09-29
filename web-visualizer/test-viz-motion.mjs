import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8080/";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function importLine(file, needle) {
  const text = fs.readFileSync(path.join(publicDir, file), "utf8");
  const line = text.split(/\r?\n/).find((row) => row.includes(needle));
  return (line || "").trim();
}

function meanAbsDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

function moduleSpec(file, needle) {
  const line = importLine(file, needle);
  const match = line.match(/[\w.-]+\.js\?v=\d+/);
  if (!match) throw new Error(`missing module spec for ${needle} in ${file}`);
  return match[0];
}

const appImport = importLine("app.js", "mixer-core.js");
const vizImport = importLine("visualize.js", "mixer-core.js");
assert(appImport.includes("mixer-core.js?"), `app.js mixer import missing cache query: ${appImport}`);
assert(
  vizImport === appImport || (vizImport.includes("mixer-core.js?") && appImport.endsWith(vizImport.slice(vizImport.indexOf("mixer-core.js")))),
  `mixer-core imports must be the same module URL\n  app: ${appImport}\n  viz: ${vizImport}`,
);
const appCore = appImport.match(/mixer-core\.js\?v=\d+/);
const vizCore = vizImport.match(/mixer-core\.js\?v=\d+/);
assert(appCore && vizCore && appCore[0] === vizCore[0], `split mixer-core modules:\n  app: ${appImport}\n  viz: ${vizImport}`);
console.log("import check:", appCore[0]);
const diagSpec = moduleSpec("app.js", "diagnostics.js");
const mixerSpec = moduleSpec("app.js", "mixer-core.js");

const mixerUrls = new Set();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("request", (req) => {
  const url = req.url();
  if (url.includes("mixer-core.js")) mixerUrls.add(url.split("/").pop());
});

const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

await page.goto(`${APP_URL}#visualize`, { waitUntil: "networkidle" });
await page.click('[data-tab="visualize"]');
await page.waitForSelector("[data-viz-canvas]");
await page.waitForFunction(() => {
  const fps = document.querySelector("[data-viz-fps]")?.textContent;
  const n = Number(fps);
  return Number.isFinite(n) && n > 0;
}, { timeout: 15000 });
await page.waitForTimeout(500);

const padVisible = await page.locator("[data-pad]").isVisible();
const hostCount = await page.locator("[data-viz-pad-host]").count();
assert(!padVisible, "quadrant pad is still visible on the visualize tab");
assert(hostCount === 0, "visualize pad host is still in the DOM");

const flags0 = (await page.locator("[data-viz-flags]").textContent()) || "";
const idleA = await page.locator("[data-viz-canvas]").screenshot();
await page.waitForTimeout(280);
const idleB = await page.locator("[data-viz-canvas]").screenshot();
const idleDiff = meanAbsDiff(idleA, idleB);

await page.evaluate(
  async ({ diagSpec, raw }) => {
    const diag = await import(`/${diagSpec}`);
    diag.applyRawStick(raw[0], raw[1]);
  },
  { diagSpec, raw: [0.95, 0.85] }
);
await page.waitForTimeout(120);
await page.waitForFunction(() => {
  const flags = document.querySelector("[data-viz-flags]")?.textContent || "";
  return /RIPPLE|WAVES|MAGNET|DRIFT/.test(flags);
}, { timeout: 8000 });

const liveA = await page.locator("[data-viz-canvas]").screenshot();
await page.waitForTimeout(320);
const liveB = await page.locator("[data-viz-canvas]").screenshot();
const liveDiff = meanAbsDiff(liveA, liveB);
const flags1 = (await page.locator("[data-viz-flags]").textContent()) || "";

await page.evaluate(
  async ({ mixerSpec, xy }) => {
    const mixer = await import(`/${mixerSpec}`);
    mixer.setTarget(xy[0], xy[1], "mouse", true);
  },
  { mixerSpec, xy: [0.05, 0.05] }
);
await page.waitForTimeout(350);
const mixShot = await page.locator("[data-viz-canvas]").screenshot();
const mixDiff = meanAbsDiff(liveB, mixShot);

await browser.close();

console.log({
  mixerUrls: [...mixerUrls],
  flagsBefore: flags0.trim(),
  flagsAfter: flags1.trim(),
  idleDiff: +idleDiff.toFixed(3),
  liveDiff: +liveDiff.toFixed(3),
  mixDiff: +mixDiff.toFixed(3),
  pageErrors: errors,
});

assert(mixerUrls.size === 1, `expected one mixer-core URL, got ${[...mixerUrls].join(", ")}`);
assert(!errors.length, `page errors: ${errors.join(" | ")}`);
assert(/RIPPLE|WAVES|MAGNET|DRIFT/.test(flags1), `shader never went live: ${flags1}`);
assert(idleDiff < 12, `idle terrain should be nearly still, mean diff ${idleDiff.toFixed(3)}`);
assert(liveDiff > Math.max(12, idleDiff * 4), `stick FX produced no motion (idle ${idleDiff.toFixed(3)}, live ${liveDiff.toFixed(3)})`);
assert(mixDiff > 1.2, `pad mix change did not reach the terrain (diff ${mixDiff.toFixed(3)})`);
console.log("PASS: visualize shares mixer state, pad is hidden, terrain moves under stick FX");
