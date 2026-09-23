const dgram = require("dgram");
const http = require("http");
const fs = require("fs");
const path = require("path");
const osc = require("osc-min");
const { WebSocketServer } = require("ws");

const OSC_PORT = Number(process.env.OSC_PORT) || 9000;
const HTTP_PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");
const THREE_DIR = path.join(__dirname, "node_modules", "three");
const BEDS_DIR = path.join(PUBLIC_DIR, "beds");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

const BED_ALLOW = new Set([
  "Beach-rx.wav",
  "Forest-rx.wav",
  "River-rx.wav",
  "Meditation Synth-rx.wav",
]);

function resolveFilePath(urlPath) {
  if (urlPath.startsWith("/vendor/three/")) {
    const relative = urlPath.slice("/vendor/three/".length);
    const filePath = path.normalize(path.join(THREE_DIR, relative));
    if (!filePath.startsWith(THREE_DIR)) return null;
    return filePath;
  }

  if (urlPath.startsWith("/beds/")) {
    const name = decodeURIComponent(urlPath.slice("/beds/".length));
    if (!BED_ALLOW.has(name) || name.includes("..") || name.includes("/") || name.includes("\\")) {
      return null;
    }
    const filePath = path.normalize(path.join(BEDS_DIR, name));
    if (!filePath.startsWith(BEDS_DIR)) return null;
    return filePath;
  }

  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR)) return null;
  return filePath;
}

function oscArgs(msg) {
  const args = msg.args || [];
  return args.map((arg) => (arg && typeof arg === "object" && "value" in arg ? arg.value : arg));
}

function parseButton(value) {
  const name = String(value || "").toLowerCase();
  if (name === "x") return "cross";
  return name;
}

function oscTokens(address, args) {
  return [address, ...args]
    .flatMap((part) => String(part).split(/\s+/))
    .filter(Boolean);
}

function handleOsc(msg, broadcast) {
  if (!msg) return;
  if (msg.oscType === "bundle") {
    for (const element of msg.elements || []) handleOsc(element, broadcast);
    return;
  }
  if (msg.oscType !== "message") return;

  const address = String(msg.address || "");
  const args = oscArgs(msg);
  const tokens = oscTokens(address, args);
  const path = tokens[0] || "";
  const rest = tokens.slice(1);
  const parts = path.split("/").filter(Boolean);

  if (path === "/mixer/xy" || (parts[0] === "mixer" && parts[1] === "xy")) {
    const x = Number(parts[2] != null ? parts[2] : rest[0]);
    const y = Number(parts[3] != null ? parts[3] : rest[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      broadcast({ type: "xy", source: "mixer", x, y });
    }
    return;
  }
  if (path === "/mixer/touch" || (parts[0] === "mixer" && parts[1] === "touch")) {
    const x = Number(parts[2] != null ? parts[2] : rest[0]);
    const y = Number(parts[3] != null ? parts[3] : rest[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      broadcast({ type: "xy", source: "touch", x, y });
    }
    return;
  }
  if (path === "/mixer/dpad" || (parts[0] === "mixer" && parts[1] === "dpad")) {
    const dir = String(parts[2] || rest[0] || "").toLowerCase();
    const raw = parts[2] != null ? rest[0] : rest[1];
    const value = raw == null || raw === "" ? 1 : Number(raw);
    broadcast({
      type: "dpad",
      dir,
      value: Number.isFinite(value) ? value : 1,
    });
    return;
  }
  if (parts[0] === "fx" && parts[1] === "select") {
    const button = parseButton(parts[2] || rest[0]);
    const raw = parts[2] != null ? rest[0] : rest[1];
    const value = raw == null || raw === "" ? 1 : Number(raw);
    broadcast({
      type: "fx-select",
      button,
      value: Number.isFinite(value) ? value : 1,
    });
    return;
  }
  if (parts[0] === "fx" && parts[1] === "stick") {
    const button = parseButton(parts[2] || rest[0]);
    const x = Number(parts[2] != null ? rest[0] : rest[1]);
    const y = Number(parts[2] != null ? rest[1] : rest[2]);
    broadcast({ type: "fx-stick", button, x, y });
    return;
  }
  if (path === "/fx/raw" && rest.length >= 2) {
    broadcast({
      type: "fx-raw",
      x: Number(rest[0]),
      y: Number(rest[1]),
    });
    return;
  }
  if (parts[0] === "fx" && parts[1] === "name") {
    const button = parseButton(parts[2] || args[0]);
    const nameParts = parts[2] != null ? args : args.slice(1);
    const name = nameParts.map(String).join(" ").trim();
    if (name) broadcast({ type: "fx-name", button, name });
    return;
  }
  if (path === "/pad/right" && rest.length >= 2) {
    broadcast({ type: "pad-right", x: Number(rest[0]), y: Number(rest[1]) });
    return;
  }
  if (path === "/pad/lt" || (parts[0] === "pad" && parts[1] === "lt")) {
    broadcast({ type: "pad-trigger", side: "lt", value: Number(rest[0]) });
    return;
  }
  if (path === "/pad/rt" || (parts[0] === "pad" && parts[1] === "rt")) {
    broadcast({ type: "pad-trigger", side: "rt", value: Number(rest[0]) });
    return;
  }
  if (path === "/pad/ls" || (parts[0] === "pad" && parts[1] === "ls")) {
    const raw = rest[0];
    const value = raw == null || raw === "" ? 1 : Number(raw);
    broadcast({ type: "pad-click", side: "ls", value: Number.isFinite(value) ? value : 1 });
    return;
  }
  if (path === "/pad/rs" || (parts[0] === "pad" && parts[1] === "rs")) {
    const raw = rest[0];
    const value = raw == null || raw === "" ? 1 : Number(raw);
    broadcast({ type: "pad-click", side: "rs", value: Number.isFinite(value) ? value : 1 });
    return;
  }
  if (path === "/pad/l1" || (parts[0] === "pad" && parts[1] === "l1")) {
    const raw = rest[0];
    const value = raw == null || raw === "" ? 1 : Number(raw);
    broadcast({ type: "pad-shoulder", side: "l1", value: Number.isFinite(value) ? value : 1 });
    return;
  }
  if (path === "/pad/r1" || (parts[0] === "pad" && parts[1] === "r1")) {
    const raw = rest[0];
    const value = raw == null || raw === "" ? 1 : Number(raw);
    broadcast({ type: "pad-shoulder", side: "r1", value: Number.isFinite(value) ? value : 1 });
  }
}

const httpServer = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
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

    const contentType = MIME[path.extname(filePath)] || "application/octet-stream";
    const headers = {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
    };

    // Stream large bed WAVs (and support Range) instead of buffering whole files.
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

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
const sockets = new Set();

wss.on("connection", (socket) => {
  sockets.add(socket);
  socket.send(JSON.stringify({ type: "hello", oscPort: OSC_PORT }));
  socket.on("close", () => sockets.delete(socket));
});

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}

const udp = dgram.createSocket("udp4");
const seenOsc = new Set();

udp.on("message", (buf) => {
  let parsed;
  try {
    parsed = osc.fromBuffer(buf);
  } catch (err) {
    if (seenOsc.size < 8) {
      console.warn("OSC parse failed:", err.message);
      seenOsc.add(`parse-error-${seenOsc.size}`);
    }
    return;
  }
  const address = parsed && parsed.address;
  const args = oscArgs(parsed);
  if (String(address || "").includes("dpad")) {
    console.log("OSC", address, args);
  } else if (address && !seenOsc.has(address) && seenOsc.size < 20) {
    seenOsc.add(address);
    console.log("OSC", address, args);
  }
  handleOsc(parsed, broadcast);
});

udp.on("error", (err) => {
  console.error("OSC socket error:", err.message);
});

udp.bind(OSC_PORT, "127.0.0.1", () => {
  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    console.log(`EchoScape mixer viz`);
    console.log(`  OSC listen   udp://127.0.0.1:${OSC_PORT}`);
    console.log(`  Web app      http://127.0.0.1:${HTTP_PORT}`);
    console.log(`  Beds         http://127.0.0.1:${HTTP_PORT}/beds/…`);
  });
});
