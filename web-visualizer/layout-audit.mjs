import { chromium } from "playwright";

const viewports = [
  { name: "ultrawide-short", width: 1920, height: 720 },
  { name: "laptop-short", width: 1440, height: 780 },
  { name: "screenshot-like", width: 1600, height: 820 },
  { name: "1080p", width: 1920, height: 1080 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "macbook-16", width: 1728, height: 1117 },
  { name: "narrow", width: 900, height: 900 },
];

const browser = await chromium.launch();
const results = [];

for (const vp of viewports) {
  const page = await browser.newPage({ viewport: vp });
  await page.goto("http://127.0.0.1:8080/?v=audit", { waitUntil: "networkidle" });
  await page.waitForSelector("[data-pad]");
  const metrics = await page.evaluate(() => {
    const pad = document.querySelector("[data-pad]");
    const readout = document.querySelector(".readout");
    const ctrl = document.querySelector(".ctrl");
    const fx = document.querySelector("[data-fx]");
    const panel = document.querySelector('[data-panel="diagnostics"]');
    const stack = document.querySelector(".mixer-stack");
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    const scrolled =
      document.documentElement.scrollHeight > window.innerHeight + 2 ||
      document.documentElement.scrollWidth > window.innerWidth + 2;
    const padBox = box(pad);
    return {
      scrolled,
      scrollH: document.documentElement.scrollHeight,
      innerH: window.innerHeight,
      innerW: window.innerWidth,
      pad: padBox,
      readout: box(readout),
      ctrl: box(ctrl),
      fx: box(fx),
      stack: box(stack),
      padShareW: padBox ? +(padBox.w / window.innerWidth).toFixed(3) : null,
      padShareH: padBox ? +(padBox.h / window.innerHeight).toFixed(3) : null,
      fxBottom: fx ? Math.round(fx.getBoundingClientRect().bottom) : null,
    };
  });
  results.push({ ...vp, ...metrics });
  await page.close();
}

await browser.close();

for (const row of results) {
  const square = row.pad && Math.abs(row.pad.w - row.pad.h) <= 3;
  const overflow = row.scrolled || row.fxBottom > row.innerH + 4;
  const padHeavy = (row.padShareW || 0) > 0.36;
  const flag = overflow ? "OVERFLOW" : !square ? "NOT-SQ" : padHeavy ? "PAD-HEAVY" : "fits    ";
  console.log(
    [
      row.name.padEnd(18),
      `${row.width}x${row.height}`.padEnd(12),
      flag,
      `pad ${row.pad?.w}x${row.pad?.h}`.padEnd(16),
      `${Math.round((row.padShareW || 0) * 100)}%W`.padEnd(5),
      `ctrl ${row.ctrl?.w}x${row.ctrl?.h}`.padEnd(16),
      `fx y=${row.fx?.y} h=${row.fx?.h}`,
    ].join("  ")
  );
}
