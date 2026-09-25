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
 * Surfaces (material.surface):
 *   solid   — no splash when something rests on it
 *   liquid  — splash when a grain lands or shifts onto it
 * World floor uses catalog.floor ("liquid" | "solid").
 */

const ROTATIONS_XZ = [
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: 0, dz: -1 },
];

/**
 * @typedef {{ id: string, label: string, color: string, surface: "solid" | "liquid", rules: object[] }} MaterialDef
 * @typedef {{ get: (x: number, y: number, z: number) => number, set: (x: number, y: number, z: number, v: number) => void, inBounds: (x: number, y: number, z: number) => boolean }} GridApi
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
    const def = {
      id: item.id,
      label: String(item.label || item.id),
      color: String(item.color || "#cccccc"),
      surface,
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
  const match = parseRows(rule.match);
  const result = parseRows(rule.result);
  if (!match || !result) return null;
  if (match.length !== result.length) return null;
  const width = match[0].length;
  for (const row of match) if (row.length !== width) return null;
  for (const row of result) if (row.length !== width) return null;

  return {
    name: String(rule.name || "rule"),
    match,
    result,
    height: match.length,
    width,
    rotations: rule.rotations === "xz" ? "xz" : null,
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
    if (rule.rotations === "xz") {
      const order = shuffled(ROTATIONS_XZ);
      for (const rot of order) {
        const to = applyOrientedRule(grid, x, y, z, matIndex, rule, rot.dx, rot.dz);
        if (to) {
          const splash = shouldSplashMove(grid, from, to, matIndex, catalog);
          return { moved: true, from, to, splash };
        }
      }
      continue;
    }
    const to = applyOrientedRule(grid, x, y, z, matIndex, rule, 1, 0);
    if (to) {
      const splash = shouldSplashMove(grid, from, to, matIndex, catalog);
      return { moved: true, from, to, splash };
    }
  }
  return { moved: false, from, to: null, splash: false };
}

/**
 * One simulation tick: shuffle occupied cells, apply first matching rule each.
 * @param {GridApi} grid
 * @param {{ x: number, y: number, z: number, mat: number }[]} cells
 * @param {MaterialCatalog} catalog
 * @returns {{ moved: number, splashes: CellPos[] }}
 */
export function stepWorld(grid, cells, catalog) {
  let moved = 0;
  /** @type {CellPos[]} */
  const splashes = [];
  const order = shuffled(cells);
  const seen = new Set();

  for (const cell of order) {
    const key = `${cell.x},${cell.y},${cell.z}`;
    if (seen.has(key)) continue;
    const mat = grid.get(cell.x, cell.y, cell.z);
    if (mat <= 0) continue;
    const id = catalog.idByIndex[mat];
    const material = id ? catalog.byId.get(id) : null;
    if (!material) continue;

    const result = tryMaterialRules(grid, cell.x, cell.y, cell.z, mat, material, catalog);
    if (!result.moved) continue;
    moved += 1;
    seen.add(key);
    if (result.splash && result.to) {
      splashes.push({ x: result.to.x, y: result.to.y, z: result.to.z });
    }
  }

  return { moved, splashes };
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
function applyOrientedRule(grid, x, y, z, matIndex, rule, dx, dz) {
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
    if (!matchSymbol(site.want, value, matIndex, site.x === atX && site.y === atY && site.z === atZ)) {
      return null;
    }
  }

  /** @type {number[]} */
  const before = [];
  for (const site of sites) before.push(grid.get(site.x, site.y, site.z));

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
      const next = resultValue(outSym, before[idx], matIndex);
      if (next == null) continue;
      grid.set(wx, wy, wz, next);
      if (outSym === "@") to = { x: wx, y: wy, z: wz };
    }
  }
  return to;
}

function matchSymbol(sym, value, matIndex, isOrigin) {
  if (sym === ".") return true;
  if (sym === "@") return isOrigin && value === matIndex;
  if (sym === "_") return value === 0;
  if (sym === "x") return value > 0;
  return false;
}

function resultValue(sym, previous, matIndex) {
  if (sym === ".") return previous;
  if (sym === "_") return 0;
  if (sym === "@") return matIndex;
  if (sym === "x") return previous > 0 ? previous : null;
  return null;
}
