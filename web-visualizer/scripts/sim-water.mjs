/**
 * Headless water parameter sweep against the SandPond-style rule engine.
 * Usage: node scripts/sim-water.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const materialsPath = join(root, "public", "materials.json");
const ruleEngineUrl = pathToFileURL(join(root, "public", "rule-engine.js")).href;

const { compileMaterials, stepWorld } = await import(ruleEngineUrl);

const RULE_HZ = 22;
const DT = 1 / RULE_HZ;
const SIZE = 24;
const MAX_Y = 8;
const FACE = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function idx(x, y, z) {
  return (y * SIZE + z) * SIZE + x;
}

function makeWorld(catalog) {
  const n = SIZE * SIZE * MAX_Y;
  const cells = new Uint8Array(n);
  const sparseAges = new Float32Array(n);
  const flowDx = new Int8Array(n);
  const flowDz = new Int8Array(n);
  const occupied = new Set();

  const inBounds = (x, y, z) =>
    x >= 0 && z >= 0 && y >= 0 && x < SIZE && z < SIZE && y < MAX_Y;

  const get = (x, y, z) => (inBounds(x, y, z) ? cells[idx(x, y, z)] : 0);
  const set = (x, y, z, v) => {
    if (!inBounds(x, y, z)) return;
    const i = idx(x, y, z);
    const prev = cells[i];
    cells[i] = v;
    if (!v) {
      sparseAges[i] = 0;
      flowDx[i] = 0;
      flowDz[i] = 0;
      occupied.delete(i);
    } else {
      occupied.add(i);
      if (prev === 0) {
        sparseAges[i] = 0;
        flowDx[i] = 0;
        flowDz[i] = 0;
      }
    }
  };

  const grid = {
    get,
    set,
    inBounds,
    getSparseAge: (x, y, z) => (inBounds(x, y, z) ? sparseAges[idx(x, y, z)] : 0),
    setSparseAge: (x, y, z, v) => {
      if (inBounds(x, y, z)) sparseAges[idx(x, y, z)] = Math.max(0, Number(v) || 0);
    },
    getFlowDx: (x, y, z) => (inBounds(x, y, z) ? flowDx[idx(x, y, z)] : 0),
    setFlowDx: (x, y, z, v) => {
      if (inBounds(x, y, z)) flowDx[idx(x, y, z)] = v | 0;
    },
    getFlowDz: (x, y, z) => (inBounds(x, y, z) ? flowDz[idx(x, y, z)] : 0),
    setFlowDz: (x, y, z, v) => {
      if (inBounds(x, y, z)) flowDz[idx(x, y, z)] = v | 0;
    },
  };

  function collect() {
    /** @type {{ x: number, y: number, z: number, mat: number }[]} */
    const list = [];
    for (const i of occupied) {
      const mat = cells[i];
      if (mat <= 0) continue;
      const x = i % SIZE;
      const rest = (i / SIZE) | 0;
      const z = rest % SIZE;
      const y = (rest / SIZE) | 0;
      list.push({ x, y, z, mat });
    }
    return list;
  }

  function countSame(x, y, z, mat) {
    let n = 0;
    for (const [dx, dy, dz] of FACE) {
      if (get(x + dx, y + dy, z + dz) === mat) n += 1;
    }
    return n;
  }

  function absorbSparse() {
    const water = catalog.indexById.get("water") || 0;
    const def = catalog.byId.get("water");
    if (!def || !water) return 0;
    const minN = def.minNeighbors || 0;
    const limit = def.sparseAbsorb || 0;
    if (minN <= 0 || limit <= 0) return 0;
    let removed = 0;
    const doomed = [];
    for (const i of occupied) {
      if (cells[i] !== water) continue;
      const x = i % SIZE;
      const rest = (i / SIZE) | 0;
      const z = rest % SIZE;
      const y = (rest / SIZE) | 0;
      if (countSame(x, y, z, water) < minN) {
        const onOpenFloor = catalog.floor === "liquid" && y === 0;
        // Match falling-blocks: open floor soaks loners even if they can still move.
        if (!onOpenFloor) {
          let open = false;
          for (const [dx, dy, dz] of FACE) {
            const nx = x + dx;
            const ny = y + dy;
            const nz = z + dz;
            if (!inBounds(nx, ny, nz)) continue;
            if (get(nx, ny, nz) === 0) {
              open = true;
              break;
            }
          }
          if (open) {
            sparseAges[i] = 0;
            continue;
          }
        }
        sparseAges[i] += DT;
        if (sparseAges[i] >= limit) doomed.push(i);
      } else sparseAges[i] = 0;
    }
    for (const i of doomed) {
      const x = i % SIZE;
      const rest = (i / SIZE) | 0;
      const z = rest % SIZE;
      const y = (rest / SIZE) | 0;
      set(x, y, z, 0);
      removed += 1;
    }
    return removed;
  }

  function stats(waterIndex) {
    let count = 0;
    let alone = 0;
    let latMovesPossible = 0;
    let sumX = 0;
    let sumZ = 0;
    let minX = SIZE;
    let maxX = 0;
    let minZ = SIZE;
    let maxZ = 0;
    for (const i of occupied) {
      if (cells[i] !== waterIndex) continue;
      count += 1;
      const x = i % SIZE;
      const rest = (i / SIZE) | 0;
      const z = rest % SIZE;
      const y = (rest / SIZE) | 0;
      sumX += x;
      sumZ += z;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      if (countSame(x, y, z, waterIndex) === 0) alone += 1;
      for (const [dx, , dz] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 0, 1],
        [0, 0, -1],
      ]) {
        if (get(x + dx, y, z + dz) === 0 && inBounds(x + dx, y, z + dz)) {
          latMovesPossible += 1;
          break;
        }
      }
    }
    return {
      count,
      alone,
      latOpen: latMovesPossible,
      spread: count ? maxX - minX + (maxZ - minZ) : 0,
      cx: count ? sumX / count : 0,
      cz: count ? sumZ / count : 0,
    };
  }

  return { grid, set, get, collect, absorbSparse, stats, occupied, cells };
}

function buildBasin(world, sand, water) {
  // Open-top box of sand walls on y=0 floor sand, interior empty for water.
  const x0 = 6;
  const x1 = 17;
  const z0 = 6;
  const z1 = 17;
  for (let x = x0; x <= x1; x += 1) {
    for (let z = z0; z <= z1; z += 1) {
      world.set(x, 0, z, sand);
      if (x === x0 || x === x1 || z === z0 || z === z1) {
        world.set(x, 1, z, sand);
        world.set(x, 2, z, sand);
      }
    }
  }
  // Pour a column of water into the center.
  for (let y = 3; y <= 6; y += 1) {
    for (let x = 10; x <= 13; x += 1) {
      for (let z = 10; z <= 13; z += 1) {
        world.set(x, y, z, water);
      }
    }
  }
  return { x0, x1, z0, z1 };
}

function buildOpenSpill(world, sand, water) {
  // Small sand mound that spills onto open floor.
  for (let x = 8; x <= 14; x += 1) {
    for (let z = 8; z <= 14; z += 1) {
      world.set(x, 0, z, sand);
    }
  }
  for (let y = 1; y <= 4; y += 1) {
    for (let x = 10; x <= 12; x += 1) {
      for (let z = 10; z <= 12; z += 1) {
        world.set(x, y, z, water);
      }
    }
  }
}

function buildIsolated(world, water) {
  const spots = [
    [3, 0, 3],
    [5, 0, 8],
    [12, 0, 4],
    [18, 0, 18],
    [20, 0, 6],
    [7, 0, 20],
    [15, 1, 15],
    [2, 0, 15],
  ];
  for (const [x, y, z] of spots) world.set(x, y, z, water);
  return spots.length;
}

function runScenario(catalog, setup, ticks) {
  const world = makeWorld(catalog);
  const water = catalog.indexById.get("water");
  const sand = catalog.indexById.get("sand");
  const meta = setup(world, sand, water);

  let lateralMoves = 0;
  let fallMoves = 0;
  let absorbed = 0;
  let peakAlone = 0;
  let settleWindowMoves = 0;
  const settleStart = Math.floor(ticks * 0.6);

  for (let t = 0; t < ticks; t += 1) {
    const before = world.stats(water);
    peakAlone = Math.max(peakAlone, before.alone);
    const { moves } = stepWorld(world.grid, world.collect(), catalog);
    for (const m of moves) {
      if (m.to.y < m.from.y) fallMoves += 1;
      else if (m.to.y === m.from.y) {
        lateralMoves += 1;
        if (t >= settleStart) settleWindowMoves += 1;
      }
    }
    // Transfer sparse age is handled by grid API during moves; age alone grains.
    absorbed += world.absorbSparse();
  }

  const end = world.stats(water);
  const settleTicks = Math.max(1, ticks - settleStart);
  return {
    meta,
    end,
    lateralMoves,
    fallMoves,
    absorbed,
    peakAlone,
    jitterRate: settleWindowMoves / settleTicks,
    waterLeft: end.count,
    aloneLeft: end.alone,
    spread: end.spread,
  };
}

function withWaterParams(base, patch) {
  const raw = structuredClone(base);
  const water = raw.materials.find((m) => m.id === "water");
  Object.assign(water, patch.material || {});
  if (patch.flow) {
    const flow = water.rules.find((r) => r.name === "flow");
    Object.assign(flow, patch.flow);
  }
  if (patch.slide) {
    const slide = water.rules.find((r) => r.name === "slide");
    Object.assign(slide, patch.slide);
  }
  return raw;
}

function score(results) {
  // Higher is better. Prioritize keeping a basin pool, clearing loners,
  // then spread on open ground, then low late-game jitter.
  const basin = results.basin;
  const spill = results.spill;
  const alone = results.alone;

  const basinRetain = basin.waterLeft / Math.max(1, basin.meta.poured);
  const basinScore =
    basinRetain * 55 +
    Math.max(0, 15 - basin.aloneLeft * 3) +
    Math.max(0, 12 - basin.jitterRate);

  const spillScore =
    Math.min(20, spill.spread * 1.2) +
    Math.min(12, spill.waterLeft) * 0.35 -
    spill.aloneLeft * 2;

  const aloneClear = alone.meta.spawned - alone.waterLeft;
  const aloneScore = (aloneClear / alone.meta.spawned) * 25;

  return {
    total: basinScore + spillScore + aloneScore,
    basinScore,
    spillScore,
    aloneScore,
    basinRetain,
    jitterRate: basin.jitterRate,
  };
}

const baseMaterials = JSON.parse(readFileSync(materialsPath, "utf8"));

function buildFlatPuddle(world, _sand, water) {
  // Irregular flat sheet on the liquid floor — the jitter case.
  const cells = [
    [8, 0, 8],
    [9, 0, 8],
    [10, 0, 8],
    [11, 0, 8],
    [8, 0, 9],
    [9, 0, 9],
    [10, 0, 9],
    [12, 0, 9],
    [9, 0, 10],
    [10, 0, 10],
    [11, 0, 10],
    [10, 0, 11],
    [11, 0, 11],
    [7, 0, 10],
    [13, 0, 8],
  ];
  for (const [x, y, z] of cells) world.set(x, y, z, water);
  return { poured: cells.length };
}

function buildSnake(world, _sand, water) {
  // Thin line should contract toward a compact resting clump.
  let n = 0;
  for (let x = 6; x <= 17; x += 1) {
    world.set(x, 0, 12, water);
    n += 1;
  }
  return { poured: n };
}

function avgNeighbors(world, waterIndex) {
  let sum = 0;
  let count = 0;
  for (const i of world.occupied) {
    if (world.cells[i] !== waterIndex) continue;
    const x = i % SIZE;
    const rest = (i / SIZE) | 0;
    const z = rest % SIZE;
    const y = (rest / SIZE) | 0;
    let n = 0;
    for (const [dx, dy, dz] of FACE) {
      if (world.get(x + dx, y + dy, z + dz) === waterIndex) n += 1;
    }
    sum += n;
    count += 1;
  }
  return count ? sum / count : 0;
}

function runSettleTrace(catalog, setup, ticks) {
  const world = makeWorld(catalog);
  const water = catalog.indexById.get("water");
  const sand = catalog.indexById.get("sand");
  const meta = setup(world, sand, water);
  const samples = [];
  let lateMoves = 0;
  const lateStart = Math.floor(ticks * 0.7);

  for (let t = 0; t < ticks; t += 1) {
    const { moves } = stepWorld(world.grid, world.collect(), catalog);
    let lateral = 0;
    for (const m of moves) {
      if (m.to.y === m.from.y) lateral += 1;
    }
    if (t >= lateStart) lateMoves += lateral;
    world.absorbSparse();
    if (t % 10 === 0 || t === ticks - 1) {
      const s = world.stats(water);
      samples.push({
        t,
        water: s.count,
        alone: s.alone,
        spread: s.spread,
        moves: lateral,
        avgN: Number(avgNeighbors(world, water).toFixed(2)),
      });
    }
  }

  return {
    meta,
    samples,
    lateAvg: lateMoves / Math.max(1, ticks - lateStart),
    end: world.stats(water),
  };
}

const catalog = compileMaterials(baseMaterials);

console.log("=== Flat puddle (should contract then stop) ===");
{
  const r = runSettleTrace(catalog, buildFlatPuddle, 80);
  for (const s of r.samples) {
    console.log(
      `  t=${String(s.t).padStart(2)} water=${s.water} alone=${s.alone} spread=${s.spread} avgN=${s.avgN} moves=${s.moves}`,
    );
  }
  console.log(`  lateAvgMoves=${r.lateAvg.toFixed(2)}/tick\n`);
}

console.log("=== Snake (should contract area) ===");
{
  const r = runSettleTrace(catalog, buildSnake, 100);
  for (const s of r.samples) {
    console.log(
      `  t=${String(s.t).padStart(2)} water=${s.water} alone=${s.alone} spread=${s.spread} avgN=${s.avgN} moves=${s.moves}`,
    );
  }
  console.log(`  lateAvgMoves=${r.lateAvg.toFixed(2)}/tick\n`);
}

console.log("=== Basin (flatten + settle) ===");
{
  const r = runSettleTrace(
    catalog,
    (world, sand, water) => {
      buildBasin(world, sand, water);
      return { poured: 64 };
    },
    100,
  );
  for (const s of r.samples) {
    console.log(
      `  t=${String(s.t).padStart(2)} water=${s.water} alone=${s.alone} spread=${s.spread} avgN=${s.avgN} moves=${s.moves}`,
    );
  }
  console.log(`  lateAvgMoves=${r.lateAvg.toFixed(2)}/tick\n`);
}

console.log("=== Isolated scatter (soak) ===");
{
  const r = runSettleTrace(
    catalog,
    (world, _sand, water) => {
      const spawned = buildIsolated(world, water);
      return { spawned };
    },
    60,
  );
  for (const s of r.samples) {
    console.log(
      `  t=${String(s.t).padStart(2)} water=${s.water} alone=${s.alone} spread=${s.spread} moves=${s.moves}`,
    );
  }
  console.log(`  lateAvgMoves=${r.lateAvg.toFixed(2)}/tick  left=${r.end.count}\n`);
}
