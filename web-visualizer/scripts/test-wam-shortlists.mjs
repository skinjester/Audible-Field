import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "warning" || m.type() === "error") console.log(m.type(), m.text());
});

const api = await (await page.request.get("http://127.0.0.1:8080/catalog/wams.json")).json();
console.log("vendored count", api.plugins.length);

await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await page.waitForTimeout(6000);

async function openSlot(slot) {
  await page.locator(`[data-fx-plugin="${slot}"]`).click();
  await page.waitForSelector(".stem-dropdown:not([hidden])");
  await page.waitForTimeout(200);
  const items = await page.locator(".stem-dropdown-item").allTextContents();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  return items;
}

const cross = await openSlot("cross");
const square = await openSlot("square");
const triangle = await openSlot("triangle");
const circle = await openSlot("circle");
console.log({ cross, square, triangle, circle });

await page.locator('[data-fx-plugin="cross"]').click();
await page.locator(".stem-dropdown-item", { hasText: /^Temper$/ }).click();
await page.waitForTimeout(3000);
const label = await page.locator('[data-fx-name="cross"]').textContent();
console.log("cross after Temper:", label);

const pass =
  api.plugins.length >= 12 &&
  cross.includes("Temper") &&
  square.includes("ThruZeroFlanger") &&
  triangle.includes("SweetWah") &&
  circle.includes("OWLShimmer") &&
  /Temper/i.test(label || "");

console.log(pass ? "PASS vendor shortlists" : "FAIL vendor shortlists");
await browser.close();
process.exit(pass ? 0 : 2);
