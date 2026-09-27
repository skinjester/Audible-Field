import { readFileSync } from "node:fs";
import { compileMaterials, parseMaterialsJson, stepWorld, tickEffects } from "../public/rule-engine.js";

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
const shuffle = new Map();
const clocks = new Map();
const budget = new Map();
const key = (x, y, z) => `${x},${y},${z}`;

const grid = {
  get: (x, y, z) => occ.get(key(x, y, z)) || 0,
  set: (x, y, z, v) => {
    const id = key(x, y, z);
    if (!v) {
      occ.delete(id);
      flowDx.delete(id);
      flowDz.delete(id);
      shuffle.delete(id);
      budget.delete(id);
    } else {
      if (!occ.has(id)) {
        flowDx.delete(id);
        flowDz.delete(id);
      }
      occ.set(id, v);
    }
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
  getResting: () => true,
  getOnFloor: (_x, y) => y === 0,
  getSameAbove: (x, y, z) => {
    const mat = occ.get(key(x, y, z)) || 0;
    return mat > 0 && occ.get(key(x, y + 1, z)) === mat;
  },
  getExtent: (x, y, z) => extent.get(key(x, y, z)) ?? PITCH,
  getPitch: () => PITCH,
  cellCenter: (x, y, z) => ({ x, y, z }),
  getWorld: (x, y, z) => ({ x, y, z }),
  getFlowDx: (x, y, z) => flowDx.get(key(x, y, z)) || 0,
  setFlowDx: (x, y, z, v) => flowDx.set(key(x, y, z), v),
  getFlowDz: (x, y, z) => flowDz.get(key(x, y, z)) || 0,
  setFlowDz: (x, y, z, v) => flowDz.set(key(x, y, z), v),
  getShuffle: (x, y, z) => shuffle.get(key(x, y, z)) || 0,
  setShuffle: (x, y, z, v) => shuffle.set(key(x, y, z), v),
  getBudget: (x, y, z) => budget.get(key(x, y, z)) || 0,
  setBudget: (x, y, z, v) => budget.set(key(x, y, z), v),
  getEffectClock: (x, y, z, channel) => clocks.get(`${key(x, y, z)}:${channel}`) || 0,
  setEffectClock: (x, y, z, channel, v) => clocks.set(`${key(x, y, z)}:${channel}`, v),
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
  shuffle.clear();
  clocks.clear();
  budget.clear();
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

function cellsOf(mat) {
  const found = [];
  for (const [id, value] of occ) {
    if (value !== mat) continue;
    const [x, y, z] = id.split(",").map(Number);
    found.push({ x, y, z, mat });
  }
  return found;
}

reset();
place(4, 0, 4, exp);
stepWorld(grid, [{ x: 4, y: 0, z: 4, mat: exp }], catalog);
const lone = where(exp)[0];

reset();
place(5, 0, 4, exp);
flowDx.set(key(5, 0, 4), 1);
stepWorld(grid, [{ x: 5, y: 0, z: 4, mat: exp }], catalog);
const coasting = where(exp)[0];

reset();
place(4, 0, 4, exp);
place(4, 1, 4, exp);
place(4, 2, 4, exp);
stepWorld(grid, cellsOf(exp), catalog);
const fall1 = where(exp).slice().sort();
const fall1Life = budget.get(key(5, 0, 4));
stepWorld(grid, cellsOf(exp), catalog);
const fall2 = where(exp).slice().sort();

reset();
place(4, 0, 4, exp);
place(4, 1, 4, block);
place(4, 2, 4, block);
stepWorld(grid, cellsOf(exp).concat(cellsOf(block)), catalog);
const weighted = where(exp).slice().sort();
const weightedAbove = where(block).slice().sort();
const weightedLife = budget.get(key(5, 0, 4));

reset();
place(4, 0, 4, exp);
place(4, 1, 4, block);
stepWorld(grid, cellsOf(exp).concat(cellsOf(block)), catalog);
const oneAbove = where(exp).slice().sort();
const oneDropped = where(block)[0];

reset();
place(4, 0, 4, block);
place(4, 1, 4, exp);
stepWorld(grid, cellsOf(exp).concat(cellsOf(block)), catalog);
const heldAbove = where(exp)[0];

reset();
place(4, 0, 4, block);
stepWorld(grid, [{ x: 4, y: 0, z: 4, mat: block }], catalog);
const plainBlock = where(block)[0];

reset();
for (let y = 0; y < 5; y += 1) place(4, y, 4, exp);
for (let n = 0; n < 12; n += 1) stepWorld(grid, cellsOf(exp), catalog);
const afterStack = where(exp).slice().sort();

reset();
place(2, 0, 2, exp);
shuffle.set(key(2, 0, 2), 1);
budget.set(key(2, 0, 2), 2);
const lifeQueries = { resting: () => true, onFloor: () => true, sameAbove: () => false };
tickEffects(grid, [{ x: 2, y: 0, z: 2, mat: exp, i: 0 }], catalog, lifeQueries, 1.74);
const beforeShortLife = grid.get(2, 0, 2);
const slidScale = grid.getShrink(2, 0, 2);
tickEffects(grid, [{ x: 2, y: 0, z: 2, mat: exp, i: 0 }], catalog, lifeQueries, 0.02);
const afterShortLife = grid.get(2, 0, 2);

const report = {
  lone,
  coasting,
  fall1,
  fall1Life,
  fall2,
  weighted,
  weightedAbove,
  weightedLife,
  oneAbove,
  oneDropped,
  heldAbove,
  plainBlock,
  afterStack,
  beforeShortLife,
  slidScale,
  afterShortLife,
};
console.log(JSON.stringify(report, null, 2));

const ok =
  lone === "4,0,4" &&
  coasting === "5,0,4" &&
  fall1.join("|") === "4,0,4|4,1,4|5,0,4" &&
  fall1Life === 2 &&
  fall2.join("|") === "4,0,4" &&
  weighted.join("|") === "5,0,4" &&
  weightedAbove.join("|") === "4,0,4|4,1,4" &&
  weightedLife === 2 &&
  oneAbove.length === 0 &&
  oneDropped === "4,0,4" &&
  heldAbove === "4,1,4" &&
  plainBlock === "4,0,4" &&
  afterStack.join("|") === "4,0,4" &&
  beforeShortLife === exp &&
  slidScale === false &&
  afterShortLife === 0;
if (!ok) process.exit(1);
