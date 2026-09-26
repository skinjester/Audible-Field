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
 *   rotations: "xz"     — try horizontal facings (SandPond for/any(xz.rotations))
 *   pick: "one"         — try one facing per tick (SandPond any / Water8); default all
 *   chance: 0..1        — probability this rule is attempted (SpaceTode maybe)
 *   requireAbove        — only when cell above @ is occupied (pressure / stacked)
 *   openAbove           — only when cell above @ is empty (free surface / leveling)
 *   supportUnderDest    — destination must have support underneath
 *   seekTouch           — destination must already touch other same-material (cohesion)
 *   gainTouch           — only move if same-material contacts after >= before
 *   onlySparse          — only when this grain has fewer than material.minNeighbors contacts
 *   belowBottom: "liquid" — only fire when support under the bottom row is liquid
 *   symbols: { w: "water" } — named material letters in match/result
 *
 * Material fields:
 *   pathBias: 0..1 — how often to prefer last travel dir (0 = random spread, 1 = linear streams)
 *   minNeighbors / sparseAbsorb — soak under-connected grains after N seconds
 */

const ROTATIONS_XZ = [
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: 0, dz: -1 },
];

/**
 * @typedef {{ id: string, label: string, color: string, opacity: number, surface: "solid" | "liquid", pushPower: number, lifetime: number, erode: number, shuffleLimit: number, floorAbsorb: number, minNeighbors: number, sparseAbsorb: number, pathBias: number, rules: object[] }} MaterialDef
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
 *   getFlowDx?: (x: number, y: number, z: number) => number,
 *   setFlowDx?: (x: number, y: number, z: number, v: number) => void,
 *   getFlowDz?: (x: number, y: number, z: number) => number,
 *   setFlowDz?: (x: number, y: number, z: number, v: number) => void,
 *   getSparseAge?: (x: number, y: number, z: number) => number,
 *   setSparseAge?: (x: number, y: number, z: number, v: number) => void,
 *   getFloorAge?: (x: number, y: number, z: number) => number,
 *   setFloorAge?: (x: number, y: number, z: number, v: number) => void,
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
    const floorAbsorbRaw = Number(item.floorAbsorb);
    const floorAbsorb =
      Number.isFinite(floorAbsorbRaw) && floorAbsorbRaw > 0 ? floorAbsorbRaw : 0;
    const minNeighborsRaw = Number(item.minNeighbors);
    const minNeighbors =
      Number.isFinite(minNeighborsRaw) && minNeighborsRaw > 0
        ? Math.floor(minNeighborsRaw)
        : 0;
    const sparseAbsorbRaw = Number(item.sparseAbsorb);
    const sparseAbsorb =
      Number.isFinite(sparseAbsorbRaw) && sparseAbsorbRaw > 0 ? sparseAbsorbRaw : 0;
    const opacityRaw = Number(item.opacity);
    const opacity =
      Number.isFinite(opacityRaw) && opacityRaw > 0 && opacityRaw < 1
        ? opacityRaw
        : 1;
    const pathBiasRaw = Number(item.pathBias);
    const pathBias = Number.isFinite(pathBiasRaw)
      ? Math.min(1, Math.max(0, pathBiasRaw))
      : 0;
    const def = {
      id: item.id,
      label: String(item.label || item.id),
      color: String(item.color || "#cccccc"),
      opacity,
      surface,
      pushPower,
      lifetime,
      erode,
      shuffleLimit,
      floorAbsorb,
      minNeighbors,
      sparseAbsorb,
      pathBias,
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
    /** Only fire when the cell above @ is empty / out of bounds (free surface). */
    openAbove: rule.openAbove === true,
    /** Only fire when the cell above @ is occupied (pressure / stacked). */
    requireAbove: rule.requireAbove === true,
    /** Destination must have support underneath (occupied cell or world floor). */
    supportUnderDest: rule.supportUnderDest === true,
    /** Destination must already face-touch same material other than @ (pull into clumps). */
    seekTouch: rule.seekTouch === true,
    /** Require at least this many same-material touches at dest (2 = fill gaps, not expand rim). */
    seekTouchMin: (() => {
      const n = Number(rule.seekTouchMin);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
      return rule.seekTouch === true ? 1 : 0;
    })(),
    /** Only move when same-material face contacts after >= before (don't fray clumps). */
    gainTouch: rule.gainTouch === true,
    /** Only fire while this grain is under material.minNeighbors (seek friends, then stop). */
    onlySparse: rule.onlySparse === true,
    /** Try one random/preferred xz facing ("one") or all until one fits ("all"). */
    pick: rule.pick === "one" ? "one" : "all",
    /** SpaceTode-style maybe(): probability of attempting this rule (default 1). */
    chance: (() => {
      const c = Number(rule.chance);
      if (!Number.isFinite(c)) return 1;
      return Math.min(1, Math.max(0, c));
    })(),
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

    if (rule.chance < 1 && Math.random() >= rule.chance) continue;

    if (rule.rotations === "xz") {
      const bias = material.pathBias || 0;
      const usePath = bias > 0 && Math.random() < bias;
      const prefDx = usePath ? grid.getFlowDx?.(x, y, z) ?? 0 : 0;
      const prefDz = usePath ? grid.getFlowDz?.(x, y, z) ?? 0 : 0;
      const order = preferRotation(prefDx, prefDz);
      if (rule.pick === "one") {
        // Prefer a facing that can actually move (breach / open side), else one random try.
        const open = [];
        for (const rot of order) {
          if (facingIsOpen(grid, x, y, z, rule, rot.dx, rot.dz, matIndex, catalog)) {
            open.push(rot);
          }
        }
        const faces = open.length ? open.slice(0, 1) : order.slice(0, 1);
        for (const rot of faces) {
          const to = applyOrientedRule(grid, x, y, z, matIndex, rule, rot.dx, rot.dz, catalog);
          if (to) {
            rememberFlowDir(grid, x, y, z, to.x, to.y, to.z);
            const splash = shouldSplashMove(grid, from, to, matIndex, catalog);
            return { moved: true, from, to, splash };
          }
        }
      } else {
        for (const rot of order) {
          const to = applyOrientedRule(grid, x, y, z, matIndex, rule, rot.dx, rot.dz, catalog);
          if (to) {
            rememberFlowDir(grid, x, y, z, to.x, to.y, to.z);
            const splash = shouldSplashMove(grid, from, to, matIndex, catalog);
            return { moved: true, from, to, splash };
          }
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

/** Prefer continuing along the last travel facing; otherwise random order. */
function preferRotation(prefDx, prefDz) {
  const order = shuffled(ROTATIONS_XZ);
  if (!prefDx && !prefDz) return order;
  const pref = order.find((r) => r.dx === prefDx && r.dz === prefDz);
  if (!pref) return order;
  return [pref, ...order.filter((r) => r !== pref)];
}

function rememberFlowDir(grid, fromX, fromY, fromZ, toX, toY, toZ) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dz = toZ - fromZ;
  // Only lock horizontal heading for path-following on spills / sheets.
  if (dy !== 0 || (dx === 0 && dz === 0)) return;
  const sx = Math.sign(dx);
  const sz = Math.sign(dz);
  // Cardinal only (diagram rules are axis-aligned).
  if (sx !== 0 && sz !== 0) return;
  grid.setFlowDx?.(toX, toY, toZ, sx);
  grid.setFlowDz?.(toX, toY, toZ, sz);
}

/** True when this oriented diagram would match (no mutation). Used to pick open facings. */
function facingIsOpen(grid, x, y, z, rule, dx, dz, matIndex, catalog) {
  let atX = 0;
  let atY = 0;
  let atZ = 0;
  let foundAt = false;
  /** @type {{ x: number, y: number, z: number, want: string }[]} */
  const sites = [];
  for (let ly = 0; ly < rule.height; ly += 1) {
    for (let lx = 0; lx < rule.width; lx += 1) {
      const sym = rule.match[ly][lx];
      const off = worldOffset(lx, ly, dx, dz);
      const wx = x + off.x;
      const wy = y + off.y;
      const wz = z + off.z;
      if (sym === "@") {
        if (foundAt) return false;
        if (off.x !== 0 || off.y !== 0 || off.z !== 0) return false;
        foundAt = true;
        atX = wx;
        atY = wy;
        atZ = wz;
      }
      sites.push({ x: wx, y: wy, z: wz, want: sym });
    }
  }
  if (!foundAt) return false;
  for (const site of sites) {
    if (!grid.inBounds(site.x, site.y, site.z)) return false;
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
      return false;
    }
  }
  if (rule.belowBottom === "liquid") {
    if (!catalog) return false;
    for (let lx = 0; lx < rule.width; lx += 1) {
      const off = worldOffset(lx, rule.height - 1, dx, dz);
      if (!isLiquidSupport(grid, x + off.x, y + off.y, z + off.z, catalog)) return false;
    }
  }
  if (rule.requireAbove) {
    const ay = y + 1;
    if (!grid.inBounds(x, ay, z) || grid.get(x, ay, z) <= 0) return false;
  }
  if (rule.openAbove) {
    const ay = y + 1;
    if (grid.inBounds(x, ay, z) && grid.get(x, ay, z) > 0) return false;
  }
  if (rule.onlySparse && catalog) {
    const id = catalog.idByIndex[matIndex];
    const def = id ? catalog.byId.get(id) : null;
    const minN = def?.minNeighbors || 0;
    if (minN > 0 && countSameTouches(grid, x, y, z, matIndex) >= minN) return false;
  }

  /** @type {{ x: number, y: number, z: number } | null} */
  let dest = null;
  for (let ly = 0; ly < rule.height; ly += 1) {
    for (let lx = 0; lx < rule.width; lx += 1) {
      if (rule.result[ly][lx] !== "@") continue;
      const off = worldOffset(lx, ly, dx, dz);
      dest = { x: x + off.x, y: y + off.y, z: z + off.z };
    }
  }
  if (dest && (dest.x !== x || dest.y !== y || dest.z !== z)) {
    if (rule.supportUnderDest && !hasSupportBelow(grid, dest.x, dest.y, dest.z)) return false;
    if (rule.seekTouch && !destinationSeeksTouch(grid, x, y, z, dest.x, dest.y, dest.z, matIndex, rule.seekTouchMin || 1)) {
      return false;
    }
    if (rule.gainTouch && !moveGainsOrKeepsTouch(grid, x, y, z, dest.x, dest.y, dest.z, matIndex)) {
      return false;
    }
  }
  return true;
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

  if (rule.requireAbove) {
    const ay = y + 1;
    if (!grid.inBounds(x, ay, z) || grid.get(x, ay, z) <= 0) return null;
  }

  if (rule.openAbove) {
    const ay = y + 1;
    if (grid.inBounds(x, ay, z) && grid.get(x, ay, z) > 0) return null;
  }

  if (rule.onlySparse && catalog) {
    const id = catalog.idByIndex[matIndex];
    const def = id ? catalog.byId.get(id) : null;
    const minN = def?.minNeighbors || 0;
    if (minN > 0 && countSameTouches(grid, x, y, z, matIndex) >= minN) return null;
  }

  /** @type {CellPos | null} */
  let dest = null;
  for (let ly = 0; ly < rule.height; ly += 1) {
    for (let lx = 0; lx < rule.width; lx += 1) {
      if (rule.result[ly][lx] !== "@") continue;
      const off = worldOffset(lx, ly, dx, dz);
      dest = { x: x + off.x, y: y + off.y, z: z + off.z };
    }
  }

  if (rule.supportUnderDest && dest && (dest.x !== x || dest.y !== y || dest.z !== z)) {
    if (!hasSupportBelow(grid, dest.x, dest.y, dest.z)) return null;
  }

  if (
    rule.seekTouch &&
    dest &&
    (dest.x !== x || dest.y !== y || dest.z !== z) &&
    !destinationSeeksTouch(grid, x, y, z, dest.x, dest.y, dest.z, matIndex, rule.seekTouchMin || 1)
  ) {
    return null;
  }

  if (
    rule.gainTouch &&
    dest &&
    (dest.x !== x || dest.y !== y || dest.z !== z) &&
    !moveGainsOrKeepsTouch(grid, x, y, z, dest.x, dest.y, dest.z, matIndex)
  ) {
    return null;
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
  const sparseAge = grid.getSparseAge?.(x, y, z) ?? 0;
  const floorAge = grid.getFloorAge?.(x, y, z) ?? 0;
  const flowDirX = grid.getFlowDx?.(x, y, z) ?? 0;
  const flowDirZ = grid.getFlowDz?.(x, y, z) ?? 0;

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
    grid.setSparseAge?.(to.x, to.y, to.z, sparseAge);
    grid.setFloorAge?.(to.x, to.y, to.z, floorAge);
    grid.setFlowDx?.(to.x, to.y, to.z, flowDirX);
    grid.setFlowDz?.(to.x, to.y, to.z, flowDirZ);
    return to;
  }
  // Applied with no @ in result (e.g. etch consumes self + neighbor).
  return { x, y, z };
}

function hasSupportBelow(grid, x, y, z) {
  if (y <= 0) return true;
  if (!grid.inBounds(x, y - 1, z)) return true;
  return grid.get(x, y - 1, z) > 0;
}

const TOUCH_DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function destinationTouchCount(grid, _ox, _oy, _oz, tx, ty, tz, matIndex) {
  // Count water already adjacent to dest *before* the move (includes the mover
  // at origin when adjacent). Gap between two bodies → 2; open perimeter → 1.
  let n = 0;
  for (const [dx, dy, dz] of TOUCH_DIRS) {
    const nx = tx + dx;
    const ny = ty + dy;
    const nz = tz + dz;
    if (!grid.inBounds(nx, ny, nz)) continue;
    if (grid.get(nx, ny, nz) === matIndex) n += 1;
  }
  return n;
}

function destinationSeeksTouch(grid, ox, oy, oz, tx, ty, tz, matIndex, minTouches = 1) {
  return destinationTouchCount(grid, ox, oy, oz, tx, ty, tz, matIndex) >= minTouches;
}

function countSameTouches(grid, x, y, z, matIndex) {
  let n = 0;
  for (const [dx, dy, dz] of TOUCH_DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (!grid.inBounds(nx, ny, nz)) continue;
    if (grid.get(nx, ny, nz) === matIndex) n += 1;
  }
  return n;
}

function moveGainsOrKeepsTouch(grid, ox, oy, oz, tx, ty, tz, matIndex) {
  const before = countSameTouches(grid, ox, oy, oz, matIndex);
  let after = 0;
  for (const [dx, dy, dz] of TOUCH_DIRS) {
    const nx = tx + dx;
    const ny = ty + dy;
    const nz = tz + dz;
    if (nx === ox && ny === oy && nz === oz) continue;
    if (!grid.inBounds(nx, ny, nz)) continue;
    if (grid.get(nx, ny, nz) === matIndex) after += 1;
  }
  return after >= before;
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
  grid.setSparseAge?.(x, y, z, 0);
  grid.setFloorAge?.(x, y, z, 0);
  grid.setFlowDx?.(x, y, z, 0);
  grid.setFlowDz?.(x, y, z, 0);
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
