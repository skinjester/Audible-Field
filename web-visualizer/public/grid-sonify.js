/**
 * Quadrant sonification.
 * Footprint (ground cells occupied) sets each sample's level.
 * Maximum column height opens that sample's Greyhole send.
 * Diffuse grains that are rising add their drawn altitude to that height, and the
 * Greyhole tail goes to a very long decay for as long as the rise is in the air.
 * More ground covered opens that sample's low-pass.
 * Closer to the center of its quadrant raises that sample's pitch, up to an octave.
 * Farther from that center lowers it, down to the sample's own pitch at the corners.
 * A landing repeats that quadrant's sample through a filter sweep lasting the ground-ring splash,
 * at the pitch of the cell that landed. Face WAMs stay off.
 */

const CORNERS = ["tl", "tr", "bl", "br"];
/** Few occupied cells sit here. A wide pour reaches the open cutoff. */
const LPF_FEW = 1100;
const LPF_MANY = 20000;

function clamp01(n) {
  return Math.min(1, Math.max(0, Number(n) || 0));
}

function follow(current, target, dt, tau) {
  if (!(dt > 0)) return current;
  const a = 1 - Math.exp(-dt / tau);
  return current + (target - current) * a;
}

/** Share of a quadrant that reaches full level. One wide pour is about this much ground. */
const FOOTPRINT_FULL = 0.045;
/** Below 1, small patches stay audible while a single column stays quieter than a wide pile. */
const FOOTPRINT_CURVE = 0.55;
/** World-unit stack that counts as full reverb. Taller than this stays fully wet. */
const HEIGHT_OPEN = 2.5 / 12;
/**
 * Drawn altitude (world units) of rising grains that fully opens the send.
 * A climb through this range is the height parameter for the rise.
 */
const RISE_FULL = 2.5;
/** How fast the long tail engages once grains start rising. */
const DECAY_ATTACK = 0.12;
/** How long the long tail keeps ringing after the rise is gone. */
const DECAY_RELEASE = 14;

function footprintGain(coverage) {
  if (!(coverage > 0)) return 0;
  return clamp01(Math.pow(coverage / FOOTPRINT_FULL, FOOTPRINT_CURVE));
}

/** More of the quadrant filled → higher cutoff. */
function cutoffHz(amount) {
  const a = clamp01(amount);
  return LPF_FEW * Math.pow(LPF_MANY / LPF_FEW, a);
}

const gains = { tl: 0, tr: 0, bl: 0, br: 0 };
const heights = { tl: 0, tr: 0, bl: 0, br: 0 };
/** 0..1 throw of Greyhole decay. 1 is the very long rising tail. */
const decays = { tl: 0, tr: 0, bl: 0, br: 0 };
const longTails = { tl: false, tr: false, bl: false, br: false };
/** Holds the long tail after rising grains have cleared. */
const riseLatch = { tl: false, tr: false, bl: false, br: false };
const pitches = { tl: 1, tr: 1, bl: 1, br: 1 };
let gen = -1;

function hitLife(hit) {
  if (typeof hit === "number") return hit;
  return Number(hit?.life) || 0;
}

const DRY_BEDS = {
  activeFx: "cross",
  rawX: 0,
  rawY: 0,
  rightX: 0,
  rightY: 0,
  lt: 0,
  rt: 0,
  l1: false,
  r1: false,
  ls: false,
  rs: false,
  fx: {
    cross: { x: 0, y: 0 },
    square: { x: 0, y: 0 },
    triangle: { x: 0, y: 0 },
    circle: { x: 0, y: 0 },
  },
};

export function resetFieldSonify() {
  for (const id of CORNERS) {
    gains[id] = 0;
    heights[id] = 0;
    decays[id] = 0;
    riseLatch[id] = false;
    pitches[id] = 1;
  }
  gen = -1;
}

/**
 * @param {object} snap
 * @param {number} dt
 */
export function fieldFrame(snap, dt) {
  const quads = snap?.quads || {};
  const cutoffs = { tl: LPF_FEW, tr: LPF_FEW, bl: LPF_FEW, br: LPF_FEW };
  for (const id of CORNERS) {
    const quad = quads[id] || {};
    const coverage = clamp01(quad.coverage);
    const height = clamp01(quad.height);
    const gainTarget = footprintGain(coverage);
    const stackOpen = coverage <= 0 ? 0 : clamp01(height / HEIGHT_OPEN);
    const riseTip = Math.max(0, Number(quad.rise) || 0);
    const rising = riseTip > 0;
    // Rising altitude is the height parameter: the send opens as those grains climb.
    // A gentle curve so the first lift already raises the height parameter, then the climb fills it.
    const riseOpen = rising ? clamp01(Math.pow(riseTip / RISE_FULL, 0.55)) : 0;
    const reverbTarget = Math.max(stackOpen, riseOpen);
    if (rising) riseLatch[id] = true;
    let decayTarget = reverbTarget;
    let decayTau = 0.25;
    if (rising) {
      decayTarget = 1;
      decayTau = DECAY_ATTACK;
    } else if (riseLatch[id]) {
      decayTarget = reverbTarget;
      decayTau = DECAY_RELEASE;
      if (decays[id] - reverbTarget < 0.04) riseLatch[id] = false;
    }
    longTails[id] = rising || riseLatch[id];
    gains[id] = gainTarget <= 0 ? 0 : follow(gains[id], gainTarget, dt, 0.08);
    heights[id] = reverbTarget <= 0 ? 0 : follow(heights[id], reverbTarget, dt, rising ? 0.12 : 0.25);
    decays[id] = follow(decays[id], decayTarget, dt, decayTau);
    cutoffs[id] = cutoffHz(gains[id]);
    const rateTarget = Number(quad.rate);
    const nextRate = Number.isFinite(rateTarget) && rateTarget > 0 ? rateTarget : 1;
    pitches[id] = follow(pitches[id], nextRate, dt, 0.12);
  }

  let splash = null;
  const nextGen = Number(snap?.gen) || 0;
  if (nextGen !== gen) {
    gen = nextGen;
    const hits = snap?.splash || {};
    const lives = {};
    let any = 0;
    for (const id of CORNERS) {
      const list = Array.isArray(hits[id]) ? hits[id].filter((hit) => hitLife(hit) > 0) : [];
      if (list.length) {
        lives[id] = list;
        any += list.length;
      }
    }
    if (any > 0) splash = lives;
  }

  return {
    gains,
    cutoffs,
    rates: pitches,
    reverbs: heights,
    decays,
    longTails,
    pans: snap?.pans || { tl: 0, tr: 0, bl: 0, br: 0 },
    splash,
    controller: DRY_BEDS,
  };
}
