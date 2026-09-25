/**
 * Tiny SandPond-style rule runner.
 * Materials declare diagram rules; the world only supplies get/set occupancy.
 *
 * Symbols in match / result rows (top → bottom, left → right):
 *   @  this grain
 *   _  empty
 *   x  occupied (any material)
 *   .  anything (keep / ignore)
 *
 * A result with no @ clears this grain (consume-in-place), e.g. etch.
 *
 * Surfaces (material.surface):
 *   solid   — no splash when something rests on it
 *   liquid  — splash when a grain lands or shifts onto it
 * World floor uses catalog.floor ("liquid" | "solid").
 *
 * Optional rule fields:
 *   rotations: "xz"     — try all four horizontal facings (SandPond for(xz.rotations))
 *   belowBottom: "liquid" — only fire when support under the bottom row is liquid
 *   symbols: { w: "water" } — named material letters in match/result
 *
 * Material fields:
 *   shuffleLimit — after this many same-height hops with little net travel, delete the grain
 */

const ROTATIONS_XZ = [
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: 0, dz: -1 },
];

/**
 * @typedef {{ id: string, label: string, color: string, surface: "solid" | "liquid", pushPower: number, lifetime: number, erode: number, shuffleLimit: number, rules: object[] }} MaterialDef
 * @typedef {{
 *   get: (x: number, y: number, z: number) => number,
 *   set: (x: number, y: number, z: number, v: number) => void,
 *   inBounds: (x: number, y: number, z: number) => boolean,
 *   getBudget?: (x: number, y: number, z: number) => number,
 *   setBudget?: (x: number, y: number, z: number, v: number) => void,
 *   getAge?: (x: number, y: number, z: number) => number,
 *   setAge?: (x: number, y: number, z: number, v: number) => void,
 *   getErodeLife?: (x: number, y: number, z: number) => number,
 *   setErodeLife?: (x: number, y: number, z: number, v: number) => void,
 *   getPosY?: (x: number, y: number, z: number) => number,
 *   setPosY?: (x: number, y: number, z: number, v: number) => void,
 *   getPosX?: (x: number, y: number, z: number) => number,
 *   setPosX?: (x: number, y: number, z: number, v: number) => void,
 *   getPosZ?: (x: number, y: number, z: number) => number,
 *   setPosZ?: (x: number, y: number, z: number, v: number) => void,
 *   getEmitSize?: (x: number, y: number, z: number) => number,
 *   setEmitSize?: (x: number, y: number, z: number, v: number) => void,
 *   getShuffle?: (x: number, y: number, z: number) => number,
 *   setShuffle?: (x: number, y: number, z: number, v: number) => void,
 *   getShuffleOriginX?: (x: number, y: number, z: number) => number,
 *   setShuffleOriginX?: (x: number, y: number, z: number, v: number) => void,
 *   getShuffleOriginZ?: (x: number, y: number, z: number) => number,
 *   setShuffleOriginZ?: (x: number, y: number, z: number, v: number) => void,
 * }} GridApi
 * @typedef {{ defaultId: string, floor: "solid" | "liquid", list: MaterialDef[], byId: Map<string, MaterialDef>, indexById: Map<string, number>, idByIndex: string[] }} MaterialCatalog
 * @typedef {{ x: number, y: number, z: number }} CellPos
 */

/**
 * @param {unknown} raw
 * @returns {MaterialCatalog}
 */
export function compileMaterials(raw) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const list = Array.isArray(payload.materials) ? payload.materials : [];
  /** @type {MaterialDef[]} */
  const materials = [];
  const byId = new Map();
  const indexById = new Map();
  /** @type {string[]} */
  const idByIndex = [""];

  for (const item of list) {
    if (!item || typeof item.id !== "string" || !item.id) continue;
    const surface = item.surface === "liquid" ? "liquid" : "solid";
    const pushPower = Math.max(0, Math.floor(Number(item.pushPower) || 0));
    const lifetimeRaw = Number(item.lifetime);
    const lifetime =
      Number.isFinite(lifetimeRaw) && lifetimeRaw > 0 ? lifetimeRaw : 0;
    const erodeRaw = Number(item.erode);
    const erode =
      Number.isFinite(erodeRaw) && erodeRaw > 0 ? erodeRaw : 0;
    const shuffleRaw = Number(item.shuffleLimit);
    const shuffleLimit =
      Number.isFinite(shuffleRaw) && shuffleRaw > 0 ? Math.floor(shuffleRaw) : 0;
    const def = {
      id: item.id,
      label: String(item.label || item.id),
      color: String(item.color || "#cccccc"),
      surface,
      pushPower,
      lifetime,
      erode,
      shuffleLimit,
      rules: Array.isArray(item.rules) ? item.rules.map(normalizeRule).filter(Boolean) : [],
    };
    materials.push(def);
    byId.set(def.id, def);
    indexById.set(def.id, materials.length);
    idByIndex.push(def.id);
  }

  const defaultId =
    typeof payload.default === "string" && byId.has(payload.default)
      ? payload.default
      : materials[0]?.id || "";

  const floor = payload.floor === "solid" ? "solid" : "liquid";

  return { defaultId, floor, list: materials, byId, indexById, idByIndex };
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== "object") return null;

  if (rule.type === "push") {
    const target = String(rule.target || "").trim();
    if (!target) return null;
    return {
      name: String(rule.name || "push"),
      type: "push",
      target,
      match: null,
      result: null,
      height: 0,
      width: 0,
      rotations: null,
      symbols: null,
      belowBottom: null,
    };
  }

  const match = parseRows(rule.match);
  const result = parseRows(rule.result);
  if (!match || !result) return null;
  if (match.length !== result.length) return null;
  const width = match[0].length;
  for (const row of match) if (row.length !== width) return null;
  for (const row of result) if (row.length !== width) return null;

  return {
    name: String(rule.name || "rule"),
    type: "diagram",
    match,
    result,
    height: match.length,
    width,
    rotations: rule.rotations === "xz" ? "xz" : null,
    symbols:
      rule.symbols && typeof rule.symbols === "object" && !Array.isArray(rule.symbols)
        ? { ...rule.symbols }
        : null,
    belowBottom: rule.belowBottom === "liquid" ? "liquid" : null,
  };
}

function parseRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  /** @type {string[][]} */
  const out = [];
  for (const row of rows) {
    if (typeof row !== "string" || !row.length) return null;
    out.push([...row]);
  }
  return out;
}

/**
 * True when resting at (x,y,z) is on a liquid surface (water cell below, or liquid floor).
 * @param {GridApi} grid
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {MaterialCatalog} catalog
 */
export function isLiquidSupport(grid, x, y, z, catalog) {
  if (!catalog) return false;
  if (y <= 0) return catalog.floor === "liquid";
  if (!grid.inBounds(x, y - 1, z)) return catalog.floor === "liquid";
  const below = grid.get(x, y - 1, z);
  if (below <= 0) return false;
  const id = catalog.idByIndex[below];
  const mat = id ? catalog.byId.get(id) : null;
  return mat?.surface === "liquid";
}

/**
 * Splash when a grain moves onto / into liquid, or settles on a liquid support.
 * Not when resting on solid (block, sand, …).
 * @param {GridApi} grid
 * @param {CellPos} from
 * @param {CellPos} to
 * @param {number} matIndex
 * @param {MaterialCatalog} catalog
 */
export function shouldSplashMove(grid, from, to, matIndex, catalog) {
  if (!catalog || !to) return false;
  const moverId = catalog.idByIndex[matIndex];
  const mover = moverId ? catalog.byId.get(moverId) : null;
  // Liquids don't splash when they themselves settle.
  if (mover?.surface === "liquid") return false;

  const destMat = grid.get(to.x, to.y, to.z);
  // Moved into a liquid cell (displaced / mixed occupancy edge case).
  if (destMat === matIndex) {
    // Check what we replaced isn't knowable after the fact; use support + neighbor liquids.
    if (isLiquidSupport(grid, to.x, to.y, to.z, catalog)) return true;
  }

  // Landed or shifted to rest on liquid (including world floor).
  if (isLiquidSupport(grid, to.x, to.y, to.z, catalog)) {
    // Only splash when this move actually arrived / resettled, not mid-air.
    const stillFalling = to.y > 0 && grid.inBounds(to.x, to.y - 1, to.z) && grid.get(to.x, to.y - 1, to.z) === 0;
    if (stillFalling) return false;
    return true;
  }

  return false;
}

/**
 * @param {GridApi} grid
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} matIndex
 * @param {MaterialDef} material
 * @param {MaterialCatalog} [catalog]
 * @returns {{ moved: boolean, from: CellPos, to: CellPos | null, splash: boolean }}
 */
export function tryMaterialRules(grid, x, y, z, matIndex, material, catalog = null) {
  const from = { x, y, z };
  if (!material?.rules?.length) return { moved: false, from, to: null, splash: false };

  for (const rule of material.rules) {
    if (rule.type === "push") {
      const to = applyPushRule(grid, x, y, z, matIndex, rule, catalog);
      if (to) {
        const splash = shouldSplashMove(grid, from, to, matIndex, catalog);
        return { moved: true, from, to, splash };
      }
      continue;
    }

    if (rule.rotations === "xz") {
      for (const rot of shuffled(ROTATIONS_XZ)) {
        const to = applyOrientedRule(grid, x, y, z, matIndex, rule, rot.dx, rot.dz, catalog);
        if (to) {
          const splash = shouldSplashMove(grid, from, to, matIndex, catalog);
          return { moved: true, from, to, splash };
        }
      }
      continue;
    }
    const to = applyOrientedRule(grid, x, y, z, matIndex, rule, 1, 0, catalog);
    if (to) {
      const splash = shouldSplashMove(grid, from, to, matIndex, catalog);
      return { moved: true, from, to, splash };
    }
  }
  return { moved: false, from, to: null, splash: false };
}

/**
 * Push a contiguous column of `rule.target` down by one.
 * Into empty: shift the column. Into liquid floor: shift and destroy the bottom grain.
 * Consumes 1 push budget from this block or any block stacked contiguously above it
 * (so N stacked blocks with pushPower 1 can dig N deep).
 */
function applyPushRule(grid, x, y, z, matIndex, rule, catalog) {
  if (!catalog) return null;
  const targetIndex = catalog.indexById.get(rule.target) || 0;
  if (targetIndex <= 0) return null;

  const topSandY = y - 1;
  if (!grid.inBounds(x, topSandY, z)) return null;
  if (grid.get(x, topSandY, z) !== targetIndex) return null;

  let bottomY = topSandY;
  while (bottomY > 0 && grid.get(x, bottomY - 1, z) === targetIndex) {
    bottomY -= 1;
  }

  const underY = bottomY - 1;
  const underEmpty =
    underY >= 0 && grid.inBounds(x, underY, z) && grid.get(x, underY, z) === 0;
  const underLiquid = isLiquidSupport(grid, x, bottomY, z, catalog);

  if (!underEmpty && !underLiquid) return null;
  if (!consumeColumnBudget(grid, x, y, z, matIndex)) return null;

  const remain = grid.getBudget?.(x, y, z) ?? 0;
  const age = grid.getAge?.(x, y, z) ?? 0;
  const erodeLife = grid.getErodeLife?.(x, y, z) ?? 0;
  const posY = grid.getPosY?.(x, y, z) ?? 0;
  const posX = grid.getPosX?.(x, y, z) ?? 0;
  const posZ = grid.getPosZ?.(x, y, z) ?? 0;
  const emitSize = grid.getEmitSize?.(x, y, z) ?? 0;
  const shuffle = grid.getShuffle?.(x, y, z) ?? 0;
  const shuffleOx = grid.getShuffleOriginX?.(x, y, z) ?? 0;
  const shuffleOz = grid.getShuffleOriginZ?.(x, y, z) ?? 0;
  grid.set(x, y, z, 0);
  clearCellMeta(grid, x, y, z);
  grid.set(x, topSandY, z, matIndex);
  grid.setBudget?.(x, topSandY, z, remain);
  grid.setAge?.(x, topSandY, z, age);
  grid.setErodeLife?.(x, topSandY, z, erodeLife);
  grid.setPosY?.(x, topSandY, z, posY);
  grid.setPosX?.(x, topSandY, z, posX);
  grid.setPosZ?.(x, topSandY, z, posZ);
  if (emitSize > 0) grid.setEmitSize?.(x, topSandY, z, emitSize);
  grid.setShuffle?.(x, topSandY, z, shuffle);
  grid.setShuffleOriginX?.(x, topSandY, z, shuffleOx);
  grid.setShuffleOriginZ?.(x, topSandY, z, shuffleOz);

  if (underEmpty) {
    for (let sy = underY; sy < topSandY; sy += 1) {
      grid.set(x, sy, z, targetIndex);
    }
  } else {
    for (let sy = bottomY; sy < topSandY; sy += 1) {
      grid.set(x, sy, z, targetIndex);
    }
  }

  return { x, y: topSandY, z };
}

/**
 * Spend 1 budget from this cell or a contiguous same-material stack above it.
 * @returns {boolean}
 */
function consumeColumnBudget(grid, x, y, z, matIndex) {
  let cy = y;
  while (grid.inBounds(x, cy, z) && grid.get(x, cy, z) === matIndex) {
    const b = grid.getBudget?.(x, cy, z) ?? 0;
    if (b >= 1) {
      grid.setBudget?.(x, cy, z, b - 1);
      return true;
    }
    cy += 1;
  }
  return false;
}

/**
 * One simulation tick: shuffle occupied cells, apply first matching rule each.
 * @param {GridApi} grid
 * @param {{ x: number, y: number, z: number, mat: number }[]} cells
 * @param {MaterialCatalog} catalog
 * @returns {{ moved: number, splashes: CellPos[], moves: { from: CellPos, to: CellPos, mat: number }[] }}
 */
export function stepWorld(grid, cells, catalog) {
  let moved = 0;
  /** @type {CellPos[]} */
  const splashes = [];
  /** @type {{ from: CellPos, to: CellPos, mat: number }[]} */
  const moves = [];
  const order = cells.slice().sort((a, b) => b.y - a.y || Math.random() - 0.5);
  const seen = new Set();

  for (const cell of order) {
    const key = `${cell.x},${cell.y},${cell.z}`;
    if (seen.has(key)) continue;
    const mat = grid.get(cell.x, cell.y, cell.z);
    // Snapshot can go stale when a higher cell pushes into this one.
    if (mat <= 0 || mat !== cell.mat) continue;
    const id = catalog.idByIndex[mat];
    const material = id ? catalog.byId.get(id) : null;
    if (!material) continue;

    const result = tryMaterialRules(grid, cell.x, cell.y, cell.z, mat, material, catalog);
    if (!result.moved || !result.to) continue;
    moved += 1;
    seen.add(key);
    seen.add(`${result.to.x},${result.to.y},${result.to.z}`);
    moves.push({ from: result.from, to: result.to, mat });
    if (result.splash) {
      splashes.push({ x: result.to.x, y: result.to.y, z: result.to.z });
    }
  }

  return { moved, splashes, moves };
}

/**
 * @template T
 * @param {T[]} list
 * @returns {T[]}
 */
function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Map local (lx, ly) with lx along "right" (dx,dz) and ly down in world -Y.
 */
function worldOffset(lx, ly, dx, dz) {
  return {
    x: lx * dx,
    y: -ly,
    z: lx * dz,
  };
}

/**
 * @returns {CellPos | null} new @ position when the rule applied
 */
function applyOrientedRule(grid, x, y, z, matIndex, rule, dx, dz, catalog) {
  /** @type {{ x: number, y: number, z: number, want: string }[]} */
  const sites = [];
  let atX = 0;
  let atY = 0;
  let atZ = 0;
  let foundAt = false;

  for (let ly = 0; ly < rule.height; ly += 1) {
    for (let lx = 0; lx < rule.width; lx += 1) {
      const sym = rule.match[ly][lx];
      const off = worldOffset(lx, ly, dx, dz);
      const wx = x + off.x;
      const wy = y + off.y;
      const wz = z + off.z;
      if (sym === "@") {
        if (foundAt) return null;
        if (off.x !== 0 || off.y !== 0 || off.z !== 0) return null;
        foundAt = true;
        atX = wx;
        atY = wy;
        atZ = wz;
      }
      sites.push({ x: wx, y: wy, z: wz, want: sym });
    }
  }
  if (!foundAt) return null;

  for (const site of sites) {
    if (!grid.inBounds(site.x, site.y, site.z)) return null;
    const value = grid.get(site.x, site.y, site.z);
    if (
      !matchSymbol(
        site.want,
        value,
        matIndex,
        site.x === atX && site.y === atY && site.z === atZ,
        rule,
        catalog,
      )
    ) {
      return null;
    }
  }

  if (rule.belowBottom === "liquid") {
    if (!catalog) return null;
    for (let lx = 0; lx < rule.width; lx += 1) {
      const off = worldOffset(lx, rule.height - 1, dx, dz);
      const bx = x + off.x;
      const by = y + off.y;
      const bz = z + off.z;
      if (!isLiquidSupport(grid, bx, by, bz, catalog)) return null;
    }
  }

  /** @type {number[]} */
  const before = [];
  for (const site of sites) before.push(grid.get(site.x, site.y, site.z));
  const budget = grid.getBudget?.(x, y, z) ?? 0;
  const age = grid.getAge?.(x, y, z) ?? 0;
  const erodeLife = grid.getErodeLife?.(x, y, z) ?? 0;
  const posY = grid.getPosY?.(x, y, z) ?? 0;
  const posX = grid.getPosX?.(x, y, z) ?? 0;
  const posZ = grid.getPosZ?.(x, y, z) ?? 0;
  const emitSize = grid.getEmitSize?.(x, y, z) ?? 0;
  const shuffle = grid.getShuffle?.(x, y, z) ?? 0;
  const shuffleOx = grid.getShuffleOriginX?.(x, y, z) ?? 0;
  const shuffleOz = grid.getShuffleOriginZ?.(x, y, z) ?? 0;

  /** @type {CellPos | null} */
  let to = null;
  for (let ly = 0; ly < rule.height; ly += 1) {
    for (let lx = 0; lx < rule.width; lx += 1) {
      const outSym = rule.result[ly][lx];
      const off = worldOffset(lx, ly, dx, dz);
      const wx = x + off.x;
      const wy = y + off.y;
      const wz = z + off.z;
      const idx = ly * rule.width + lx;
      const next = resultValue(outSym, before[idx], matIndex, rule, catalog);
      if (next == null) continue;
      grid.set(wx, wy, wz, next);
      if (next === 0) clearCellMeta(grid, wx, wy, wz);
      if (outSym === "@") to = { x: wx, y: wy, z: wz };
    }
  }
  if (to) {
    clearCellMeta(grid, x, y, z);
    grid.setBudget?.(to.x, to.y, to.z, budget);
    grid.setAge?.(to.x, to.y, to.z, age);
    grid.setErodeLife?.(to.x, to.y, to.z, erodeLife);
    grid.setPosY?.(to.x, to.y, to.z, posY);
    grid.setPosX?.(to.x, to.y, to.z, posX);
    grid.setPosZ?.(to.x, to.y, to.z, posZ);
    if (emitSize > 0) grid.setEmitSize?.(to.x, to.y, to.z, emitSize);
    grid.setShuffle?.(to.x, to.y, to.z, shuffle);
    grid.setShuffleOriginX?.(to.x, to.y, to.z, shuffleOx);
    grid.setShuffleOriginZ?.(to.x, to.y, to.z, shuffleOz);
    return to;
  }
  // Applied with no @ in result (e.g. etch consumes self + neighbor).
  return { x, y, z };
}

function clearCellMeta(grid, x, y, z) {
  grid.setBudget?.(x, y, z, 0);
  grid.setAge?.(x, y, z, 0);
  grid.setErodeLife?.(x, y, z, 0);
  grid.setPosY?.(x, y, z, 0);
  grid.setPosX?.(x, y, z, 0);
  grid.setPosZ?.(x, y, z, 0);
  grid.setEmitSize?.(x, y, z, 0);
  grid.setShuffle?.(x, y, z, 0);
  grid.setShuffleOriginX?.(x, y, z, 0);
  grid.setShuffleOriginZ?.(x, y, z, 0);
}

function namedMaterialIndex(sym, rule, catalog) {
  const id = rule?.symbols?.[sym];
  if (!id || !catalog) return 0;
  return catalog.indexById.get(id) || 0;
}

function matchSymbol(sym, value, matIndex, isOrigin, rule, catalog) {
  if (sym === ".") return true;
  if (sym === "@") return isOrigin && value === matIndex;
  if (sym === "_") return value === 0;
  if (sym === "x") return value > 0;
  const named = namedMaterialIndex(sym, rule, catalog);
  if (named > 0) return value === named;
  return false;
}

function resultValue(sym, previous, matIndex, rule, catalog) {
  if (sym === ".") return previous;
  if (sym === "_") return 0;
  if (sym === "@") return matIndex;
  if (sym === "x") return previous > 0 ? previous : null;
  const named = namedMaterialIndex(sym, rule, catalog);
  if (named > 0) return named;
  return null;
}
