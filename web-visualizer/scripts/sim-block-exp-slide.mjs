import { readFileSync } from "node:fs";
import { compileMaterials, parseMaterialsJson, stepWorld } from "../public/rule-engine.js";

const catalog = compileMaterials(
  parseMaterialsJson(readFileSync(new URL("../public/materials.json", import.meta.url), "utf8")),
);
const exp = catalog.indexById.get("block-exp");
const block = catalog.indexById.get("block");
if (!exp || !block) throw new Error("missing materials");
if (catalog.byId.get("block-exp")?.slideOpen !== true) throw new Error("slideOpen not compiled");
if (catalog.byId.get("block")?.slideOpen) throw new Error("block should not slide open");

const PITCH = 1;
const occ = new Map();
const shrink = new Map();
const shrinkAmt = new Map();
const extent = new Map();
const flowDx = new Map();
const flowDz = new Map();
const key = (x, y, z) => `${x},${y},${z}`;

const grid = {
  get: (x, y, z) => occ.get(key(x, y, z)) || 0,
  set: (x, y, z, v) => {
    if (!v) occ.delete(key(x, y, z));
    else occ.set(key(x, y, z), v);
  },
  inBounds: (x, y, z) => x >= 0 && z >= 0 && y >= 0 && x < 16 && z < 16 && y < 8,
  getShrink: (x, y, z) => shrink.get(key(x, y, z)) === true,
  setShrink: (x, y, z, on, t) => {
    const id = key(x, y, z);
    if (on) {
      shrink.set(id, true);
      shrinkAmt.set(id, t);
    } else {
      shrink.delete(id);
      shrinkAmt.delete(id);
    }
  },
  getShrinkT: (x, y, z) => shrinkAmt.get(key(x, y, z)) || 0,
  getExtent: (x, y, z) => extent.get(key(x, y, z)) ?? PITCH,
  getPitch: () => PITCH,
  cellCenter: (x, y, z) => ({ x, y, z }),
  getWorld: (x, y, z) => ({ x, y, z }),
  getFlowDx: (x, y, z) => flowDx.get(key(x, y, z)) || 0,
  setFlowDx: (x, y, z, v) => flowDx.set(key(x, y, z), v),
  getFlowDz: (x, y, z) => flowDz.get(key(x, y, z)) || 0,
  setFlowDz: (x, y, z, v) => flowDz.set(key(x, y, z), v),
  getEffectClock: () => 0,
  setEffectClock: () => {},
  getPosX: (x) => x,
  getPosY: (_x, y) => y,
  getPosZ: (_x, _y, z) => z,
  setPosX: () => {},
  setPosY: () => {},
  setPosZ: () => {},
};

function reset() {
  occ.clear();
  shrink.clear();
  shrinkAmt.clear();
  extent.clear();
  flowDx.clear();
  flowDz.clear();
}

function place(x, y, z, mat, opts = {}) {
  occ.set(key(x, y, z), mat);
  if (opts.shrinking) {
    shrink.set(key(x, y, z), true);
    shrinkAmt.set(key(x, y, z), opts.t ?? 0);
  }
  if (opts.extent) extent.set(key(x, y, z), opts.extent);
}

function where(mat) {
  const found = [];
  for (const [id, value] of occ) {
    if (value === mat) found.push(id);
  }
  return found;
}

reset();
place(4, 0, 4, exp, { shrinking: true, t: 0 });
stepWorld(grid, [{ x: 4, y: 0, z: 4, mat: exp }], catalog);
const openStep = where(exp)[0];

reset();
place(4, 0, 4, exp, { shrinking: true, t: 0 });
place(6, 0, 4, block, { extent: 1.8 });
stepWorld(grid, [
  { x: 4, y: 0, z: 4, mat: exp },
  { x: 6, y: 0, z: 4, mat: block },
], catalog);
const fullSizeStep = where(exp)[0];

reset();
place(4, 0, 4, exp, { shrinking: true, t: 0.8 });
place(6, 0, 4, block, { extent: 1.8 });
stepWorld(grid, [
  { x: 4, y: 0, z: 4, mat: exp },
  { x: 6, y: 0, z: 4, mat: block },
], catalog);
const smallStep = where(exp)[0];

reset();
place(4, 0, 4, exp, { shrinking: false });
stepWorld(grid, [{ x: 4, y: 0, z: 4, mat: exp }], catalog);
const resting = where(exp)[0];

reset();
place(4, 0, 4, block, { shrinking: true, t: 0.8 });
stepWorld(grid, [{ x: 4, y: 0, z: 4, mat: block }], catalog);
const plainBlock = where(block)[0];

const report = { openStep, fullSizeStep, smallStep, resting, plainBlock };
console.log(JSON.stringify(report, null, 2));

const ok =
  openStep === "5,0,4" &&
  fullSizeStep === "4,0,5" &&
  smallStep === "5,0,4" &&
  resting === "4,0,4" &&
  plainBlock === "4,0,4";
if (!ok) process.exit(1);
