/**
 * Reproduce stem-dropdown outside-click dismiss.
 * Run: node scripts/test-dropdown-dismiss.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8080/";

async function dumpDropdown(page, label) {
  const info = await page.evaluate(() => {
    const el = document.querySelector(".stem-dropdown");
    if (!el) return { exists: false };
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      exists: true,
      hiddenAttr: el.hidden,
      hasHiddenAttr: el.hasAttribute("hidden"),
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      ariaHidden: el.getAttribute("aria-hidden"),
      width: rect.width,
      height: rect.height,
      visibleBox: rect.width > 0 && rect.height > 0 && cs.display !== "none",
    };
  });
  console.log(`\n[${label}]`, JSON.stringify(info, null, 2));
  return info;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (msg) => console.log("PAGE:", msg.type(), msg.text()));

await page.goto(BASE, { waitUntil: "networkidle" });

// Prefer Browser mode so stem slots are interactive.
const browserBtn = page.locator('[data-mode="browser"]');
if (await browserBtn.count()) {
  await browserBtn.click();
  await page.waitForTimeout(200);
}

const slot = page.locator('[data-stem-slot="br"]');
await slot.waitFor({ state: "visible" });
const disabled = await slot.isDisabled();
console.log("stem slot disabled?", disabled);
if (disabled) {
  console.error("FAIL: stem slot disabled — cannot open dropdown");
  await browser.close();
  process.exit(1);
}

await slot.click();
await page.waitForSelector(".stem-dropdown:not([hidden])", { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(400);
const openInfo = await dumpDropdown(page, "after open");

if (!openInfo.visibleBox) {
  console.error("FAIL: dropdown did not open");
  await browser.close();
  process.exit(1);
}

// Click well outside the dropdown (page corner).
await page.mouse.click(8, 8);
await page.waitForTimeout(300);
const afterOutside = await dumpDropdown(page, "after outside click");

// Also try Escape if still open
if (afterOutside.visibleBox) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await dumpDropdown(page, "after Escape");
}

// Probe: does display:flex override [hidden]?
const cssProbe = await page.evaluate(() => {
  const el = document.createElement("div");
  el.className = "stem-dropdown";
  el.hidden = true;
  document.body.appendChild(el);
  const display = getComputedStyle(el).display;
  el.remove();
  return { displayWhenHiddenTrue: display, overridden: display !== "none" };
});
console.log("\n[CSS probe: .stem-dropdown[hidden]]", cssProbe);

const pass = !afterOutside.visibleBox;
console.log("\nRESULT:", pass ? "PASS — outside click closed dropdown" : "FAIL — dropdown still visible after outside click");
if (!pass && cssProbe.overridden) {
  console.log("ROOT CAUSE: .stem-dropdown { display:flex } overrides the hidden attribute — close sets hidden but menu stays painted.");
}

await browser.close();
process.exit(pass ? 0 : 2);
