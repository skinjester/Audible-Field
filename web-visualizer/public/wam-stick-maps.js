/**
 * Hand-editable per-WAM stick bindings.
 *
 * Each entry:
 * - params: full list of continuous params (id, label, min, max, default)
 * - x: param ids driven by stick X (0–1 → min–max × scale)
 * - y: param ids driven by stick Y
 * - forceOff: params forced to 0 while the WAM is active (bypass, etc.)
 *
 * Edit x / y arrays to change what the thumbstick controls.
 * Params not in x/y keep their `default` (applied once on load).
 *
 * Seeded from runtime getParameterInfo (scripts/probe-wam-params.mjs).
 * Regenerate probe with: node scripts/probe-wam-params.mjs
 */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   min: number,
 *   max: number,
 *   default: number,
 * }} WamParamDef
 *
 * @typedef {{
 *   name: string,
 *   params: WamParamDef[],
 *   x: string[],
 *   y: string[],
 *   forceOff?: string[],
 * }} WamStickMap
 */

/** @type {Record<string, WamStickMap>} */
export const WAM_STICK_MAPS = {
  "burns-audio/reverb/index.js": {
    name: "Microverb",
    params: [{ id: "wet", label: "wet", min: 0, max: 1, default: 0.3 }],
    x: ["wet"],
    y: [],
  },

  "burns-audio/distortion/index.js": {
    name: "Simple Distortion",
    params: [
      { id: "overdrive", label: "overdrive", min: 1, max: 10, default: 1 },
      { id: "flavor", label: "flavor", min: 0, max: 1, default: 0 },
      { id: "level", label: "level", min: 0, max: 2, default: 1 },
      { id: "offset", label: "offset", min: 0, max: 1, default: 0 },
    ],
    x: ["overdrive"],
    y: ["flavor"],
  },

  "wimmics/DualPitchShifter/index.js": {
    name: "DualPitchShifter",
    params: [
      { id: "/DualPitchShifter/ShiftL", label: "ShiftL", min: -12, max: 12, default: 0 },
      { id: "/DualPitchShifter/ShiftR", label: "ShiftR", min: -12, max: 12, default: 0 },
      { id: "/DualPitchShifter/Mix", label: "Mix", min: 0, max: 1, default: 0.5 },
      { id: "/DualPitchShifter/WindowSize", label: "WindowSize", min: 20, max: 1000, default: 50 },
      { id: "/DualPitchShifter/bypass", label: "bypass", min: 0, max: 1, default: 0 },
    ],
    x: ["/DualPitchShifter/ShiftL", "/DualPitchShifter/ShiftR"],
    y: ["/DualPitchShifter/Mix"],
    forceOff: ["/DualPitchShifter/bypass"],
  },

  "wimmics/graphicEqualizer/index.js": {
    name: "GraphicEqualizer",
    // Stick uses mid peaking band only; other bands stay at defaults.
    // Gain clamped to ±12 dB for usable stick range (native AudioParam max is huge).
    params: [
      { id: "enabled", label: "enabled", min: 0, max: 1, default: 1 },
      { id: "peaking_2_frequency", label: "low-mid freq", min: 80, max: 800, default: 230 },
      { id: "peaking_2_gain", label: "low-mid gain", min: -12, max: 12, default: 0 },
      { id: "peaking_3_frequency", label: "high-mid freq", min: 800, max: 6000, default: 2500 },
      { id: "peaking_3_gain", label: "high-mid gain", min: -12, max: 12, default: 0 },
      { id: "peaking_4_frequency", label: "presence freq", min: 2000, max: 10000, default: 5000 },
      { id: "peaking_4_gain", label: "presence gain", min: -12, max: 12, default: 0 },
    ],
    x: ["peaking_3_frequency"],
    y: ["peaking_3_gain"],
  },

  "wimmics/greyhole/index.js": {
    name: "Grey Hole",
    params: [
      { id: "/greyhole/delayTime", label: "delayTime", min: 0.001, max: 1.45, default: 0.2 },
      { id: "/greyhole/size", label: "size", min: 0.5, max: 3, default: 1 },
      { id: "/greyhole/feedback", label: "feedback", min: 0, max: 1, default: 0.9 },
      { id: "/greyhole/diffusion", label: "diffusion", min: 0, max: 0.99, default: 0.5 },
      { id: "/greyhole/damping", label: "damping", min: 0, max: 0.99, default: 0 },
      { id: "/greyhole/modDepth", label: "modDepth", min: 0, max: 1, default: 0.1 },
      { id: "/greyhole/modFreq", label: "modFreq", min: 0, max: 10, default: 2 },
      { id: "/greyhole/bypass", label: "bypass", min: 0, max: 1, default: 0 },
    ],
    x: ["/greyhole/size", "/greyhole/delayTime"],
    y: ["/greyhole/feedback", "/greyhole/diffusion"],
    forceOff: ["/greyhole/bypass"],
  },

  "wimmics/OwlDirty/index.js": {
    name: "OwlDirty",
    params: [
      { id: "/OwlDirty/DRIVE", label: "DRIVE", min: 0, max: 0.7, default: 0 },
      { id: "/OwlDirty/TONE", label: "TONE", min: 900, max: 8000, default: 4000 },
      { id: "/OwlDirty/DECAY", label: "DECAY", min: 0.5, max: 1, default: 0.7 },
      { id: "/OwlDirty/MIX", label: "MIX", min: 0, max: 1, default: 0.75 },
      { id: "/OwlDirty/bypass", label: "bypass", min: 0, max: 1, default: 0 },
    ],
    x: ["/OwlDirty/DRIVE", "/OwlDirty/TONE"],
    y: ["/OwlDirty/DECAY", "/OwlDirty/MIX"],
    forceOff: ["/OwlDirty/bypass"],
  },

  "wimmics/OwlShimmer/index.js": {
    name: "OWLShimmer",
    params: [
      { id: "/untitled/SHIMMER", label: "SHIMMER", min: 0, max: 0.7, default: 0.3 },
      { id: "/untitled/TONE", label: "TONE", min: 900, max: 8000, default: 4000 },
      { id: "/untitled/DECAY", label: "DECAY", min: 0.5, max: 1, default: 0.7 },
      { id: "/untitled/MIX", label: "MIX", min: 0, max: 1, default: 0.75 },
      { id: "/untitled/bypass", label: "bypass", min: 0, max: 1, default: 0 },
    ],
    // Matches prior Crystallizer-adjacent mapping: X = shimmer/tone, Y = decay/mix
    x: ["/untitled/SHIMMER", "/untitled/TONE"],
    y: ["/untitled/DECAY", "/untitled/MIX"],
    forceOff: ["/untitled/bypass", "/OwlShimmer/bypass"],
  },

  "wimmics/pingpongdelay/dist/index.js": {
    name: "PingPongDelay",
    params: [
      { id: "time", label: "time", min: 0, max: 1, default: 0.5 },
      { id: "feedback", label: "feedback", min: 0, max: 1, default: 0.5 },
      { id: "mix", label: "mix", min: 0, max: 1, default: 0.5 },
      { id: "enabled", label: "enabled", min: 0, max: 1, default: 1 },
    ],
    x: ["time"],
    y: ["feedback"],
  },

  "wimmics/quadrafuzz/dist/index.js": {
    name: "QuadraFuzz",
    params: [
      { id: "lowGain", label: "lowGain", min: 0, max: 1, default: 0.6 },
      { id: "midLowGain", label: "midLowGain", min: 0, max: 1, default: 0.8 },
      { id: "midHighGain", label: "midHighGain", min: 0, max: 1, default: 0.5 },
      { id: "highGain", label: "highGain", min: 0, max: 1, default: 0.5 },
      { id: "enabled", label: "enabled", min: 0, max: 1, default: 1 },
    ],
    x: ["lowGain", "midLowGain"],
    y: ["midHighGain", "highGain"],
  },

  "wimmics/stonephaser/index.js": {
    name: "StonePhaser",
    params: [
      { id: "/untitled/LFO frequency", label: "LFO frequency", min: 0.01, max: 5, default: 0.2 },
      { id: "/untitled/Feedback depth", label: "Feedback depth", min: 0, max: 99, default: 75 },
      { id: "/untitled/Dry/wet mix", label: "Dry/wet mix", min: 0, max: 100, default: 50 },
      { id: "/untitled/Color", label: "Color", min: 0, max: 1, default: 1 },
      { id: "/untitled/Feedback bass cut", label: "Feedback bass cut", min: 10, max: 5000, default: 500 },
      { id: "/untitled/Bypass", label: "Bypass", min: 0, max: 1, default: 0 },
    ],
    x: ["/untitled/LFO frequency"],
    y: ["/untitled/Feedback depth"],
    forceOff: ["/untitled/Bypass"],
  },

  "wimmics/sweetWah/index.js": {
    name: "SweetWah",
    params: [
      { id: "/Sweet/Frequency", label: "Frequency", min: 0, max: 12, default: 4 },
      { id: "/Sweet/Mix", label: "Mix", min: 0, max: 1, default: 0.5 },
      { id: "/Sweet/Low", label: "Low", min: 0, max: 1, default: 0.8 },
      { id: "/Sweet/High", label: "High", min: 0, max: 1, default: 0.8 },
      { id: "/Sweet/bypass", label: "bypass", min: 0, max: 1, default: 0 },
    ],
    x: ["/Sweet/Frequency"],
    y: ["/Sweet/Mix"],
    forceOff: ["/Sweet/bypass"],
  },

  "wimmics/temper/index.js": {
    name: "Temper",
    params: [
      { id: "/temper/Drive", label: "Drive", min: -10, max: 10, default: 4 },
      { id: "/temper/Cutoff", label: "Cutoff", min: 100, max: 20000, default: 20000 },
      { id: "/temper/Resonance", label: "Resonance", min: 1, max: 8, default: 1 },
      { id: "/temper/Saturation", label: "Saturation", min: 0, max: 1, default: 1 },
      { id: "/temper/Curve", label: "Curve", min: 0.1, max: 4, default: 1 },
      { id: "/temper/Level", label: "Level", min: -24, max: 24, default: -3 },
      { id: "/temper/Feedback", label: "Feedback", min: -60, max: -24, default: -60 },
      { id: "/temper/99_bypass", label: "bypass", min: 0, max: 1, default: 0 },
    ],
    x: ["/temper/Drive"],
    y: ["/temper/Cutoff", "/temper/Resonance"],
    forceOff: ["/temper/99_bypass"],
  },

  "wimmics/ThruZeroFlanger/index.js": {
    name: "ThruZeroFlanger",
    params: [
      { id: "/ThruZeroFlanger/Rate", label: "Rate", min: 0, max: 1, default: 0.1 },
      { id: "/ThruZeroFlanger/Depth", label: "Depth", min: 3, max: 100, default: 20 },
      { id: "/ThruZeroFlanger/Delay", label: "Delay", min: 0.5, max: 20, default: 10 },
      { id: "/ThruZeroFlanger/L-ROffset", label: "L-ROffset", min: 0, max: 1, default: 0 },
      { id: "/ThruZeroFlanger/bypass", label: "bypass", min: 0, max: 1, default: 0 },
    ],
    x: ["/ThruZeroFlanger/Rate"],
    y: ["/ThruZeroFlanger/Depth"],
    forceOff: ["/ThruZeroFlanger/bypass"],
  },

  "wimmics/WeirdPhaser/index.js": {
    name: "WeirdPhaser",
    params: [
      { id: "/weirdPhaser/Rate", label: "Rate", min: 0, max: 1, default: 0 },
      { id: "/weirdPhaser/Feedback", label: "Feedback", min: 0, max: 1, default: 0 },
      { id: "/weirdPhaser/RateScalar", label: "RateScalar", min: 1, max: 40, default: 1 },
      { id: "/weirdPhaser/L-ROffset", label: "L-ROffset", min: 0, max: 1, default: 0 },
      { id: "/weirdPhaser/bypass", label: "bypass", min: 0, max: 1, default: 0 },
    ],
    x: ["/weirdPhaser/Rate"],
    y: ["/weirdPhaser/Feedback"],
    forceOff: ["/weirdPhaser/bypass"],
  },
};

/**
 * @param {string} pluginPath
 * @returns {WamStickMap | null}
 */
export function getWamStickMap(pluginPath) {
  if (!pluginPath) return null;
  const key = String(pluginPath).replace(/^\/+/, "").replace(/^wams\//, "");
  return WAM_STICK_MAPS[key] || null;
}
