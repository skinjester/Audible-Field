/**
 * Safari on a phone: the speaker stays closed until resume() or a buffer
 * start runs inside a trusted gesture. A buffer started before that is discarded.
 * An untrusted event does not count. userActivation alone does not count.
 * Depth stays up through the event's microtasks. A later macrotask releases it.
 */
(() => {
  const coarseQuery = (query) => String(query).includes("pointer") && String(query).includes("coarse");
  const nativeMatch = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    if (coarseQuery(query)) {
      return {
        matches: true,
        media: String(query),
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
      };
    }
    return nativeMatch(query);
  };
  try {
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => 5 });
  } catch {
    /* already defined */
  }

  const Native = window.AudioContext || window.webkitAudioContext;
  const origResume = Native.prototype.resume;
  const origStart = AudioBufferSourceNode.prototype.start;
  const origConnect = AudioNode.prototype.connect;
  const contexts = [];
  let depth = 0;

  const gestureTypes = ["touchstart", "pointerdown", "touchend", "click", "keydown"];
  for (const type of gestureTypes) {
    window.addEventListener(
      type,
      (event) => {
        if (event.isTrusted !== true) return;
        depth += 1;
        setTimeout(() => {
          depth = Math.max(0, depth - 1);
        }, 0);
      },
      true
    );
  }

  function meta(ctx) {
    let row = ctx.__launchMeta;
    if (!row) {
      row = { live: false, gate: null, analyser: null };
      ctx.__launchMeta = row;
      contexts.push(ctx);
    }
    return row;
  }

  function openGate(ctx) {
    const row = meta(ctx);
    row.live = true;
    if (row.gate) row.gate.gain.value = 1;
  }

  Native.prototype.resume = function () {
    const pending = origResume.call(this);
    if (depth > 0) openGate(this);
    return pending;
  };

  AudioBufferSourceNode.prototype.start = function (...args) {
    const row = meta(this.context);
    const allowed = depth > 0 || (row.live && this.context.state === "running");
    if (depth > 0) openGate(this.context);
    if (!allowed) {
      try {
        this.disconnect();
      } catch {
        /* not connected yet */
      }
      const silent = this.context.createGain();
      silent.gain.value = 0;
      origConnect.call(this, silent);
    }
    return origStart.apply(this, args);
  };

  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest && this.context && dest === this.context.destination) {
      const row = meta(this.context);
      if (!row.gate) {
        row.gate = this.context.createGain();
        row.gate.gain.value = row.live ? 1 : 0;
        row.analyser = this.context.createAnalyser();
        row.analyser.fftSize = 2048;
        origConnect.call(row.gate, row.analyser);
        origConnect.call(row.analyser, this.context.destination);
      }
      return origConnect.call(this, row.gate, ...rest);
    }
    return origConnect.call(this, dest, ...rest);
  };

  window.__audioLaunchProbe = () => {
    let chosen = null;
    for (const ctx of contexts) {
      const row = ctx.__launchMeta;
      if (!row) continue;
      if (!chosen || row.analyser) chosen = { ctx, row };
    }
    if (!chosen) return { ready: false };
    const { ctx, row } = chosen;
    let rms = 0;
    if (row.analyser) {
      const data = new Float32Array(row.analyser.fftSize);
      row.analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
      rms = Math.sqrt(sum / data.length);
    }
    return {
      ready: true,
      state: ctx.state,
      live: row.live,
      rms,
      detail: document.querySelector("[data-audio-detail]")?.textContent || "",
      health: document.querySelector("[data-audio-health]")?.textContent || "",
      status: document.querySelector("[data-status-audio]")?.textContent || "",
    };
  };
})();
