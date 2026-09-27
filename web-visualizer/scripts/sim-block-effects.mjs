import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (err) => errors.push(err.stack || err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`${msg.text()} @ ${msg.location().url}:${msg.location().lineNumber}`);
});
page.on("response", (res) => {
  if (res.status() >= 400) errors.push(`HTTP ${res.status()} ${res.url()}`);
});

await page.goto("http://127.0.0.1:8080/?sim=1", { waitUntil: "domcontentloaded" });
await page.click('[data-tab="falling-blocks"]');
try {
  await page.waitForFunction(() => window.__fallingSim, null, { timeout: 20000 });
} catch (err) {
  const debug = await page.evaluate(() => ({
    href: location.href,
    body: document.body.className,
    error: document.querySelector("[data-falling-error]")?.textContent || "",
    panelHidden: document.querySelector("[data-panel='falling-blocks']")?.hasAttribute("hidden"),
    hook: typeof window.__fallingSim,
  }));
  console.log("DEBUG", JSON.stringify({ debug, errors }, null, 2));
  throw err;
}

const infection = await page.evaluate(() => window.__fallingSim.infectionCase());
await page.evaluate(() => window.__fallingSim.placeColumn(1));
await page.waitForTimeout(1200);
const loneEarly = await page.evaluate(() => window.__fallingSim.state());
await page.waitForTimeout(3600);
const loneLate = await page.evaluate(() => window.__fallingSim.state());

await page.evaluate(() => window.__fallingSim.placeColumn(2));
await page.waitForFunction(() => {
  const s = window.__fallingSim.state();
  const bottom = s.samples.find((cell) => cell.y === 0);
  const top = s.samples.find((cell) => cell.y > 0);
  return (
    s.atoms === 2 &&
    bottom &&
    bottom.shrinking === false &&
    bottom.scale > 0.98 &&
    bottom.clocks[1] > 0.4 &&
    top &&
    top.shrinking === false &&
    top.clocks[0] === 0 &&
    top.clocks[1] === 0
  );
});
const stackEarly = await page.evaluate(() => window.__fallingSim.state());
await page.waitForFunction(() => {
  const s = window.__fallingSim.state();
  return s.atoms === 1 && s.samples[0]?.shrinking === true && s.samples[0].clocks[0] < 1.2;
});
const stackMid = await page.evaluate(() => window.__fallingSim.state());
await page.waitForFunction(() => window.__fallingSim.state().atoms === 0, null, { timeout: 15000 });
const stackLate = await page.evaluate(() => window.__fallingSim.state());

await browser.close();

const report = {
  errors: errors.filter((e) => !e.includes("favicon")),
  infection,
  loneEarly,
  loneLate,
  stackEarly,
  stackMid,
  stackLate,
};
console.log(JSON.stringify(report, null, 2));

const lone = loneEarly.samples[0];
const bottom = stackEarly.samples.find((s) => s.y === 0);
const top = stackEarly.samples.find((s) => s.y > 0);
const ok =
  report.errors.length === 0 &&
  infection.tagged.block === 6 &&
  infection.tagged.water === 0 &&
  infection.tagged.erode === 0 &&
  infection.stacked.present === 1 &&
  infection.stacked.shrink?.shrinking === false &&
  infection.airborne.present === 1 &&
  infection.airborne.shrink?.shrinking === true &&
  loneEarly.atoms === 1 &&
  lone?.shrinking === true &&
  lone?.scale < 0.9 &&
  loneLate.atoms === 0 &&
  stackEarly.atoms === 2 &&
  stackEarly.samples.find((s) => s.y === 0)?.shrinking === false &&
  stackMid.atoms === 1 &&
  stackMid.samples[0]?.shrinking === true &&
  stackMid.samples[0].clocks[0] < 1.2 &&
  stackLate.atoms === 0;

if (!ok) process.exit(1);
