/**
 * Browser-side recreation of the EchoScape Max mix path:
 *   4 looping beds → equal-power gains → dry/wet gate → face-button FX → pan → out
 *
 * Commercial VSTs are approximated with Web Audio nodes so design can iterate
 * without Max. Character will differ; routing and control semantics match.
 */

import { equalPowerMix, STEM_CORNERS, state as mixerState, controller as mixerController } from "./mixer-core.js?v=60";

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

    this._panner = this.ctx.createStereoPanner();
    this._panner.pan.value = 0;

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
    this._tone.connect(this._panner);
    this._panner.connect(this._master);
    this._master.connect(this.ctx.destination);

    this._tone.connect(this._reverbSend);
    this._reverbSend.connect(this._reverb);
    this._reverb.connect(this._master);

    await this._loadStems();

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

    // --- Circle: Crystallizer-ish delay shimmer ---
    const cryIn = ctx.createGain();
    const cryDelay = ctx.createDelay(1.5);
    cryDelay.delayTime.value = 0.28;
    const cryFb = ctx.createGain();
    cryFb.gain.value = 0.35;
    const cryFilter = ctx.createBiquadFilter();
    cryFilter.type = "highpass";
    cryFilter.frequency.value = 400;
    const cryOut = ctx.createGain();
    cryOut.gain.value = 0;
    const cryLfo = ctx.createOscillator();
    cryLfo.type = "sine";
    cryLfo.frequency.value = 0.35;
    const cryLfoGain = ctx.createGain();
    cryLfoGain.gain.value = 0.04;
    cryLfo.connect(cryLfoGain);
    cryLfoGain.connect(cryDelay.delayTime);
    cryLfo.start();
    this._wetIn.connect(cryIn);
    cryIn.connect(cryDelay);
    cryDelay.connect(cryFilter);
    cryFilter.connect(cryFb);
    cryFb.connect(cryDelay);
    cryFilter.connect(cryOut);
    cryOut.connect(this._wet);
    this.fx.circle = {
      out: cryOut,
      apply(x, y) {
        const delay = 0.08 + clamp01(1 - x) * 0.55;
        const fb = 0.15 + clamp01(y) * 0.55;
        cryDelay.delayTime.setTargetAtTime(delay, ctx.currentTime, 0.05);
        cryFb.gain.setTargetAtTime(fb, ctx.currentTime, RAMP);
        cryLfoGain.gain.setTargetAtTime(0.01 + clamp01(y) * 0.06, ctx.currentTime, RAMP);
      },
    };
  }

  async _loadStems() {
    // Load sequentially so the first bed can start sooner and we avoid
    // saturating the network with four ~50MB WAVs at once.
    for (const corner of CORNERS) {
      const meta = STEM_CORNERS[corner];
      const url = `/beds/${encodeURIComponent(meta.file)}`;
      const el = new Audio();
      // Do NOT set crossOrigin on same-origin media — it can silence
      // MediaElementSource when the response lacks CORS headers.
      el.loop = true;
      el.preload = "auto";
      el.src = url;

      await waitForMedia(el);

      const source = this.ctx.createMediaElementSource(el);
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(this._sum);

      this.stems[corner] = { el, source, gain, meta };
      console.info("[EchoScape audio] loaded", meta.label, {
        readyState: el.readyState,
        duration: el.duration,
      });
    }
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
  }
}

export const audioEngine = new EchoScapeAudioEngine();
