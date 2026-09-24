/**
 * Vendor selected public WAMs from webaudiomodules.com/community into public/wams.
 * Recursively follows relative imports + common asset names.
 *
 * Usage: node scripts/vendor-wams.mjs
 */
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEST = path.join(ROOT, "public", "wams");
const BASE = "https://www.webaudiomodules.com/community/plugins/";

/** Shortlist mapped to face-button slots (and RT). */
const PLUGINS = [
  // Cross — drive
  "wimmics/temper",
  "wimmics/quadrafuzz/dist",
  "burns-audio/distortion",
  // Square — modulation / delay
  "wimmics/ThruZeroFlanger",
  "wimmics/stonephaser",
  "wimmics/WeirdPhaser",
  "wimmics/pingpongdelay/dist",
  // Triangle — filter / pitch
  "wimmics/sweetWah",
  "wimmics/DualPitchShifter",
  "wimmics/graphicEqualizer",
  // Circle — shimmer family (OwlShimmer already local)
  "wimmics/OwlDirty",
  // RT hall candidates (available for later)
  "wimmics/greyhole",
  "burns-audio/reverb",
];

const EXTRA_SEED = [
  "descriptor.json",
  "index.js",
  "Node.js",
  "host.js",
  "main.json",
  "default.png",
  "screenshot.png",
  "Gui/index.js",
  "Gui/Gui.js",
];

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "echoscape-vendor" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchBuffer(res.headers.location).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            const err = new Error(`HTTP ${res.statusCode} ${url}`);
            err.status = res.statusCode;
            err.body = buf;
            reject(err);
            return;
          }
          resolve(buf);
        });
      })
      .on("error", reject);
  });
}

function extractRefs(text, fromFile) {
  const refs = new Set();
  const dir = path.posix.dirname(fromFile.replace(/\\/g, "/"));
  const re =
    /(?:from\s+|import\s*\(|new\s+URL\s*\(\s*|fetch\s*\(\s*|Worker\s*\(\s*|AudioWorkletNode[^,]*,\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) {
    let ref = m[1];
    if (/^(https?:|data:|blob:)/i.test(ref)) continue;
    if (ref.startsWith("/")) continue;
    // resolve relative to current file
    let resolved = path.posix.normalize(path.posix.join(dir === "." ? "" : dir, ref));
    if (resolved.startsWith("../")) {
      // allow leaving plugin folder into shared utils — still under plugins/
      resolved = path.posix.normalize(resolved);
    }
    refs.add(resolved.replace(/^\.\//, ""));
  }
  // bare .wasm / .json near Faust plugins
  const assetRe = /['"]([^'"]+\.(?:wasm|json|png|svg|jpg|jpeg|css|html|js|dsp))['"]/g;
  while ((m = assetRe.exec(text))) {
    const ref = m[1];
    if (/^(https?:|data:)/i.test(ref)) continue;
    if (ref.includes("node_modules") || ref.startsWith("@")) continue;
    if (!ref.includes("/") && !ref.includes(".")) continue;
    if (ref.startsWith("./") || ref.startsWith("../") || !ref.includes(":")) {
      const resolved = path.posix.normalize(path.posix.join(dir === "." ? "" : dir, ref));
      if (!resolved.startsWith("..") || resolved.includes("utils/")) {
        refs.add(resolved.replace(/^\.\//, ""));
      }
    }
  }
  return [...refs];
}

async function downloadPlugin(pluginRel) {
  const queue = [];
  const seen = new Set();
  const prefix = pluginRel.replace(/\/+$/, "");

  for (const seed of EXTRA_SEED) {
    queue.push(`${prefix}/${seed}`);
  }

  // Also seed utils if wimmics plugin references sibling utils
  let ok = 0;
  let fail = 0;

  while (queue.length) {
    const rel = queue.shift().replace(/\\/g, "/").replace(/^\/+/, "");
    if (seen.has(rel)) continue;
    seen.add(rel);

    // Only download under our plugin or shared wimmics/utils
    const allowed =
      rel.startsWith(prefix + "/") ||
      rel.startsWith("wimmics/utils/") ||
      rel.startsWith("burns-audio/");
    if (!allowed) continue;

    const url = BASE + rel;
    const dest = path.join(DEST, rel);
    try {
      const buf = await fetchBuffer(url);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      ok++;
      process.stdout.write(`  + ${rel}\n`);

      const ext = path.extname(rel).toLowerCase();
      if ([".js", ".mjs", ".html", ".css", ".json"].includes(ext)) {
        const text = buf.toString("utf8");
        for (const ref of extractRefs(text, rel)) {
          // refs may be like wimmics/temper/Gui/Gui.js already absolute-from-plugins
          let next = ref;
          if (!next.startsWith("wimmics/") && !next.startsWith("burns-audio/")) {
            // relative path already resolved against file dir in extractRefs
            next = ref;
          }
          // If extract resolved to something still relative without vendor prefix
          if (!next.startsWith("wimmics/") && !next.startsWith("burns-audio/")) {
            next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), path.posix.basename(ref) === ref ? ref : ref));
            // extractRefs already joined with dir — use as-is if it contains /
            next = ref.includes("/") || ref.includes(".") ? ref : `${prefix}/${ref}`;
            if (!next.startsWith("wimmics/") && !next.startsWith("burns-audio/")) {
              // ref from extractRefs is path relative to plugins root when we joined with file dir
              // Our extractRefs returns paths relative to plugins root IF fromFile includes vendor prefix
              next = ref.startsWith("wimmics/") || ref.startsWith("burns-audio/")
                ? ref
                : path.posix.normalize(path.posix.join(path.posix.dirname(rel), ref));
              // wait - extractRefs already does join(dir, ref) where dir is dirname of fromFile
              // fromFile is e.g. wimmics/temper/index.js so dir is wimmics/temper
              // so ref comes back as wimmics/temper/Gui/index.js — good, already full
              next = ref;
            }
          }
          if (!seen.has(next)) queue.push(next);
        }
      }
    } catch (err) {
      if (err.status === 404) {
        fail++;
        continue;
      }
      console.warn(`  ! ${rel}: ${err.message}`);
      fail++;
    }
  }

  return { ok, fail };
}

async function main() {
  console.log("Vendoring WAMs into", DEST);
  fs.mkdirSync(DEST, { recursive: true });

  for (const plugin of PLUGINS) {
    console.log(`\n== ${plugin} ==`);
    const { ok, fail } = await downloadPlugin(plugin);
    console.log(`   done: ${ok} files (${fail} missing seeds/refs)`);
  }

  // Normalize quadrafuzz/pingpongdelay: if they live under .../dist, also ensure
  // descriptor is findable — /api/wams walks for descriptor.json.
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
