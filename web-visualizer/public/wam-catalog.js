/**
 * Face-button FX catalog: native approximations + known WAM stick maps
 * and per-slot shortlists for the FX dropdown.
 * Vendored plugins are discovered at runtime via GET /api/wams.
 */

import { OWL_SHIMMER_PARAMS, setWamParam } from "./wam-host.js?v=3";

/** @typedef {'cross' | 'square' | 'triangle' | 'circle'} FxSlot */

/** @type {Record<FxSlot, { id: string, label: string, kind: 'native' }>} */
export const NATIVE_FX = {
  cross: { id: "native:cross", label: "Saturn 2", kind: "native" },
  square: { id: "native:square", label: "Comb Filter", kind: "native" },
  triangle: { id: "native:triangle", label: "Formant Filter", kind: "native" },
  circle: { id: "native:circle", label: "Crystallizer", kind: "native" },
};

/**
 * Preferred plugin paths (under /wams/) shown in each face-button dropdown.
 * Only entries that are actually vendored appear in the menu.
 */
export const SLOT_WAM_PATHS = {
  cross: [
    "wimmics/temper/index.js",
    "burns-audio/distortion/index.js",
    "wimmics/quadrafuzz/dist/index.js",
  ],
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

/**
 * Stick → param maps for known vendored WAMs (keyed by plugin path under /wams/).
 * Unknown WAMs get a no-op apply (still audible through the plugin defaults).
 */
export const WAM_STICK_MAPS = {
  "wimmics/OwlShimmer/index.js": (audioNode, x, y) => {
    if (!audioNode) return;
    const shimmer = Math.min(0.7, 0.08 + clamp01(1 - x) * 0.62);
    const decay = 0.5 + clamp01(y) * 0.5;
    const mix = 0.55 + clamp01(y) * 0.4;
    const tone = 1600 + clamp01(x) * 5400;
    setWamParam(audioNode, OWL_SHIMMER_PARAMS.shimmer, shimmer);
    setWamParam(audioNode, OWL_SHIMMER_PARAMS.decay, decay);
    setWamParam(audioNode, OWL_SHIMMER_PARAMS.mix, mix);
    setWamParam(audioNode, OWL_SHIMMER_PARAMS.tone, tone);
    setWamParam(audioNode, OWL_SHIMMER_PARAMS.bypass, 0);
  },
};

function clamp01(n) {
  return Math.min(1, Math.max(0, Number(n) || 0));
}

/**
 * @param {string} pluginPath
 * @returns {(node: object, x: number, y: number) => void}
 */
export function stickMapForPath(pluginPath) {
  return WAM_STICK_MAPS[pluginPath] || (() => {});
}

/**
 * @param {FxSlot} slot
 * @param {{ path: string }} plugin
 */
export function pluginFitsSlot(slot, plugin) {
  const allow = SLOT_WAM_PATHS[slot];
  if (!allow?.length) return true;
  const p = String(plugin.path || "").replace(/\\/g, "/");
  return allow.includes(p);
}

/**
 * Default assignment when browser audio starts.
 * @type {Record<FxSlot, string>}
 */
export const DEFAULT_FX_IDS = {
  cross: NATIVE_FX.cross.id,
  square: NATIVE_FX.square.id,
  triangle: NATIVE_FX.triangle.id,
  circle: "wam:wimmics/OwlShimmer",
};
