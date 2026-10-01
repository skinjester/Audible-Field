/**
 * Quadrant sonification.
 * Footprint (ground cells occupied) sets each sample's level.
 * Stack height opens the dry bed. A short pile stays dark and warm. It keeps brightening until the stack is about 6 world units tall.
 * Rising Diffuse grains open that bed's Greyhole send, fully by 2.5 world units, and the feedback jumps to the long diffuse tail as soon as they lift. Delay time and size stay fixed.
 * Greyhole stays closed: moving its delay with the stack was glitching playback.
 * More ground covered opens that sample's low-pass.
 * Closer to the center of its quadrant raises that sample's pitch, up to an octave.
 * Rising Diffuse grains raise it further, another octave by the top of the field.
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
/**
 * Pile height and rising grains open each stem's Greyhole send.
 * Off for now: Greyhole rewrites delayTime as that send moves, and the crossfade glitches.
 */
const HEIGHT_REVERB = false;
/** World-unit resting stack that fully opens the dry-bed EQ. Taller than this stays full-range. */
const STACK_EQ_FULL = 6;
/** Short pile. Tall pile reaches the open low-pass. */
const HEIGHT_LP_LOW = 420;
const HEIGHT_LP_HIGH = 16000;
/**
 * Drawn altitude (world units) that fully opens the Diffuse Greyhole send.
 * The first lift already raises it; 2.5 is full, the same range as the main-branch rise.
 */
const RISE_FULL = 2.5;
/** Drawn altitude where rising Diffuse grains have raised the bed by an octave. */
const RISE_PITCH_TOP = 12;
/** Greyhole feedback for a rising Diffuse tail. Just under runaway, same as the main branch. */
const FEEDBACK_MAX = 0.98;
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

/** Resting stack opens the top of the bed. */
function heightCutoff(amount) {
  const a = clamp01(amount);
  return HEIGHT_LP_LOW * Math.pow(HEIGHT_LP_HIGH / HEIGHT_LP_LOW, a);
}

const gains = { tl: 0, tr: 0, bl: 0, br: 0 };
const heights = { tl: 0, tr: 0, bl: 0, br: 0 };
/** 0..1 throw of Greyhole decay. 1 is the very long rising tail. */
const decays = { tl: 0, tr: 0, bl: 0, br: 0 };
const longTails = { tl: false, tr: false, bl: false, br: false };
/** Holds the long tail after rising grains have cleared. */
const riseLatch = { tl: false, tr: false, bl: false, br: false };
const pitches = { tl: 1, tr: 1, bl: 1, br: 1 };
/** 0..1 short hall from the resting stack. */
const halls = { tl: 0, tr: 0, bl: 0, br: 0 };
/** 0..1 mid bump from the resting stack. Rising grains do not move this. */
const resonances = { tl: 0, tr: 0, bl: 0, br: 0 };
/** 0..1 Greyhole send from rising Diffuse grains. The resting stack does not open it. */
const diffuses = { tl: 0, tr: 0, bl: 0, br: 0 };
/** Greyhole feedback for that rise. Hits the long tail immediately, then rings after the grains land. */
const feedbacks = { tl: 0, tr: 0, bl: 0, br: 0 };
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
    halls[id] = 0;
    resonances[id] = 0;
    diffuses[id] = 0;
    feedbacks[id] = 0;
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
    const stackNorm = clamp01(Number.isFinite(Number(quad.stack)) ? quad.stack : height);
    const stackWorld = stackNorm * 12;
    const stackOpen = coverage <= 0 ? 0 : clamp01(Math.pow(stackNorm / (2.5 / 12), 0.45));
    const stackEq = coverage <= 0 ? 0 : clamp01(stackWorld / STACK_EQ_FULL);
    const riseTip = Math.max(0, Number(quad.rise) || 0);
    const rising = riseTip > 0;
    const riseOpen = rising ? clamp01(Math.pow(riseTip / RISE_FULL, 0.55)) : 0;
    let feedbackTarget = 0;
    let feedbackTau = 0.35;
    if (rising) {
      feedbackTarget = FEEDBACK_MAX;
      feedbackTau = DECAY_ATTACK;
    } else if (riseLatch[id]) {
      feedbackTarget = 0;
      feedbackTau = DECAY_RELEASE;
      if (feedbacks[id] < 0.04) riseLatch[id] = false;
    }
    feedbacks[id] = follow(feedbacks[id], feedbackTarget, dt, feedbackTau);
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
    }
    longTails[id] = rising || riseLatch[id];
    gains[id] = gainTarget <= 0 ? 0 : follow(gains[id], gainTarget, dt, 0.08);
    heights[id] = reverbTarget <= 0 ? 0 : follow(heights[id], reverbTarget, dt, rising ? 0.12 : 0.25);
    decays[id] = follow(decays[id], decayTarget, dt, decayTau);
    halls[id] = 0;
    resonances[id] = stackEq <= 0 ? 0 : follow(resonances[id], stackEq, dt, 0.2);
    diffuses[id] = follow(diffuses[id], riseOpen, dt, rising ? 0.12 : 0.25);
    cutoffs[id] = Math.min(cutoffHz(gains[id]), heightCutoff(resonances[id]));
    const rateTarget = Number(quad.rate);
    const positionRate = Number.isFinite(rateTarget) && rateTarget > 0 ? rateTarget : 1;
    const risePitch = Math.pow(2, clamp01(riseTip / RISE_PITCH_TOP));
    pitches[id] = follow(pitches[id], positionRate * risePitch, dt, rising ? 0.08 : 0.2);
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
    reverbs: HEIGHT_REVERB ? heights : { tl: 0, tr: 0, bl: 0, br: 0 },
    decays: HEIGHT_REVERB ? decays : { tl: 0, tr: 0, bl: 0, br: 0 },
    longTails: HEIGHT_REVERB ? longTails : { tl: false, tr: false, bl: false, br: false },
    halls,
    resonances,
    diffuses,
    feedbacks,
    pans: snap?.pans || { tl: 0, tr: 0, bl: 0, br: 0 },
    splash,
    controller: DRY_BEDS,
  };
}
