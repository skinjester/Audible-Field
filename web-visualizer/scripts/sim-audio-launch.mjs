/**
 * Phone launch silence.
 * The speaker stays closed until the context is suspended and resumed from a
 * tap, which is what Settings → Audio off → on does. A cold emit or a
 * Diagnostics tap has to do that itself.
 */
import { chromium, devices } from "playwright";
import { readFileSync } from "fs";

const BASE = process.env.AUDIO_SIM_URL || "http://127.0.0.1:8080/";
const RMS_FLOOR = 0.008;
const SHIM = readFileSync(new URL("./sim-audio-launch-shim.js", import.meta.url), "utf8");

function phoneContext(browser) {
  return browser.newContext({
    ...devices["Pixel 5"],
    serviceWorkers: "block",
  });
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--autoplay-policy=document-user-activation-required"],
  });
}

async function prepare(context, tab) {
  await context.addInitScript((tabId) => {
    try {
      localStorage.setItem("audible-field.tab", tabId);
    } catch {
      /* ignore */
    }
  }, tab);
  await context.addInitScript({ content: SHIM });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const probe = window.__audioLaunchProbe?.();
    const text = `${probe?.detail || ""} ${probe?.health || ""} ${probe?.status || ""}`;
    return probe?.ready && /beds [1-4]\/4/.test(text) && !/Loading/.test(probe?.status || "");
  }, null, { timeout: 30000 });
  return { page, errors };
}

async function readProbe(page) {
  return page.evaluate(() => window.__audioLaunchProbe());
}

async function waitForAudible(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = await readProbe(page);
  while (Date.now() < deadline) {
    last = await readProbe(page);
    if (last.live && last.rms >= RMS_FLOOR) return last;
    await page.waitForTimeout(200);
  }
  return last;
}

async function scenarioDiagnostics(browser) {
  const context = await phoneContext(browser);
  const { page, errors } = await prepare(context, "diagnostics");
  const before = await readProbe(page);
  await page.click("[data-pad]");
  const afterTap = await waitForAudible(page, 8000);
  await context.close();
  return { name: "diagnostics-tap", errors, before, afterTap };
}

async function scenarioFallingEmit(browser) {
  const context = await phoneContext(browser);
  const { page, errors } = await prepare(context, "falling-blocks");
  await page.waitForSelector("[data-falling-touch-emit]");
  const before = await readProbe(page);
  await page.click("[data-falling-touch-emit]");
  const afterEmit = await readProbe(page);
  await page.click('[data-tab="diagnostics"]');
  const afterDiagnostics = await waitForAudible(page, 8000);
  await context.close();
  return { name: "falling-emit", errors, before, afterEmit, afterDiagnostics };
}

const browser = await launchBrowser();
let report;
try {
  report = {
    diagnostics: await scenarioDiagnostics(browser),
    falling: await scenarioFallingEmit(browser),
  };
} finally {
  await browser.close();
}

console.log(JSON.stringify(report, null, 2));

function audible(probe) {
  return !!(probe && probe.live && probe.rms >= RMS_FLOOR);
}

const diagnosticsOk = report.diagnostics.before?.live === false && audible(report.diagnostics.afterTap);
const fallingOk =
  report.falling.before?.live === false &&
  report.falling.afterEmit?.live === true &&
  audible(report.falling.afterDiagnostics);
const errors = [report.diagnostics, report.falling].flatMap((row) => row.errors || []);
if (!diagnosticsOk || !fallingOk || errors.length) {
  console.error(JSON.stringify({ diagnosticsOk, fallingOk, errorCount: errors.length }, null, 2));
  process.exit(1);
}
console.log("audio launch sim: first tap opens the output");
