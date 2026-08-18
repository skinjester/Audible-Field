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

function handleOsc(msg, broadcast) {
  if (!msg) return;
  if (msg.oscType === "bundle") {
    for (const element of msg.elements || []) handleOsc(element, broadcast);
    return;
  }
  if (msg.oscType !== "message") return;

  const address = msg.address;
  const args = oscArgs(msg);

  if (address === "/mixer/xy" && args.length >= 2) {
    broadcast({ type: "xy", source: "mixer", x: Number(args[0]), y: Number(args[1]) });
    return;
  }
  if (address === "/mixer/touch" && args.length >= 2) {
    broadcast({ type: "xy", source: "touch", x: Number(args[0]), y: Number(args[1]) });
    return;
  }
  if (address === "/mixer/dpad" && args.length >= 1) {
    broadcast({
      type: "dpad",
      dir: String(args[0]),
      value: args.length > 1 ? Number(args[1]) : 1,
    });
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

udp.on("message", (buf) => {
  let parsed;
  try {
    parsed = osc.fromBuffer(buf);
  } catch {
    return;
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
