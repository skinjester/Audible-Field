const dgram = require("dgram");
const http = require("http");
const fs = require("fs");
const path = require("path");
const osc = require("osc-min");
const { WebSocketServer } = require("ws");

const OSC_PORT = Number(process.env.OSC_PORT) || 9000;
const HTTP_PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

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

  if (path === "/mixer/xy" && rest.length >= 2) {
    broadcast({ type: "xy", source: "mixer", x: Number(rest[0]), y: Number(rest[1]) });
    return;
  }
  if (path === "/mixer/touch" && rest.length >= 2) {
    broadcast({ type: "xy", source: "touch", x: Number(rest[0]), y: Number(rest[1]) });
    return;
  }
  if (path === "/mixer/dpad" || (parts[0] === "mixer" && parts[1] === "dpad")) {
    const dir = String(parts[2] || rest[0] || "");
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
  }
}

const httpServer = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
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
  if (address && !seenOsc.has(address) && seenOsc.size < 20) {
    seenOsc.add(address);
    console.log("OSC", address, oscArgs(parsed));
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
  });
});
