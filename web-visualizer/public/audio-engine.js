/**
 * Browser-side recreation of the EchoScape Max mix path:
 *   4 looping beds → equal-power gains → dry/wet gate → face-button FX
 *   → tone (LT) → shoulder FX (L1/R1) → pan → master (+ RT hall / R1 bloom)
 *
 * Commercial VSTs are approximated with Web Audio nodes so design can iterate
 * without Max. Circle upgrades to OWLShimmer (WAM) when the CDN load succeeds;
 * otherwise the native crystallizer fallback stays in place.
 *
 * Shoulder character (momentary, distinct from LT/RT):
 *   L1 — Abyss plunge: resonant lowpass + peak scream + grit
 *   R1 — Glass bloom: reverse IR convolution + upward highpass shimmer
 */

import { equalPowerMix, STEM_CORNERS, state as mixerState, controller as mixerController } from "./mixer-core.js?v=61";
import {
  loadWam,
  OWL_SHIMMER_PATH,
  OWL_SHIMMER_PARAMS,
  setWamParam,
} from "./wam-host.js?v=2";

const CORNERS = ["tl", "tr", "bl", "br"];
const FX_IDS = ["cross", "square", "triangle", "circle"];
const RAMP = 0.02;

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
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
    this._master = null;
    this._dry = null;
    this._wet = null;
    this._sum = null;
    this._panner = null;
    this._reverb = null;
    this._reverbSend = null;
    this._tone = null;
    this._wetIn = null;
    this._shoulderOut = null;
    this._l1Filter = null;
    this._l1Peak = null;
    this._l1Drive = null;
    this._l1DriveGain = null;
    this._r1Send = null;
    this._r1PreDelay = null;
    this._r1Feedback = null;
    this._r1Highpass = null;
    this._r1Bloom = null;
    this._r1Peak = null;
    this._r1Drive = null;
    this._r1Wet = null;
    this._comp = null;
    this._l1Held = false;
    this._r1Held = false;
    /** @type {'pending' | 'wam' | 'native'} */
    this.circleFxMode = "pending";
    this._circleIn = null;
    this._circleWam = null;
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
    await this.ctx.resume();

    this._sum = this.ctx.createGain();
    this._sum.gain.value = 1;

    this._dry = this.ctx.createGain();
    this._dry.gain.value = 1;
    this._wet = this.ctx.createGain();
    this._wet.gain.value = 0;

    this._tone = this.ctx.createBiquadFilter();
    this._tone.type = "lowpass";
    this._tone.frequency.value = 18000;
    this._tone.Q.value = 0.7;

    this._buildShoulderFx();

    this._panner = this.ctx.createStereoPanner();
    this._panner.pan.value = 0;

    this._comp = this.ctx.createDynamicsCompressor();
    this._comp.threshold.value = -12;
    this._comp.knee.value = 18;
    this._comp.ratio.value = 3.5;
    this._comp.attack.value = 0.005;
    this._comp.release.value = 0.18;

    this._master = this.ctx.createGain();
    this._master.gain.value = 1;

    this._reverbSend = this.ctx.createGain();
    this._reverbSend.gain.value = 0;
    this._reverb = this._createReverb();

    this._buildFx();

    this._sum.connect(this._dry);
    this._sum.connect(this._wetIn);
    this._dry.connect(this._tone);
    this._wet.connect(this._tone);
    // tone → L1 insert → shoulder bus → pan → compressor → master
    this._tone.connect(this._l1Filter);
    this._tone.connect(this._l1Drive);
    this._shoulderOut.connect(this._panner);
    this._panner.connect(this._comp);
    this._comp.connect(this._master);
    this._master.connect(this.ctx.destination);

    // RT hall (ambient) — post-tone, before shoulder color
    this._tone.connect(this._reverbSend);
    this._reverbSend.connect(this._reverb);
    this._reverb.connect(this._master);

    // R1 glass bloom — parallel reverse convolution off the shoulder bus
    this._shoulderOut.connect(this._r1Send);
    this._r1Wet.connect(this._master);

    // Load beds and OWLShimmer in parallel — WAM failure keeps native Circle.
    const [, circleMode] = await Promise.all([
      this._loadStems(),
      this._tryUpgradeCircleWam(),
    ]);
    this.circleFxMode = circleMode;

    this.ready = true;
    this.running = true;
    this.setActiveFx(this.activeFx, true);
    this.sync(mixerState, mixerController);
    await this._playAll();

    if (this.ctx.state !== "running") {
      await this.ctx.resume();
    }

    console.info("[EchoScape audio] started", {
      ctx: this.ctx.state,
      sampleRate: this.ctx.sampleRate,
      circleFx: this.circleFxMode,
      stems: CORNERS.map((c) => ({
        corner: c,
        paused: this.stems[c]?.el.paused,
        time: this.stems[c]?.el.currentTime,
        readyState: this.stems[c]?.el.readyState,
      })),
    });

    return this;
  }

  async resume() {
    if (this.ctx && this.ctx.state !== "running") {
      await this.ctx.resume();
    }
  }

  async ensurePlaying() {
    await this.resume();
    await this._playAll();
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
    if (this._circleWam) {
      try {
        this._circleWam.audioNode?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        await this._circleWam.destroy?.();
      } catch {
        /* ignore */
      }
      this._circleWam = null;
    }
    try {
      await this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.stems = {};
    this.fx = {};
    this.ready = false;
    this.running = false;
    this._l1Held = false;
    this._r1Held = false;
    this.circleFxMode = "pending";
    this._circleIn = null;
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
   * Reverse / metallic impulse — densifies toward the end so the bloom
   * feels like glass shattering backward into a bright space (unlike RT hall).
   */
  _createReverseBloom() {
    const seconds = 2.4;
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      const phase = ch * 0.37;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const rise = Math.pow(t, 1.15);
        const shimmer =
          Math.sin(i * 0.041 + phase) * 0.35 +
          Math.sin(i * 0.113 + phase * 2) * 0.22 +
          Math.sin(i * 0.29 + phase * 0.5) * 0.12;
        const spike = ((i * 13 + ch * 71) % 90) === 0 ? 0.95 : 0;
        const clang = ((i * 29 + ch * 41) % 160) === 0 ? 0.7 : 0;
        data[i] =
          ((Math.random() * 2 - 1) * 0.85 + shimmer + spike + clang) *
          rise *
          (0.25 + 0.9 * t);
      }
    }
    const convolver = this.ctx.createConvolver();
    convolver.buffer = buffer;
    return convolver;
  }

  _buildShoulderFx() {
    const ctx = this.ctx;

    // --- L1 Abyss plunge (series insert) ---
    this._l1Filter = ctx.createBiquadFilter();
    this._l1Filter.type = "lowpass";
    this._l1Filter.frequency.value = 20000;
    this._l1Filter.Q.value = 0.7;

    this._l1Peak = ctx.createBiquadFilter();
    this._l1Peak.type = "peaking";
    this._l1Peak.frequency.value = 900;
    this._l1Peak.Q.value = 4;
    this._l1Peak.gain.value = 0;

    this._l1Drive = ctx.createWaveShaper();
    this._l1Drive.curve = makeDistortionCurve(0.55);
    this._l1Drive.oversample = "2x";
    this._l1DriveGain = ctx.createGain();
    this._l1DriveGain.gain.value = 0;

    this._shoulderOut = ctx.createGain();
    this._shoulderOut.gain.value = 1;

    this._l1Filter.connect(this._l1Peak);
    this._l1Peak.connect(this._shoulderOut);
    this._l1Drive.connect(this._l1DriveGain);
    this._l1DriveGain.connect(this._shoulderOut);

    // --- R1 Glass bloom (parallel reverse convolution, extreme) ---
    this._r1Send = ctx.createGain();
    this._r1Send.gain.value = 0;

    this._r1PreDelay = ctx.createDelay(0.55);
    this._r1PreDelay.delayTime.value = 0.048;

    this._r1Feedback = ctx.createGain();
    this._r1Feedback.gain.value = 0;

    this._r1Highpass = ctx.createBiquadFilter();
    this._r1Highpass.type = "highpass";
    this._r1Highpass.frequency.value = 280;
    this._r1Highpass.Q.value = 0.9;

    this._r1Bloom = this._createReverseBloom();

    this._r1Peak = ctx.createBiquadFilter();
    this._r1Peak.type = "peaking";
    this._r1Peak.frequency.value = 3200;
    this._r1Peak.Q.value = 6;
    this._r1Peak.gain.value = 0;

    this._r1Drive = ctx.createWaveShaper();
    this._r1Drive.curve = makeDistortionCurve(0.75);
    this._r1Drive.oversample = "2x";

    this._r1Wet = ctx.createGain();
    this._r1Wet.gain.value = 1;

    this._r1Send.connect(this._r1PreDelay);
    this._r1PreDelay.connect(this._r1Highpass);
    this._r1Highpass.connect(this._r1Bloom);
    this._r1Bloom.connect(this._r1Peak);
    this._r1Peak.connect(this._r1Drive);
    this._r1Drive.connect(this._r1Wet);
    // Dense freeze feedback — compressor on master keeps it from exploding
    this._r1Drive.connect(this._r1Feedback);
    this._r1Feedback.connect(this._r1PreDelay);
  }

  _applyShoulders(l1, r1, t) {
    const l1On = !!l1;
    const r1On = !!r1;
    const l1Attack = l1On && !this._l1Held;
    const r1Attack = r1On && !this._r1Held;
    this._l1Held = l1On;
    this._r1Held = r1On;

    // L1: plunge into resonant mud (fast in, slower surface)
    const l1Tau = l1Attack ? 0.045 : l1On ? 0.08 : 0.22;
    this._l1Filter.frequency.setTargetAtTime(l1On ? 240 : 20000, t, l1Tau);
    this._l1Filter.Q.setTargetAtTime(l1On ? 16 : 0.7, t, l1Tau);
    this._l1Peak.frequency.setTargetAtTime(l1On ? 380 : 900, t, l1Tau);
    this._l1Peak.Q.setTargetAtTime(l1On ? 11 : 4, t, l1Tau);
    this._l1Peak.gain.setTargetAtTime(l1On ? 14 : 0, t, l1Tau);
    this._l1DriveGain.gain.setTargetAtTime(l1On ? 0.42 : 0, t, l1Tau);

    // R1: shatter upward into reverse glass space (snap in, long hang out)
    const r1Tau = r1Attack ? 0.018 : r1On ? 0.04 : 0.55;
    this._r1Send.gain.setTargetAtTime(r1On ? 1.35 : 0, t, r1Tau);
    this._r1Highpass.frequency.setTargetAtTime(r1On ? 4800 : 280, t, r1Tau);
    this._r1Highpass.Q.setTargetAtTime(r1On ? 8.5 : 0.9, t, r1Tau);
    this._r1PreDelay.delayTime.setTargetAtTime(r1On ? 0.14 : 0.048, t, r1Tau);
    this._r1Feedback.gain.setTargetAtTime(r1On ? 0.72 : 0, t, r1Tau);
    this._r1Peak.frequency.setTargetAtTime(r1On ? 5100 : 3200, t, r1Tau);
    this._r1Peak.Q.setTargetAtTime(r1On ? 14 : 6, t, r1Tau);
    this._r1Peak.gain.setTargetAtTime(r1On ? 16 : 0, t, r1Tau);
    this._r1Wet.gain.setTargetAtTime(r1On ? 1.55 : 1, t, r1Tau);

    // Duck dry path so bloom owns the mix (L1 grit still stacks if both held)
    const dryTarget = r1On ? 0.28 : l1On ? 0.78 : 1;
    const dryTau = r1On ? r1Tau : l1Tau;
    this._shoulderOut.gain.setTargetAtTime(dryTarget, t, dryTau);
  }

  _buildFx() {
    const ctx = this.ctx;
    this._wetIn = ctx.createGain();
    this._wetIn.gain.value = 1;

    // --- Cross: Saturn-like saturation ---
    const satIn = ctx.createGain();
    const satDrive = ctx.createWaveShaper();
    satDrive.curve = makeDistortionCurve(0.35);
    satDrive.oversample = "2x";
    const satTone = ctx.createBiquadFilter();
    satTone.type = "lowpass";
    satTone.frequency.value = 8000;
    const satOut = ctx.createGain();
    satOut.gain.value = 0;
    this._wetIn.connect(satIn);
    satIn.connect(satDrive);
    satDrive.connect(satTone);
    satTone.connect(satOut);
    satOut.connect(this._wet);
    this.fx.cross = {
      out: satOut,
      apply(x, y) {
        const drive = clamp01(x);
        const tone = clamp01(1 - y * 0.85);
        satDrive.curve = makeDistortionCurve(0.15 + drive * 0.85);
        satTone.frequency.setTargetAtTime(1200 + tone * 14000, ctx.currentTime, RAMP);
      },
    };

    // --- Square: Comb filter ---
    const combIn = ctx.createGain();
    const combDelay = ctx.createDelay(0.1);
    combDelay.delayTime.value = 0.012;
    const combFb = ctx.createGain();
    combFb.gain.value = 0.45;
    const combOut = ctx.createGain();
    combOut.gain.value = 0;
    this._wetIn.connect(combIn);
    combIn.connect(combDelay);
    combDelay.connect(combFb);
    combFb.connect(combDelay);
    combDelay.connect(combOut);
    combOut.connect(this._wet);
    this.fx.square = {
      out: combOut,
      apply(x, y) {
        const t = 0.002 + clamp01(x) * 0.045;
        const fb = 0.15 + clamp01(y) * 0.75;
        combDelay.delayTime.setTargetAtTime(t, ctx.currentTime, RAMP);
        combFb.gain.setTargetAtTime(fb, ctx.currentTime, RAMP);
      },
    };

    // --- Triangle: Formant-ish dual peaking ---
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
    const formOut = ctx.createGain();
    formOut.gain.value = 0;
    this._wetIn.connect(formIn);
    formIn.connect(f1);
    f1.connect(f2);
    f2.connect(formOut);
    formOut.connect(this._wet);
    this.fx.triangle = {
      out: formOut,
      apply(x, y) {
        const shift = 0.5 + clamp01(x) * 2.5;
        const res = 2 + clamp01(y) * 10;
        f1.frequency.setTargetAtTime(400 * shift, ctx.currentTime, RAMP);
        f2.frequency.setTargetAtTime(900 * shift, ctx.currentTime, RAMP);
        f1.Q.setTargetAtTime(res, ctx.currentTime, RAMP);
        f2.Q.setTargetAtTime(res * 1.1, ctx.currentTime, RAMP);
      },
    };

    // --- Circle: native crystallizer (upgradable to OWLShimmer WAM) ---
    this._circleIn = ctx.createGain();
    this._circleIn.gain.value = 1;
    const cryOut = ctx.createGain();
    cryOut.gain.value = 0;
    this._wetIn.connect(this._circleIn);
    cryOut.connect(this._wet);
    this._wireNativeCircle(this._circleIn, cryOut);
    this.fx.circle = {
      out: cryOut,
      apply: (x, y) => this._applyNativeCircle(x, y),
    };
  }

  _wireNativeCircle(input, output) {
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
    input.connect(cryDelay);
    cryDelay.connect(cryFilter);
    cryFilter.connect(cryFb);
    cryFb.connect(cryDelay);
    cryFilter.connect(output);
    this._nativeCircle = { cryDelay, cryFb, cryFilter, cryLfo, cryLfoGain };
  }

  _applyNativeCircle(x, y) {
    const nodes = this._nativeCircle;
    if (!nodes || !this.ctx) return;
    const delay = 0.08 + clamp01(1 - x) * 0.55;
    const fb = 0.15 + clamp01(y) * 0.55;
    nodes.cryDelay.delayTime.setTargetAtTime(delay, this.ctx.currentTime, 0.05);
    nodes.cryFb.gain.setTargetAtTime(fb, this.ctx.currentTime, RAMP);
    nodes.cryLfoGain.gain.setTargetAtTime(0.01 + clamp01(y) * 0.06, this.ctx.currentTime, RAMP);
  }

  _applyOwlShimmer(x, y) {
    const node = this._circleWam?.audioNode;
    if (!node) return;
    const shimmer = Math.min(0.7, 0.08 + clamp01(1 - x) * 0.62);
    const decay = 0.5 + clamp01(y) * 0.5;
    const mix = 0.55 + clamp01(y) * 0.4;
    const tone = 1600 + clamp01(x) * 5400;
    setWamParam(node, OWL_SHIMMER_PARAMS.shimmer, shimmer);
    setWamParam(node, OWL_SHIMMER_PARAMS.decay, decay);
    setWamParam(node, OWL_SHIMMER_PARAMS.mix, mix);
    setWamParam(node, OWL_SHIMMER_PARAMS.tone, tone);
    setWamParam(node, OWL_SHIMMER_PARAMS.bypass, 0);
  }

  /**
   * Swap Circle insert from native crystallizer → OWLShimmer WAM.
   * @returns {Promise<'wam' | 'native'>}
   */
  async _tryUpgradeCircleWam() {
    if (!this.ctx || !this._circleIn || !this.fx.circle) return "native";
    try {
      const instance = await loadWam(this.ctx, OWL_SHIMMER_PATH);
      const wamNode = instance.audioNode;

      // Detach native insert completely before wiring the WAM.
      try {
        this._circleIn.disconnect();
      } catch {
        /* ignore */
      }
      try {
        this._nativeCircle?.cryFilter?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        this._nativeCircle?.cryLfo?.stop();
      } catch {
        /* ignore */
      }

      this._circleIn.connect(wamNode);
      wamNode.connect(this.fx.circle.out);

      this._circleWam = instance;
      this._nativeCircle = null;
      this.fx.circle.apply = (x, y) => this._applyOwlShimmer(x, y);
      this._applyOwlShimmer(0.5, 0.5);

      console.info("[EchoScape audio] Circle FX → OWLShimmer (WAM)");
      return "wam";
    } catch (err) {
      console.warn(
        "[EchoScape audio] OWLShimmer unavailable, keeping native Circle FX:",
        err?.message || err
      );
      return "native";
    }
  }

  async _loadStems() {
    // Load sequentially so the first bed can start sooner and we avoid
    // saturating the network with four ~50MB WAVs at once.
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
   * @param {{ resume?: boolean }} [opts]
   */
  async _attachStem(corner, url, meta, opts = {}) {
    if (!this.ctx || !this._sum) throw new Error("Audio engine not started");

    const el = new Audio();
    el.loop = true;
    el.preload = "auto";
    el.src = url;

    await waitForMedia(el);

    const source = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    const prev = this.stems[corner];
    const prevGain = prev?.gain?.gain?.value ?? 0;
    gain.gain.value = prevGain;
    source.connect(gain);
    gain.connect(this._sum);

    if (prev) {
      try {
        prev.el.pause();
      } catch {
        /* ignore */
      }
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
      prev.el.removeAttribute("src");
      prev.el.load();
    }

    this.stems[corner] = { el, source, gain, meta };

    if (opts.resume && this.running) {
      try {
        await el.play();
      } catch (err) {
        console.warn("[EchoScape audio] replaceStem play failed:", err?.message || err);
      }
    }
  }

  /**
   * Swap the looping bed for one pad corner.
   * @param {string} corner
   * @param {{ url: string, label?: string, file?: string, id?: string }} sample
   */
  async replaceStem(corner, sample) {
    if (!CORNERS.includes(corner)) throw new Error(`Unknown corner ${corner}`);
    if (!sample?.url) throw new Error("replaceStem requires sample.url");
    if (!this.running || !this.ctx) {
      // Assignment still updates STEM_CORNERS via caller; load on next start.
      return;
    }
    const meta = STEM_CORNERS[corner];
    await this._attachStem(corner, sample.url, meta, { resume: true });
    console.info("[EchoScape audio] replaced", corner, meta.label);
  }

  setActiveFx(button, force = false) {
    if (!FX_IDS.includes(button)) return;
    if (!force && !this.running) return;
    if (!this.ctx || !this.fx[button]) return;

    this.activeFx = button;
    const t = this.ctx.currentTime;
    for (const id of FX_IDS) {
      const node = this.fx[id];
      if (!node) continue;
      node.out.gain.setTargetAtTime(id === button ? 1 : 0, t, RAMP);
    }
    this._wet.gain.setTargetAtTime(0.45, t, RAMP);
    this._dry.gain.setTargetAtTime(0.85, t, RAMP);
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
    }

    if (controller.activeFx !== this.activeFx) {
      this.setActiveFx(controller.activeFx);
    }

    const slot = controller.fx[controller.activeFx];
    const fx = this.fx[controller.activeFx];
    if (slot && fx?.apply) {
      fx.apply(Number(slot.x) || 0, Number(slot.y) || 0);
    }

    const pan = clamp01((Number(controller.rightX) || 0) * 0.5 + 0.5) * 2 - 1;
    this._panner.pan.value = pan * 0.9;

    const lt = clamp01(Math.abs(Number(controller.lt) || 0) > 1.5 ? controller.lt / 255 : controller.lt);
    const rt = clamp01(Math.abs(Number(controller.rt) || 0) > 1.5 ? controller.rt / 255 : controller.rt);
    this._tone.frequency.value = 18000 - lt * 14000;
    this._reverbSend.gain.value = rt * 0.45;

    this._applyShoulders(controller.l1, controller.r1, t);
  }
}

export const audioEngine = new EchoScapeAudioEngine();
