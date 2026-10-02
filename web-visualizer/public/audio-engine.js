/**
 * Browser-side recreation of the EchoScape Max mix path:
 *   4 looping beds → equal-power gains → dry/wet gate → face-button FX
 *   → tone (LT lowpass / RT highpass) → shoulder FX (L1/R1) → pan → master
 *
 * Commercial VSTs are approximated with Web Audio nodes so design can iterate
 * without Max. Face-button slots can load vendored WAMs (e.g. OWLShimmer) via
 * the FX picker; native approximations remain the fallback.
 *
 * Shoulder / trigger character:
 *   LT — Lowpass sweeps upward (cutoff rises as the trigger is pulled)
 *   RT — Highpass sweeps downward (cutoff falls as the trigger is pulled)
 *   L1 — Reverb: parallel hall, dry stays in place
 *   R1 — Delay: timed repeats with a damped, decaying feedback loop
 */

import {
  equalPowerMix,
  STEM_CORNERS,
  state as mixerState,
  controller as mixerController,
  setActiveFx as setMixerActiveFx,
} from "./mixer-core.js?v=67";
import {
  loadWam,
  resolveStickBinding,
  applyWamDefaults,
  applyStickToWamParams,
} from "./wam-host.js?v=9";
import {
  NATIVE_FX,
  DEFAULT_STICK_SCALE,
  STICK_SCALE_MIN,
} from "./wam-catalog.js?v=5";

const CORNERS = ["tl", "tr", "bl", "br"];
const GREYHOLE_PATH = "wimmics/greyhole/index.js";
const FX_IDS = ["cross", "square", "triangle", "circle"];
const FX_PICK_SLOTS = ["square", "triangle", "circle"];
const FX_STORAGE_KEY = "echoscape.fxPrefs";
const STICK_AXES = ["x", "y"];
const RAMP = 0.02;

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

/**
 * Last value written through writeParam.
 * AudioParam.value does not update until the audio thread catches up,
 * so reading it every frame would keep scheduling the same event.
 * @type {WeakMap<AudioParam, number>}
 */
const paramWritten = new WeakMap();

/**
 * Assign an AudioParam only when the value moved.
 * Writing the same `.value` every frame inserts a new event at `currentTime`,
 * and on a quiet graph those events come through as crackles.
 * @param {AudioParam | null | undefined} param
 * @param {number} value
 * @param {number} [eps]
 */
function writeParam(param, value, eps = 1e-4) {
  if (!param || !Number.isFinite(value)) return;
  const prev = paramWritten.get(param);
  if (typeof prev === "number" && Math.abs(prev - value) <= eps) return;
  paramWritten.set(param, value);
  param.value = value;
}

/** Equal-power dry/wet. `mix` 0 is fully dry. */
function equalPowerFade(mix) {
  const m = clamp01(mix);
  const angle = m * Math.PI * 0.5;
  return { dry: Math.cos(angle), wet: Math.sin(angle) };
}

/** Open pile. Heavy pile reaches the closed low-pass. */
const WEIGHT_LP_OPEN = 18000;
const WEIGHT_LP_HEAVY = 2500;
/** Low shelf at full weight. */
const WEIGHT_SHELF_DB = 6;

/** Log low-pass. Weight 0 is open. Weight 1 is the heavy pile. */
function weightCutoff(amount) {
  const w = clamp01(amount);
  return WEIGHT_LP_OPEN * Math.pow(WEIGHT_LP_HEAVY / WEIGHT_LP_OPEN, w);
}

/**
 * Soft clip whose dry/wet blend and makeup keep a steady level.
 * Same compensation as the camera drive, at a milder throw.
 */
function weightDrive(amount) {
  const drive = clamp01(amount);
  const pre = 1 + drive * 2.2;
  const ref = 0.3;
  const shaped = Math.tanh(pre * ref);
  const post = shaped > 1e-4 ? ref / shaped : 1;
  const grit = equalPowerFade(drive * 0.45);
  return { pre, post, dry: grit.dry, wet: grit.wet };
}

/** Odd tanh curve over ±1. Small signals stay near unity; peaks fold. */
function tanhCurve(n) {
  const curve = new Float32Array(n);
  const last = n - 1;
  for (let i = 0; i < n; i += 1) {
    const x = (i / last) * 2 - 1;
    curve[i] = Math.tanh(x);
  }
  return curve;
}

function strikeLife(hit) {
  if (typeof hit === "number") return hit;
  return Number(hit?.life) || 0;
}

function strikeRate(hit) {
  const rate = typeof hit === "number" ? 1 : Number(hit?.rate);
  if (!Number.isFinite(rate) || rate <= 0) return 1;
  return Math.min(4, Math.max(0.25, rate));
}

/** Phone-class pointer: coarse primary pointer and a touch screen. */
function isCoarseTouch() {
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches === true;
  const touch = (navigator.maxTouchPoints || 0) > 0;
  return coarse && touch;
}

/** Safari uses "interrupted" after a lock, a call, or a backgrounded tab. */
function contextNeedsResume(ctx) {
  return !!ctx && (ctx.state === "suspended" || ctx.state === "interrupted");
}

/** Longest ring in the burst, clamped to a splash voice. */
function strikeBurstLife(lives) {
  let life = 0;
  for (let i = 0; i < lives.length; i += 1) life = Math.max(life, strikeLife(lives[i]));
  return Math.min(5, Math.max(0.1, life || 0.1));
}

/** Fully open splash low-pass. The sweep ends here, above the bed's current cutoff. */
const SPLASH_OPEN_HZ = 20000;

/**
 * Where the splash low-pass starts and where it ends.
 * The bed already runs through its coverage low-pass and its pile-weight low-pass.
 * The phrase starts darker than that bed, then opens to full brightness, so the
 * restart is a brightening rather than another copy of the loop.
 * @param {{ tone?: BiquadFilterNode, weightLp?: BiquadFilterNode }} stem
 */
function strikeSplashCutoffs(stem) {
  const tone = Number(stem?.tone?.frequency?.value);
  const weight = Number(stem?.weightLp?.frequency?.value);
  const toneHz = Number.isFinite(tone) && tone > 0 ? tone : SPLASH_OPEN_HZ;
  const weightHz = Number.isFinite(weight) && weight > 0 ? weight : toneHz;
  const bed = Math.max(40, Math.min(SPLASH_OPEN_HZ, Math.min(toneHz, weightHz)));
  const start = Math.max(180, Math.min(bed * 0.4, bed - 400));
  return { start, end: SPLASH_OPEN_HZ };
}

/** Phrase keeps ringing this long after the splash ring is gone. */
const PHRASE_TAIL = 0.12;
/** Bright octave above the phrase. It dies with the ring. */
const SPARKLE_HP_HZ = 4000;
/** Share of the phrase peak. The high-pass throws away the body of the sample. */
const SPARKLE_LEVEL = 0.42;

/**
 * Phrase restart level, under the stem.
 * A full extra copy of the bed was too loud. This keeps the opening sweep audible.
 * Heavier landings are a little louder. The floor keeps the first cells of a quiet pile speaking.
 */
const PHRASE_LEVEL = 0.55;

function strikePeak(stemLevel, rate, count) {
  const weight = Math.min(1.5, Math.pow(Math.max(1, count), 0.35));
  const amount = Math.max(0.35, Math.min(1, Number(stemLevel) || 0));
  return PHRASE_LEVEL * amount * (1 / Math.sqrt(Math.max(0.25, rate))) * weight;
}

/** Grain and tick ignore another landing on the same pile inside this window. */
const SPLASH_REFRACTORY = 0.11;
/** Heard length of a sample grain. The visual ring stays longer. */
const GRAIN_SEC = 0.07;
/** Heard length of a noise tick. */
const TICK_SEC = 0.08;
/** Grain bandpass. Above the bed's body, wide enough to keep the sample's timbre. */
const GRAIN_BP_HZ = 1600;
const GRAIN_BP_Q = 3;
/** Peak hold. The rest of GRAIN_SEC is the decay. */
const GRAIN_HOLD_SEC = 0.025;
/** Small lift. The bandpass is what separates the splash from the bed. */
const GRAIN_LIFT = 1.25;
/** Tick bandpass at the pile's pitch. Wide enough to read as a tick, not a whistle. */
const TICK_BASE_HZ = 240;
const TICK_Q = 2;

/**
 * Stem level and landing weight shared by the grain and the tick.
 * The floor keeps a quiet pile's first atom audible.
 * A heavy cluster is only a little louder.
 */
function impactAmount(stemLevel, count) {
  const weight = Math.min(1.15, Math.pow(Math.max(1, count), 0.22));
  const amount = Math.max(0.4, Math.min(1, Number(stemLevel) || 0));
  return amount * 0.9 * weight;
}

/**
 * Grain sits near the stem. A faster slice is louder, so the rate term pulls it back.
 * The phrase path still uses strikePeak.
 */
function impactPeak(stemLevel, rate, count) {
  return impactAmount(stemLevel, count) * (1 / Math.sqrt(Math.max(0.25, rate)));
}

function tickHz(rate) {
  return Math.min(4000, Math.max(80, TICK_BASE_HZ * Math.max(0.25, rate)));
}

/**
 * Bring band-limited noise back up to the level of the unfiltered burst.
 * A higher pile is a wider band in hertz, so the makeup shrinks with pitch.
 */
function tickMakeup(q, sampleRate, f0) {
  const f = Math.max(1, f0);
  const fs = Math.max(1, sampleRate);
  return Math.sqrt((q * fs) / (Math.PI * f));
}

/**
 * A slice of the sample, not the bed's playhead.
 * The cell picks the offset so two landings are different specks.
 * @param {AudioBuffer} buffer
 * @param {{ x?: number, z?: number }} hit
 * @param {number} rate
 */
function grainSlice(buffer, hit, rate) {
  const dur = Number(buffer?.duration) || 0;
  if (!(dur > 0)) return { offset: 0, duration: 0.01 };
  const wanted = GRAIN_SEC * Math.max(0.25, rate);
  const slice = Math.min(dur, Math.max(0.01, wanted));
  const span = Math.max(0, dur - slice);
  const x = Number(hit?.x) || 0;
  const z = Number(hit?.z) || 0;
  const h = Math.abs((x | 0) * 17 + (z | 0) * 31);
  const offset = span > 1e-4 ? ((h % 997) / 997) * span : 0;
  return { offset, duration: slice };
}

function defaultAxisScales() {
  return { x: DEFAULT_STICK_SCALE, y: DEFAULT_STICK_SCALE };
}

function clampAxisScale(n) {
  const v = Math.round((Number(n) || DEFAULT_STICK_SCALE) * 10) / 10;
  if (!Number.isFinite(v)) return DEFAULT_STICK_SCALE;
  return Math.max(STICK_SCALE_MIN, v);
}

/** Normalize legacy number or `{ x, y }` into per-axis scales. */
function normalizeAxisScales(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const v = clampAxisScale(raw);
    return { x: v, y: v };
  }
  if (raw && typeof raw === "object") {
    return {
      x: clampAxisScale(raw.x),
      y: clampAxisScale(raw.y),
    };
  }
  return defaultAxisScales();
}

function loadFxPrefs() {
  try {
    const raw = localStorage.getItem(FX_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveFxPrefs(payload) {
  try {
    localStorage.setItem(FX_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("[EchoScape] could not save FX prefs:", err);
  }
}

/** Drop a previous mono explicit mode so the next insert can connect. */
function relaxInsertChannels(node) {
  if (!node) return;
  try {
    node.channelCountMode = "max";
    node.channelCount = 2;
    node.channelInterpretation = "speakers";
  } catch {
    /* some nodes refuse a channel-count change while connected */
  }
}

function makeDistortionCurve(amount) {
  const samples = 2048;
  const curve = new Float32Array(samples);
  const k = 1 + amount * 80;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function waitForMedia(el, timeoutMs = 60000) {
  if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out loading ${el.src}`));
    }, timeoutMs);

    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Failed to load ${el.src}`));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      el.removeEventListener("canplay", onReady);
      el.removeEventListener("loadeddata", onReady);
      el.removeEventListener("error", onError);
    };

    el.addEventListener("canplay", onReady, { once: true });
    el.addEventListener("loadeddata", onReady, { once: true });
    el.addEventListener("error", onError, { once: true });
  });
}

export class EchoScapeAudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.running = false;
    this.error = null;
    this.stems = {};
    /** Bed elements opened before the stem graph exists, so a click can start them. */
    this._pendingEls = {};
    this.fx = {};
    this.activeFx = "cross";
    /** True while the master trim is at its open level. Falling Blocks closes it on an empty grid. */
    this._outputAudible = true;
    /** Last requested master trim, as a fraction of the open level. */
    this._outputAmount = 1;
    this._outputOpen = 0.28;
    /** Last camera presence applied to the post-master stage. */
    this._camClose = null;
    this._camAway = null;
    this._master = null;
    /** Post-master camera stage: far = quieter/darker, close = louder/saturated. */
    this._viewLp = null;
    this._brightDry = null;
    this._brightWet = null;
    this._camSum = null;
    this._driveDry = null;
    this._drivePre = null;
    this._driveShaper = null;
    this._drivePost = null;
    this._driveWet = null;
    this._driveSum = null;
    this._viewLevel = null;
    this._dry = null;
    this._wet = null;
    this._sum = null;
    this._panner = null;
    this._reverb = null;
    this._reverbSend = null;
    this._tone = null;
    this._hp = null;
    this._wetIn = null;
    this._shoulderOut = null;
    this._splashOut = null;
    /** Landing voice. Phrase restarts the sample in phase with the bed. */
    this.splashMode = "phrase";
    /** Last impact start per corner and pile, in context time. */
    this._impactAt = null;
    /** @type {AudioBuffer | null} */
    this._tickNoise = null;
    this._l1Dry = null;
    this._l1Send = null;
    this._l1Reverb = null;
    this._r1Send = null;
    this._r1Delay = null;
    this._r1Feedback = null;
    this._r1Wet = null;
    this._comp = null;
    this._l1Held = false;
    this._r1Held = false;
    /** @type {AudioContext | null} */
    this._watchedCtx = null;
    /** @type {'pending' | 'wam' | 'native'} */
    this.circleFxMode = "pending";
    /** @type {Record<string, { id: string, label: string, kind: string, path?: string }>} */
    this.fxAssignment = {};
    /** @type {Record<string, object | null>} */
    this._fxWam = {};
    /** @type {Record<string, GainNode | null>} */
    this._fxInsertIn = {};
    /** @type {Record<string, object | null>} */
    this._fxStickParams = {};
    /** @type {Record<string, { x: number, y: number }>} */
    this.fxStickScale = {
      square: defaultAxisScales(),
      triangle: defaultAxisScales(),
      circle: defaultAxisScales(),
    };
  }

  async start() {
    if (this.running) {
      await this.resume();
      await this._playAll();
      return this;
    }
    if (this._startInFlight) return this._startInFlight;
    this._startInFlight = this._startOnce();
    try {
      return await this._startInFlight;
    } finally {
      this._startInFlight = null;
    }
  }

  async _startOnce() {
    this.error = null;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      this.error = "Web Audio is not available in this browser.";
      throw new Error(this.error);
    }

    if (!this.ctx || this.ctx.state === "closed") this.ctx = new AC();
    this._watchContext(this.ctx);
    // Outside a user gesture, some Chromium builds never resolve resume().
    await this._safeResume(300);

    this._sum = this.ctx.createGain();
    this._sum.gain.value = 1;

    this._dry = this.ctx.createGain();
    this._dry.gain.value = 1;
    this._wet = this.ctx.createGain();
    this._wet.gain.value = 0;

    // LT lowpass (open until pulled) and RT highpass (open until pulled).
    this._tone = this.ctx.createBiquadFilter();
    this._tone.type = "lowpass";
    this._tone.frequency.value = 20000;
    this._tone.Q.value = 0.7;
    this._hp = this.ctx.createBiquadFilter();
    this._hp.type = "highpass";
    this._hp.frequency.value = 20;
    this._hp.Q.value = 0.7;

    this._buildShoulderFx();

    this._panner = this.ctx.createStereoPanner();
    this._panner.pan.value = 0;

    this._comp = this.ctx.createDynamicsCompressor();
    this._comp.threshold.value = -12;
    this._comp.knee.value = 18;
    this._comp.ratio.value = 3.5;
    this._comp.attack.value = 0.005;
    this._comp.release.value = 0.18;

    // Everything sums here, including paths that used to skip the compressor.
    this._outBus = this.ctx.createGain();
    this._outBus.gain.value = 1;

    this._limiter = this.ctx.createDynamicsCompressor();
    this._limiter.threshold.value = -2;
    this._limiter.knee.value = 0;
    this._limiter.ratio.value = 20;
    this._limiter.attack.value = 0.002;
    this._limiter.release.value = 0.12;

    this._master = this.ctx.createGain();
    // Four full-scale beds sum well above 0 dBFS. Trim after the limiter.
    this._master.gain.value = 0.28;

    this._reverbSend = this.ctx.createGain();
    this._reverbSend.gain.value = 0;
    this._reverb = this._createReverb();

    this._buildFx();

    this._sum.connect(this._dry);
    this._sum.connect(this._wetIn);
    this._dry.connect(this._tone);
    this._wet.connect(this._tone);
    this._tone.connect(this._hp);
    // filters → dry shoulder bus; L1 reverb and R1 delay are parallel
    this._hp.connect(this._l1Dry);
    this._hp.connect(this._l1Send);
    this._shoulderOut.connect(this._panner);
    this._splashOut = this.ctx.createGain();
    this._splashOut.gain.value = 1;
    this._splashOut.connect(this._shoulderOut);
    this._panner.connect(this._comp);
    this._comp.connect(this._outBus);
    this._outBus.connect(this._limiter);
    this._limiter.connect(this._master);
    this._buildCameraStage();

    // R1 delay joins the dry bus so the source and the echo share one level
    this._l1Dry.connect(this._r1Send);
    this._r1Wet.connect(this._shoulderOut);

    // Beds first so sound can start even if WAM restore is slow/hangs.
    await this._loadStems();
    this.ready = true;
    this.running = true;
    this.setActiveFx(mixerController.activeFx || this.activeFx, true);
    this.sync(mixerState, mixerController);
    await this._playAll();
    await this._safeResume(300);
    void this._loadStemReverbs();
    void this._loadHall();

    // Restore WAMs after audible beds are up (best-effort, time-boxed).
    try {
      await Promise.race([
        this._restoreFxPrefs(),
        new Promise((resolve) => setTimeout(resolve, 12000)),
      ]);
    } catch (err) {
      console.warn("[EchoScape audio] FX pref restore failed:", err?.message || err);
    }
    this.circleFxMode = this._fxWam?.circle ? "wam" : "native";
    this.setActiveFx(mixerController.activeFx || this.activeFx, true);
    this.sync(mixerState, mixerController);

    console.info("[EchoScape audio] started", {
      ctx: this.ctx.state,
      sampleRate: this.ctx.sampleRate,
      circleFx: this.circleFxMode,
      fx: Object.fromEntries(
        FX_PICK_SLOTS.map((id) => [id, this.fxAssignment?.[id]?.label || "native"])
      ),
      stems: CORNERS.map((c) => ({
        corner: c,
        paused: this.stems[c]?.el.paused,
        time: this.stems[c]?.el.currentTime,
        readyState: this.stems[c]?.el.readyState,
      })),
    });

    return this;
  }

  /** Log context transitions once per AudioContext instance. */
  _watchContext(ctx) {
    if (!ctx || ctx === this._watchedCtx) return;
    this._watchedCtx = ctx;
    ctx.addEventListener("statechange", () => {
      console.info("[EchoScape audio] AudioContext:", ctx.state);
    });
  }

  /** Resume without hanging when autoplay policy blocks the promise. */
  async _safeResume(timeoutMs = 300) {
    if (!this.ctx || this.ctx.state === "running") return;
    try {
      await Promise.race([
        this.ctx.resume(),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    } catch {
      /* ignore — pad click will retry */
    }
  }

  async resume() {
    await this._safeResume(1000);
  }

  /**
   * Start the looping beds during a user gesture.
   * Chrome allows AudioBuffer splashes once the context is running, but it
   * blocks HTML media playback unless play() is called in the gesture itself.
   * Call this synchronously from pointerdown or keydown, before any await.
   */
  beginGesture() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if ((!this.ctx || this.ctx.state === "closed") && AC) this.ctx = new AC();
    this._watchContext(this.ctx);
    const poke = () => {
      for (const corner of CORNERS) {
        if (this.stems[corner]?.bedVoice || this.stems[corner]?.notes?.length) continue;
        const wired = this.stems[corner]?.el;
        if (wired) {
          this._playEl(wired, true);
          continue;
        }
        let pending = this._pendingEls[corner];
        if (!pending) pending = this._openPendingBed(corner);
        if (pending) this._playEl(pending, false);
      }
    };
    poke();
    if (contextNeedsResume(this.ctx)) {
      void this.ctx.resume().then(() => {
        if (navigator.userActivation?.isActive) poke();
      });
    }
  }

  /**
   * Bring sound back after the page returns to the foreground.
   * An interrupted or suspended context gets Safari's suspend-then-resume.
   * A context that stayed running only restarts beds that actually paused.
   */
  async recoverForeground() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === "closed") return;
    if (contextNeedsResume(ctx)) {
      try {
        await ctx.suspend();
      } catch {
        /* an interrupted context may reject suspend */
      }
      try {
        await ctx.resume();
      } catch {
        /* the next tap retries */
      }
      this.beginGesture();
      return;
    }
    if (ctx.state === "running") this._pokePausedBeds();
  }

  /** Restart bed elements that stopped while the context kept running. */
  _pokePausedBeds() {
    for (const corner of CORNERS) {
      if (this.stems[corner]?.bedVoice || this.stems[corner]?.notes?.length) continue;
      const wired = this.stems[corner]?.el;
      if (wired) {
        if (wired.paused) this._playEl(wired, true);
        continue;
      }
      const pending = this._pendingEls[corner];
      if (pending?.paused) this._playEl(pending, false);
    }
  }

  /**
   * Snapshot for the header and Diagnostics readout.
   * WAM count is plugins in the graph, not the catalog total.
   */
  audioHealth() {
    /** @type {Record<string, string>} */
    const beds = {};
    /** @type {Record<string, number>} */
    const strikes = {};
    let bedsPlaying = 0;
    let strikeTotal = 0;
    for (const corner of CORNERS) {
      const el = this.stems[corner]?.el || this._pendingEls[corner] || null;
      const bed = this.stems[corner]?.bedVoice || this.stems[corner]?.notes?.length
        ? "playing"
        : !el
          ? "missing"
          : el.paused
            ? "paused"
            : "playing";
      beds[corner] = bed;
      if (bed === "playing") bedsPlaying += 1;
      const count = this.stems[corner]?.strikes?.length || 0;
      strikes[corner] = count;
      strikeTotal += count;
    }
    return {
      state: this.ctx?.state || "none",
      sampleRate: this.ctx?.sampleRate || 0,
      beds,
      bedsPlaying,
      strikes,
      strikeTotal,
      wams: this.loadedWamCount(),
    };
  }

  /** One line: rate, context, beds, strike voices, loaded WAMs. */
  audioHealthLabel() {
    const health = this.audioHealth();
    const khz = health.sampleRate ? `${Math.round(health.sampleRate / 1000)} kHz` : "—";
    const strikes = CORNERS.map((corner) => health.strikes[corner]).join(" ");
    const quiet = CORNERS.filter((corner) => health.beds[corner] !== "playing");
    const beds = !quiet.length
      ? "beds 4/4"
      : quiet.every((corner) => health.beds[corner] === "missing")
        ? `beds ${health.bedsPlaying}/4`
        : `beds ${health.bedsPlaying}/4 ${quiet.map((corner) => `${corner} ${health.beds[corner]}`).join(" ")}`;
    return `${khz} · ${health.state} · ${beds} · strikes ${strikes} · WAMs ${health.wams}`;
  }

  async ensurePlaying() {
    this.beginGesture();
    await this.resume();
    await this._playAll();
  }

  /** Pause beds and suspend the AudioContext without tearing down the graph. */
  async suspendPlayback() {
    if (!this.ctx) return;
    for (const corner of CORNERS) {
      const stem = this.stems[corner];
      if (!stem?.el) continue;
      try {
        if (!stem.el.paused) stem.el.pause();
      } catch {
        /* ignore */
      }
    }
    if (this.ctx.state === "running") {
      try {
        await this.ctx.suspend();
      } catch {
        /* ignore */
      }
    }
  }

  _playEl(el, audible) {
    if (!el) return;
    el.muted = false;
    if (audible) el.volume = 1;
    if (!el.paused) return;
    const pending = el.play();
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  }

  /** A bed element the gesture can start before the stem graph exists. */
  _openPendingBed(corner) {
    const meta = STEM_CORNERS[corner];
    if (!meta) return null;
    const url = meta.url || `/beds/${encodeURIComponent(meta.file)}`;
    const el = this._createBedElement(url);
    this._pendingEls[corner] = el;
    return el;
  }

  _createBedElement(url) {
    const el = new Audio();
    el.loop = true;
    el.preload = "auto";
    el.preservesPitch = false;
    el.mozPreservesPitch = false;
    el.webkitPreservesPitch = false;
    el.playsInline = true;
    el.volume = 0;
    el.dataset.bedUrl = url;
    el.src = url;
    if (document.body && !el.isConnected) {
      el.setAttribute("playsinline", "");
      el.setAttribute("aria-hidden", "true");
      el.style.cssText = "position:fixed;width:0;height:0;opacity:0;pointer-events:none";
      document.body.appendChild(el);
    }
    return el;
  }

  _releaseBedElement(el) {
    if (!el) return;
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch {
      /* ignore */
    }
    el.remove();
  }

  async _playAll() {
    const plays = CORNERS.map(async (corner) => {
      const stem = this.stems[corner];
      if (!stem?.el || stem.bedVoice || stem.notes?.length) return;
      stem.el.muted = false;
      stem.el.volume = 1;
      if (stem.el.paused) {
        await stem.el.play();
      }
    });
    const results = await Promise.allSettled(plays);
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) {
      console.warn(
        "[EchoScape audio] play() failed for some stems:",
        failed.map((f) => f.reason?.message || f.reason)
      );
    }
  }

  async stop() {
    if (!this.running && !this.ctx) return;
    for (const corner of CORNERS) {
      const pending = this._pendingEls[corner];
      if (pending) this._releaseBedElement(pending);
      const stem = this.stems[corner];
      if (!stem) continue;
      this._stopBufferBed(stem);
      this._stopPileNotes(stem);
      this._releaseStrikes(stem);
      try {
        stem.el.pause();
        stem.el.removeAttribute("src");
        stem.el.load();
        stem.el.remove();
      } catch {
        /* ignore */
      }
      try {
        stem.source.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (this._fxWam) {
      for (const id of FX_IDS) {
        await this._destroySlotWam(id);
      }
    }
    try {
      await this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.stems = {};
    this._pendingEls = {};
    this.fx = {};
    this.fxAssignment = {};
    this._fxWam = {};
    this._fxInsertIn = {};
    this._fxStickParams = {};
    this._viewLp = null;
    this._brightDry = null;
    this._brightWet = null;
    this._camSum = null;
    this._driveDry = null;
    this._drivePre = null;
    this._driveShaper = null;
    this._drivePost = null;
    this._driveWet = null;
    this._driveSum = null;
    this._viewLevel = null;
    this.ready = false;
    this.running = false;
    this._l1Held = false;
    this._r1Held = false;
    this.circleFxMode = "pending";
  }

  _createReverb() {
    const seconds = 2.4;
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.2);
      }
    }
    const convolver = this.ctx.createConvolver();
    convolver.buffer = buffer;
    return convolver;
  }

  /**
   * Longer, softened hall for the L1 send. Distinct from the shorter RT hall.
   */
  _createShoulderReverb() {
    const seconds = 3.1;
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let z = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const env = Math.pow(1 - t, 1.35) * Math.exp(-t * 1.6);
        const noise = (Math.random() * 2 - 1) * env;
        z += 0.07 * (noise - z);
        data[i] = z;
      }
    }
    const convolver = this.ctx.createConvolver();
    convolver.buffer = buffer;
    return convolver;
  }

  _buildShoulderFx() {
    const ctx = this.ctx;

    this._shoulderOut = ctx.createGain();
    this._shoulderOut.gain.value = 1;

    // --- L1 reverb (parallel; dry path is untouched) ---
    this._l1Dry = ctx.createGain();
    this._l1Dry.gain.value = 1;
    this._l1Dry.connect(this._shoulderOut);

    this._l1Send = ctx.createGain();
    this._l1Send.gain.value = 0;
    this._l1Reverb = this._createShoulderReverb();
    const l1Damp = ctx.createBiquadFilter();
    l1Damp.type = "lowpass";
    l1Damp.frequency.value = 4200;
    l1Damp.Q.value = 0.5;
    const l1Wet = ctx.createGain();
    l1Wet.gain.value = 0.7;
    this._l1Send.connect(this._l1Reverb);
    this._l1Reverb.connect(l1Damp);
    l1Damp.connect(l1Wet);
    l1Wet.connect(this._shoulderOut);

    // --- R1 delay (repeats decay; lowpass in the loop keeps them from building) ---
    this._r1Send = ctx.createGain();
    this._r1Send.gain.value = 0;

    this._r1Delay = ctx.createDelay(2);
    this._r1Delay.delayTime.value = 0.9;

    const r1Damp = ctx.createBiquadFilter();
    r1Damp.type = "lowpass";
    r1Damp.frequency.value = 3200;
    r1Damp.Q.value = 0.5;

    this._r1Feedback = ctx.createGain();
    this._r1Feedback.gain.value = 0.32;

    this._r1Wet = ctx.createGain();
    this._r1Wet.gain.value = 1;

    this._r1Send.connect(this._r1Delay);
    this._r1Delay.connect(this._r1Wet);
    this._r1Delay.connect(r1Damp);
    r1Damp.connect(this._r1Feedback);
    this._r1Feedback.connect(this._r1Delay);
  }

  _applyShoulders(l1, r1, t) {
    const l1On = !!l1;
    const r1On = !!r1;
    const l1Changed = l1On !== this._l1Held;
    const r1Changed = r1On !== this._r1Held;
    this._l1Held = l1On;
    this._r1Held = r1On;

    // Only schedule on press/release edges. Re-calling setTargetAtTime every
    // frame restarts the ramp and makes release feel instantaneous.
    // Attack: snappy so FX is fully in while held. Release: long fade out.
    const L1_ATTACK = 0.12;
    const L1_RELEASE = 0.45;
    const R1_ATTACK = 0.03;
    const R1_RELEASE = 0.06;

    if (l1Changed) {
      const tau = l1On ? L1_ATTACK : L1_RELEASE;
      this._l1Send.gain.setTargetAtTime(l1On ? 0.85 : 0, t, tau);
    }

    if (r1Changed) {
      const tau = r1On ? R1_ATTACK : R1_RELEASE;
      this._r1Send.gain.setTargetAtTime(r1On ? 1 : 0, t, tau);
    }
  }

  _buildFx() {
    const ctx = this.ctx;
    this._wetIn = ctx.createGain();
    this._wetIn.gain.value = 1;
    this._fxInsertIn = {};
    this._fxWam = {};
    this.fxAssignment = {};

    this._wireNativeSlot("cross", (insertIn, out) => this._buildNativeCross(insertIn, out));
    this._wireNativeSlot("square", (insertIn, out) => this._buildNativeSquare(insertIn, out));
    this._wireNativeSlot("triangle", (insertIn, out) => this._buildNativeTriangle(insertIn, out));
    this._wireNativeSlot("circle", (insertIn, out) => this._buildNativeCircle(insertIn, out));
  }

  /**
   * @param {string} id
   * @param {(insertIn: GainNode, out: GainNode) => { apply: Function, teardown: Function }} builder
   */
  _wireNativeSlot(id, builder) {
    const ctx = this.ctx;
    const insertIn = ctx.createGain();
    insertIn.gain.value = 1;
    const out = ctx.createGain();
    out.gain.value = 0;
    this._wetIn.connect(insertIn);
    out.connect(this._wet);
    this._fxInsertIn[id] = insertIn;
    const native = builder(insertIn, out);
    this.fx[id] = {
      out,
      apply: native.apply,
      teardownNative: native.teardown,
      rebuildNative: () => builder(insertIn, out),
    };
    this.fxAssignment[id] = {
      id: NATIVE_FX[id].id,
      label: NATIVE_FX[id].label,
      kind: "native",
    };
    this._fxWam[id] = null;
  }

  _buildNativeCross(insertIn, out) {
    const ctx = this.ctx;
    const satIn = ctx.createGain();
    const satDrive = ctx.createWaveShaper();
    satDrive.curve = makeDistortionCurve(0.35);
    satDrive.oversample = "2x";
    const satTone = ctx.createBiquadFilter();
    satTone.type = "lowpass";
    satTone.frequency.value = 8000;
    insertIn.connect(satIn);
    satIn.connect(satDrive);
    satDrive.connect(satTone);
    satTone.connect(out);
    return {
      apply(x, y) {
        const drive = clamp01(x);
        const tone = clamp01(1 - y * 0.85);
        satDrive.curve = makeDistortionCurve(0.15 + drive * 0.85);
        satTone.frequency.setTargetAtTime(1200 + tone * 14000, ctx.currentTime, RAMP);
      },
      teardown() {
        try {
          satIn.disconnect();
        } catch {
          /* ignore */
        }
        try {
          satDrive.disconnect();
        } catch {
          /* ignore */
        }
        try {
          satTone.disconnect();
        } catch {
          /* ignore */
        }
      },
    };
  }

  _buildNativeSquare(insertIn, out) {
    const ctx = this.ctx;
    const combIn = ctx.createGain();
    const combDelay = ctx.createDelay(0.1);
    combDelay.delayTime.value = 0.012;
    const combFb = ctx.createGain();
    combFb.gain.value = 0.45;
    insertIn.connect(combIn);
    combIn.connect(combDelay);
    combDelay.connect(combFb);
    combFb.connect(combDelay);
    combDelay.connect(out);
    return {
      apply(x, y) {
        const t = 0.002 + clamp01(x) * 0.045;
        const fb = 0.15 + clamp01(y) * 0.75;
        combDelay.delayTime.setTargetAtTime(t, ctx.currentTime, RAMP);
        combFb.gain.setTargetAtTime(fb, ctx.currentTime, RAMP);
      },
      teardown() {
        try {
          combIn.disconnect();
        } catch {
          /* ignore */
        }
        try {
          combDelay.disconnect();
        } catch {
          /* ignore */
        }
        try {
          combFb.disconnect();
        } catch {
          /* ignore */
        }
      },
    };
  }

  _buildNativeTriangle(insertIn, out) {
    const ctx = this.ctx;
    const formIn = ctx.createGain();
    const f1 = ctx.createBiquadFilter();
    f1.type = "peaking";
    f1.frequency.value = 700;
    f1.Q.value = 4;
    f1.gain.value = 10;
    const f2 = ctx.createBiquadFilter();
    f2.type = "peaking";
    f2.frequency.value = 1200;
    f2.Q.value = 5;
    f2.gain.value = 8;
    insertIn.connect(formIn);
    formIn.connect(f1);
    f1.connect(f2);
    f2.connect(out);
    return {
      apply(x, y) {
        const shift = 0.5 + clamp01(x) * 2.5;
        const res = 2 + clamp01(y) * 10;
        f1.frequency.setTargetAtTime(400 * shift, ctx.currentTime, RAMP);
        f2.frequency.setTargetAtTime(900 * shift, ctx.currentTime, RAMP);
        f1.Q.setTargetAtTime(res, ctx.currentTime, RAMP);
        f2.Q.setTargetAtTime(res * 1.1, ctx.currentTime, RAMP);
      },
      teardown() {
        try {
          formIn.disconnect();
        } catch {
          /* ignore */
        }
        try {
          f1.disconnect();
        } catch {
          /* ignore */
        }
        try {
          f2.disconnect();
        } catch {
          /* ignore */
        }
      },
    };
  }

  _buildNativeCircle(insertIn, out) {
    const ctx = this.ctx;
    const cryDelay = ctx.createDelay(1.5);
    cryDelay.delayTime.value = 0.28;
    const cryFb = ctx.createGain();
    cryFb.gain.value = 0.35;
    const cryFilter = ctx.createBiquadFilter();
    cryFilter.type = "highpass";
    cryFilter.frequency.value = 400;
    const cryLfo = ctx.createOscillator();
    cryLfo.type = "sine";
    cryLfo.frequency.value = 0.35;
    const cryLfoGain = ctx.createGain();
    cryLfoGain.gain.value = 0.04;
    cryLfo.connect(cryLfoGain);
    cryLfoGain.connect(cryDelay.delayTime);
    cryLfo.start();
    insertIn.connect(cryDelay);
    cryDelay.connect(cryFilter);
    cryFilter.connect(cryFb);
    cryFb.connect(cryDelay);
    cryFilter.connect(out);
    return {
      apply: (x, y) => {
        const delay = 0.08 + clamp01(1 - x) * 0.55;
        const fb = 0.15 + clamp01(y) * 0.55;
        cryDelay.delayTime.setTargetAtTime(delay, ctx.currentTime, 0.05);
        cryFb.gain.setTargetAtTime(fb, ctx.currentTime, RAMP);
        cryLfoGain.gain.setTargetAtTime(0.01 + clamp01(y) * 0.06, ctx.currentTime, RAMP);
      },
      teardown() {
        try {
          cryLfo.stop();
        } catch {
          /* ignore */
        }
        try {
          cryDelay.disconnect();
        } catch {
          /* ignore */
        }
        try {
          cryFilter.disconnect();
        } catch {
          /* ignore */
        }
        try {
          cryFb.disconnect();
        } catch {
          /* ignore */
        }
        try {
          cryLfo.disconnect();
        } catch {
          /* ignore */
        }
        try {
          cryLfoGain.disconnect();
        } catch {
          /* ignore */
        }
      },
    };
  }

  async _destroySlotWam(id) {
    const instance = this._fxWam?.[id];
    if (!instance) return;
    try {
      instance.audioNode?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await instance.destroy?.();
    } catch {
      /* ignore */
    }
    this._fxWam[id] = null;
  }

  /** Face-slot plugins plus per-stem Greyhole instances currently in the graph. */
  loadedWamCount() {
    let count = 0;
    for (const instance of Object.values(this._fxWam || {})) {
      if (instance) count += 1;
    }
    for (const rec of Object.values(this._stemReverbs || {})) {
      if (rec?.instance) count += 1;
    }
    return count;
  }

  /**
   * Tear down every loaded WAM and restore native inserts.
   * Prefer pressing X / Cross (setActiveFx) to mute WAMs without wiping
   * assignments or stick scales — that only routes wet away from WAM slots.
   * @returns {Promise<string[]>} slots that previously had a WAM
   */
  async disableAllWams() {
    if (!this.ctx || !this.fx) return [];
    const cleared = [];
    for (const id of FX_IDS) {
      if (!this._fxWam?.[id]) continue;
      await this._assignFxSlot(
        id,
        {
          id: NATIVE_FX[id].id,
          kind: "native",
          label: NATIVE_FX[id].label,
        },
        { activate: false }
      );
      cleared.push(id);
    }
    this.circleFxMode = "native";
    if (cleared.length) {
      console.info("[EchoScape audio] WAMs unloaded:", cleared.join(", "));
    }
    return cleared;
  }

  /**
   * Assign native FX or a vendored WAM to a face-button slot.
   * @param {string} button
   * @param {{ id: string, kind: 'native'|'wam', label: string, path?: string }} choice
   */
  async replaceFx(button, choice) {
    if (button === "cross") {
      throw new Error("Cross (X) cannot host a WAM — it bypasses WAMs");
    }
    if (!this.ctx || !this.fx[button]) {
      await this.start();
    } else {
      await this.resume();
    }
    const assigned = await this._assignFxSlot(button, choice);
    this._persistFxPrefs();
    return assigned;
  }

  /**
   * Persist current face FX assignments + stick scales as the next-session defaults.
   * Switching to X / Cross does not call this — muting leaves prefs intact.
   */
  _persistFxPrefs() {
    const assignments = {};
    const scales = {};
    for (const slot of FX_PICK_SLOTS) {
      const assigned = this.fxAssignment?.[slot];
      if (assigned?.kind === "wam" && assigned.path) {
        assignments[slot] = {
          id: String(assigned.id || ""),
          kind: "wam",
          label: String(assigned.label || assigned.path),
          path: String(assigned.path),
        };
      } else {
        const native = NATIVE_FX[slot];
        assignments[slot] = {
          id: native.id,
          kind: "native",
          label: native.label,
        };
      }
      scales[slot] = normalizeAxisScales(this.fxStickScale?.[slot]);
    }
    const face = FX_IDS.includes(this.activeFx)
      ? this.activeFx
      : mixerController.activeFx || "cross";
    saveFxPrefs({
      assignments,
      scales,
      activeFx: face,
    });
  }

  /**
   * Apply saved WAM / scale prefs after native FX graph is built.
   * Each face keeps its own assignment; only the active face is audible.
   */
  async _restoreFxPrefs() {
    const prefs = loadFxPrefs();
    if (!prefs) return;

    for (const slot of FX_PICK_SLOTS) {
      if (prefs.scales?.[slot] != null) {
        this.fxStickScale[slot] = normalizeAxisScales(prefs.scales[slot]);
      }
    }

    const assignments = prefs.assignments || {};
    const restored = [];
    for (const slot of FX_PICK_SLOTS) {
      const choice = assignments[slot];
      if (choice?.kind !== "wam" || !choice.path) continue;
      try {
        await this._assignFxSlot(
          slot,
          {
            id: String(choice.id || choice.path),
            kind: "wam",
            label: String(choice.label || choice.path),
            path: String(choice.path),
          },
          { activate: false }
        );
        restored.push(slot);
      } catch (err) {
        console.warn(
          `[EchoScape audio] could not restore saved WAM for ${slot}:`,
          err?.message || err
        );
      }
    }

    if (!restored.length) return;

    const preferred = prefs.activeFx;
    const face = FX_PICK_SLOTS.includes(preferred)
      ? preferred
      : preferred === "cross"
        ? "cross"
        : restored[0];
    setMixerActiveFx(face);
    this.setActiveFx(face, true);
    console.info("[EchoScape audio] restored FX prefs", {
      restored,
      face,
      scales: Object.fromEntries(
        restored.map((slot) => [slot, this.fxStickScale[slot]])
      ),
    });
  }

  /**
   * @param {string} button
   * @param {{ id: string, kind: 'native'|'wam', label: string, path?: string }} choice
   * @param {{ activate?: boolean }} [opts] activate — select this face after assign (default true for WAM)
   */
  async _assignFxSlot(button, choice, opts = {}) {
    if (!FX_IDS.includes(button)) throw new Error(`Unknown FX slot ${button}`);
    if (!choice?.kind) throw new Error("replaceFx requires choice.kind");
    if (button === "cross" && choice.kind === "wam") {
      throw new Error("Cross (X) cannot host a WAM");
    }

    const slot = this.fx[button];
    const insertIn = this._fxInsertIn[button];
    if (!slot || !insertIn || !this.ctx) throw new Error(`FX slot ${button} not built`);

    // Tear down current insert (WAM or native chain).
    await this._destroySlotWam(button);
    try {
      insertIn.disconnect();
    } catch {
      /* ignore */
    }
    try {
      slot.teardownNative?.();
    } catch {
      /* ignore */
    }
    slot.teardownNative = null;
    relaxInsertChannels(insertIn);

    if (choice.kind === "wam") {
      const path = choice.path;
      if (!path) throw new Error("WAM choice requires path");
      try {
        const instance = await loadWam(this.ctx, path);
        const wamNode = instance.audioNode;
        insertIn.connect(wamNode);
        wamNode.connect(slot.out);
        this._fxWam[button] = instance;
        const binding = resolveStickBinding(path);
        if (!binding) {
          console.warn(
            `[EchoScape audio] no stick map for ${path} — edit public/wam-stick-maps.js`
          );
        }
        this._fxStickParams[button] = binding;
        applyWamDefaults(wamNode, binding);
        this.fxStickScale[button] = normalizeAxisScales(this.fxStickScale[button]);
        slot.apply = (stickX, stickY) => {
          applyStickToWamParams(
            wamNode,
            this._fxStickParams[button],
            stickX,
            stickY,
            this.fxStickScale[button] || defaultAxisScales()
          );
        };
        slot.apply(0, 0);
        this.fxAssignment[button] = {
          id: choice.id,
          label: choice.label || path,
          kind: "wam",
          path,
        };
        if (button === "circle") this.circleFxMode = "wam";
        console.info(
          `[EchoScape audio] ${button} FX → ${choice.label || path} (WAM)`,
          binding
            ? {
                x: binding.x.map((p) => p.label || p.id),
                y: binding.y.map((p) => p.label || p.id),
              }
            : "(no map)"
        );
        const shouldActivate = opts.activate !== false;
        if (shouldActivate) {
          this.setActiveFx(button, true);
          // Keep pad/UI controller on this face so sync() does not mute the WAM.
          setMixerActiveFx(button);
        }
        this.sync(mixerState, mixerController);
        return this.fxAssignment[button];
      } catch (err) {
        console.warn(
          `[EchoScape audio] WAM failed for ${button}, restoring native:`,
          err?.message || err
        );
        choice = {
          id: NATIVE_FX[button].id,
          kind: "native",
          label: NATIVE_FX[button].label,
        };
      }
    }

    // Native
    this._fxStickParams[button] = null;
    const native = slot.rebuildNative?.() || this._wireFallbackNative(button, insertIn, slot.out);
    slot.apply = native.apply;
    slot.teardownNative = native.teardown;
    this.fxAssignment[button] = {
      id: choice.id || NATIVE_FX[button].id,
      label: choice.label || NATIVE_FX[button].label,
      kind: "native",
    };
    if (button === "circle") this.circleFxMode = "native";
    console.info(`[EchoScape audio] ${button} FX → ${this.fxAssignment[button].label} (native)`);
    this.setActiveFx(this.activeFx, true);
    this.sync(mixerState, mixerController);
    return this.fxAssignment[button];
  }

  /**
   * Max multiplier at full +stick for one axis. Live multiplier is 1 at rest.
   * @param {string} button
   * @param {'x'|'y'} axis
   * @param {number} scale
   * @param {{ persist?: boolean }} [opts]
   */
  setFxStickScale(button, axis, scale, opts = {}) {
    if (!FX_PICK_SLOTS.includes(button)) return;
    if (!STICK_AXES.includes(axis)) return;
    const n = Number(scale);
    if (!Number.isFinite(n)) return;
    const current = normalizeAxisScales(this.fxStickScale[button]);
    current[axis] = clampAxisScale(n);
    this.fxStickScale[button] = current;
    if (this.fxAssignment?.[button]?.kind === "wam" && this.fx[button]?.apply) {
      try {
        this.fx[button].apply(
          Number(mixerController.rawX) || 0,
          Number(mixerController.rawY) || 0
        );
      } catch {
        /* ignore */
      }
    }
    if (opts.persist !== false) this._persistFxPrefs();
  }

  /**
   * @param {string} button
   * @param {'x'|'y'} [axis]
   * @returns {number | { x: number, y: number }}
   */
  getFxStickScale(button, axis) {
    const scales = normalizeAxisScales(this.fxStickScale?.[button]);
    if (axis === "x" || axis === "y") return scales[axis];
    return scales;
  }

  getFxStickParams(button) {
    return this._fxStickParams?.[button] || null;
  }

  _wireFallbackNative(button, insertIn, out) {
    if (button === "cross") return this._buildNativeCross(insertIn, out);
    if (button === "square") return this._buildNativeSquare(insertIn, out);
    if (button === "triangle") return this._buildNativeTriangle(insertIn, out);
    return this._buildNativeCircle(insertIn, out);
  }

  async _loadStems() {
    // Load sequentially so the first bed can start sooner and we avoid
    // saturating the network with four large WAVs at once.
    for (const corner of CORNERS) {
      const meta = STEM_CORNERS[corner];
      const url = meta.url || `/beds/${encodeURIComponent(meta.file)}`;
      await this._attachStem(corner, url, meta);
      console.info("[EchoScape audio] loaded", meta.label, {
        readyState: this.stems[corner]?.el?.readyState,
        duration: this.stems[corner]?.el?.duration,
      });
    }
  }

  /**
   * Build / replace one corner's MediaElementSource chain.
   * @param {string} corner
   * @param {string} url
   * @param {object} meta
   * @param {{ resume?: boolean, initialGain?: number }} [opts]
   */
  async _attachStem(corner, url, meta, opts = {}) {
    if (!this.ctx || !this._sum) throw new Error("Audio engine not started");

    const prev = this.stems[corner];
    // Silence previous stem immediately so the old bed does not keep playing
    // while the replacement buffers.
    if (prev) {
      this._stopBufferBed(prev);
      this._stopPileNotes(prev);
      try {
        prev.gain.gain.value = 0;
      } catch {
        /* ignore */
      }
      try {
        prev.el.pause();
      } catch {
        /* ignore */
      }
    }

    let el = this._pendingEls[corner];
    const reuse = el && el.dataset.bedUrl === url && el !== prev?.el;
    if (!reuse) {
      if (el && el !== prev?.el) this._releaseBedElement(el);
      el = this._createBedElement(url);
      this._pendingEls[corner] = el;
    }
    // play() has to happen while the click is still active. Waiting for the
    // file first drops the gesture, and Chrome then leaves the bed paused.
    if (navigator.userActivation?.isActive) this._playEl(el, false);

    await waitForMedia(el);
    delete this._pendingEls[corner];

    const source = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    // Beds are wide stereo files. Fold to mono so the panner can place them.
    const mono = this.ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = "explicit";
    const pan = this.ctx.createStereoPanner();
    const tone = this.ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 20000;
    tone.Q.value = 0.7;
    const weightLp = this.ctx.createBiquadFilter();
    weightLp.type = "lowpass";
    weightLp.frequency.value = WEIGHT_LP_OPEN;
    weightLp.Q.value = 0.7;
    const body = this.ctx.createBiquadFilter();
    body.type = "lowshelf";
    body.frequency.value = 250;
    body.Q.value = 0.7;
    body.gain.value = 0;
    const air = this.ctx.createBiquadFilter();
    air.type = "highshelf";
    air.frequency.value = 650;
    air.Q.value = 0.7;
    air.gain.value = 0;
    const satDry = this.ctx.createGain();
    satDry.gain.value = 1;
    const satPre = this.ctx.createGain();
    satPre.gain.value = 1;
    const satShaper = this.ctx.createWaveShaper();
    satShaper.curve = tanhCurve(2048);
    satShaper.oversample = "2x";
    const satPost = this.ctx.createGain();
    satPost.gain.value = 1;
    const satWet = this.ctx.createGain();
    satWet.gain.value = 0;
    const satSum = this.ctx.createGain();
    satSum.gain.value = 1;
    const weights = equalPowerMix(mixerState.x, mixerState.y);
    const initialGain =
      typeof opts.initialGain === "number" ? opts.initialGain : weights[corner] ?? 0;
    gain.gain.value = initialGain;
    pan.pan.value = 0;
    source.connect(gain);
    gain.connect(mono);
    mono.connect(pan);
    pan.connect(weightLp);
    weightLp.connect(body);
    body.connect(air);
    air.connect(satDry);
    air.connect(satPre);
    satPre.connect(satShaper);
    satShaper.connect(satPost);
    satPost.connect(satWet);
    satDry.connect(satSum);
    satWet.connect(satSum);
    satSum.connect(tone);
    tone.connect(this._sum);
    const reverbSend = this._stemReverbs?.[corner]?.send;
    if (reverbSend) pan.connect(reverbSend);
    const hallSend = this._hallSends?.[corner];
    if (hallSend) pan.connect(hallSend);

    if (prev) {
      this._releaseStrikes(prev);
      try {
        prev.source.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.gain.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.mono?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.pan?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.weightLp?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.body?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.air?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.satDry?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.satPre?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.satShaper?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.satPost?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.satWet?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.satSum?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.tone?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.strike?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        prev.el.removeAttribute("src");
        prev.el.load();
        prev.el.remove();
      } catch {
        /* ignore */
      }
    }

    this.stems[corner] = {
      el,
      source,
      gain,
      mono,
      pan,
      weightLp,
      body,
      air,
      satDry,
      satPre,
      satShaper,
      satPost,
      satWet,
      satSum,
      tone,
      meta,
      strikes: [],
    };
    this._primeStrikeBuffer(corner, url);

    el.volume = 1;
    if (opts.resume !== false && (this.running || navigator.userActivation?.isActive)) {
      try {
        el.muted = false;
        if (el.paused) await el.play();
      } catch (err) {
        console.warn("[EchoScape audio] stem play failed:", err?.message || err);
        if (this.running) throw err;
      }
    }
  }

  /**
   * Swap the looping bed for one pad corner (stops previous audio first).
   * @param {string} corner
   * @param {{ url: string, label?: string, file?: string, id?: string }} sample
   */
  async replaceStem(corner, sample) {
    if (!CORNERS.includes(corner)) throw new Error(`Unknown corner ${corner}`);
    if (!sample?.url) throw new Error("replaceStem requires sample.url");

    if (!this.running || !this.ctx) {
      await this.start();
    } else {
      await this.resume();
    }

    const meta = STEM_CORNERS[corner];
    const weights = equalPowerMix(mixerState.x, mixerState.y);
    await this._attachStem(corner, sample.url, meta, {
      resume: true,
      initialGain: weights[corner],
    });
    // Re-apply full mix so sibling corners stay correct after the swap.
    this.sync(mixerState, mixerController);
    console.info("[EchoScape audio] replaced", corner, meta?.label || sample.url, sample.url);
  }

  setActiveFx(button, force = false) {
    if (!FX_IDS.includes(button)) return;
    if (!force && !this.running) return;
    if (!this.ctx || !this.fx[button]) return;

    this.activeFx = button;
    const bypass = button === "cross";
    const t = this.ctx.currentTime;
    for (const id of FX_IDS) {
      const node = this.fx[id];
      if (!node) continue;
      // Cross is the mute face: every slot, including native Saturn, stays closed.
      node.out.gain.setTargetAtTime(!bypass && id === button ? 1 : 0, t, RAMP);
    }
    this._wet.gain.setTargetAtTime(bypass ? 0 : 0.45, t, RAMP);
    this._dry.gain.setTargetAtTime(bypass ? 1 : 0.85, t, RAMP);
    // Slot gains mute inactive faces (including WAMs). Do not destroy WAM
    // instances here — X / Cross only turns FX off until that face is selected again.
  }

  /**
   * Master trim as a fraction of the open level. 0 is silence, 1 is the normal trim.
   * Camera distance scales a stage after this, so the open level stays the baseline.
   * @param {number} amount01
   */
  setOutputLevel(amount01) {
    if (!this._master || !this.ctx) return;
    const amount = Math.min(1, Math.max(0, Number(amount01) || 0));
    if (this._outputAmount === amount) return;
    this._outputAmount = amount;
    this._outputAudible = amount > 0.0001;
    const target = this._outputOpen * amount;
    const t = this.ctx.currentTime;
    this._master.gain.cancelScheduledValues(t);
    // Callers close this only once beds, tails, and splashes are already quiet.
    this._master.gain.setValueAtTime(target, t);
  }

  /** True while a landing splash is still ringing. */
  hasLiveStrikes() {
    for (const corner of CORNERS) {
      const strikes = this.stems[corner]?.strikes;
      if (!strikes) continue;
      for (let i = 0; i < strikes.length; i += 1) {
        if (!strikes[i].released) return true;
      }
    }
    return false;
  }

  /**
   * Distance from the default camera height.
   * `near` and `far` are 0 at the default: baseline level, filter bypassed, no drive.
   * `far` 1 is the farthest zoom (quieter, low-passed). `near` 1 is the closest (louder, soft-clipped).
   * @param {number} near
   * @param {number} far
   */
  setCameraPresence(near, far) {
    if (!this.ctx || !this._viewLevel) return;
    const close = Math.round(clamp01(near) * 10000) / 10000;
    const away = Math.round(clamp01(far) * 10000) / 10000;
    if (this._camClose === close && this._camAway === away) return;
    this._camClose = close;
    this._camAway = away;
    const t = this.ctx.currentTime;
    const tau = 0.045;

    const level =
      (1 + Math.pow(close, 0.9) * 0.8) * (1 - Math.pow(away, 1.05) * 0.68);
    this._viewLevel.gain.setTargetAtTime(level, t, tau);

    const dark = Math.pow(away, 0.9);
    const bright = equalPowerFade(dark);
    this._brightDry.gain.setTargetAtTime(bright.dry, t, tau);
    this._brightWet.gain.setTargetAtTime(bright.wet, t, tau);
    const cutoff = 19000 * Math.pow(680 / 19000, Math.pow(away, 0.75));
    this._viewLp.frequency.setTargetAtTime(cutoff, t, tau);

    const drive = Math.pow(close, 1.3);
    const pre = 1 + drive * 3.4;
    const ref = 0.3;
    const shaped = Math.tanh(pre * ref);
    const post = shaped > 1e-4 ? ref / shaped : 1;
    const grit = equalPowerFade(drive * 0.38);
    this._drivePre.gain.setTargetAtTime(pre, t, tau);
    this._drivePost.gain.setTargetAtTime(post, t, tau);
    this._driveDry.gain.setTargetAtTime(grit.dry, t, tau);
    this._driveWet.gain.setTargetAtTime(grit.wet, t, tau);
  }

  /** Low-pass and soft clip after the master trim. Default camera leaves both bypassed. */
  _buildCameraStage() {
    const ctx = this.ctx;
    this._viewLp = ctx.createBiquadFilter();
    this._viewLp.type = "lowpass";
    this._viewLp.frequency.value = 19000;
    this._viewLp.Q.value = 0.7;

    this._brightDry = ctx.createGain();
    this._brightDry.gain.value = 1;
    this._brightWet = ctx.createGain();
    this._brightWet.gain.value = 0;
    this._camSum = ctx.createGain();
    this._camSum.gain.value = 1;

    this._driveDry = ctx.createGain();
    this._driveDry.gain.value = 1;
    this._drivePre = ctx.createGain();
    this._drivePre.gain.value = 1;
    this._driveShaper = ctx.createWaveShaper();
    this._driveShaper.curve = tanhCurve(2048);
    this._driveShaper.oversample = "2x";
    this._drivePost = ctx.createGain();
    this._drivePost.gain.value = 1;
    this._driveWet = ctx.createGain();
    this._driveWet.gain.value = 0;
    this._driveSum = ctx.createGain();
    this._driveSum.gain.value = 1;

    this._viewLevel = ctx.createGain();
    this._viewLevel.gain.value = 1;

    this._master.connect(this._brightDry);
    this._master.connect(this._viewLp);
    this._viewLp.connect(this._brightWet);
    this._brightDry.connect(this._camSum);
    this._brightWet.connect(this._camSum);
    this._camSum.connect(this._driveDry);
    this._camSum.connect(this._drivePre);
    this._drivePre.connect(this._driveShaper);
    this._driveShaper.connect(this._drivePost);
    this._drivePost.connect(this._driveWet);
    this._driveDry.connect(this._driveSum);
    this._driveWet.connect(this._driveSum);
    this._driveSum.connect(this._viewLevel);
    this._viewLevel.connect(ctx.destination);
  }

  /**
   * One shared hall. Each bed has its own send.
   * Microverb's room samples are not in the project, and its generated tail
   * was too quiet to read as height, so this is a native convolver with a
   * softened noise room turned up enough to hear.
   * The send leaves at the panner, before the weight filters.
   */
  async _loadHall() {
    if (this._hall || !this.ctx || !this._sum) return;
    this._hallSends = {};
    const ctx = this.ctx;
    const input = ctx.createGain();
    input.gain.value = 1;
    const verb = this._createShoulderReverb();
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 6500;
    damp.Q.value = 0.5;
    const ret = ctx.createGain();
    ret.gain.value = 0.85;
    input.connect(verb);
    verb.connect(damp);
    damp.connect(ret);
    ret.connect(this._sum);
    this._hall = { input, verb, ret };
    for (const corner of CORNERS) {
      const send = ctx.createGain();
      send.gain.value = 0;
      const stem = this.stems[corner];
      if (stem?.pan) stem.pan.connect(send);
      send.connect(input);
      this._hallSends[corner] = send;
    }
  }

  /**
   * Resting pile. The short hall stays closed.
   * `weights` darkens and thickens the dry bed. 0 is light. 1 is heavy.
   * Loudness stays on the stem gain. The high shelf stays flat.
   * @param {{ tl?: number, tr?: number, bl?: number, br?: number } | null} halls
   * @param {{ tl?: number, tr?: number, bl?: number, br?: number } | null} weights
   */
  setPileBody(halls, weights) {
    if (!this.running) return;
    for (const corner of CORNERS) {
      const send = this._hallSends?.[corner];
      if (send) writeParam(send.gain, 0, 1e-5);
      const stem = this.stems[corner];
      if (!stem?.weightLp) continue;
      const amount = clamp01(Number(weights?.[corner]) || 0);
      writeParam(stem.weightLp.frequency, weightCutoff(amount), 0.5);
      if (stem.body) writeParam(stem.body.gain, amount * WEIGHT_SHELF_DB, 1e-3);
      if (stem.air) writeParam(stem.air.gain, 0, 1e-4);
      const drive = weightDrive(amount);
      if (stem.satPre) writeParam(stem.satPre.gain, drive.pre, 1e-4);
      if (stem.satPost) writeParam(stem.satPost.gain, drive.post, 1e-4);
      if (stem.satDry) writeParam(stem.satDry.gain, drive.dry, 1e-4);
      if (stem.satWet) writeParam(stem.satWet.gain, drive.wet, 1e-4);
    }
  }

  /**
   * One Greyhole per bed. The rising tail opens that channel's send, taken before the weight filters.
   */
  async _loadStemReverbs() {
    if (this._stemReverbs || !this.ctx) return;
    this._stemReverbs = {};
    for (const corner of CORNERS) {
      try {
        const instance = await loadWam(this.ctx, GREYHOLE_PATH);
        const node = instance.audioNode;
        const send = this.ctx.createGain();
        send.gain.value = 0;
        send.channelCount = 2;
        send.channelCountMode = "explicit";
        send.channelInterpretation = "speakers";
        const ret = this.ctx.createGain();
        // Same wet level as the main-branch Greyhole (diagnostics wet bus).
        ret.gain.value = 0.45;
        const stem = this.stems[corner];
        if (stem?.pan) stem.pan.connect(send);
        send.connect(node);
        node.connect(ret);
        ret.connect(this._sum);
        this._applyAiryGreyhole(node);
        this._stemReverbs[corner] = { instance, send, ret, node, applied: 1, longTail: false, hold: true };
      } catch (err) {
        console.warn(`[EchoScape audio] Greyhole failed for ${corner}:`, err?.message || err);
      }
    }
    const loaded = Object.keys(this._stemReverbs);
    if (loaded.length) console.info("[EchoScape audio] Greyhole per stem", loaded.join(", "));
  }

  /**
   * Fixed Greyhole for rising Diffuse grains.
   * Size and delay stay put. Moving them crossfades the long buffer and glitches.
   * @param {{ setParamValue?: Function }} node
   */
  _applyAiryGreyhole(node) {
    if (!node?.setParamValue) return;
    const delay = this._greyholeDelayCeil();
    const targets = {
      "/greyhole/bypass": 0,
      "/greyhole/damping": 0,
      "/greyhole/modDepth": 0.1,
      "/greyhole/modFreq": 2,
      "/greyhole/size": 3,
      "/greyhole/delayTime": delay,
      "/greyhole/feedback": 0,
      "/greyhole/diffusion": 0.99,
    };
    for (const [name, value] of Object.entries(targets)) {
      try {
        node.setParamValue(name, value);
      } catch {
        /* param name differs */
      }
    }
  }

  /**
   * Greyhole send for rising Diffuse grains. Delay time and size are not touched.
   * Feedback is the long diffuse tail: it reaches max as soon as grains lift, then rings down.
   * `wets` scales the return. An empty quadrant slews it to silence.
   * @param {{ tl?: number, tr?: number, bl?: number, br?: number } | null} levels
   * @param {{ tl?: number, tr?: number, bl?: number, br?: number } | null} [feedbacks]
   * @param {{ tl?: number, tr?: number, bl?: number, br?: number } | null} [wets]
   */
  setDiffuseGreyhole(levels, feedbacks, wets) {
    if (!this.running || !this._stemReverbs) return;
    for (const corner of CORNERS) {
      const rec = this._stemReverbs[corner];
      if (!rec?.send) continue;
      const level = Math.min(1, Math.max(0, Number(levels?.[corner]) || 0));
      writeParam(rec.send.gain, level, 1e-5);
      if (rec.ret && wets) {
        const wet = Math.min(1, Math.max(0, Number(wets[corner]) || 0));
        writeParam(rec.ret.gain, 0.45 * wet, 1e-5);
      }
      if (!rec.node?.setParamValue) continue;
      const rawFeedback = Math.min(1, Math.max(0, Number(feedbacks?.[corner]) || 0));
      const feedback = rawFeedback < 0.01 ? 0 : Math.round(rawFeedback * 100) / 100;
      if (rec.feedback === feedback) continue;
      rec.feedback = feedback;
      try {
        rec.node.setParamValue("/greyhole/feedback", feedback);
      } catch {
        /* param name differs */
      }
    }
  }

  /**
   * greyhole.dsp stores the main echo in de.sdelay(65536, 22050, …).
   * delayTime is in seconds, then multiplied by the sample rate and clamped
   * to 65533. A 1.45s time at 48 kHz lands on the end of that buffer, and the
   * 22050-sample crossfade glitches for as long as delayTime keeps moving.
   * Stay a full crossfade inside the buffer.
   */
  _greyholeDelayCeil() {
    const rate = this.ctx?.sampleRate || 48000;
    const samples = 65536 - 22050 - 64;
    return Math.min(1.45, Math.max(0.2, samples / rate));
  }

  /**
   * Match the diagnostics Square Grey Hole. Stick scales 2.6 and 3.8 pin
   * center-stick to the top of size, delayTime, feedback, and diffusion.
   * Height 1 is that setting. Shorter stacks move toward it.
   * A rising tail holds a long feedback bloom. On a phone that bloom stays
   * inside a lighter size and feedback so four Greyholes are not pinned
   * at the densest setting for the whole rise.
   * @param {number} height01
   * @param {boolean} longTail
   */
  _greyholeTargets(height01, longTail) {
    const h = Math.min(1, Math.max(0, Number(height01) || 0));
    const shaped = longTail ? Math.min(1, 0.82 + 0.18 * h) : h;
    const mobileTail = longTail && isCoarseTouch();
    const feedbackCeil = longTail ? (mobileTail ? 0.92 : 0.98) : 1;
    const sizeMax = mobileTail ? 2 : 3;
    const diffusion = (mobileTail ? 0.72 : 0.99) * shaped;
    return {
      "/greyhole/bypass": 0,
      "/greyhole/damping": 0,
      "/greyhole/modDepth": mobileTail ? 0 : 0.1,
      "/greyhole/modFreq": 2,
      "/greyhole/size": 0.5 + (sizeMax - 0.5) * shaped,
      "/greyhole/delayTime": Math.min(0.001 + (1.45 - 0.001) * shaped, this._greyholeDelayCeil()),
      "/greyhole/feedback": Math.min(feedbackCeil, longTail ? shaped : h),
      "/greyhole/diffusion": diffusion,
    };
  }

  /**
   * @param {{ setParamValue?: Function }} node
   * @param {number} height01
   * @param {boolean} [longTail]
   * @param {boolean} [moveDelays] When false, leave delayTime and size where they are.
   */
  _applyGreyholeHeight(node, height01, longTail = false, moveDelays = true) {
    if (!node?.setParamValue) return;
    const targets = this._greyholeTargets(height01, longTail);
    for (const [name, value] of Object.entries(targets)) {
      if (!moveDelays && (name === "/greyhole/delayTime" || name === "/greyhole/size")) continue;
      try {
        node.setParamValue(name, value);
      } catch {
        /* param name differs */
      }
    }
  }

  /**
   * Per-stem Greyhole send. 0 is dry. 1 is the diagnostics Grey Hole at full throw.
   * `decays` drives the tail length. `longTails` holds the very long rising decay.
   * @param {{ tl?: number, tr?: number, bl?: number, br?: number } | null} levels
   * @param {{ tl?: number, tr?: number, bl?: number, br?: number } | null} [decays]
   * @param {{ tl?: boolean, tr?: boolean, bl?: boolean, br?: boolean } | null} [longTails]
   */
  setStemReverb(levels, decays, longTails) {
    if (!this._stemReverbs) return;
    for (const corner of CORNERS) {
      const rec = this._stemReverbs[corner];
      if (!rec?.send) continue;
      if (rec.hold) continue;
      const level = Math.min(1, Math.max(0, Number(levels?.[corner]) || 0));
      const decay = Math.min(1, Math.max(0, Number(decays?.[corner] ?? level) || 0));
      const longTail = Boolean(longTails?.[corner]);
      rec.send.gain.value = level;
      if (rec.ret) {
        const wet = isCoarseTouch() && longTail ? 0.28 : 0.45;
        if (Math.abs(rec.ret.gain.value - wet) > 0.001) rec.ret.gain.value = wet;
      }
      // delayTime and size move a 65536-sample crossfade. The diffuse tail
      // slews for about 14s, so those two stay put until the tail starts or ends.
      // Feedback still steps down with the decay, which is what lets the bloom release.
      const step = longTail ? 0.12 : 0.04;
      const entered = rec.longTail !== longTail;
      if (!entered && Math.abs(decay - rec.applied) < step) continue;
      rec.applied = decay;
      rec.longTail = longTail;
      this._applyGreyholeHeight(rec.node, decay, longTail, entered || !longTail);
    }
  }

  /**
   * @param {{ tl?: number, tr?: number, bl?: number, br?: number }} gains
   * @param {{ tl?: number, tr?: number, bl?: number, br?: number }} [pans]
   * @param {{ tl?: number, tr?: number, bl?: number, br?: number }} [cutoffs] Hz
   */
  setStemGains(gains, pans, cutoffs) {
    if (!this.running) return;
    for (const corner of CORNERS) {
      const stem = this.stems[corner];
      if (!stem?.gain) continue;
      const level = Math.min(1, Math.max(0, Number(gains?.[corner]) || 0));
      writeParam(stem.gain.gain, level, 1e-5);
      if (stem.pan) {
        const placed = Math.min(1, Math.max(-1, Number(pans?.[corner]) || 0));
        writeParam(stem.pan.pan, placed, 1e-4);
      }
      if (stem.tone) {
        const hz = Number(cutoffs?.[corner]);
        writeParam(stem.tone.frequency, Number.isFinite(hz) && hz > 0 ? hz : 20000, 0.5);
      }
    }
  }

  /**
   * Decode a copy of the bed so a landing can play at its own pitch.
   * @param {string} corner
   * @param {string} url
   */
  _primeStrikeBuffer(corner, url) {
    if (!this.ctx || !url) return;
    if (!this._strikeBuffers) this._strikeBuffers = {};
    if (!this._strikeToken) this._strikeToken = {};
    const next = (this._strikeToken[corner] || 0) + 1;
    this._strikeToken[corner] = next;
    this._strikeBuffers[corner] = null;
    const ctx = this.ctx;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.arrayBuffer();
      })
      .then((raw) => ctx.decodeAudioData(raw))
      .then((buffer) => {
        if (this._strikeToken[corner] !== next) return;
        this._strikeBuffers[corner] = buffer;
        this._adoptBufferBed(corner, buffer);
      })
      .catch((err) => {
        console.warn("[EchoScape audio] strike buffer", corner, err?.message || err);
      });
  }

  /**
   * HTML media `loop` leaves a silence at the wrap point, and each element keeps a decoder running.
   * Once the bed is decoded, play that copy from a looping buffer instead and
   * pause the element so the gap, and a second decoder, stay out of the mix.
   * @param {string} corner
   * @param {AudioBuffer} buffer
   * @param {number} [offset]
   */
  _adoptBufferBed(corner, buffer, offset) {
    if (!this.ctx || !buffer || !(buffer.duration > 0)) return;
    const stem = this.stems[corner];
    if (!stem?.gain) return;
    if (stem.bedVoice && stem.bedBuffer === buffer) return;
    this._stopBufferBed(stem);
    const dur = buffer.duration;
    const fromEl = Number(stem.el?.currentTime);
    const raw = Number.isFinite(offset) ? offset : Number.isFinite(fromEl) ? fromEl : 0;
    const pos = ((raw % dur) + dur) % dur;
    const rate = stem.el?.playbackRate > 0 ? stem.el.playbackRate : 1;
    if (stem.el && !stem.el.paused) {
      try {
        stem.el.pause();
      } catch {
        /* ignore */
      }
    }
    try {
      stem.source?.disconnect();
    } catch {
      /* already disconnected */
    }
    const voice = this.ctx.createBufferSource();
    voice.buffer = buffer;
    voice.loop = true;
    voice.playbackRate.value = rate;
    voice.connect(stem.gain);
    const when = this.ctx.currentTime;
    voice.start(when, pos);
    stem.bedVoice = voice;
    stem.bedBuffer = buffer;
    stem.bedStartedAt = when;
    stem.bedOffset = pos;
    voice.onended = () => {
      if (stem.bedVoice !== voice) return;
      stem.bedVoice = null;
      if (!this.running || this.ctx?.state === "closed") return;
      if (stem.notes?.length) return;
      this._adoptBufferBed(corner, buffer, 0);
    };
  }

  /** @param {{ bedVoice?: AudioBufferSourceNode | null }} stem */
  _stopBufferBed(stem) {
    const voice = stem?.bedVoice;
    if (!voice) return;
    stem.bedVoice = null;
    try {
      voice.onended = null;
    } catch {
      /* ignore */
    }
    try {
      voice.stop();
    } catch {
      /* already stopped */
    }
    try {
      voice.disconnect();
    } catch {
      /* already disconnected */
    }
  }

  _clampRate(raw) {
    const next = Number(raw);
    if (!Number.isFinite(next) || next <= 0) return 1;
    return Math.min(4, Math.max(0.25, next));
  }

  /** @param {{ voice?: AudioBufferSourceNode | null, startedAt?: number, offset?: number }} slot */
  _notePosition(slot) {
    const buffer = slot?.voice?.buffer;
    if (!buffer || !(buffer.duration > 0) || !this.ctx) return 0;
    const rate = slot.voice.playbackRate.value || 1;
    const elapsed = (this.ctx.currentTime - (slot.startedAt || 0)) * rate;
    const pos = (slot.offset || 0) + elapsed;
    return ((pos % buffer.duration) + buffer.duration) % buffer.duration;
  }

  /**
   * Seconds into the looping bed, so a landing can start at that same point.
   * @param {{ el?: HTMLAudioElement, notes?: { voice?: AudioBufferSourceNode | null }[], bedVoice?: AudioBufferSourceNode | null, bedBuffer?: AudioBuffer | null, bedStartedAt?: number, bedOffset?: number }} stem
   */
  _bedPosition(stem, pileId) {
    if (pileId != null) {
      const note = stem?.notes?.find((slot) => slot.id === pileId && slot.voice);
      if (note) return this._notePosition(note);
    }
    const note = stem?.notes?.find((slot) => slot.voice);
    if (note) return this._notePosition(note);
    const buffer = stem?.bedBuffer;
    const voice = stem?.bedVoice;
    if (buffer && voice && buffer.duration > 0 && this.ctx) {
      const rate = voice.playbackRate.value || 1;
      const elapsed = (this.ctx.currentTime - (stem.bedStartedAt || 0)) * rate;
      const pos = (stem.bedOffset || 0) + elapsed;
      return ((pos % buffer.duration) + buffer.duration) % buffer.duration;
    }
    return Number(stem?.el?.currentTime) || 0;
  }

  /** Offset inside a looping buffer. Never equal to the duration, which start() rejects. */
  _loopOffset(position, duration) {
    if (!(duration > 0)) return 0;
    const wrapped = (((Number(position) || 0) % duration) + duration) % duration;
    return wrapped >= duration ? 0 : wrapped;
  }

  /** @param {{ voice?: AudioBufferSourceNode | null, gain?: GainNode | null }} slot */
  _releasePileNote(slot) {
    if (!slot) return;
    const voice = slot.voice;
    slot.voice = null;
    if (!voice) return;
    try {
      voice.onended = null;
    } catch {
      /* ignore */
    }
    const now = this.ctx?.currentTime || 0;
    try {
      if (slot.gain) {
        const gain = slot.gain.gain;
        const current = Math.max(0.0001, gain.value || 0.0001);
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(current, now);
        gain.linearRampToValueAtTime(0.0001, now + 0.04);
      }
      voice.stop(now + 0.05);
      const gainNode = slot.gain;
      window.setTimeout(() => {
        try {
          voice.disconnect();
        } catch {
          /* already gone */
        }
        try {
          gainNode?.disconnect();
        } catch {
          /* already gone */
        }
      }, 80);
    } catch {
      /* already stopped */
    }
  }

  /** @param {{ notes?: object[] }} stem */
  _stopPileNotes(stem) {
    if (!stem?.notes?.length) return;
    while (stem.notes.length) this._releasePileNote(stem.notes.pop());
  }

  /**
   * One looping copy of the quadrant sample per connected pile.
   * @param {string} corner
   * @param {{ id: number, rate: number, share: number }[]} notes
   */
  _syncPileNotes(corner, notes) {
    const stem = this.stems[corner];
    if (!stem) return;
    if (!stem.notes) stem.notes = [];
    const wanted = notes.filter((note) => note && note.id != null);
    if (!wanted.length) {
      this._stopPileNotes(stem);
      return;
    }
    const buffer = stem.bedBuffer || this._strikeBuffers?.[corner] || null;
    if (!buffer || !this.ctx) {
      this._stopPileNotes(stem);
      const el = stem.el;
      if (!el) return;
      let best = wanted[0];
      for (let i = 1; i < wanted.length; i += 1) {
        if ((Number(wanted[i].share) || 0) > (Number(best.share) || 0)) best = wanted[i];
      }
      const next = this._clampRate(best.rate);
      if (el.preservesPitch !== false) el.preservesPitch = false;
      if (Math.abs(el.playbackRate - next) > 0.002) el.playbackRate = next;
      return;
    }
    this._stopBufferBed(stem);
    if (stem.el && !stem.el.paused) {
      try {
        stem.el.pause();
      } catch {
        /* ignore */
      }
    }
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const keep = new Set();
    for (let i = 0; i < wanted.length; i += 1) {
      const note = wanted[i];
      const id = note.id;
      keep.add(id);
      const rate = this._clampRate(note.rate);
      const share = Math.sqrt(Math.min(1, Math.max(0, Number(note.share) || 0)));
      const level = share > 0 ? share : 1 / Math.sqrt(wanted.length);
      let index = -1;
      for (let n = 0; n < stem.notes.length; n += 1) {
        if (stem.notes[n].id === id) {
          index = n;
          break;
        }
      }
      const existing = index >= 0 ? stem.notes[index] : null;
      if (!existing?.voice) {
        if (existing) this._releasePileNote(existing);
        const gain = ctx.createGain();
        gain.gain.value = 0.0001;
        const voice = ctx.createBufferSource();
        voice.buffer = buffer;
        voice.loop = true;
        voice.playbackRate.value = rate;
        const dur = buffer.duration;
        let pos = 0;
        for (let n = 0; n < stem.notes.length; n += 1) {
          if (stem.notes[n].voice) {
            pos = this._notePosition(stem.notes[n]);
            break;
          }
        }
        const offset = dur > 0 ? ((pos % dur) + dur) % dur : 0;
        voice.connect(gain);
        gain.connect(stem.gain);
        voice.start(now, offset);
        gain.gain.linearRampToValueAtTime(level, now + 0.04);
        const slot = { id, voice, gain, startedAt: now, offset, rate };
        voice.onended = () => {
          if (slot.voice !== voice) return;
          slot.voice = null;
        };
        if (index >= 0) stem.notes[index] = slot;
        else stem.notes.push(slot);
        continue;
      }
      if (Math.abs(existing.voice.playbackRate.value - rate) > 0.002) existing.voice.playbackRate.value = rate;
      existing.rate = rate;
      const gain = existing.gain.gain;
      const current = Math.max(0.0001, gain.value || 0.0001);
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(current, now);
      gain.setTargetAtTime(level, now, 0.05);
    }
    for (let i = stem.notes.length - 1; i >= 0; i -= 1) {
      if (keep.has(stem.notes[i].id)) continue;
      this._releasePileNote(stem.notes[i]);
      stem.notes.splice(i, 1);
    }
  }

  /**
   * Pitch each quadrant's bed.
   * An array of `{ id, rate, share }` is one note per connected pile.
   * A number keeps the older single rate. Null returns every bed to its original pitch.
   * @param {{ tl?: number | { id: number, rate: number, share: number }[], tr?: number | { id: number, rate: number, share: number }[], bl?: number | { id: number, rate: number, share: number }[], br?: number | { id: number, rate: number, share: number }[] } | null} rates
   */
  setStemPitch(rates) {
    if (!this.running) return;
    for (const corner of CORNERS) {
      const stem = this.stems[corner];
      if (!stem) continue;
      const raw = rates ? rates[corner] : null;
      if (Array.isArray(raw)) {
        this._syncPileNotes(corner, raw);
        continue;
      }
      this._stopPileNotes(stem);
      const next = this._clampRate(raw);
      const voice = stem.bedVoice;
      if (voice) {
        if (Math.abs(voice.playbackRate.value - next) > 0.002) voice.playbackRate.value = next;
        continue;
      }
      const el = stem.el;
      if (!el) continue;
      if (el.preservesPitch !== false) el.preservesPitch = false;
      if (Math.abs(el.playbackRate - next) > 0.002) el.playbackRate = next;
    }
  }

  /**
   * Landing voice for each pile.
   * Grain and tick are short one-shots. Another landing on that pile inside
   * 110ms is skipped. Phrase restarts the sample in phase with the bed.
   * @param {Record<string, ({ life: number, rate?: number, x?: number, z?: number, pileId?: number } | number)[]> | null} hits
   */
  playSplash(hits) {
    if (!this.running || !this.ctx || !this._splashOut || !hits) return;
    for (const corner of CORNERS) {
      const lives = hits[corner];
      if (!lives?.length) continue;
      const groups = new Map();
      for (let i = 0; i < lives.length; i += 1) {
        const hit = lives[i];
        const pileId = hit?.pileId;
        const key = pileId == null ? "rate" : pileId;
        let group = groups.get(key);
        if (!group) {
          group = { pileId, rate: strikeRate(hit), lives: [] };
          groups.set(key, group);
        }
        group.lives.push(hit);
      }
      for (const group of groups.values()) this._strikeStem(corner, group);
    }
  }

  _releaseStrike(stem, strike) {
    if (!stem || !strike || strike.released) return;
    strike.released = true;
    if (strike.timer) {
      window.clearTimeout(strike.timer);
      strike.timer = 0;
    }
    const list = stem.strikes;
    if (list) {
      const index = list.indexOf(strike);
      if (index >= 0) list.splice(index, 1);
    }
    if (strike.voice) {
      try {
        strike.voice.stop();
      } catch {
        /* already stopped */
      }
    }
    if (strike.sparkVoice) {
      try {
        strike.sparkVoice.stop();
      } catch {
        /* already stopped */
      }
    }
    if (strike.tap && strike.gain) {
      try {
        strike.tap.disconnect(strike.gain);
      } catch {
        /* already disconnected */
      }
    }
    for (const node of strike.nodes) {
      try {
        node.disconnect();
      } catch {
        /* already gone */
      }
    }
  }

  _releaseStrikes(stem) {
    if (!stem?.strikes) return;
    while (stem.strikes.length) this._releaseStrike(stem, stem.strikes[0]);
  }

  /**
   * Match the splash shelves to the bed so a short warm pile does not splash bright.
   * @param {{ body?: BiquadFilterNode, air?: BiquadFilterNode }} stem
   * @param {BiquadFilterNode} body
   * @param {BiquadFilterNode} air
   */
  _copySplashShelves(stem, body, air) {
    const apply = (from, to, fallback) => {
      to.type = from?.type || fallback.type;
      to.frequency.value = Number(from?.frequency?.value) || fallback.frequency;
      to.Q.value = Number(from?.Q?.value) || fallback.Q;
      to.gain.value = Number.isFinite(Number(from?.gain?.value)) ? Number(from.gain.value) : fallback.gain;
    };
    apply(stem?.body, body, { type: "lowshelf", frequency: 200, Q: 0.7, gain: 0 });
    apply(stem?.air, air, { type: "highshelf", frequency: 650, Q: 0.7, gain: 0 });
  }

  /** Fade at the end of a phrase. The body of the event is the rest of `dur`. */
  _phraseRelease(dur) {
    return Math.min(0.16, Math.max(0.08, dur * 0.18));
  }

  /**
   * Start the level, the opening, and the pitch.
   * The peak holds while the low-pass opens, then fades.
   */
  _shapeSplash(strike, stem, when, dur, peak, rate, panValue, startHz, endHz) {
    const release = this._phraseRelease(dur);
    const hold = dur - release;
    const level = Math.max(0.001, peak);
    const gain = strike.gain.gain;
    gain.cancelScheduledValues(when);
    const from = strike.live ? Math.max(0.001, gain.value || 0.001) : 0.001;
    gain.setValueAtTime(from, when);
    gain.exponentialRampToValueAtTime(level, when + 0.012);
    if (hold > 0.02) gain.setValueAtTime(level, when + hold);
    gain.exponentialRampToValueAtTime(0.001, when + dur);

    const cutoff = strike.filter.frequency;
    cutoff.cancelScheduledValues(when);
    cutoff.setValueAtTime(startHz, when);
    if (endHz > startHz) cutoff.exponentialRampToValueAtTime(endHz, when + dur);

    if (strike.pan) strike.pan.pan.setValueAtTime(panValue, when);
    if (strike.voice) strike.voice.playbackRate.setValueAtTime(rate, when);
    this._copySplashShelves(stem, strike.body, strike.air);
    strike.until = when + dur;
    strike.live = true;
  }

  /**
   * A later ring outlasts the phrase that is already opening.
   * The low-pass keeps its original sweep. Only the level is held out to this ring.
   */
  _extendSplash(strike, when, until, peak, rate, panValue) {
    const dur = Math.max(0.05, until - when);
    const release = Math.min(this._phraseRelease(dur), dur * 0.45);
    const holdAt = until - release;
    const level = Math.max(0.001, peak);
    const gain = strike.gain.gain;
    gain.cancelScheduledValues(when);
    const from = Math.max(0.001, gain.value || level);
    gain.setValueAtTime(from, when);
    if (from < level) gain.exponentialRampToValueAtTime(level, when + Math.min(0.02, dur * 0.25));
    if (holdAt > when + 0.02) gain.setValueAtTime(level, holdAt);
    gain.exponentialRampToValueAtTime(0.001, until);
    if (strike.pan) strike.pan.pan.setValueAtTime(panValue, when);
    if (strike.voice) strike.voice.playbackRate.setValueAtTime(rate, when);
    strike.until = until;
    strike.live = true;
  }

  /**
   * A short octave-up copy of the landing, high-passed, off to the side of the
   * phrase low-pass so the top is bright while the body is still opening.
   * One glint per landing. It fades with the ring.
   * @param {{ sparkGain?: GainNode, sparkVoice?: AudioBufferSourceNode | null, nodes?: AudioNode[] }} strike
   * @param {AudioBuffer | null} buffer
   * @param {number} sparkDur
   */
  _sparkSplash(strike, buffer, when, rate, offset, peak, sparkDur) {
    if (!this.ctx || !buffer || !strike?.sparkGain) return;
    const previous = strike.sparkVoice;
    if (previous) {
      try {
        previous.stop();
      } catch {
        /* already stopped */
      }
      try {
        previous.disconnect();
      } catch {
        /* already gone */
      }
      const index = strike.nodes?.indexOf(previous) ?? -1;
      if (index >= 0) strike.nodes.splice(index, 1);
    }
    const sparkRate = Math.min(4, Math.max(0.5, rate * 2));
    const voice = this.ctx.createBufferSource();
    voice.buffer = buffer;
    voice.loop = false;
    voice.playbackRate.value = sparkRate;
    voice.connect(strike.sparkGain);
    const heard = Math.max(0.05, sparkDur);
    const playDur = Math.min(buffer.duration, Math.max(0.02, heard * sparkRate));
    const startAt = this._loopOffset(offset, buffer.duration);
    const room = Math.max(0.02, buffer.duration - startAt);
    try {
      voice.start(when, startAt, Math.min(playDur, room));
    } catch {
      try {
        voice.disconnect();
      } catch {
        /* already gone */
      }
      return;
    }
    strike.sparkVoice = voice;
    if (strike.nodes) strike.nodes.push(voice);
    const level = Math.max(0.001, peak * SPARKLE_LEVEL);
    const gain = strike.sparkGain.gain;
    gain.cancelScheduledValues(when);
    gain.setValueAtTime(0.001, when);
    gain.exponentialRampToValueAtTime(level, when + 0.008);
    gain.exponentialRampToValueAtTime(0.001, when + heard);
  }

  _armSplashRelease(stem, strike, dur) {
    if (strike.timer) {
      window.clearTimeout(strike.timer);
      strike.timer = 0;
    }
    strike.timer = window.setTimeout(() => {
      this._releaseStrike(stem, strike);
    }, (dur + 0.08) * 1000);
  }

  /**
   * Grain, tick, or phrase. Switching releases voices that are still ringing.
   * @param {string} mode
   */
  setSplashMode(mode) {
    const next = mode === "tick" || mode === "phrase" ? mode : "grain";
    if (this.splashMode === next) return;
    this.splashMode = next;
    for (const corner of CORNERS) this._releaseStrikes(this.stems[corner]);
  }

  _impactKey(pileId) {
    return pileId == null ? "_" : pileId;
  }

  /** True while this pile is still inside the impact window. */
  _impactCooling(corner, pileId) {
    const last = this._impactAt?.[corner]?.get(this._impactKey(pileId));
    if (last == null || !this.ctx) return false;
    return this.ctx.currentTime - last < SPLASH_REFRACTORY;
  }

  _markImpact(corner, pileId, when) {
    if (!this._impactAt) this._impactAt = {};
    if (!this._impactAt[corner]) this._impactAt[corner] = new Map();
    this._impactAt[corner].set(this._impactKey(pileId), when);
  }

  /** White noise for the tick. The bandpass, not playback rate, sets the pitch. */
  _tickNoiseBuffer() {
    if (!this.ctx) return null;
    if (this._tickNoise && this._tickNoise.sampleRate === this.ctx.sampleRate) return this._tickNoise;
    const seconds = 0.25;
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = this.ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    this._tickNoise = buffer;
    return buffer;
  }

  /**
   * Fast attack, an optional hold, then a decay across the rest of the event.
   * The filter stays put. Tick passes no hold.
   * @param {{ gain: GainNode, live: boolean }} strike
   * @param {number} [holdSec]
   */
  _shapeImpact(strike, when, dur, peak, holdSec) {
    const level = Math.max(0.001, peak);
    const attack = Math.min(0.005, dur * 0.2);
    const hold = Math.min(Math.max(0, Number(holdSec) || 0), Math.max(0, dur - attack - 0.01));
    const gain = strike.gain.gain;
    gain.cancelScheduledValues(when);
    gain.setValueAtTime(0.001, when);
    gain.exponentialRampToValueAtTime(level, when + attack);
    if (hold > 0.001) gain.setValueAtTime(level, when + attack + hold);
    gain.exponentialRampToValueAtTime(0.001, when + dur);
    strike.live = true;
  }

  /**
   * One short event for the pile. Grain plays a cell-sized slice of the sample
   * through a bandpass above the bed, and holds the peak before it decays.
   * Tick is noise through a bandpass at the pile pitch. A landing inside the
   * refractory window does not start another voice.
   * @param {"grain" | "tick"} mode
   */
  _strikeImpact(corner, group, mode) {
    const stem = this.stems[corner];
    if (!stem?.source || !this.ctx || !this._splashOut) return;
    if (!stem.strikes) stem.strikes = [];
    const lives = group?.lives || [];
    const audible = lives.filter((hit) => strikeLife(hit) > 0);
    if (!audible.length) return;
    const pileId = group.pileId;
    if (this._impactCooling(corner, pileId)) return;

    const tick = mode === "tick";
    const buffer = tick ? this._tickNoiseBuffer() : this._strikeBuffers?.[corner] || stem.bedBuffer || null;
    if (!buffer) return;

    const ctx = this.ctx;
    const dur = tick ? TICK_SEC : GRAIN_SEC;
    const note = pileId == null ? null : stem.notes?.find((slot) => slot.id === pileId);
    const playing = Number(note?.voice?.playbackRate?.value);
    const rate = this._clampRate(Number.isFinite(playing) && playing > 0 ? playing : note?.rate || group.rate);
    const stemLevel = Number(stem.gain?.gain?.value) || 0;
    const hz = tick ? tickHz(rate) : GRAIN_BP_HZ;
    const peak = tick
      ? impactAmount(stemLevel, audible.length) * tickMakeup(TICK_Q, ctx.sampleRate, hz)
      : impactPeak(stemLevel, rate, audible.length) * GRAIN_LIFT;
    const panValue = stem.pan ? stem.pan.pan.value : 0;

    let live = null;
    for (let i = 0; i < stem.strikes.length; i += 1) {
      const strike = stem.strikes[i];
      if (strike.released) continue;
      if (pileId == null ? strike.pileId == null : strike.pileId === pileId) live = strike;
    }
    if (live) this._releaseStrike(stem, live);

    const gain = ctx.createGain();
    gain.gain.value = 0.001;
    const body = ctx.createBiquadFilter();
    const air = ctx.createBiquadFilter();
    const filter = ctx.createBiquadFilter();
    if (tick) {
      filter.type = "bandpass";
      filter.Q.value = TICK_Q;
      filter.frequency.value = hz;
    } else {
      filter.type = "bandpass";
      filter.Q.value = GRAIN_BP_Q;
      filter.frequency.value = hz;
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = panValue;
    this._copySplashShelves(stem, body, air);

    const voice = ctx.createBufferSource();
    voice.buffer = buffer;
    voice.loop = false;
    voice.playbackRate.value = tick ? 1 : rate;
    const when = ctx.currentTime;
    let offset = 0;
    let playDur = Math.min(buffer.duration, dur);
    if (!tick) {
      const slice = grainSlice(buffer, audible[0], rate);
      offset = slice.offset;
      playDur = slice.duration;
    }
    if (offset + playDur > buffer.duration) playDur = Math.max(0.01, buffer.duration - offset);
    voice.connect(gain);
    try {
      voice.start(when, offset, Math.max(0.01, playDur));
    } catch {
      try {
        voice.disconnect();
      } catch {
        /* already gone */
      }
      return;
    }

    gain.connect(body);
    body.connect(air);
    air.connect(filter);
    filter.connect(pan);
    pan.connect(this._splashOut);
    const nodes = [gain, body, air, filter, pan, voice];
    const strike = {
      nodes,
      voice,
      tap: null,
      gain,
      body,
      air,
      filter,
      pan,
      pileId,
      timer: 0,
      released: false,
      live: false,
    };
    stem.strikes.push(strike);
    this._shapeImpact(strike, when, dur, peak, tick ? 0 : GRAIN_HOLD_SEC);
    this._armSplashRelease(stem, strike, dur);
    this._markImpact(corner, pileId, when);
  }

  _strikeStem(corner, group) {
    const mode = this.splashMode === "tick" || this.splashMode === "phrase" ? this.splashMode : "grain";
    if (mode !== "phrase") {
      this._strikeImpact(corner, group, mode);
      return;
    }
    const stem = this.stems[corner];
    if (!stem?.source) return;
    if (!stem.strikes) stem.strikes = [];
    const lives = group?.lives || [];
    const audible = lives.filter((hit) => strikeLife(hit) > 0);
    if (!audible.length) return;
    const ctx = this.ctx;
    const ring = strikeBurstLife(audible);
    const dur = ring + PHRASE_TAIL;
    const pileId = group.pileId;
    const note = pileId == null ? null : stem.notes?.find((slot) => slot.id === pileId);
    const playing = Number(note?.voice?.playbackRate?.value);
    const rate = this._clampRate(Number.isFinite(playing) && playing > 0 ? playing : note?.rate || group.rate);
    const stemLevel = Number(stem.gain?.gain?.value) || 0;
    const peak = strikePeak(stemLevel, rate, audible.length);
    const { start: startHz, end: endHz } = strikeSplashCutoffs(stem);
    const panValue = stem.pan ? stem.pan.pan.value : 0;

    const buffer = this._strikeBuffers?.[corner] || stem.bedBuffer || null;
    let live = null;
    for (let i = 0; i < stem.strikes.length; i += 1) {
      const strike = stem.strikes[i];
      if (strike.released) continue;
      if (pileId == null ? strike.pileId == null : strike.pileId === pileId) live = strike;
    }
    // A landing that arrived before the file decoded taps the element.
    // Once a buffer exists, that tap is silent if the element was paused for the pile notes.
    if (live && !live.voice && buffer) {
      this._releaseStrike(stem, live);
      live = null;
    }
    if (live) {
      const when = ctx.currentTime;
      const wantUntil = when + dur;
      if (wantUntil > (live.until || 0) + 0.015) {
        this._extendSplash(live, stem, when, wantUntil, peak, rate, panValue);
        this._armSplashRelease(stem, live, wantUntil - when);
      } else {
        if (live.pan) live.pan.pan.setValueAtTime(panValue, when);
        if (live.voice) live.voice.playbackRate.setValueAtTime(rate, when);
      }
      if (buffer) this._sparkSplash(live, buffer, when, rate, this._bedPosition(stem, pileId), peak, ring);
      return;
    }

    const gain = ctx.createGain();
    gain.gain.value = 0.001;
    const body = ctx.createBiquadFilter();
    const air = ctx.createBiquadFilter();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.85;
    filter.frequency.value = startHz;
    const sparkGain = ctx.createGain();
    sparkGain.gain.value = 0.001;
    const sparkHp = ctx.createBiquadFilter();
    sparkHp.type = "highpass";
    sparkHp.Q.value = 0.7;
    sparkHp.frequency.value = SPARKLE_HP_HZ;
    const pan = ctx.createStereoPanner();
    pan.pan.value = panValue;
    this._copySplashShelves(stem, body, air);
    const nodes = [gain, body, air, filter, sparkGain, sparkHp, pan];
    /** @type {AudioBufferSourceNode | null} */
    let voice = null;
    /** @type {AudioNode | null} */
    let tap = null;
    const when = ctx.currentTime;
    const splashOffset = buffer ? this._bedPosition(stem, pileId) : 0;
    if (buffer) {
      voice = ctx.createBufferSource();
      voice.buffer = buffer;
      voice.loop = true;
      voice.playbackRate.value = rate;
      voice.connect(gain);
      voice.start(when, this._loopOffset(splashOffset, buffer.duration));
      nodes.push(voice);
    } else if (stem.el && !stem.el.paused && stem.source) {
      tap = stem.source;
      tap.connect(gain);
    } else {
      return;
    }
    gain.connect(body);
    body.connect(air);
    air.connect(filter);
    filter.connect(pan);
    sparkGain.connect(sparkHp);
    sparkHp.connect(pan);
    pan.connect(this._splashOut);
    const strike = {
      nodes,
      voice,
      tap,
      gain,
      body,
      air,
      filter,
      pan,
      sparkGain,
      sparkVoice: null,
      sparkAt: null,
      pileId,
      timer: 0,
      released: false,
      live: false,
    };
    stem.strikes.push(strike);
    this._shapeSplash(strike, stem, when, dur, peak, rate, panValue, startHz, endHz);
    if (buffer) this._sparkSplash(strike, buffer, when, rate, splashOffset, peak, ring);
    this._armSplashRelease(stem, strike, dur);
  }

  /**
   * The shared low-pass stays open. Each stem's own filter carries brightness.
   * @param {number} _amount
   */
  setMotionDepth(_amount) {
    if (!this._tone) return;
    this._tone.frequency.value = 20000;
    this._tone.Q.value = 0.7;
  }

  /**
   * Apply mixer-core state to the audio graph.
   * @param {{x:number,y:number}} mixState
   * @param {object} controller
   * @param {{ stems?: boolean }} [opts]
   * `stems: false` leaves each bed's gain, pan, and low-pass alone.
   * Falling Blocks sets those from the grid immediately after this call.
   * Writing the center mix first opens every bed for one render quantum.
   * On an empty grid that quantum is a crackle.
   */
  sync(mixState, controller, opts) {
    if (!this.running || !this.ctx) return;
    const t = this.ctx.currentTime;

    if (opts?.stems !== false) {
      const weights = equalPowerMix(mixState.x, mixState.y);
      for (const corner of CORNERS) {
        const stem = this.stems[corner];
        if (!stem) continue;
        // Snap gains — setTargetAtTime with RAMP was fine, but immediate
        // values make first audible frame reliable after start.
        writeParam(stem.gain.gain, weights[corner], 1e-5);
        if (stem.pan) writeParam(stem.pan.pan, 0, 1e-4);
        if (stem.tone) writeParam(stem.tone.frequency, 20000, 0.5);
      }
    }

    if (controller.activeFx !== this.activeFx) {
      this.setActiveFx(controller.activeFx);
    }

    if (controller.activeFx !== "cross") {
      const slot = controller.fx[controller.activeFx];
      const fx = this.fx[controller.activeFx];
      if (slot && fx?.apply) {
        if (this._fxWam?.[controller.activeFx]) {
          fx.apply(Number(controller.rawX) || 0, Number(controller.rawY) || 0);
        } else {
          fx.apply(Number(slot.x) || 0, Number(slot.y) || 0);
        }
      }
    }

    const pan = clamp01((Number(controller.rightX) || 0) * 0.5 + 0.5) * 2 - 1;
    writeParam(this._panner.pan, pan * 0.9, 1e-4);

    const lt = clamp01(Math.abs(Number(controller.lt) || 0) > 1.5 ? controller.lt / 255 : controller.lt);
    const rt = clamp01(Math.abs(Number(controller.rt) || 0) > 1.5 ? controller.rt / 255 : controller.rt);
    // Released = wide open. LT sweeps the lowpass up from ~200 Hz; RT sweeps the highpass down from ~8 kHz.
    writeParam(this._tone.frequency, lt <= 0.001 ? 20000 : 200 * Math.pow(18000 / 200, lt), 0.5);
    writeParam(this._tone.Q, 0.7, 1e-4);
    if (this._hp) {
      writeParam(this._hp.frequency, rt <= 0.001 ? 20 : 8000 * Math.pow(35 / 8000, rt), 0.5);
    }

    this._applyShoulders(controller.l1, controller.r1, t);
    this.setStemReverb(null);
  }
}

export const audioEngine = new EchoScapeAudioEngine();
