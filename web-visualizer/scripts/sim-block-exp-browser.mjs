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
await page.waitForFunction(() => window.__fallingSim, null, { timeout: 20000 });

const labels = await page.locator("[data-falling-palette] button").allTextContents();
await page.click('[data-material="block-exp"]');
const pressed = await page.getAttribute('[data-material="block-exp"]', "aria-pressed");

const before = await page.evaluate(() => {
  window.__fallingSim.placeColumn(1);
  return window.__fallingSim.state();
});
await page.waitForTimeout(800);
const mid = await page.evaluate(() => window.__fallingSim.state());

await browser.close();

const start = before.samples[0];
const later = mid.samples[0];
const report = {
  errors: errors.filter((e) => !e.includes("favicon")),
  labels,
  pressed,
  before,
  mid,
};
console.log(JSON.stringify(report, null, 2));

const ok =
  report.errors.length === 0 &&
  labels.includes("Block Exp") &&
  pressed === "true" &&
  before.atoms === 1 &&
  mid.atoms === 1 &&
  later &&
  start &&
  later.shrinking === true &&
  later.scale < 0.95 &&
  later.x > start.x;
if (!ok) process.exit(1);
