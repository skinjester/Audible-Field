import { readFileSync } from "node:fs";
import { applyConvert, compileMaterials, parseMaterialsJson, stepWorld } from "../public/rule-engine.js";

const raw = parseMaterialsJson(readFileSync(new URL("../public/materials.json", import.meta.url), "utf8"));
const catalog = compileMaterials(raw);
const diffuse = catalog.indexById.get("diffuse");
const sand = catalog.indexById.get("sand");
const block = catalog.indexById.get("block");
if (!diffuse || !sand || !block) throw new Error("missing materials");
const spread = catalog.byId.get("diffuse").effects.find((effect) => effect.name === "spread");
if (spread?.limit !== "collection") throw new Error("spread limit did not compile");

function makeGrid(w, h, d) {
  const occ = new Map();
  const budget = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  return {
    occ,
    budget,
    get: (x, y, z) => occ.get(key(x, y, z)) || 0,
    set: (x, y, z, v) => {
      if (!v) {
        occ.delete(key(x, y, z));
        budget.set(key(x, y, z), 0);
      } else {
        const prev = occ.get(key(x, y, z)) || 0;
        occ.set(key(x, y, z), v);
        if (prev === 0 && v === diffuse) budget.set(key(x, y, z), 1);
      }
    },
    inBounds: (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < w && y < h && z < d,
    getBudget: (x, y, z) => budget.get(key(x, y, z)) || 0,
    setBudget: (x, y, z, v) => budget.set(key(x, y, z), v),
    cells() {
      const list = [];
      for (const [k, mat] of occ) {
        const [x, y, z] = k.split(",").map(Number);
        list.push({ x, y, z, mat });
      }
      return list;
    },
    count(mat) {
      let n = 0;
      for (const v of occ.values()) if (v === mat) n += 1;
      return n;
    },
  };
}

function pourDiffuse(grid, x, y, z) {
  grid.set(x, y, z, diffuse);
  grid.setBudget(x, y, z, 1);
}

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

// Stack of 5 against a taller sand wall: one tick turns 5, then stops.
{
  const grid = makeGrid(6, 12, 3);
  for (let y = 0; y < 5; y += 1) pourDiffuse(grid, 1, y, 1);
  for (let y = 0; y < 10; y += 1) grid.set(2, y, 1, sand);
  for (let y = 0; y < 10; y += 1) grid.set(3, y, 1, sand);
  applyConvert(grid, grid.cells(), catalog);
  const turned = grid.count(diffuse) - 5;
  if (turned !== 5) fail(`wall tick1 turned ${turned}, expected 5`);
  applyConvert(grid, grid.cells(), catalog);
  const later = grid.count(diffuse) - 5;
  if (later !== 5) fail(`wall tick2 turned ${later}, expected 5`);
}

// Stack of 5 touching one sand grain, with a sand row beyond it: exactly 5 total.
{
  const grid = makeGrid(24, 8, 3);
  for (let y = 0; y < 5; y += 1) pourDiffuse(grid, 0, y, 1);
  for (let x = 1; x <= 20; x += 1) grid.set(x, 0, 1, sand);
  for (let tick = 0; tick < 12; tick += 1) applyConvert(grid, grid.cells(), catalog);
  const turned = grid.count(diffuse) - 5;
  if (turned !== 5) fail(`row turned ${turned}, expected 5`);
}

// One diffuse grain beside many neighbors turns one.
{
  const grid = makeGrid(5, 5, 5);
  pourDiffuse(grid, 2, 2, 2);
  for (const [x, y, z] of [
    [3, 2, 2],
    [1, 2, 2],
    [2, 3, 2],
    [2, 1, 2],
    [2, 2, 3],
    [2, 2, 1],
  ]) {
    grid.set(x, y, z, block);
  }
  applyConvert(grid, grid.cells(), catalog);
  applyConvert(grid, grid.cells(), catalog);
  if (grid.count(diffuse) !== 2) fail(`lone turned into ${grid.count(diffuse)}, expected 2`);
}

// Separate stacks do not share a budget.
{
  const grid = makeGrid(8, 6, 8);
  pourDiffuse(grid, 0, 0, 0);
  pourDiffuse(grid, 0, 1, 0);
  pourDiffuse(grid, 6, 0, 6);
  pourDiffuse(grid, 6, 1, 6);
  for (let x = 1; x <= 4; x += 1) grid.set(x, 0, 0, sand);
  for (let x = 2; x <= 5; x += 1) grid.set(x, 0, 6, sand);
  for (let tick = 0; tick < 6; tick += 1) applyConvert(grid, grid.cells(), catalog);
  const left = [1, 2, 3, 4].filter((x) => grid.get(x, 0, 0) === diffuse).length;
  const right = [2, 3, 4, 5].filter((x) => grid.get(x, 0, 6) === diffuse).length;
  if (left !== 2 || right !== 2) fail(`separate stacks left ${left} right ${right}, expected 2 and 2`);
}

// A stack that just moved keeps its conversions. The next still tick spends them on the pile.
{
  const grid = makeGrid(6, 8, 6);
  for (let x = 0; x < 6; x += 1) {
    for (let z = 0; z < 6; z += 1) grid.set(x, 0, z, sand);
  }
  for (let y = 1; y <= 5; y += 1) pourDiffuse(grid, 2, y, 2);
  const moves = [];
  for (let y = 1; y <= 5; y += 1) moves.push({ to: { x: 2, y, z: 2 } });
  applyConvert(grid, grid.cells(), catalog, moves);
  if (grid.count(diffuse) !== 5) fail(`moving stack turned early, diffuse=${grid.count(diffuse)}`);
  for (let tick = 0; tick < 8; tick += 1) applyConvert(grid, grid.cells(), catalog);
  if (grid.count(diffuse) !== 10) fail(`settled stack diffuse=${grid.count(diffuse)}, expected 10`);
}

// Five diffuse fall and slide onto a sand floor, then convert that floor once they sit.
{
  const grid = makeGrid(10, 20, 10);
  for (let x = 0; x < 10; x += 1) {
    for (let z = 0; z < 10; z += 1) grid.set(x, 0, z, sand);
  }
  for (let y = 0; y < 5; y += 1) pourDiffuse(grid, 4, 12 + y, 4);
  let spentWhileMoving = false;
  for (let tick = 0; tick < 30; tick += 1) {
    const stepped = stepWorld(grid, grid.cells(), catalog);
    const moved = new Set(stepped.moves.map((move) => `${move.to.x},${move.to.y},${move.to.z}`));
    const charged = [];
    for (const cell of grid.cells()) {
      if (cell.mat !== diffuse) continue;
      if (grid.getBudget(cell.x, cell.y, cell.z) > 0) charged.push(`${cell.x},${cell.y},${cell.z}`);
    }
    const before = grid.count(diffuse);
    applyConvert(grid, grid.cells(), catalog, stepped.moves);
    const allMoved = charged.length > 0 && charged.every((key) => moved.has(key));
    if (allMoved && grid.count(diffuse) !== before) spentWhileMoving = true;
  }
  if (spentWhileMoving) fail("spent conversions while every charged grain was moving");
  const turned = grid.count(diffuse) - 5;
  if (turned !== 5) fail(`fallen stack turned ${turned}, expected 5`);
}

if (process.exitCode) {
  console.error("diffuse spread checks failed");
} else {
  console.log("diffuse spread checks ok");
}
