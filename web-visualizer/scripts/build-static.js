/**
 * Publish a static tree for local serving and a later Vercel deploy.
 * Output is web-visualizer/dist. Catalog paths always use "/".
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const SAMPLES_DIR = path.join(ROOT, "..", "sample-master");
const NATURE_DIR = path.join(SAMPLES_DIR, "beds");
const NATURE_FILES = ["Beach-rx.wav", "Forest-rx.wav", "River-rx.wav"];
const RUNTIME_DIR = path.join(ROOT, "..", "sample-runtime");
const WAMS_DIR = path.join(PUBLIC_DIR, "wams");
const THREE_FILE = path.join(ROOT, "node_modules", "three", "build", "three.module.js");
const DIST_DIR = path.join(ROOT, "dist");

const AUDIO_EXTS = new Set([".wav", ".aif", ".aiff", ".mp3", ".ogg", ".flac", ".m4a", ".webm", ".aac"]);
const SKIP_DIRS = new Set(["docs", "__test__", "node_modules"]);

function underRoot(filePath, root) {
  const resolved = path.normalize(filePath);
  const rootResolved = path.normalize(root);
  return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
}

function shouldSkipPublic(src) {
  const rel = path.relative(PUBLIC_DIR, src);
  if (!rel || rel.startsWith("..")) return false;
  if (rel.split(path.sep).some((part) => SKIP_DIRS.has(part))) return true;
  try {
    if (fs.statSync(src).isFile() && AUDIO_EXTS.has(path.extname(src).toLowerCase())) return true;
  } catch {
    return false;
  }
  return false;
}

function addSample(byFolder, folder, name) {
  if (!byFolder.has(folder)) byFolder.set(folder, []);
  byFolder.get(folder).push(name);
}

function walkSampleMasters(byFolder) {
  function walk(absDir, relDir) {
    if (!fs.existsSync(absDir)) return;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!relDir && entry.name === "beds") continue;
        if (!underRoot(abs, SAMPLES_DIR)) continue;
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) continue;
      addSample(byFolder, relDir || "", entry.name);
    }
  }

  walk(SAMPLES_DIR, "");
}

/** Menu names from the committed playback map when the local masters are absent. */
function listSamplesFromRuntimeMap(byFolder) {
  const mapFile = path.join(PUBLIC_DIR, "runtime-beds.js");
  if (!fs.existsSync(mapFile)) return;
  const text = fs.readFileSync(mapFile, "utf8");
  const re = /"(\/samples\/[^"]+)"/g;
  let match;
  while ((match = re.exec(text))) {
    let rel;
    try {
      rel = decodeURIComponent(match[1].slice("/samples/".length));
    } catch {
      continue;
    }
    if (!rel || rel.split("/").includes("..")) continue;
    const parts = rel.split("/");
    const name = parts.pop();
    if (!name || !AUDIO_EXTS.has(path.extname(name).toLowerCase())) continue;
    addSample(byFolder, parts.join("/"), name);
  }
}

function listAllSamplesGrouped() {
  const byFolder = new Map();
  walkSampleMasters(byFolder);
  if (byFolder.size === 0) listSamplesFromRuntimeMap(byFolder);

  const groups = [...byFolder.entries()]
    .filter(([, files]) => files.length > 0)
    .map(([folder, files]) => ({
      folder: folder.replace(/\\/g, "/"),
      files: files.slice().sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.folder.localeCompare(b.folder));

  const natureFiles = NATURE_FILES.filter((name) => {
    const filePath = path.join(NATURE_DIR, name);
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  });
  const listedNature = natureFiles.length
    ? natureFiles
    : NATURE_FILES.filter((name) => {
        const mapFile = path.join(PUBLIC_DIR, "runtime-beds.js");
        if (!fs.existsSync(mapFile)) return false;
        return fs.readFileSync(mapFile, "utf8").includes(`"/beds/${name}"`);
      });
  if (listedNature.length) {
    groups.unshift({
      folder: "nature",
      urlBase: "/beds",
      files: listedNature,
    });
  }

  return { groups };
}

function listWams() {
  const plugins = [];
  if (!fs.existsSync(WAMS_DIR)) return { plugins };

  function walk(absDir, relDir) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "utils" || entry.name === "node_modules") continue;
        if (!underRoot(abs, WAMS_DIR)) continue;
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile() || entry.name !== "descriptor.json") continue;
      if (!underRoot(abs, WAMS_DIR)) continue;
      let desc;
      try {
        desc = JSON.parse(fs.readFileSync(abs, "utf8"));
      } catch {
        continue;
      }
      const folder = (relDir || "").replace(/\\/g, "/");
      const indexJs = path.join(absDir, "index.js");
      if (!fs.existsSync(indexJs)) continue;
      const pluginPath = folder ? `${folder}/index.js` : "index.js";
      plugins.push({
        id: `wam:${folder || desc.identifier || desc.name}`,
        name: desc.name || path.basename(folder) || "WAM",
        vendor: desc.vendor || folder.split("/")[0] || "Unknown",
        path: pluginPath.replace(/\\/g, "/"),
        folder,
        keywords: Array.isArray(desc.keywords) ? desc.keywords : [],
      });
    }
  }

  walk(WAMS_DIR, "");
  plugins.sort((a, b) => {
    const v = String(a.vendor).localeCompare(String(b.vendor));
    return v !== 0 ? v : String(a.name).localeCompare(String(b.name));
  });
  return { plugins };
}

function writeJson(filePath, body) {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function main() {
  if (!fs.existsSync(THREE_FILE)) {
    throw new Error("Missing node_modules/three. Run npm install in web-visualizer.");
  }

  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  fs.cpSync(PUBLIC_DIR, DIST_DIR, {
    recursive: true,
    filter: (src) => !shouldSkipPublic(src),
  });

  if (process.env.VERCEL && fs.existsSync(RUNTIME_DIR)) {
    fs.cpSync(RUNTIME_DIR, path.join(DIST_DIR, "sample-runtime"), { recursive: true });
  }

  const threeDest = path.join(DIST_DIR, "vendor", "three", "build", "three.module.js");
  fs.mkdirSync(path.dirname(threeDest), { recursive: true });
  fs.copyFileSync(THREE_FILE, threeDest);

  const samples = listAllSamplesGrouped();
  const sampleCount = samples.groups
    .filter((group) => group.folder !== "nature")
    .reduce((count, group) => count + group.files.length, 0);
  const wams = listWams();
  writeJson(path.join(DIST_DIR, "catalog", "samples-all.json"), samples);
  writeJson(path.join(DIST_DIR, "catalog", "wams.json"), wams);

  console.log(
    `dist ready: ${sampleCount} samples, ${samples.groups.length} sample groups, ${wams.plugins.length} WAMs`
  );
}

main();
