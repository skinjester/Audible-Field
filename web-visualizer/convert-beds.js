/**
 * Convert EchoScape 24-bit PCM beds → 16-bit PCM WAVs for Web Audio / HTMLAudioElement.
 * Chromium often cannot decode 24-bit WAV via MediaElement or decodeAudioData.
 */
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "EchoScape Max patch files");
const OUT_DIR = path.join(__dirname, "public", "beds");

const FILES = [
  "Beach-rx.wav",
  "Forest-rx.wav",
  "River-rx.wav",
];

function readU32(buf, off) {
  return buf.readUInt32LE(off);
}
function readU16(buf, off) {
  return buf.readUInt16LE(off);
}

function findChunk(buf, id) {
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const size = readU32(buf, offset + 4);
    if (chunkId === id) return { offset: offset + 8, size };
    offset += 8 + size + (size % 2);
  }
  return null;
}

function convertFile(name) {
  const src = path.join(SRC_DIR, name);
  const dst = path.join(OUT_DIR, name);
  if (!fs.existsSync(src)) {
    console.warn("missing", src);
    return;
  }
  if (fs.existsSync(dst)) {
    const s = fs.statSync(src);
    const d = fs.statSync(dst);
    if (d.mtimeMs >= s.mtimeMs && d.size > 1000) {
      console.log("skip (up to date)", name);
      return;
    }
  }

  const buf = fs.readFileSync(src);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${name}: not a RIFF/WAVE file`);
  }

  const fmt = findChunk(buf, "fmt ");
  const data = findChunk(buf, "data");
  if (!fmt || !data) throw new Error(`${name}: missing fmt/data`);

  const audioFormat = readU16(buf, fmt.offset);
  const channels = readU16(buf, fmt.offset + 2);
  const sampleRate = readU32(buf, fmt.offset + 4);
  const bitsPerSample = readU16(buf, fmt.offset + 14);

  if (audioFormat !== 1) throw new Error(`${name}: unsupported format ${audioFormat}`);
  if (bitsPerSample !== 24 && bitsPerSample !== 16) {
    throw new Error(`${name}: unexpected bit depth ${bitsPerSample}`);
  }

  console.log(`convert ${name}: ${channels}ch ${sampleRate}Hz ${bitsPerSample}-bit → 16-bit`);

  let pcm16;
  if (bitsPerSample === 16) {
    pcm16 = buf.subarray(data.offset, data.offset + data.size);
  } else {
    const frames = Math.floor(data.size / (channels * 3));
    pcm16 = Buffer.alloc(frames * channels * 2);
    let si = data.offset;
    let di = 0;
    for (let i = 0; i < frames * channels; i++) {
      // 24-bit little-endian signed → 16-bit (drop low byte)
      let sample = buf[si] | (buf[si + 1] << 8) | (buf[si + 2] << 16);
      if (sample & 0x800000) sample |= ~0xffffff; // sign extend
      si += 3;
      let s16 = sample >> 8;
      if (s16 > 32767) s16 = 32767;
      if (s16 < -32768) s16 = -32768;
      pcm16.writeInt16LE(s16, di);
      di += 2;
    }
  }

  const dataSize = pcm16.length;
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16); // PCM fmt chunk size
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  out.writeUInt16LE(channels * 2, 32); // block align
  out.writeUInt16LE(16, 34); // bits
  out.write("data", 36);
  out.writeUInt32LE(dataSize, 40);
  pcm16.copy(out, 44);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(dst, out);
  console.log(`  wrote ${dst} (${(out.length / 1e6).toFixed(1)} MB)`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const file of FILES) convertFile(file);
console.log("done");
