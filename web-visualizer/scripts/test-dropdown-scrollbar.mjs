import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await page.locator('[data-mode="browser"]').click();
await page.locator('[data-stem-slot="br"]').click();
await page.waitForSelector(".stem-dropdown:not([hidden])");
await page.waitForTimeout(500);
const info = await page.evaluate(() => {
  const list = document.querySelector(".stem-dropdown-list");
  const scroll = document.querySelector(".stem-dropdown .ui-scroll-track");
  const thumb = document.querySelector(".stem-dropdown .ui-scroll-thumb");
  const dd = document.querySelector(".stem-dropdown");
  const cs = list ? getComputedStyle(list) : null;
  const sr = scroll?.getBoundingClientRect();
  const dr = dd?.getBoundingClientRect();
  return {
    nativeScrollbarWidth: cs?.scrollbarWidth,
    hasCustomScroll: !!scroll,
    hasThumb: !!thumb,
    scrollNeeded: scroll?.parentElement?.classList.contains("is-scrollable"),
    thumbHeight: thumb?.getBoundingClientRect().height ?? 0,
    insetRight: sr && dr ? Math.round(dr.right - sr.right) : null,
    insetTop: sr && dr ? Math.round(sr.top - dr.top) : null,
    insetBottom: sr && dr ? Math.round(dr.bottom - sr.bottom) : null,
  };
});
console.log(JSON.stringify(info, null, 2));
const ok =
  info.nativeScrollbarWidth === "none" &&
  info.hasCustomScroll &&
  info.scrollNeeded &&
  info.thumbHeight > 0 &&
  info.insetRight >= 4;
console.log(ok ? "PASS custom scrollbar" : "FAIL custom scrollbar");
await browser.close();
process.exit(ok ? 0 : 2);
