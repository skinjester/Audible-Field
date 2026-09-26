/**
 * Headless water parameter sweep against the SandPond-style rule engine.
 * Usage: node scripts/sim-water.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
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

const sweeps = [];
for (const pathBias of [0.1, 0.2, 0.3, 0.45]) {
  for (const chance of [0.35, 0.45, 0.55, 0.65]) {
    for (const sparseAbsorb of [0.6, 0.9, 1.2]) {
      sweeps.push({ pathBias, chance, sparseAbsorb, minNeighbors: 1 });
    }
  }
}

const ranked = [];
for (const p of sweeps) {
  const raw = withWaterParams(baseMaterials, {
    material: {
      pathBias: p.pathBias,
      minNeighbors: p.minNeighbors,
      sparseAbsorb: p.sparseAbsorb,
    },
    flow: { pick: "one", chance: p.chance },
    slide: { pick: "one" },
  });
  const catalog = compileMaterials(raw);

  /** @type {ReturnType<typeof score>[]} */
  const trials = [];
  let basinWater = 0;
  let spillSpread = 0;
  let aloneLeft = 0;
  for (let trial = 0; trial < 3; trial += 1) {
    const basin = runScenario(
      catalog,
      (world, sand, water) => {
        buildBasin(world, sand, water);
        return { poured: 4 * 4 * 4 };
      },
      90,
    );
    const spill = runScenario(
      catalog,
      (world, sand, water) => {
        buildOpenSpill(world, sand, water);
        return {};
      },
      80,
    );
    const alone = runScenario(
      catalog,
      (world, _sand, water) => {
        const spawned = buildIsolated(world, water);
        return { spawned };
      },
      50,
    );
    const results = { basin, spill, alone };
    trials.push(score(results));
    basinWater += basin.waterLeft;
    spillSpread += spill.spread;
    aloneLeft += alone.waterLeft;
  }

  const avg = {
    total: trials.reduce((s, t) => s + t.total, 0) / trials.length,
    basinRetain: trials.reduce((s, t) => s + t.basinRetain, 0) / trials.length,
    jitterRate: trials.reduce((s, t) => s + t.jitterRate, 0) / trials.length,
  };
  ranked.push({
    ...p,
    ...avg,
    basinWater: basinWater / trials.length,
    spillSpread: spillSpread / trials.length,
    aloneLeft: aloneLeft / trials.length,
  });
}

ranked.sort((a, b) => {
  // Prefer high basin retain when totals are close.
  if (Math.abs(b.total - a.total) < 4 && Math.abs(b.basinRetain - a.basinRetain) > 0.05) {
    return b.basinRetain - a.basinRetain;
  }
  return b.total - a.total;
});
const top = ranked.slice(0, 8);
const best = ranked[0];

console.log("Top water tunings (higher score = better):");
for (const row of top) {
  console.log(
    `  bias=${row.pathBias} chance=${row.chance} alone=${row.sparseAbsorb}s  ` +
      `score=${row.total.toFixed(1)}  basinKeep=${(row.basinRetain * 100).toFixed(0)}%  ` +
      `jitter=${row.jitterRate.toFixed(2)}/tick  spillSpread=${row.spillSpread}  aloneLeft=${row.aloneLeft}`,
  );
}

console.log("\nBest:", best);

// Apply best to materials.json
const next = withWaterParams(baseMaterials, {
  material: {
    pathBias: best.pathBias,
    minNeighbors: 1,
    sparseAbsorb: best.sparseAbsorb,
  },
  flow: { pick: "one", chance: best.chance },
  slide: { pick: "one" },
});
writeFileSync(materialsPath, `${JSON.stringify(next, null, 2)}\n`);
console.log(`\nWrote tuned water params to ${materialsPath}`);
