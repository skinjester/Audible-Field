/**
 * Tiny SandPond / SpaceTode-style rule runner.
 * Materials declare diagram rules; the world only supplies get/set occupancy.
 *
 * Rule diagrams mirror SpaceTode. Spaces only line symbols up with =>.
 *   diagram: ["@ => _", "_    @"]
 *   diagram: ["@. => _.", "x_    x@"]
 * Symbols (match / result, top → bottom, left → right):
 *   @  this grain
 *   _  empty
 *   x  occupied (any material)
 *   .  anything (keep / ignore)
 *
 * A result with no @ clears this grain (consume-in-place), e.g. etch.
 * Legacy match/result string arrays still compile.
 *
 * Surfaces (material.surface):
 *   solid   — no splash when something rests on it
 *   liquid  — splash when a grain lands or shifts onto it
 * World floor uses catalog.floor ("liquid" | "solid").
 * sonify: false — the grain is not footprint or height, and landing is silent.
 *
 * SpaceTode-ish rule fields (aliases accepted):
 *   for: "xz.rotations" / rotations: "xz" — try all horizontal facings
 *   any: "xz.rotations"                  — try one facing per tick (pick: "one")
 *   maybe: 0..1 / chance: 0..1           — probability this rule is attempted
 *
 * Optional condition fields (extensible — add more without changing diagram syntax):
 *   requireAbove, openAbove, supportUnderDest, seekTouch, seekTouchMin,
 *   gainTouch, gainTouchStrict, onlySparse (positive count), belowBottom, symbols
 *   bias: "flow" — prefer the last horizontal facing
 *
 * Effect rules (no diagram) live in the same rules array. `when` is a flat
 * predicate object (all must pass). `do` is one verb:
 *   { age, hold?: seconds, lifeScale?: number, visual?: "shrink" | "rise", slideLife?: "above", then: "clear" }
 * visual "rise": the grain waits `hold` seconds, then lifts and fades for
 * (poured lifetime, or `age` when none is stored) × `lifeScale`, then clears.
 * lifeScale defaults to 1. The wait is not taken out of that lifetime. The same
 * age clock measures the wait and the climb. The lift is drawn on top of the
 * cell; the cell stays put until it clears.
 * slideLife "above": the horizontal travel of a grain is the number of atoms
 * stacked on it when it first slides. It despawns at that distance, stays full
 * size while sliding, and a shorter stack means a shorter life. 0 steps keeps
 * the full age and the shrink visual.
 * slide "closestOpen": a resting floor block with any atom above steps one cell
 * outward. The column above drops straight down into the cell it left.
 *   { infect: { seconds, skipSurface?: "liquid" } }
 *   A poured lifetime on the infecting grain replaces seconds.
 *   { absorbSparse: { seconds, minNeighbors } }
 *   { dryUnbounded: { seconds, resetOn?: "gainedTouch" } }
 *   { cullShuffle: { hops, span } }
 * Predicates: resting, onFloor, sameAbove, above, flow, boundedCatchment, infection,
 * belowMinNeighbors. Host column queries supply resting / onFloor / sameAbove / above.
 * `above` is any atom higher in the same column, any material.
 * All matching effects run. Each age / absorb / dry rule has its own clock.
 * One infection channel caps a matching age, or shrinks a cell that has none.
 */

const ROTATIONS_XZ = [
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: 0, dz: -1 },
];

/**
 * @typedef {{ id: string, label: string, color: string, opacity: number, surface: "solid" | "liquid", sonify: boolean, pushPower: number, slideOpen: boolean, rules: object[], effects: object[] }} MaterialDef
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
 *   getEffectClock?: (x: number, y: number, z: number, channel: number) => number,
 *   setEffectClock?: (x: number, y: number, z: number, channel: number, v: number) => void,
 *   getInfection?: (x: number, y: number, z: number) => number,
 *   setInfection?: (x: number, y: number, z: number, v: number) => void,
 *   getInfectionAge?: (x: number, y: number, z: number) => number,
 *   setInfectionAge?: (x: number, y: number, z: number, v: number) => void,
 *   setShrink?: (x: number, y: number, z: number, shrinking: boolean, t: number) => void,
 *   getShrink?: (x: number, y: number, z: number) => boolean,
 *   getShrinkT?: (x: number, y: number, z: number) => number,
 *   getExtent?: (x: number, y: number, z: number) => number,
 *   getPitch?: (x: number, y: number, z: number) => number,
 *   cellCenter?: (x: number, y: number, z: number) => { x: number, y: number, z: number },
 *   getWorld?: (x: number, y: number, z: number) => { x: number, y: number, z: number },
 * }} GridApi
 * @typedef {{ defaultId: string, floor: "solid" | "liquid", clockCount: number, list: MaterialDef[], byId: Map<string, MaterialDef>, indexById: Map<string, number>, idByIndex: string[] }} MaterialCatalog
 * @typedef {{ x: number, y: number, z: number }} CellPos
 */

/**
 * materials.json allows block comments so unused materials can be
 * commented out in-place. Strip them (and // line comments) before parse.
 * @param {string} text
 * @returns {unknown}
 */
export function parseMaterialsJson(text) {
  const stripped = String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(stripped);
}

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
  let clockCount = 0;

  for (const item of list) {
    if (!item || typeof item.id !== "string" || !item.id) continue;
    const surface = item.surface === "liquid" ? "liquid" : "solid";
    const pushPower = Math.max(0, Math.floor(Number(item.pushPower) || 0));
    const opacityRaw = Number(item.opacity);
    const opacity =
      Number.isFinite(opacityRaw) && opacityRaw > 0 && opacityRaw < 1
        ? opacityRaw
        : 1;
    /** @type {object[]} */
    const rules = [];
    /** @type {object[]} */
    const effects = [];
    if (Array.isArray(item.rules)) {
      for (const raw of item.rules) {
        const rule = normalizeRule(raw);
        if (!rule) continue;
        if (rule.type === "effect") {
          if (
            rule.kind === "age" ||
            rule.kind === "absorbSparse" ||
            rule.kind === "dryUnbounded"
          ) {
            rule.clockId = clockCount;
            clockCount += 1;
          }
          effects.push(rule);
        } else {
          rules.push(rule);
        }
      }
    }
    const def = {
      id: item.id,
      label: String(item.label || item.id),
      color: String(item.color || "#cccccc"),
      opacity,
      surface,
      sonify: item.sonify !== false,
      pushPower,
      rules,
      effects,
      slideOpen: effects.some((effect) => effect.slide === "closestOpen"),
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

  return { defaultId, floor, clockCount, list: materials, byId, indexById, idByIndex };
}

function normalizeWhen(when) {
  if (!when || typeof when !== "object" || Array.isArray(when)) return {};
  /** @type {Record<string, boolean | number>} */
  const out = {};
  for (const key of ["resting", "onFloor", "sameAbove", "above", "boundedCatchment", "infection", "flow"]) {
    if (when[key] === true || when[key] === false) out[key] = when[key];
  }
  const below = Number(when.belowMinNeighbors);
  if (Number.isFinite(below) && below > 0) out.belowMinNeighbors = Math.floor(below);
  return out;
}

function positiveSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {object} rule
 * @returns {object | null}
 */
function normalizeEffect(rule) {
  const verb = rule.do;
  if (!verb || typeof verb !== "object" || Array.isArray(verb)) return null;
  const base = {
    name: String(rule.name || "effect"),
    type: "effect",
    when: normalizeWhen(rule.when),
    clockId: -1,
  };
  const age = positiveSeconds(verb.age);
  if (age > 0) {
    const visual = verb.visual === "rise" ? "rise" : verb.visual === "shrink" ? "shrink" : null;
    const holdRaw = Math.max(0, Number(verb.hold) || 0);
    const scaleRaw = Number(verb.lifeScale);
    return {
      ...base,
      kind: "age",
      seconds: age,
      hold: visual === "rise" ? holdRaw : Math.min(holdRaw, age),
      lifeScale: visual === "rise" && Number.isFinite(scaleRaw) && scaleRaw > 0 ? scaleRaw : 1,
      visual,
      slide: verb.visual === "shrink" && verb.slide === "closestOpen" ? "closestOpen" : null,
      thenClear: verb.then === "clear",
      slideUnits: Math.max(0, Math.floor(Number(verb.slideUnits) || 0)),
      slideLifeAbove: verb.slideLife === "above",
    };
  }
  if (verb.infect && typeof verb.infect === "object") {
    const seconds = positiveSeconds(verb.infect.seconds);
    if (!seconds) return null;
    return {
      ...base,
      kind: "infect",
      seconds,
      skipSurface: verb.infect.skipSurface === "liquid" ? "liquid" : null,
    };
  }
  if (verb.absorbSparse && typeof verb.absorbSparse === "object") {
    const seconds = positiveSeconds(verb.absorbSparse.seconds);
    const minNeighbors = Math.floor(Number(verb.absorbSparse.minNeighbors) || 0);
    if (!seconds || minNeighbors <= 0) return null;
    return { ...base, kind: "absorbSparse", seconds, minNeighbors };
  }
  if (verb.dryUnbounded && typeof verb.dryUnbounded === "object") {
    const seconds = positiveSeconds(verb.dryUnbounded.seconds);
    if (!seconds) return null;
    return {
      ...base,
      kind: "dryUnbounded",
      seconds,
      resetOn: verb.dryUnbounded.resetOn === "gainedTouch" ? "gainedTouch" : null,
    };
  }
  if (verb.cullShuffle && typeof verb.cullShuffle === "object") {
    const hops = Math.floor(Number(verb.cullShuffle.hops) || 0);
    const span = Math.floor(Number(verb.cullShuffle.span) || 0);
    if (hops <= 0) return null;
    return { ...base, kind: "cullShuffle", hops, span: span > 0 ? span : 2 };
  }
  if (verb.slide === "closestOpen") {
    return { ...base, kind: "slideClosest", slide: "closestOpen" };
  }
  return null;
}

function normalizeRule(rule) {
  if (typeof rule === "string") {
    return normalizeRule({ diagram: rule });
  }
  if (!rule || typeof rule !== "object") return null;
  if (rule.do && rule.diagram == null && rule.match == null && rule.type !== "push") {
    return normalizeEffect(rule);
  }

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

  let match = null;
  let result = null;
  if (rule.diagram != null) {
    const parsed = parseDiagram(rule.diagram);
    if (!parsed) return null;
    match = parsed.match;
    result = parsed.result;
  } else {
    match = parseRows(rule.match);
    result = parseRows(rule.result);
  }
  if (!match || !result) return null;
  if (match.length !== result.length) return null;
  const width = match[0].length;
  for (const row of match) if (row.length !== width) return null;
  for (const row of result) if (row.length !== width) return null;

  const xzAny = isXzRotationHint(rule.any);
  const xzFor = isXzRotationHint(rule.for) || rule.rotations === "xz";
  const rotations = xzAny || xzFor ? "xz" : null;
  /** Try one random/preferred xz facing ("one") or all until one fits ("all"). */
  let pick = "all";
  if (rule.pick === "one" || xzAny) pick = "one";
  else if (rule.pick === "all" || xzFor) pick = "all";

  const chanceRaw = rule.maybe != null ? Number(rule.maybe) : Number(rule.chance);
  const chance = Number.isFinite(chanceRaw)
    ? Math.min(1, Math.max(0, chanceRaw))
    : 1;

  return {
    name: String(rule.name || "rule"),
    type: "diagram",
    match,
    result,
    height: match.length,
    width,
    rotations,
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
    /** Like gainTouch but require a strict increase (contract until resting). */
    gainTouchStrict: rule.gainTouchStrict === true,
    /** Stop this diagram once same-material touches reach this count. */
    onlySparse: (() => {
      const n = Number(rule.onlySparse);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    })(),
    /** Prefer the grain's last horizontal facing when set to "flow". */
    bias: rule.bias === "flow" ? "flow" : null,
    pick,
    /** SpaceTode-style maybe(): probability of attempting this rule (default 1). */
    chance,
  };
}

function isXzRotationHint(value) {
  if (value === true || value === "xz") return true;
  const s = String(value || "").toLowerCase();
  return s === "xz.rotations" || s === "xz.directions";
}

/**
 * Parse SpaceTode diagram lines into match/result char grids.
 * The first `=>` sets a vertical cut. Spaces are alignment only.
 * A symbol that lands in the arrow columns rejects the diagram.
 *   ["@ => _", "_    @"]
 *   ["@. => _.", "x_    x@"]
 * @param {unknown} diagram
 * @returns {{ match: string[][], result: string[][] } | null}
 */
function parseDiagram(diagram) {
  /** @type {string[]} */
  let lines = [];
  if (typeof diagram === "string") {
    lines = diagram.split(/\r?\n/);
  } else if (Array.isArray(diagram)) {
    lines = diagram.map((row) => String(row ?? ""));
  } else {
    return null;
  }
  lines = lines.map((l) => l.replace(/\t/g, " ")).filter((l) => l.trim().length > 0);
  if (!lines.length) return null;

  let arrowAt = -1;
  for (const line of lines) {
    const idx = line.indexOf("=>");
    if (idx >= 0) {
      arrowAt = idx;
      break;
    }
  }
  if (arrowAt < 0) return null;
  const rightStart = arrowAt + 2;

  /** @type {string[][]} */
  const match = [];
  /** @type {string[][]} */
  const result = [];

  for (const line of lines) {
    const idx = line.indexOf("=>");
    /** @type {string} */
    let leftSrc;
    /** @type {string} */
    let rightSrc;
    if (idx >= 0) {
      if (idx !== arrowAt) return null;
      leftSrc = line.slice(0, idx);
      rightSrc = line.slice(idx + 2);
    } else {
      const gutter = line.slice(arrowAt, Math.min(line.length, rightStart));
      if (gutter.trim() !== "") return null;
      leftSrc = line.slice(0, Math.min(line.length, arrowAt));
      rightSrc = line.length > rightStart ? line.slice(rightStart) : "";
    }
    const left = [...leftSrc.replace(/\s+/g, "")];
    const right = [...rightSrc.replace(/\s+/g, "")];
    if (!left.length || left.length !== right.length) return null;
    match.push(left);
    result.push(right);
  }

  const width = match[0].length;
  if (match.some((row) => row.length !== width)) return null;
  return { match, result };
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
  // Removal grains and liquids make no landing sound.
  if (mover?.sonify === false || mover?.surface === "liquid") return false;

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
      const usePath = rule.bias === "flow";
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
  const effectState = readEffectState(grid, x, y, z, catalog);
  const posY = grid.getPosY?.(x, y, z) ?? 0;
  const posX = grid.getPosX?.(x, y, z) ?? 0;
  const posZ = grid.getPosZ?.(x, y, z) ?? 0;
  const emitSize = grid.getEmitSize?.(x, y, z) ?? 0;
  const life = grid.getLife?.(x, y, z) ?? 0;
  const shuffle = grid.getShuffle?.(x, y, z) ?? 0;
  const shuffleOx = grid.getShuffleOriginX?.(x, y, z) ?? 0;
  const shuffleOz = grid.getShuffleOriginZ?.(x, y, z) ?? 0;
  grid.set(x, y, z, 0);
  clearCellMeta(grid, x, y, z, catalog);
  grid.set(x, topSandY, z, matIndex);
  grid.setBudget?.(x, topSandY, z, remain);
  writeEffectState(grid, x, topSandY, z, effectState);
  grid.setPosY?.(x, topSandY, z, posY);
  grid.setPosX?.(x, topSandY, z, posX);
  grid.setPosZ?.(x, topSandY, z, posZ);
  if (emitSize > 0) grid.setEmitSize?.(x, topSandY, z, emitSize);
  if (life > 0) grid.setLife?.(x, topSandY, z, life);
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

const SLIDE_OPEN_RADIUS = 6;

function slideOpenEffect(material) {
  return (material?.effects || []).find((effect) => effect.slide === "closestOpen") || null;
}

function slideWhenMatches(grid, x, y, z, effect) {
  const when = effect?.when || {};
  if (when.resting === true && grid.getResting?.(x, y, z) !== true) return false;
  if (when.resting === false && grid.getResting?.(x, y, z) === true) return false;
  if (when.onFloor === true && grid.getOnFloor?.(x, y, z) !== true) return false;
  if (when.onFloor === false && grid.getOnFloor?.(x, y, z) === true) return false;
  if (when.sameAbove === true && grid.getSameAbove?.(x, y, z) !== true) return false;
  if (when.sameAbove === false && grid.getSameAbove?.(x, y, z) === true) return false;
  return true;
}

/** Drop the stack above a vacated cell straight down, one cell each. */
function dropColumnAbove(grid, x, y, z, catalog) {
  let gy = y + 1;
  while (grid.inBounds(x, gy, z)) {
    const mat = grid.get(x, gy, z);
    if (mat <= 0) break;
    transferGrain(grid, x, gy, z, x, gy - 1, z, mat, catalog);
    gy += 1;
  }
}

/**
 * The floor grain steps one cell outward. Any atoms above it then drop into
 * the cell it left. Its travel budget is how many atoms were above it when it
 * first slid.
 * @returns {CellPos | null}
 */
function trySlideClosestOpen(grid, x, y, z, matIndex, material, catalog) {
  const effect = slideOpenEffect(material);
  if (!effect || !slideWhenMatches(grid, x, y, z, effect)) return null;
  if (grid.getOnFloor?.(x, y, z) !== true) return null;
  if (stackAbove(grid, x, y, z) <= 0) return null;
  const seen = new Set();
  const to = nudgeOutOne(grid, x, y, z, matIndex, catalog, 0, 0, seen);
  if (!to) return null;
  dropColumnAbove(grid, x, y, z, catalog);
  return to;
}

/** Occupied cells stacked directly above this one, of any material. */
function stackAbove(grid, x, y, z) {
  let n = 0;
  let gy = y + 1;
  while (grid.inBounds(x, gy, z) && grid.get(x, gy, z) > 0) {
    n += 1;
    gy += 1;
  }
  return n;
}

/**
 * Move this floor block one cell outward. A neighbor already in the way slides
 * one cell first. One call moves each block at most once.
 * @returns {CellPos | null}
 */
function nudgeOutOne(grid, x, y, z, matIndex, catalog, hintDx, hintDz, seen) {
  const here = `${x},${y},${z}`;
  if (seen.has(here) || grid.get(x, y, z) !== matIndex) return null;
  seen.add(here);
  const pitch = grid.getPitch?.(x, y, z) ?? 0;
  const center = grid.cellCenter?.(x, y, z);
  if (!(pitch > 0) || !center) return null;
  const size = grid.getExtent?.(x, y, z) || pitch;
  const flowDx = grid.getFlowDx?.(x, y, z) ?? 0;
  const flowDz = grid.getFlowDz?.(x, y, z) ?? 0;
  const preferDx = flowDx || hintDx;
  const preferDz = flowDz || hintDz;

  const line = outwardNeighbor(grid, x, y, z, matIndex);
  if (line) {
    const dx = Math.sign(line.x - x);
    const dz = Math.sign(line.z - z);
    if (nudgeOutOne(grid, line.x, y, line.z, matIndex, catalog, dx, dz, seen) && grid.get(line.x, y, line.z) === 0) {
      if (stepInto(grid, x, y, z, line.x, y, line.z, matIndex, catalog, center, pitch, size)) {
        return { x: line.x, y, z: line.z };
      }
    }
  }

  /** @type {{ x: number, z: number }[]} */
  const steps = [];
  if (preferDx !== 0 || preferDz !== 0) {
    const sx = Math.sign(preferDx);
    const sz = preferDx !== 0 ? 0 : Math.sign(preferDz);
    steps.push({ x: x + sx, z: z + sz });
  } else {
    const best = closestOpenCell(grid, x, y, z, center, pitch, size);
    if (!best) return null;
    const sx = Math.sign(best.x - x);
    const sz = Math.sign(best.z - z);
    if (sx !== 0) steps.push({ x: x + sx, z });
    if (sz !== 0) steps.push({ x, z: z + sz });
    steps.sort(
      (a, b) =>
        Math.abs(best.x - a.x) + Math.abs(best.z - a.z) - (Math.abs(best.x - b.x) + Math.abs(best.z - b.z)),
    );
  }

  for (const step of steps) {
    if (!grid.inBounds(step.x, y, step.z)) continue;
    const occ = grid.get(step.x, y, step.z);
    if (occ === matIndex) {
      const dx = Math.sign(step.x - x);
      const dz = Math.sign(step.z - z);
      if (!nudgeOutOne(grid, step.x, y, step.z, matIndex, catalog, dx, dz, seen)) continue;
    }
    if (grid.get(step.x, y, step.z) !== 0) continue;
    if (!stepInto(grid, x, y, z, step.x, y, step.z, matIndex, catalog, center, pitch, size)) continue;
    return { x: step.x, y, z: step.z };
  }
  return null;
}

/** Same-material neighbor already spreading away from this block. */
function outwardNeighbor(grid, x, y, z, matIndex) {
  /** @type {{ x: number, z: number, away: number, dx: number, dz: number } | null} */
  let best = null;
  for (const [dx, dz] of SLIDE_CARDINALS) {
    const nx = x + dx;
    const nz = z + dz;
    if (!grid.inBounds(nx, y, nz) || grid.get(nx, y, nz) !== matIndex) continue;
    const fdx = grid.getFlowDx?.(nx, y, nz) ?? 0;
    const fdz = grid.getFlowDz?.(nx, y, nz) ?? 0;
    const away = fdx === dx && fdz === dz && (fdx !== 0 || fdz !== 0) ? 1 : 0;
    const next = { x: nx, z: nz, away, dx, dz };
    if (
      !best ||
      next.away > best.away ||
      (next.away === best.away && (next.dx > best.dx || (next.dx === best.dx && next.dz > best.dz)))
    ) {
      best = next;
    }
  }
  return best;
}

/**
 * @returns {boolean}
 */
function stepInto(grid, x, y, z, toX, toY, toZ, matIndex, catalog, center, pitch, size) {
  const hole = grid.cellCenter(toX, toY, toZ);
  const slot = closestSlotInCell(center, hole, pitch, size);
  if (!cubeOfSizeFits(grid, toX, toY, toZ, slot.x, hole.y, slot.z, size, x, y, z)) return false;
  const prev = grid.getShuffle?.(x, y, z) ?? 0;
  const stored = grid.getBudget?.(x, y, z) ?? 0;
  const cap = prev > 0 ? stored : stackAbove(grid, x, y, z);
  transferGrain(grid, x, y, z, toX, toY, toZ, matIndex, catalog);
  const slid = prev + 1;
  grid.setShuffle?.(toX, toY, toZ, slid);
  if (cap > 0) grid.setBudget?.(toX, toY, toZ, cap);
  const sx = Math.sign(toX - x);
  const sz = Math.sign(toZ - z);
  if (sx !== 0) grid.setFlowDx?.(toX, toY, toZ, sx);
  else if (sz !== 0) grid.setFlowDz?.(toX, toY, toZ, sz);
  if (usesStackSlideLife(catalog, matIndex) && cap > 0 && slid >= cap) {
    grid.set(toX, toY, toZ, 0);
    clearCellMeta(grid, toX, toY, toZ, catalog);
  }
  return true;
}

/** True when this material's slide distance is the stack it left. */
function usesStackSlideLife(catalog, matIndex) {
  const material = materialByIndex(catalog, matIndex);
  return (material?.effects || []).some((effect) => effect.kind === "age" && effect.slideLifeAbove);
}

/**
 * @returns {{ x: number, y: number, z: number } | null}
 */
function closestOpenCell(grid, x, y, z, center, pitch, size) {
  /** @type {{ x: number, y: number, z: number, dist: number, align: number, dx: number, dz: number } | null} */
  let best = null;
  for (let dz = -SLIDE_OPEN_RADIUS; dz <= SLIDE_OPEN_RADIUS; dz += 1) {
    for (let dx = -SLIDE_OPEN_RADIUS; dx <= SLIDE_OPEN_RADIUS; dx += 1) {
      if (dx === 0 && dz === 0) continue;
      const nx = x + dx;
      const nz = z + dz;
      if (!grid.inBounds(nx, y, nz) || grid.get(nx, y, nz) !== 0) continue;
      const hole = grid.cellCenter(nx, y, nz);
      const slot = closestSlotInCell(center, hole, pitch, size);
      if (!cubeOfSizeFits(grid, nx, y, nz, slot.x, hole.y, slot.z, size, x, y, z)) continue;
      const dist = Math.hypot(slot.x - center.x, slot.z - center.z);
      const next = { x: nx, y, z: nz, dist, align: 0, dx, dz };
      if (closerOpenSlot(next, best)) best = next;
    }
  }
  return best;
}

const SLIDE_CARDINALS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * No empty cell next to this grain. Push a neighbor into an empty cell, then
 * step into the cell that push opened.
 * @returns {CellPos | null}
 */
function pushToMakeRoom(grid, x, y, z, matIndex, catalog, pitch) {
  /** @type {{ nx: number, nz: number, ex: number, ez: number, away: number, dx: number, dz: number } | null} */
  let best = null;
  for (const [dx, dz] of SLIDE_CARDINALS) {
    const nx = x + dx;
    const nz = z + dz;
    if (!grid.inBounds(nx, y, nz) || grid.get(nx, y, nz) <= 0) continue;
    for (const [px, pz] of SLIDE_CARDINALS) {
      const ex = nx + px;
      const ez = nz + pz;
      if ((ex === x && ez === z) || !grid.inBounds(ex, y, ez) || grid.get(ex, y, ez) !== 0) continue;
      const nSize = grid.getExtent?.(nx, y, nz) || pitch;
      const from = grid.cellCenter?.(nx, y, nz);
      const hole = grid.cellCenter?.(ex, y, ez);
      if (!from || !hole) continue;
      const slot = closestSlotInCell(from, hole, pitch, nSize);
      if (!cubeOfSizeFits(grid, ex, y, ez, slot.x, hole.y, slot.z, nSize, nx, y, nz)) continue;
      const away = px === dx && pz === dz ? 1 : 0;
      const next = { nx, nz, ex, ez, away, dx, dz };
      if (
        !best ||
        next.away > best.away ||
        (next.away === best.away && (next.dx > best.dx || (next.dx === best.dx && next.dz > best.dz)))
      ) {
        best = next;
      }
    }
  }
  if (!best) return null;
  const occ = grid.get(best.nx, y, best.nz);
  const fdx = grid.getFlowDx?.(best.nx, y, best.nz) ?? 0;
  const fdz = grid.getFlowDz?.(best.nx, y, best.nz) ?? 0;
  transferGrain(grid, best.nx, y, best.nz, best.ex, y, best.ez, occ, catalog);
  grid.setFlowDx?.(best.ex, y, best.ez, fdx);
  grid.setFlowDz?.(best.ex, y, best.ez, fdz);
  transferGrain(grid, x, y, z, best.nx, y, best.nz, matIndex, catalog);
  rememberFlowDir(grid, x, y, z, best.nx, y, best.nz);
  dropColumnAbove(grid, x, y, z, catalog);
  return { x: best.nx, y, z: best.nz };
}

/**
 * @param {{ dist: number, align: number, dx: number, dz: number } | null} next
 * @param {{ dist: number, align: number, dx: number, dz: number } | null} best
 */
function closerOpenSlot(next, best) {
  if (!best) return true;
  const eps = 1e-4;
  if (next.dist < best.dist - eps) return true;
  if (next.dist > best.dist + eps) return false;
  if (next.align !== best.align) return next.align > best.align;
  if (next.dx !== best.dx) return next.dx > best.dx;
  return next.dz > best.dz;
}

/**
 * Closest center for a cube of `size` that still sits inside the empty cell.
 * @param {{ x: number, z: number }} from
 * @param {{ x: number, y: number, z: number }} cell
 * @param {number} pitch
 * @param {number} size
 */
function closestSlotInCell(from, cell, pitch, size) {
  const inset = Math.max(0, (pitch - size) * 0.5);
  return {
    x: cell.x + Math.max(-inset, Math.min(inset, from.x - cell.x)),
    z: cell.z + Math.max(-inset, Math.min(inset, from.z - cell.z)),
  };
}

/**
 * True when a cube of side `size` at this world center misses every other atom.
 * Neighbors are scanned around the destination cell.
 */
function cubeOfSizeFits(grid, cx, cy, cz, wx, wy, wz, size, selfX, selfY, selfZ) {
  if (!(size > 0)) return false;
  const half = size * 0.5;
  const pitch = grid.getPitch?.(cx, cy, cz) || size;
  const reach = Math.max(2, Math.ceil((half + pitch) / Math.max(pitch, 1e-6)) + 2);
  const eps = 1e-4;
  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dz = -reach; dz <= reach; dz += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        const nx = cx + dx;
        const ny = cy + dy;
        const nz = cz + dz;
        if (nx === selfX && ny === selfY && nz === selfZ) continue;
        if (!grid.inBounds(nx, ny, nz) || grid.get(nx, ny, nz) <= 0) continue;
        const nCenter = grid.getWorld?.(nx, ny, nz);
        if (!nCenter) continue;
        const nHalf = (grid.getExtent?.(nx, ny, nz) || pitch) * 0.5;
        if (
          Math.abs(wx - nCenter.x) < half + nHalf - eps &&
          Math.abs(wy - nCenter.y) < half + nHalf - eps &&
          Math.abs(wz - nCenter.z) < half + nHalf - eps
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Move one grain and its clocks, pose, and shrink onto an empty cell.
 */
function transferGrain(grid, x, y, z, toX, toY, toZ, matIndex, catalog) {
  const budget = grid.getBudget?.(x, y, z) ?? 0;
  const effectState = readEffectState(grid, x, y, z, catalog);
  const posY = grid.getPosY?.(x, y, z) ?? 0;
  const posX = grid.getPosX?.(x, y, z) ?? 0;
  const posZ = grid.getPosZ?.(x, y, z) ?? 0;
  const emitSize = grid.getEmitSize?.(x, y, z) ?? 0;
  const life = grid.getLife?.(x, y, z) ?? 0;
  const shuffle = grid.getShuffle?.(x, y, z) ?? 0;
  const shuffleOx = grid.getShuffleOriginX?.(x, y, z) ?? 0;
  const shuffleOz = grid.getShuffleOriginZ?.(x, y, z) ?? 0;
  const shrinking = grid.getShrink?.(x, y, z) === true;
  const shrinkT = grid.getShrinkT?.(x, y, z) ?? 0;
  const risingT = grid.getRiseT?.(x, y, z) ?? 0;
  const risingElapsed = grid.getRiseElapsed?.(x, y, z) ?? 0;

  grid.set(toX, toY, toZ, matIndex);
  grid.set(x, y, z, 0);
  clearCellMeta(grid, x, y, z, catalog);
  grid.setBudget?.(toX, toY, toZ, budget);
  writeEffectState(grid, toX, toY, toZ, effectState);
  grid.setPosY?.(toX, toY, toZ, posY);
  grid.setPosX?.(toX, toY, toZ, posX);
  grid.setPosZ?.(toX, toY, toZ, posZ);
  if (emitSize > 0) grid.setEmitSize?.(toX, toY, toZ, emitSize);
  if (life > 0) grid.setLife?.(toX, toY, toZ, life);
  grid.setShuffle?.(toX, toY, toZ, shuffle);
  grid.setShuffleOriginX?.(toX, toY, toZ, shuffleOx);
  grid.setShuffleOriginZ?.(toX, toY, toZ, shuffleOz);
  grid.setShrink?.(toX, toY, toZ, shrinking, shrinkT);
  if (risingElapsed > 0 || risingT > 0) grid.setRise?.(toX, toY, toZ, true, risingT, risingElapsed);
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

    let result = tryMaterialRules(grid, cell.x, cell.y, cell.z, mat, material, catalog);
    if (!result.moved || !result.to) {
      const slid = trySlideClosestOpen(grid, cell.x, cell.y, cell.z, mat, material, catalog);
      if (!slid) continue;
      result = { moved: true, from: { x: cell.x, y: cell.y, z: cell.z }, to: slid, splash: false };
    }
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
  if (rule.onlySparse > 0 && countSameTouches(grid, x, y, z, matIndex) >= rule.onlySparse) {
    return false;
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
    if (rule.gainTouchStrict && !moveGainsTouch(grid, x, y, z, dest.x, dest.y, dest.z, matIndex)) {
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

  if (rule.onlySparse > 0 && countSameTouches(grid, x, y, z, matIndex) >= rule.onlySparse) {
    return null;
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

  if (
    rule.gainTouchStrict &&
    dest &&
    (dest.x !== x || dest.y !== y || dest.z !== z) &&
    !moveGainsTouch(grid, x, y, z, dest.x, dest.y, dest.z, matIndex)
  ) {
    return null;
  }

  /** @type {number[]} */
  const before = [];
  for (const site of sites) before.push(grid.get(site.x, site.y, site.z));
  const budget = grid.getBudget?.(x, y, z) ?? 0;
  const effectState = readEffectState(grid, x, y, z, catalog);
  const posY = grid.getPosY?.(x, y, z) ?? 0;
  const posX = grid.getPosX?.(x, y, z) ?? 0;
  const posZ = grid.getPosZ?.(x, y, z) ?? 0;
  const emitSize = grid.getEmitSize?.(x, y, z) ?? 0;
  const life = grid.getLife?.(x, y, z) ?? 0;
  const shuffle = grid.getShuffle?.(x, y, z) ?? 0;
  const shuffleOx = grid.getShuffleOriginX?.(x, y, z) ?? 0;
  const shuffleOz = grid.getShuffleOriginZ?.(x, y, z) ?? 0;
  const flowDirX = grid.getFlowDx?.(x, y, z) ?? 0;
  const flowDirZ = grid.getFlowDz?.(x, y, z) ?? 0;
  const risingT = grid.getRiseT?.(x, y, z) ?? 0;
  const risingElapsed = grid.getRiseElapsed?.(x, y, z) ?? 0;

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
      if (next === 0) clearCellMeta(grid, wx, wy, wz, catalog);
      if (outSym === "@") to = { x: wx, y: wy, z: wz };
    }
  }
  if (to) {
    clearCellMeta(grid, x, y, z, catalog);
    grid.setBudget?.(to.x, to.y, to.z, budget);
    writeEffectState(grid, to.x, to.y, to.z, effectState);
    grid.setPosY?.(to.x, to.y, to.z, posY);
    grid.setPosX?.(to.x, to.y, to.z, posX);
    grid.setPosZ?.(to.x, to.y, to.z, posZ);
    if (emitSize > 0) grid.setEmitSize?.(to.x, to.y, to.z, emitSize);
    if (life > 0) grid.setLife?.(to.x, to.y, to.z, life);
    grid.setShuffle?.(to.x, to.y, to.z, shuffle);
    grid.setShuffleOriginX?.(to.x, to.y, to.z, shuffleOx);
    grid.setShuffleOriginZ?.(to.x, to.y, to.z, shuffleOz);
    grid.setFlowDx?.(to.x, to.y, to.z, flowDirX);
    grid.setFlowDz?.(to.x, to.y, to.z, flowDirZ);
    if (risingElapsed > 0 || risingT > 0) grid.setRise?.(to.x, to.y, to.z, true, risingT, risingElapsed);
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

function destinationTouchCount(grid, ox, oy, oz, tx, ty, tz, matIndex) {
  // Count water already adjacent to dest, excluding the mover. That way
  // seekTouchMin:2 means a real gap/pocket (2+ others), not a rim slide
  // where the only second "touch" is the grain about to leave.
  let n = 0;
  for (const [dx, dy, dz] of TOUCH_DIRS) {
    const nx = tx + dx;
    const ny = ty + dy;
    const nz = tz + dz;
    if (nx === ox && ny === oy && nz === oz) continue;
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
  return touchDelta(grid, ox, oy, oz, tx, ty, tz, matIndex) >= 0;
}

function moveGainsTouch(grid, ox, oy, oz, tx, ty, tz, matIndex) {
  return touchDelta(grid, ox, oy, oz, tx, ty, tz, matIndex) > 0;
}

function touchDelta(grid, ox, oy, oz, tx, ty, tz, matIndex) {
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
  return after - before;
}

function readEffectState(grid, x, y, z, catalog) {
  const n = catalog?.clockCount || 0;
  /** @type {number[]} */
  const clocks = [];
  for (let c = 0; c < n; c += 1) clocks.push(grid.getEffectClock?.(x, y, z, c) ?? 0);
  return {
    clocks,
    infection: grid.getInfection?.(x, y, z) ?? 0,
    infectionAge: grid.getInfectionAge?.(x, y, z) ?? 0,
  };
}

function writeEffectState(grid, x, y, z, state) {
  if (!state) return;
  for (let c = 0; c < state.clocks.length; c += 1) {
    grid.setEffectClock?.(x, y, z, c, state.clocks[c]);
  }
  grid.setInfection?.(x, y, z, state.infection);
  grid.setInfectionAge?.(x, y, z, state.infectionAge);
}

function clearEffectState(grid, x, y, z, catalog) {
  const n = catalog?.clockCount || 0;
  for (let c = 0; c < n; c += 1) grid.setEffectClock?.(x, y, z, c, 0);
  grid.setInfection?.(x, y, z, 0);
  grid.setInfectionAge?.(x, y, z, 0);
  grid.setShrink?.(x, y, z, false, 0);
  grid.setRise?.(x, y, z, false, 0);
}

function clearCellMeta(grid, x, y, z, catalog = null) {
  grid.setBudget?.(x, y, z, 0);
  grid.setLife?.(x, y, z, 0);
  grid.setPosY?.(x, y, z, 0);
  grid.setPosX?.(x, y, z, 0);
  grid.setPosZ?.(x, y, z, 0);
  grid.setEmitSize?.(x, y, z, 0);
  grid.setShuffle?.(x, y, z, 0);
  grid.setShuffleOriginX?.(x, y, z, 0);
  grid.setShuffleOriginZ?.(x, y, z, 0);
  grid.setFlowDx?.(x, y, z, 0);
  grid.setFlowDz?.(x, y, z, 0);
  clearEffectState(grid, x, y, z, catalog);
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

const EFFECT_DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function materialByIndex(catalog, matIndex) {
  if (!catalog || matIndex <= 0) return null;
  const id = catalog.idByIndex[matIndex];
  return id ? catalog.byId.get(id) : null;
}

function whenMatches(when, ctx) {
  if (!when) return true;
  if (when.resting != null && ctx.resting !== when.resting) return false;
  if (when.onFloor != null && ctx.onFloor !== when.onFloor) return false;
  if (when.sameAbove != null && ctx.sameAbove !== when.sameAbove) return false;
  if (when.above != null && ctx.above !== when.above) return false;
  if (when.flow != null && ctx.flow !== when.flow) return false;
  if (when.boundedCatchment != null && ctx.boundedCatchment !== when.boundedCatchment) return false;
  if (when.infection != null && ctx.infection !== when.infection) return false;
  if (when.belowMinNeighbors != null && !(ctx.sameNeighbors < when.belowMinNeighbors)) return false;
  return true;
}

function effectContext(grid, cell, catalog, queries) {
  const index = cell.i;
  return {
    resting: queries?.resting?.(index) === true,
    onFloor: queries?.onFloor?.(index) === true,
    sameAbove: queries?.sameAbove?.(index) === true,
    above: queries?.above?.(index) === true,
    flow: (grid.getFlowDx?.(cell.x, cell.y, cell.z) ?? 0) !== 0 || (grid.getFlowDz?.(cell.x, cell.y, cell.z) ?? 0) !== 0,
    boundedCatchment: isBoundedCatchment(grid, cell.x, cell.y, cell.z, catalog),
    sameNeighbors: countSameTouches(grid, cell.x, cell.y, cell.z, cell.mat),
    infection: (grid.getInfection?.(cell.x, cell.y, cell.z) ?? 0) > 0,
  };
}

function isBoundedCatchment(grid, x, y, z, catalog) {
  if (!catalog) return false;
  if (y > 0 && grid.inBounds(x, y - 1, z)) {
    const below = grid.get(x, y - 1, z);
    if (below > 0 && materialByIndex(catalog, below)?.surface === "solid") return true;
  }
  for (const [dx, , dz] of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ]) {
    const nx = x + dx;
    const nz = z + dz;
    if (!grid.inBounds(nx, y, nz)) continue;
    const nmat = grid.get(nx, y, nz);
    if (nmat > 0 && materialByIndex(catalog, nmat)?.surface === "solid") return true;
  }
  return false;
}

function hasEmptyFace(grid, x, y, z) {
  for (const [dx, dy, dz] of EFFECT_DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (!grid.inBounds(nx, ny, nz)) continue;
    if (grid.get(nx, ny, nz) === 0) return true;
  }
  return false;
}

function getClock(grid, x, y, z, channel) {
  return grid.getEffectClock?.(x, y, z, channel) ?? 0;
}

function setClock(grid, x, y, z, channel, value) {
  grid.setEffectClock?.(x, y, z, channel, Math.max(0, Number(value) || 0));
}

/**
 * Tag face neighbors from infect effects. Liquids are skipped when the rule says so.
 * @param {GridApi} grid
 * @param {{ x: number, y: number, z: number, mat: number }[]} cells
 * @param {MaterialCatalog} catalog
 * @returns {boolean}
 */
export function applyInfect(grid, cells, catalog) {
  if (!catalog || !cells?.length) return false;
  let dirty = false;
  for (const cell of cells) {
    if (grid.get(cell.x, cell.y, cell.z) !== cell.mat) continue;
    const material = materialByIndex(catalog, cell.mat);
    if (!material?.effects?.length) continue;
    for (const effect of material.effects) {
      if (effect.kind !== "infect") continue;
      if (!whenMatches(effect.when, effectContext(grid, cell, catalog, null))) continue;
      for (const [dx, dy, dz] of EFFECT_DIRS) {
        const nx = cell.x + dx;
        const ny = cell.y + dy;
        const nz = cell.z + dz;
        if (!grid.inBounds(nx, ny, nz)) continue;
        const nmat = grid.get(nx, ny, nz);
        if (nmat <= 0 || nmat === cell.mat) continue;
        if ((grid.getInfection?.(nx, ny, nz) ?? 0) > 0) continue;
        const neighbor = materialByIndex(catalog, nmat);
        if (effect.skipSurface && neighbor?.surface === effect.skipSurface) continue;
        const baked = grid.getLife?.(cell.x, cell.y, cell.z) ?? 0;
        const seconds = baked > 0 ? baked : effect.seconds;
        grid.setInfection?.(nx, ny, nz, seconds);
        dirty = true;
      }
    }
  }
  return dirty;
}

/**
 * Shuffle cull and dry-clock reset from the diagram move list.
 * @param {GridApi} grid
 * @param {{ from: CellPos, to: CellPos, mat: number }[]} moves
 * @param {MaterialCatalog} catalog
 * @returns {boolean}
 */
export function applyPostMoves(grid, moves, catalog) {
  if (!catalog || !moves?.length) return false;
  let culled = false;
  for (const move of moves) {
    if (grid.get(move.to.x, move.to.y, move.to.z) !== move.mat) continue;
    const material = materialByIndex(catalog, move.mat);
    if (!material?.effects?.length) continue;
    for (const effect of material.effects) {
      if (effect.kind === "cullShuffle") {
        if (move.to.y < move.from.y) {
          grid.setShuffle?.(move.to.x, move.to.y, move.to.z, 0);
          grid.setShuffleOriginX?.(move.to.x, move.to.y, move.to.z, 0);
          grid.setShuffleOriginZ?.(move.to.x, move.to.y, move.to.z, 0);
        } else if (move.to.y !== move.from.y) {
          grid.setShuffle?.(move.to.x, move.to.y, move.to.z, 0);
        } else {
          let count = grid.getShuffle?.(move.to.x, move.to.y, move.to.z) ?? 0;
          let ox = grid.getShuffleOriginX?.(move.to.x, move.to.y, move.to.z) ?? 0;
          let oz = grid.getShuffleOriginZ?.(move.to.x, move.to.y, move.to.z) ?? 0;
          if (count <= 0) {
            ox = move.from.x;
            oz = move.from.z;
            count = 0;
          }
          count += 1;
          if (count >= effect.hops) {
            const span = Math.abs(move.to.x - ox) + Math.abs(move.to.z - oz);
            if (span <= effect.span) {
              grid.set(move.to.x, move.to.y, move.to.z, 0);
              clearCellMeta(grid, move.to.x, move.to.y, move.to.z, catalog);
              culled = true;
              break;
            }
            ox = move.to.x;
            oz = move.to.z;
            count = 1;
          }
          grid.setShuffle?.(move.to.x, move.to.y, move.to.z, count);
          grid.setShuffleOriginX?.(move.to.x, move.to.y, move.to.z, ox);
          grid.setShuffleOriginZ?.(move.to.x, move.to.y, move.to.z, oz);
        }
      } else if (effect.kind === "dryUnbounded" && effect.resetOn === "gainedTouch") {
        const before = countSameTouches(grid, move.from.x, move.from.y, move.from.z, move.mat);
        const after = countSameTouches(grid, move.to.x, move.to.y, move.to.z, move.mat);
        if (after > before) {
          setClock(grid, move.to.x, move.to.y, move.to.z, effect.clockId, 0);
          for (const [dx, dy, dz] of EFFECT_DIRS) {
            const nx = move.to.x + dx;
            const ny = move.to.y + dy;
            const nz = move.to.z + dz;
            if (!grid.inBounds(nx, ny, nz)) continue;
            if (grid.get(nx, ny, nz) === move.mat) setClock(grid, nx, ny, nz, effect.clockId, 0);
          }
        }
      }
    }
  }
  return culled;
}

/**
 * Tick age, sparse absorb, and unbounded drying. Writes the shrink flag.
 * @param {GridApi} grid
 * @param {{ x: number, y: number, z: number, mat: number, i?: number }[]} cells
 * @param {MaterialCatalog} catalog
 * @param {{ resting?: (i: number) => boolean, onFloor?: (i: number) => boolean, sameAbove?: (i: number) => boolean, above?: (i: number) => boolean }} queries
 * @param {number} dt
 * @returns {boolean}
 */
export function tickEffects(grid, cells, catalog, queries, dt) {
  if (!catalog || !(dt > 0) || !cells?.length) return false;
  let dirty = false;
  /** @type {{ x: number, y: number, z: number }[]} */
  const doomed = [];

  for (const cell of cells) {
    if (grid.get(cell.x, cell.y, cell.z) !== cell.mat) continue;
    const material = materialByIndex(catalog, cell.mat);
    const ctx = effectContext(grid, cell, catalog, queries);
    let matchedAge = false;
    let shrink = false;
    let shrinkT = 0;
    let rise = false;
    let riseT = 0;
    let riseElapsed = 0;
    const prevRise = grid.getRiseT?.(cell.x, cell.y, cell.z) ?? 0;
    const infection = grid.getInfection?.(cell.x, cell.y, cell.z) ?? 0;

    for (const effect of material?.effects || []) {
      if (effect.kind === "age") {
        if (!whenMatches(effect.when, ctx)) {
          const clockNow = getClock(grid, cell.x, cell.y, cell.z, effect.clockId);
          let keepRising = false;
          if (effect.visual === "rise" && clockNow > (effect.hold || 0)) {
            const relaxed = { ...effect.when };
            delete relaxed.resting;
            keepRising = whenMatches(relaxed, ctx);
          }
          if (!keepRising) {
            if (clockNow > 0) {
              setClock(grid, cell.x, cell.y, cell.z, effect.clockId, 0);
              dirty = true;
            }
            continue;
          }
        }
        matchedAge = true;
        let clock = getClock(grid, cell.x, cell.y, cell.z, effect.clockId) + dt;
        const baked = grid.getLife?.(cell.x, cell.y, cell.z) ?? 0;
        let limit = baked > 0 ? baked : effect.seconds;
        let slid = 0;
        if (effect.slideLifeAbove) {
          slid = grid.getShuffle?.(cell.x, cell.y, cell.z) ?? 0;
          const cap = grid.getBudget?.(cell.x, cell.y, cell.z) ?? 0;
          if (slid === 0 && stackAbove(grid, cell.x, cell.y, cell.z) > 0) {
            if (getClock(grid, cell.x, cell.y, cell.z, effect.clockId) > 0) {
              setClock(grid, cell.x, cell.y, cell.z, effect.clockId, 0);
              dirty = true;
            }
            continue;
          }
          if (cap > 0 && slid >= cap) {
            doomed.push(cell);
            dirty = true;
            continue;
          }
          if (cap > 0 && slid > 0) limit *= 1 - slid / cap;
        } else if (effect.slideUnits > 0) {
          slid = grid.getShuffle?.(cell.x, cell.y, cell.z) ?? 0;
          if (slid >= effect.slideUnits) {
            doomed.push(cell);
            dirty = true;
            continue;
          }
          limit *= 1 - slid / effect.slideUnits;
        }
        if (effect.visual === "rise") {
          const scale = effect.lifeScale > 0 ? effect.lifeScale : 1;
          const base = baked > 0 ? baked : effect.seconds;
          const hold = Math.max(0, effect.hold || 0);
          limit = hold + Math.max(1e-4, base * scale);
        }
        if (infection > 0) limit = Math.min(limit, infection);
        if (effect.thenClear && clock >= limit) {
          doomed.push(cell);
          dirty = true;
          continue;
        }
        setClock(grid, cell.x, cell.y, cell.z, effect.clockId, clock);
        if (effect.visual === "shrink" && slid === 0) {
          shrink = true;
          shrinkT = Math.max(shrinkT, limit > 0 ? Math.min(1, clock / limit) : 0);
          dirty = true;
        } else if (effect.visual === "rise" && slid === 0) {
          const hold = Math.min(effect.hold || 0, limit);
          if (clock > hold) {
            const span = Math.max(1e-4, limit - hold);
            const elapsed = Math.max(0, clock - hold);
            rise = true;
            riseT = Math.max(riseT, Math.min(1, elapsed / span));
            riseElapsed = Math.max(riseElapsed, elapsed);
          }
        }
      } else if (effect.kind === "absorbSparse") {
        if (!whenMatches(effect.when, ctx)) {
          if (getClock(grid, cell.x, cell.y, cell.z, effect.clockId) > 0) {
            setClock(grid, cell.x, cell.y, cell.z, effect.clockId, 0);
          }
          continue;
        }
        if (ctx.sameNeighbors < effect.minNeighbors) {
          const onOpenFloor = catalog.floor === "liquid" && cell.y === 0;
          if (!onOpenFloor && hasEmptyFace(grid, cell.x, cell.y, cell.z)) {
            if (getClock(grid, cell.x, cell.y, cell.z, effect.clockId) > 0) {
              setClock(grid, cell.x, cell.y, cell.z, effect.clockId, 0);
            }
          } else {
            const clock = getClock(grid, cell.x, cell.y, cell.z, effect.clockId) + dt;
            if (clock >= effect.seconds) doomed.push(cell);
            else setClock(grid, cell.x, cell.y, cell.z, effect.clockId, clock);
            dirty = true;
          }
        } else if (getClock(grid, cell.x, cell.y, cell.z, effect.clockId) > 0) {
          setClock(grid, cell.x, cell.y, cell.z, effect.clockId, 0);
        }
      } else if (effect.kind === "dryUnbounded") {
        if (!whenMatches(effect.when, ctx) || ctx.boundedCatchment) {
          if (getClock(grid, cell.x, cell.y, cell.z, effect.clockId) > 0) {
            setClock(grid, cell.x, cell.y, cell.z, effect.clockId, 0);
            dirty = true;
          }
          continue;
        }
        const clock = getClock(grid, cell.x, cell.y, cell.z, effect.clockId) + dt;
        if (clock >= effect.seconds) {
          doomed.push(cell);
          dirty = true;
        } else {
          setClock(grid, cell.x, cell.y, cell.z, effect.clockId, clock);
        }
      }
    }

    if (!matchedAge && infection > 0) {
      const age = (grid.getInfectionAge?.(cell.x, cell.y, cell.z) ?? 0) + dt;
      if (age >= infection) {
        doomed.push(cell);
        dirty = true;
      } else {
        grid.setInfectionAge?.(cell.x, cell.y, cell.z, age);
        shrink = true;
        shrinkT = Math.max(shrinkT, infection > 0 ? Math.min(1, age / infection) : 0);
        dirty = true;
      }
    } else if ((grid.getInfectionAge?.(cell.x, cell.y, cell.z) ?? 0) > 0) {
      grid.setInfectionAge?.(cell.x, cell.y, cell.z, 0);
    }

    grid.setShrink?.(cell.x, cell.y, cell.z, shrink, shrink ? shrinkT : 0);
    if (rise || prevRise > 0) dirty = true;
    grid.setRise?.(cell.x, cell.y, cell.z, rise, rise ? riseT : 0, rise ? riseElapsed : 0);
  }

  for (const cell of doomed) {
    if (grid.get(cell.x, cell.y, cell.z) <= 0) continue;
    grid.set(cell.x, cell.y, cell.z, 0);
    clearCellMeta(grid, cell.x, cell.y, cell.z, catalog);
    dirty = true;
  }
  return dirty;
}
