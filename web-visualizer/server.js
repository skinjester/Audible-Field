const http = require("http");
const fs = require("fs");
const path = require("path");

const HTTP_PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");
const THREE_DIR = path.join(__dirname, "node_modules", "three");
const BEDS_DIR = path.join(PUBLIC_DIR, "beds");
const SAMPLES_DIR = path.join(__dirname, "..", "samples");
const WAMS_DIR = path.join(PUBLIC_DIR, "wams");
const STEM_DEFAULTS_FILE = path.join(PUBLIC_DIR, "stem-defaults.json");
const STEM_CORNERS = ["tl", "tr", "bl", "br"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const AUDIO_EXTS = new Set([".wav", ".aif", ".aiff", ".mp3", ".ogg", ".flac", ".m4a"]);

const BED_ALLOW = new Set([
  "Beach-rx.wav",
  "Forest-rx.wav",
  "River-rx.wav",
  "Meditation Synth-rx.wav",
]);

function underRoot(filePath, root) {
  const resolved = path.normalize(filePath);
  const rootResolved = path.normalize(root);
  return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
}

function resolveSampleRel(relPath) {
  const cleaned = String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (cleaned.includes("..")) return null;
  const filePath = path.normalize(path.join(SAMPLES_DIR, cleaned));
  if (!underRoot(filePath, SAMPLES_DIR)) return null;
  return { cleaned, filePath };
}

function listSamplesDir(relPath) {
  const resolved = resolveSampleRel(relPath || "");
  if (!resolved) return null;
  const { cleaned, filePath } = resolved;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isDirectory()) return null;

  const entries = fs.readdirSync(filePath, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      dirs.push(entry.name);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) continue;
    files.push(entry.name);
  }
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));
  return { path: cleaned, dirs, files };
}

/** Recursively collect audio files grouped by relative folder under samples/. */
function listAllSamplesGrouped() {
  if (!fs.existsSync(SAMPLES_DIR) || !fs.statSync(SAMPLES_DIR).isDirectory()) {
    return { groups: [] };
  }

  const byFolder = new Map();

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
        if (!underRoot(abs, SAMPLES_DIR)) continue;
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) continue;
      const folder = relDir || "";
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder).push(entry.name);
    }
  }

  walk(SAMPLES_DIR, "");

  const groups = [...byFolder.entries()]
    .filter(([, files]) => files.length > 0)
    .map(([folder, files]) => ({
      folder,
      files: files.slice().sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.folder.localeCompare(b.folder));

  const natureFiles = ["Beach-rx.wav", "Forest-rx.wav", "River-rx.wav"].filter((name) => {
    const filePath = path.join(BEDS_DIR, name);
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  });
  if (natureFiles.length) {
    groups.unshift({
      folder: "nature",
      urlBase: "/beds",
      files: natureFiles,
    });
  }

  return { groups };
}

/** Discover vendored WAM2 plugins (descriptor.json under public/wams, skip utils). */
function listWams() {
  const plugins = [];
  if (!fs.existsSync(WAMS_DIR) || !fs.statSync(WAMS_DIR).isDirectory()) {
    return { plugins };
  }

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
      const folder = relDir || "";
      const indexJs = path.join(absDir, "index.js");
      if (!fs.existsSync(indexJs)) continue;
      const pluginPath = folder ? `${folder}/index.js` : "index.js";
      plugins.push({
        id: `wam:${folder || desc.identifier || desc.name}`,
        name: desc.name || path.basename(folder) || "WAM",
        vendor: desc.vendor || folder.split("/")[0] || "Unknown",
        path: pluginPath.replace(/\\/g, "/"),
        folder: folder.replace(/\\/g, "/"),
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

function resolveFilePath(urlPath) {
  if (urlPath.startsWith("/vendor/three/")) {
    const relative = urlPath.slice("/vendor/three/".length);
    const filePath = path.normalize(path.join(THREE_DIR, relative));
    if (!underRoot(filePath, THREE_DIR)) return null;
    return filePath;
  }

  if (urlPath.startsWith("/beds/")) {
    const name = decodeURIComponent(urlPath.slice("/beds/".length));
    if (!BED_ALLOW.has(name) || name.includes("..") || name.includes("/") || name.includes("\\")) {
      return null;
    }
    const filePath = path.normalize(path.join(BEDS_DIR, name));
    if (!underRoot(filePath, BEDS_DIR)) return null;
    return filePath;
  }

  if (urlPath.startsWith("/samples/")) {
    const rel = decodeURIComponent(urlPath.slice("/samples/".length));
    const resolved = resolveSampleRel(rel);
    if (!resolved) return null;
    return resolved.filePath;
  }

  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!underRoot(filePath, PUBLIC_DIR)) return null;
  return filePath;
}

function isSafeStemUrl(url) {
  if (typeof url !== "string" || url.length > 512) return false;
  if (!url.startsWith("/samples/") && !url.startsWith("/beds/")) return false;
  if (url.includes("..") || url.includes("\\") || url.includes("\0")) return false;
  return true;
}

function sanitizeStemDefaults(body) {
  if (!body || typeof body !== "object") return null;
  const corners = {};
  for (const corner of STEM_CORNERS) {
    const next = body[corner];
    if (!next || typeof next !== "object") return null;
    const label = String(next.label || "").trim().slice(0, 120);
    const file = String(next.file || "").trim().slice(0, 180);
    const url = String(next.url || "").trim();
    const id = String(next.id || label).trim().slice(0, 240);
    if (!label || !file || !isSafeStemUrl(url)) return null;
    corners[corner] = { id, label, file, url };
  }
  const savedAt = Number(body.savedAt);
  return {
    savedAt: Number.isFinite(savedAt) ? savedAt : Date.now(),
    ...corners,
  };
}

function readJsonBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : null);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

const httpServer = http.createServer((req, res) => {
  const rawUrl = req.url || "/";
  const qIndex = rawUrl.indexOf("?");
  const urlPath = decodeURIComponent(qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl);
  const query = qIndex >= 0 ? new URLSearchParams(rawUrl.slice(qIndex + 1)) : new URLSearchParams();

  if (urlPath === "/api/stem-defaults" && req.method === "POST") {
    void (async () => {
      try {
        const next = sanitizeStemDefaults(await readJsonBody(req));
        if (!next) {
          sendJson(res, 400, { error: "Invalid stem defaults" });
          return;
        }
        fs.writeFileSync(STEM_DEFAULTS_FILE, `${JSON.stringify(next, null, 2)}\n`);
        sendJson(res, 200, next);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 400, { error: "Invalid JSON" });
      }
    })();
    return;
  }

  if (urlPath === "/api/samples/all") {
    sendJson(res, 200, listAllSamplesGrouped());
    return;
  }

  if (urlPath === "/api/wams") {
    sendJson(res, 200, listWams());
    return;
  }

  if (urlPath === "/api/samples") {
    const listing = listSamplesDir(query.get("path") || "");
    if (!listing) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    sendJson(res, 200, listing);
    return;
  }

  const filePath = resolveFilePath(urlPath);

  if (!filePath) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(statErr && statErr.code === "ENOENT" ? 404 : 500).end("Not found");
      return;
    }

    const contentType = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const headers = {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
    };

    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = Number(parts[0]);
      const end = parts[1] ? Number(parts[1]) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    fs.createReadStream(filePath).pipe(res);
  });
});

httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
  console.log(`EchoScape mixer viz`);
  console.log(`  Web app      http://127.0.0.1:${HTTP_PORT}`);
  console.log(`  Beds         http://127.0.0.1:${HTTP_PORT}/beds/…`);
  console.log(`  Samples      http://127.0.0.1:${HTTP_PORT}/samples/…`);
});
