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
} from "./mixer-core.js?v=65";
import {
  loadWam,
  resolveStickBinding,
  applyWamDefaults,
  applyStickToWamParams,
} from "./wam-host.js?v=7";
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

/** Equal-power dry/wet. `mix` 0 is fully dry. */
function equalPowerFade(mix) {
  const m = clamp01(mix);
  const angle = m * Math.PI * 0.5;
  return { dry: Math.cos(angle), wet: Math.sin(angle) };
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

/** Up to `max` lifetimes spread from shortest to longest. */
function sampleLifetimes(lives, max) {
  const sorted = lives.filter((n) => n > 0).sort((a, b) => a - b);
  if (sorted.length <= max) return sorted;
  const out = [];
  for (let i = 0; i < max; i += 1) {
    const idx = Math.round((i * (sorted.length - 1)) / (max - 1));
    out.push(sorted[idx]);
  }
  return out;
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
    this.fx = {};
    this.activeFx = "cross";
    /** True while the master trim is at its open level. Falling Blocks closes it on an empty grid. */
    this._outputAudible = true;
    this._outputOpen = 0.28;
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
    this.error = null;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      this.error = "Web Audio is not available in this browser.";
      throw new Error(this.error);
    }

    this.ctx = new AC();
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

  async ensurePlaying() {
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

  async _playAll() {
    const plays = CORNERS.map(async (corner) => {
      const stem = this.stems[corner];
      if (!stem?.el) return;
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
      const stem = this.stems[corner];
      if (!stem) continue;
      try {
        stem.el.pause();
        stem.el.removeAttribute("src");
        stem.el.load();
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

    const el = new Audio();
    el.loop = true;
    el.preload = "auto";
    el.src = url;

    await waitForMedia(el);

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
    const weights = equalPowerMix(mixerState.x, mixerState.y);
    const initialGain =
      typeof opts.initialGain === "number" ? opts.initialGain : weights[corner] ?? 0;
    gain.gain.value = initialGain;
    pan.pan.value = 0;
    source.connect(gain);
    gain.connect(mono);
    mono.connect(pan);
    pan.connect(tone);
    tone.connect(this._sum);
    const reverbSend = this._stemReverbs?.[corner]?.send;
    if (reverbSend) tone.connect(reverbSend);

    if (prev) {
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
      } catch {
        /* ignore */
      }
    }

    this.stems[corner] = { el, source, gain, mono, pan, tone, meta };

    if (opts.resume !== false && this.running) {
      try {
        el.muted = false;
        el.volume = 1;
        await el.play();
      } catch (err) {
        console.warn("[EchoScape audio] stem play failed:", err?.message || err);
        throw err;
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
    this._outputAudible = amount > 0.0001;
    this._master.gain.value = this._outputOpen * amount;
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
    const close = clamp01(near);
    const away = clamp01(far);
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
   * One Greyhole per bed. Height opens that channel's send; the tail stays on that sample.
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
        // Same wet level as the diagnostics face slot (wet bus at 0.45).
        ret.gain.value = 0.45;
        const stem = this.stems[corner];
        if (stem?.tone) stem.tone.connect(send);
        send.connect(node);
        node.connect(ret);
        ret.connect(this._sum);
        this._applyGreyholeHeight(node, 0);
        this._stemReverbs[corner] = { instance, send, node, applied: -1 };
      } catch (err) {
        console.warn(`[EchoScape audio] Greyhole failed for ${corner}:`, err?.message || err);
      }
    }
    const loaded = Object.keys(this._stemReverbs);
    if (loaded.length) console.info("[EchoScape audio] Greyhole per stem", loaded.join(", "));
  }

  /**
   * Match the diagnostics Square Grey Hole. Stick scales 2.6 and 3.8 pin
   * center-stick to the top of size, delayTime, feedback, and diffusion.
   * Height 1 is that setting. Shorter stacks move toward it.
   * @param {{ setParamValue?: Function }} node
   * @param {number} height01
   */
  _applyGreyholeHeight(node, height01) {
    if (!node?.setParamValue) return;
    const h = Math.min(1, Math.max(0, Number(height01) || 0));
    const pairs = [
      ["/greyhole/bypass", 0],
      ["/greyhole/damping", 0],
      ["/greyhole/modDepth", 0.1],
      ["/greyhole/modFreq", 2],
      ["/greyhole/size", 0.5 + (3 - 0.5) * h],
      ["/greyhole/delayTime", 0.001 + (1.45 - 0.001) * h],
      ["/greyhole/feedback", h],
      ["/greyhole/diffusion", 0.99 * h],
    ];
    for (const [name, value] of pairs) {
      try {
        node.setParamValue(name, value);
      } catch {
        /* param name differs */
      }
    }
  }

  /**
   * Per-stem Greyhole send. 0 is dry. 1 is the diagnostics Grey Hole at full throw.
   * @param {{ tl?: number, tr?: number, bl?: number, br?: number } | null} levels
   */
  setStemReverb(levels) {
    if (!this._stemReverbs) return;
    for (const corner of CORNERS) {
      const rec = this._stemReverbs[corner];
      if (!rec?.send) continue;
      const level = Math.min(1, Math.max(0, Number(levels?.[corner]) || 0));
      rec.send.gain.value = level;
      if (Math.abs(level - rec.applied) < 0.01) continue;
      rec.applied = level;
      this._applyGreyholeHeight(rec.node, level);
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
      stem.gain.gain.value = level;
      if (stem.pan) {
        const placed = Math.min(1, Math.max(-1, Number(pans?.[corner]) || 0));
        stem.pan.pan.value = placed;
      }
      if (stem.tone) {
        const hz = Number(cutoffs?.[corner]);
        stem.tone.frequency.value = Number.isFinite(hz) && hz > 0 ? hz : 20000;
      }
    }
  }

  /**
   * Repeat each landed quadrant's own sample. The repeat's low-pass sweeps
   * shut across that atom's lifetime: a short life closes fast, a long one lingers.
   * @param {Record<string, number[]> | null} hits lifetimes in seconds, per corner
   */
  playSplash(hits) {
    if (!this.running || !this.ctx || !this._splashOut || !hits) return;
    for (const corner of CORNERS) {
      const lives = hits[corner];
      if (lives?.length) this._strikeStem(corner, lives);
    }
  }

  _strikeStem(corner, lives) {
    const stem = this.stems[corner];
    if (!stem?.source) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const panValue = stem.pan ? stem.pan.pan.value : 0;
    const active = stem.sweepCount || 0;
    const room = 4 - active;
    if (room <= 0) return;
    const chosen = sampleLifetimes(lives, room);
    stem.sweepCount = active + chosen.length;
    for (let i = 0; i < chosen.length; i += 1) {
      const dur = Math.min(3.5, Math.max(0.1, Number(chosen[i]) || 0.1));
      const gain = ctx.createGain();
      const delay = ctx.createDelay(0.2);
      delay.delayTime.value = 0.05;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.85;
      filter.frequency.setValueAtTime(9000, t);
      filter.frequency.exponentialRampToValueAtTime(180, t + dur);
      const pan = ctx.createStereoPanner();
      pan.pan.value = panValue;
      const release = Math.min(0.15, dur * 0.3);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(0.42, t + 0.012);
      if (dur > release + 0.04) gain.gain.setValueAtTime(0.42, t + dur - release);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      stem.source.connect(gain);
      gain.connect(delay);
      delay.connect(filter);
      filter.connect(pan);
      pan.connect(this._splashOut);
      const nodes = [gain, delay, filter, pan];
      window.setTimeout(() => {
        stem.sweepCount = Math.max(0, (stem.sweepCount || 1) - 1);
        for (const node of nodes) {
          try {
            node.disconnect();
          } catch {
            /* already gone */
          }
        }
      }, (dur + 0.08) * 1000);
    }
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
   */
  sync(mixState, controller) {
    if (!this.running || !this.ctx) return;
    const t = this.ctx.currentTime;
    const weights = equalPowerMix(mixState.x, mixState.y);

    for (const corner of CORNERS) {
      const stem = this.stems[corner];
      if (!stem) continue;
      // Snap gains — setTargetAtTime with RAMP was fine, but immediate
      // values make first audible frame reliable after start.
      stem.gain.gain.value = weights[corner];
      if (stem.pan) stem.pan.pan.value = 0;
      if (stem.tone) stem.tone.frequency.value = 20000;
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
    this._panner.pan.value = pan * 0.9;

    const lt = clamp01(Math.abs(Number(controller.lt) || 0) > 1.5 ? controller.lt / 255 : controller.lt);
    const rt = clamp01(Math.abs(Number(controller.rt) || 0) > 1.5 ? controller.rt / 255 : controller.rt);
    // Released = wide open. LT sweeps the lowpass up from ~200 Hz; RT sweeps the highpass down from ~8 kHz.
    this._tone.frequency.value = lt <= 0.001 ? 20000 : 200 * Math.pow(18000 / 200, lt);
    this._tone.Q.value = 0.7;
    if (this._hp) {
      this._hp.frequency.value = rt <= 0.001 ? 20 : 8000 * Math.pow(35 / 8000, rt);
    }

    this._applyShoulders(controller.l1, controller.r1, t);
    this.setStemReverb(null);
  }
}

export const audioEngine = new EchoScapeAudioEngine();
