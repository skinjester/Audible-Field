import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "wam-params-probe.json");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("console.error", m.text().slice(0, 200));
});

await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await page.locator('[data-mode="browser"]').click();
await page.waitForTimeout(2500);

const api = await (await page.request.get("http://127.0.0.1:8080/api/wams")).json();

const result = await page.evaluate(async (plugins) => {
  const { loadWam, listStickParams } = await import("/wam-host.js?v=4");
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  await ctx.resume();

  const out = {};
  for (const p of plugins) {
    const entry = { name: p.name, vendor: p.vendor, params: {}, stickCandidates: [], error: null };
    try {
      const inst = await loadWam(ctx, p.path);
      const stick = await listStickParams(inst.audioNode, inst);
      entry.stickCandidates = stick;

      let raw = {};
      for (const target of [inst.audioNode, inst, inst.audioNode?._wamNode]) {
        if (!target?.getParameterInfo) continue;
        try {
          const next = await target.getParameterInfo();
          if (next && Object.keys(next).length) {
            raw = next;
            break;
          }
        } catch {
          /* try next */
        }
      }
      // Faust fallback: getDescriptor keyed by label
      if (!Object.keys(raw).length && typeof inst.audioNode?.getDescriptor === "function") {
        const desc = inst.audioNode.getDescriptor();
        for (const [label, v] of Object.entries(desc || {})) {
          raw[label] = { label, ...v, type: "float" };
        }
      }
      // Faust path list
      if (typeof inst.audioNode?.getParams === "function") {
        entry.paramPaths = inst.audioNode.getParams();
      }

      for (const [k, v] of Object.entries(raw)) {
        entry.params[k] = {
          label: v?.label ?? k,
          min: v?.minValue,
          max: v?.maxValue,
          default: v?.defaultValue,
          type: v?.type ?? "float",
        };
      }

      try {
        await inst.audioNode?.disconnect?.();
      } catch {
        /* ignore */
      }
      try {
        await inst.destroy?.();
      } catch {
        /* ignore */
      }
    } catch (e) {
      entry.error = e?.message || String(e);
    }
    out[p.path] = entry;
  }

  await ctx.close();
  return out;
}, api.plugins);

await browser.close();
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log("wrote", outPath);
for (const [pathKey, entry] of Object.entries(result)) {
  const n = Object.keys(entry.params || {}).length;
  console.log(
    `${pathKey}: ${entry.error || `${n} params`}${entry.stickCandidates?.length ? ` (${entry.stickCandidates.length} stickable)` : ""}`
  );
}
