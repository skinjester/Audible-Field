const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HTTP_PORT = Number(process.env.PORT) || 8080;
const DIST_DIR = path.join(__dirname, "dist");
/** Audio trace lines posted by a page opened with `?trace` land here, one per line. */
const TRACE_FILE = path.join(__dirname, "trace.log");
const TRACE_MAX_BODY = 256 * 1024;

function appendTrace(req, res) {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > TRACE_MAX_BODY) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const text = body.endsWith("\n") ? body : `${body}\n`;
    fs.appendFile(TRACE_FILE, text, (err) => {
      if (err) {
        console.error("trace append failed:", err.message);
        res.writeHead(500, { "Access-Control-Allow-Origin": "*" }).end();
        return;
      }
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
    });
  });
}

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
  ".otf": "font/otf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function underRoot(filePath, root) {
  const resolved = path.normalize(filePath);
  const rootResolved = path.normalize(root);
  return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
}

function resolveFilePath(urlPath) {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  if (!relative || relative.includes("\0")) return null;
  const filePath = path.normalize(path.join(DIST_DIR, relative));
  if (!underRoot(filePath, DIST_DIR)) return null;
  return filePath;
}

const httpServer = http.createServer((req, res) => {
  const rawUrl = req.url || "/";
  const qIndex = rawUrl.indexOf("?");
  let urlPath;
  try {
    urlPath = decodeURIComponent(qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  if (urlPath === "/trace") {
    if (req.method === "POST") {
      appendTrace(req, res);
      return;
    }
    if (req.method === "OPTIONS") {
      res
        .writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        })
        .end();
      return;
    }
    res.writeHead(405).end("Method not allowed");
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

if (!fs.existsSync(path.join(DIST_DIR, "index.html"))) {
  console.error("dist/ is missing. Run npm run build in web-visualizer.");
  process.exit(1);
}

function lanAddresses() {
  const addresses = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      const v4 = addr.family === "IPv4" || addr.family === 4;
      if (v4 && !addr.internal && !addr.address.startsWith("169.254.")) {
        addresses.push(addr.address);
      }
    }
  }
  return addresses;
}

httpServer.listen(HTTP_PORT, "0.0.0.0", () => {
  console.log(`EchoScape mixer viz`);
  console.log(`  This machine  http://127.0.0.1:${HTTP_PORT}`);
  for (const address of lanAddresses()) {
    console.log(`  On your LAN   http://${address}:${HTTP_PORT}`);
  }
});
