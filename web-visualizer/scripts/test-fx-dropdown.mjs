import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8080/";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (err) => console.log("PAGEERROR", err.message));

const api = await page.request.get(`${BASE}api/wams`);
const apiJson = await api.json();
console.log("api/wams", JSON.stringify(apiJson, null, 2));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const pluginBtn = page.locator('[data-fx-plugin="square"]');
await pluginBtn.click();
await page.waitForSelector(".stem-dropdown:not([hidden])", { timeout: 5000 });
await page.waitForTimeout(300);

const items = await page.locator(".stem-dropdown-item").allTextContents();
console.log("dropdown items:", items);

const hasNative = items.some((t) => /comb|saturn|native|filter/i.test(t));
const hasOwl = items.some((t) => /owl|shimmer/i.test(t));

await page.locator(".stem-dropdown-item", { hasText: /OWLShimmer/i }).first().click();
await page.waitForTimeout(1500);

const label = await page.locator('[data-fx-name="square"]').textContent();
console.log("square label after select:", label);

await page.mouse.click(8, 8);
await page.waitForTimeout(200);
const stillOpen = await page.locator(".stem-dropdown:not([hidden])").count();
console.log("dropdown open after outside:", stillOpen);

const pass =
  api.ok() &&
  Array.isArray(apiJson.plugins) &&
  apiJson.plugins.length >= 1 &&
  hasNative &&
  hasOwl &&
  /OWLShimmer/i.test(label || "") &&
  stillOpen === 0;

console.log(pass ? "PASS fx dropdown" : "FAIL fx dropdown");
await browser.close();
process.exit(pass ? 0 : 2);
