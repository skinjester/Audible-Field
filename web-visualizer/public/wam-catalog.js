/**
 * Face-button FX catalog: native approximations + per-slot WAM shortlists.
 * Stick→param bindings live in wam-stick-maps.js (hand-editable per WAM).
 */

/** @typedef {'cross' | 'square' | 'triangle' | 'circle'} FxSlot */

/** @type {Record<FxSlot, { id: string, label: string, kind: 'native' }>} */
export const NATIVE_FX = {
  cross: { id: "native:cross", label: "Saturn 2", kind: "native" },
  square: { id: "native:square", label: "Comb Filter", kind: "native" },
  triangle: { id: "native:triangle", label: "Formant Filter", kind: "native" },
  circle: { id: "native:circle", label: "Crystallizer", kind: "native" },
};

/**
 * Preferred plugin paths (under /wams/) — docs / legacy; pickers list all vendored WAMs.
 */
export const SLOT_WAM_PATHS = {
  cross: [],
  square: [
    "wimmics/ThruZeroFlanger/index.js",
    "wimmics/stonephaser/index.js",
    "wimmics/WeirdPhaser/index.js",
    "wimmics/pingpongdelay/dist/index.js",
  ],
  triangle: [
    "wimmics/sweetWah/index.js",
    "wimmics/DualPitchShifter/index.js",
    "wimmics/graphicEqualizer/index.js",
  ],
  circle: [
    "wimmics/OwlShimmer/index.js",
    "wimmics/DualPitchShifter/index.js",
    "wimmics/OwlDirty/index.js",
    "wimmics/greyhole/index.js",
  ],
};

/** Diagnostics field: multiplier at full +stick. Live multiplier is 1 at rest. */
export const DEFAULT_STICK_SCALE = 1;
export const STICK_SCALE_STEP = 0.1;
/** A max of 1 holds the live multiplier at 1 (neutral stick does nothing). */
export const STICK_SCALE_MIN = 1;

/**
 * Default assignment when browser audio starts.
 * @type {Record<FxSlot, string>}
 */
export const DEFAULT_FX_IDS = {
  cross: NATIVE_FX.cross.id,
  square: NATIVE_FX.square.id,
  triangle: NATIVE_FX.triangle.id,
  circle: NATIVE_FX.circle.id,
};
