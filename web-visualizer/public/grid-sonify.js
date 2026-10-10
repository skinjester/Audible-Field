/**
 * Quadrant sonification.
 * Footprint (ground cells occupied) sets each sample's level and opens its low-pass.
 * A single column stays near 7 kHz. A wide pour opens toward 20 kHz.
 * Each pile's resting height is weight on that stem: darker, a low shelf, and a soft clip.
 * Full weight is 10 atoms (2.5 world units). Taller than that stays pinned. Rising grains do not add weight.
 * Rising Diffuse grains open that bed's Greyhole send. The altitude is the average height of the cluster that holds the most of them, fully open at 10 world units, so one grain above that cluster does not open the mix by itself. Feedback follows that same climb and reaches the long tail only as the cluster gets there. The send is then scaled by how much rising mass is in the quadrant: one full-size atom is already a clear fraction, and more atoms, counted by their drawn size, fill the rest. Delay time and size stay fixed. The send is taken before the weight filters. After the last grain is gone the tail keeps ringing; only a quadrant that was not holding that tail drops quickly.
 * Greyhole stays off the resting stack: moving its delay with the stack was glitching playback.
 * Each connected pile plays that quadrant's sample as its own note.
 * The note is the pitch at the pile's center: an octave up at the quadrant center, the sample's own pitch at the corners.
 * A gap that splits a mass adds a note. Piles that touch again become one note.
 * Rising Diffuse grains do not change pitch.
 * A landing is one event for that pile, at the pile's pitch. Each ring gets a glint.
 * The phrase opens with the first ring and ends soon after the last one fades. Face WAMs stay off.
 */

const CORNERS = ["tl", "tr", "bl", "br"];
/**
 * Few occupied cells sit here. A wide pour reaches the open cutoff.
 * One column has to stay above the heavy weight low-pass (2.5 kHz), or a tower cannot get darker than a short stack.
 */
const LPF_FEW = 6000;
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
 * Resting height used to open each stem's Greyhole send.
 * Off: that send is the rising tail only, and moving delayTime with a level glitches.
 */
const HEIGHT_REVERB = false;
/** Resting stack, in world units, that reaches full weight. 10 atoms at 0.25. Taller stays pinned. */
const WEIGHT_FULL_U = 2.5;
/** Above 1, the first atoms stay light and a tower past 8 atoms is still getting heavier. */
const WEIGHT_CURVE = 1.15;
/** quad.stack is normalized to the field height. */
const STACK_FIELD_U = 12;
/**
 * Drawn altitude (world units) that fully opens the Diffuse Greyhole send.
 * This is the average height of the busiest rising cluster, not the single highest grain.
 * The playfield is 12. Full open stays near the top of that climb, so a cluster
 * that has only risen a few units is not already pinned at the ceiling.
 */
const RISE_FULL = 10;
/**
 * Below 1, a mid climb is already a clear reverb and the rest of the rise still opens it.
 * 1 is linear with height. Above 1 holds the mix back until the cluster is high.
 */
const RISE_CURVE = 0.55;
/** Greyhole feedback at a fully risen cluster. Just under runaway, same as the main branch. */
const FEEDBACK_MAX = 0.98;
/** How quickly the send and feedback catch the climb. The target itself moves with the grains. */
const DECAY_ATTACK = 0.45;
/** How long the long tail keeps ringing after the rise is gone, including after the last atom despawns. */
const DECAY_RELEASE = 14;
/** Quadrant that was not holding a diffuse tail. Feedback and the wet return fall on this time constant. */
const EMPTY_TAIL = 0.25;
/** How the dry bed lets go after the last diffuse atom. The reverb send is after this gain, so the same fade is what the tail still hears. */
const BED_RING = 2.6;
/** After this, the corner's reverb, send, and held notes are shut off so the next pile does not inherit a live tank. */
const RING_LIMIT = 3.4;
/** Settings switch. Off closes the Diffuse Greyhole send, feedback, and wet return. */
let diffuseReverb = false;

export function setDiffuseReverb(enabled) {
  diffuseReverb = !!enabled;
}
/**
 * Rising mass that fills the rest of the send after the single-atom floor.
 * Mass is the sum of drawn scales, so one full atom is 1 and a shrinking atom counts for less.
 */
const RISE_CROWD = 3.5;

/** Send share for the rising mass. One full-size atom is already audible. A crowd approaches 1. */
function riseCrowd(mass) {
  if (!(mass > 0)) return 0;
  const one = Math.min(1, mass);
  const crowd = 1 - Math.exp(-mass / RISE_CROWD);
  return clamp01(0.46 * one + 0.54 * crowd);
}

function footprintGain(coverage) {
  if (!(coverage > 0)) return 0;
  return clamp01(Math.pow(coverage / FOOTPRINT_FULL, FOOTPRINT_CURVE));
}

/** More of the quadrant filled → higher cutoff. */
function cutoffHz(amount) {
  const a = clamp01(amount);
  return LPF_FEW * Math.pow(LPF_MANY / LPF_FEW, a);
}

/** Resting column height → 0..1 weight. Empty ground is 0. */
function pileWeight(stackWorld) {
  if (!(stackWorld > 0)) return 0;
  return clamp01(Math.pow(clamp01(stackWorld / WEIGHT_FULL_U), WEIGHT_CURVE));
}

const gains = { tl: 0, tr: 0, bl: 0, br: 0 };
const heights = { tl: 0, tr: 0, bl: 0, br: 0 };
/** 0..1 throw of Greyhole decay. 1 is the very long rising tail. */
const decays = { tl: 0, tr: 0, bl: 0, br: 0 };
const longTails = { tl: false, tr: false, bl: false, br: false };
/** Holds the long tail after rising grains have cleared. */
const riseLatch = { tl: false, tr: false, bl: false, br: false };
const pitches = { tl: 1, tr: 1, bl: 1, br: 1 };
/** Smoothed playback rate for each pile note, keyed by pile id. */
const noteRates = { tl: new Map(), tr: new Map(), bl: new Map(), br: new Map() };
/** 0..1 short hall from the resting stack. The hall stays closed. */
const halls = { tl: 0, tr: 0, bl: 0, br: 0 };
/** 0..1 weight of the resting pile. Rising grains do not move this. */
const weights = { tl: 0, tr: 0, bl: 0, br: 0 };
/** 0..1 Greyhole send from rising Diffuse grains. The resting stack does not open it. */
const diffuses = { tl: 0, tr: 0, bl: 0, br: 0 };
/** Greyhole feedback for that rise. Grows with the climb, then rings after the grains land. */
const feedbacks = { tl: 0, tr: 0, bl: 0, br: 0 };
/** 0..1 Greyhole wet return. Stays open while a diffuse tail is still ringing. */
const wets = { tl: 0, tr: 0, bl: 0, br: 0 };
/** Last pile notes, kept while a diffuse tail is still fading the bed. */
const heldNotes = { tl: [], tr: [], bl: [], br: [] };
/** Seconds of ring left after the rise stops. 0 means that corner's reverb has been shut. */
const ringLeft = { tl: 0, tr: 0, bl: 0, br: 0 };
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
    noteRates[id].clear();
    heldNotes[id] = [];
    ringLeft[id] = 0;
    halls[id] = 0;
    weights[id] = 0;
    diffuses[id] = 0;
    feedbacks[id] = 0;
    wets[id] = 0;
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
  const notes = { tl: [], tr: [], bl: [], br: [] };
  for (const id of CORNERS) {
    const quad = quads[id] || {};
    const coverage = clamp01(quad.coverage);
    const height = clamp01(quad.height);
    const gainTarget = footprintGain(coverage);
    const stackNorm = clamp01(Number.isFinite(Number(quad.stack)) ? quad.stack : height);
    const stackWorld = stackNorm * STACK_FIELD_U;
    const weightTarget = coverage <= 0 ? 0 : pileWeight(stackWorld);
    const riseTip = Math.max(0, Number(quad.rise) || 0);
    const rising = riseTip > 0;
    const riseOpen = rising ? clamp01(Math.pow(riseTip / RISE_FULL, RISE_CURVE)) : 0;
    const crowd = riseCrowd(Number(quad.riseMass) || 0);
    const riseSend = riseOpen * crowd;
    const empty = coverage <= 0 && !rising;
    if (rising) ringLeft[id] = RING_LIMIT;
    else if (ringLeft[id] > 0) ringLeft[id] = Math.max(0, ringLeft[id] - dt);
    const tailing = rising || ringLeft[id] > 0;
    riseLatch[id] = tailing;
    let feedbackTarget = 0;
    let feedbackTau = 0.35;
    if (!diffuseReverb) {
      feedbackTarget = 0;
      feedbackTau = EMPTY_TAIL;
    } else if (rising) {
      feedbackTarget = FEEDBACK_MAX * riseOpen;
      feedbackTau = DECAY_ATTACK;
    } else if (tailing) {
      feedbackTarget = 0;
      feedbackTau = 1.15;
    } else if (empty) {
      feedbackTarget = 0;
      feedbackTau = EMPTY_TAIL;
    }
    feedbacks[id] = follow(feedbacks[id], feedbackTarget, dt, feedbackTau);
    const reverbTarget = riseOpen;
    let decayTarget = reverbTarget;
    let decayTau = 0.25;
    if (rising) {
      decayTarget = 1;
      decayTau = DECAY_ATTACK;
    } else if (tailing) {
      decayTarget = 0;
      decayTau = 1.15;
    } else if (empty) {
      decayTarget = 0;
      decayTau = EMPTY_TAIL;
    }
    longTails[id] = tailing;
    gains[id] = gainTarget <= 0
      ? (tailing ? follow(gains[id], 0, dt, BED_RING) : 0)
      : follow(gains[id], gainTarget, dt, 0.08);
    heights[id] = reverbTarget <= 0 ? 0 : follow(heights[id], reverbTarget, dt, rising ? 0.12 : 0.25);
    decays[id] = follow(decays[id], decayTarget, dt, decayTau);
    halls[id] = 0;
    weights[id] = weightTarget <= 0 ? 0 : follow(weights[id], weightTarget, dt, 0.2);
    if (!diffuseReverb) {
      diffuses[id] = 0;
      feedbacks[id] = 0;
      wets[id] = 0;
    } else if (!(tailing && !rising)) {
      diffuses[id] = follow(diffuses[id], riseSend, dt, empty ? EMPTY_TAIL : rising ? DECAY_ATTACK : 0.25);
    }
    // Resting piles keep the bed. They do not keep Greyhole open.
    if (diffuseReverb) {
      const wetOpen = tailing;
      wets[id] = follow(wets[id], wetOpen ? 1 : 0, dt, wetOpen ? 0.08 : EMPTY_TAIL);
    }
    cutoffs[id] = cutoffHz(gains[id]);
    const list = Array.isArray(snap?.piles?.[id]) ? snap.piles[id] : [];
    const live = new Set();
    let loudest = 0;
    let loudRate = 1;
    for (let i = 0; i < list.length; i += 1) {
      const pile = list[i];
      const pileId = pile?.id;
      if (pileId == null) continue;
      live.add(pileId);
      const target = Number(pile.rate);
      const positionRate = Number.isFinite(target) && target > 0 ? target : 1;
      const prev = noteRates[id].get(pileId);
      const next = prev == null ? positionRate : follow(prev, positionRate, dt, 0.2);
      noteRates[id].set(pileId, next);
      const share = Number(pile.share);
      const level = Number.isFinite(share) && share > 0 ? share : 0;
      notes[id].push({ id: pileId, rate: next, share: level });
      if (level >= loudest) {
        loudest = level;
        loudRate = next;
      }
    }
    for (const pileId of noteRates[id].keys()) {
      if (!live.has(pileId)) noteRates[id].delete(pileId);
    }
    pitches[id] = list.length ? loudRate : follow(pitches[id], 1, dt, 0.2);
    if (notes[id].length) heldNotes[id] = notes[id].map((note) => ({ ...note }));
    else if (tailing && heldNotes[id].length) notes[id] = heldNotes[id];
    else heldNotes[id] = [];
    if (!rising && ringLeft[id] <= 0) {
      const settled = feedbacks[id] < 0.02 && diffuses[id] < 0.02 && wets[id] < 0.02;
      if (empty || settled) {
        feedbacks[id] = 0;
        wets[id] = 0;
        diffuses[id] = 0;
      }
      if (empty) {
        gains[id] = 0;
        heldNotes[id] = [];
        notes[id] = [];
        riseLatch[id] = false;
      }
    }
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
    notes,
    reverbs: HEIGHT_REVERB ? heights : { tl: 0, tr: 0, bl: 0, br: 0 },
    decays: HEIGHT_REVERB ? decays : { tl: 0, tr: 0, bl: 0, br: 0 },
    longTails: HEIGHT_REVERB ? longTails : { tl: false, tr: false, bl: false, br: false },
    halls,
    weights,
    diffuses,
    feedbacks,
    wets,
    pans: snap?.pans || { tl: 0, tr: 0, bl: 0, br: 0 },
    splash,
    controller: DRY_BEDS,
  };
}

/**
 * Quadrant cells for the 2×2 behavior readout.
 * Pile count is the split: one connected mass is one note, a gap is another.
 * `cols` is each pile's columns, drawn as one split bar.
 * Height, mass, send, and feedback are meter levels. Height is full at
 * RISE_FULL. Mass is the crowd term that opens the send.
 * @param {object} snap
 * @param {object} shadow
 * @param {Record<string, string>} [names] sample assigned to each corner
 * @returns {{ rising: number, quads: Record<string, object> }}
 */
export function fieldDebug(snap, shadow, names) {
  const rises = Array.isArray(snap?.rises) ? snap.rises : [];
  const rising = { tl: 0, tr: 0, bl: 0, br: 0 };
  for (let i = 0; i < rises.length; i += 1) {
    const id = rises[i]?.corner;
    if (rising[id] != null) rising[id] += 1;
  }
  /** @type {Record<string, object>} */
  const quads = {};
  for (const id of CORNERS) {
    const quad = snap?.quads?.[id] || {};
    const cells = Math.max(0, Number(quad.cells) || 0);
    const notes = Array.isArray(shadow?.notes?.[id]) ? shadow.notes[id] : [];
    const piles = notes.length;
    const riseN = rising[id];
    const send = clamp01(Number(shadow?.diffuses?.[id]) || 0);
    const feedback = clamp01(Number(shadow?.feedbacks?.[id]) || 0);
    const name = names?.[id] || id.toUpperCase();
    const height = Math.max(0, Number(quad.rise) || 0);
    const mass = Math.max(0, Number(quad.riseMass) || 0);
    /** @type {number[]} */
    const cols = [];
    if (piles > 1 && cells > 0) {
      for (let i = 0; i < notes.length; i += 1) {
        const share = Number(notes[i]?.share) || 0;
        cols.push(Math.max(1, Math.round(share * cells)));
      }
    } else if (cells > 0) {
      cols.push(cells);
    }
    quads[id] = {
      name,
      piles,
      cells,
      cols,
      rise: riseN,
      height,
      mass,
      send,
      feedback,
      meters: {
        h: clamp01(height / RISE_FULL),
        mass: mass > 0 ? 1 - Math.exp(-mass / RISE_CROWD) : 0,
        send,
        fb: feedback,
      },
    };
  }
  return { rising: rises.length, quads };
}
