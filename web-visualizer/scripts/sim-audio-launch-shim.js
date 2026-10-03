/**
 * Phone launch: the context can be "running" while the speaker stays closed.
 * Output opens only after suspend() inside a tap or key press, then resume().
 * That is the Settings → Audio off → on workaround.
 */
(() => {
  const Native = window.AudioContext || window.webkitAudioContext;
  const origResume = Native.prototype.resume;
  const origSuspend = Native.prototype.suspend;
  const origConnect = AudioNode.prototype.connect;
  const contexts = [];
  let depth = 0;

  const arm = () => {
    depth += 1;
  };
  const disarm = () => {
    depth = Math.max(0, depth - 1);
  };
  window.addEventListener("pointerdown", arm, true);
  window.addEventListener("keydown", arm, true);
  window.addEventListener("pointerup", disarm, true);
  window.addEventListener("pointercancel", disarm, true);
  window.addEventListener("keyup", disarm, true);

  function meta(ctx) {
    let row = ctx.__launchMeta;
    if (!row) {
      row = { live: false, kickArmed: false, gate: null, analyser: null };
      ctx.__launchMeta = row;
      contexts.push(ctx);
    }
    return row;
  }

  function openGate(ctx) {
    const row = meta(ctx);
    row.live = true;
    row.kickArmed = false;
    if (row.gate) row.gate.gain.value = 1;
  }

  Native.prototype.suspend = function () {
    const row = meta(this);
    if (depth > 0) row.kickArmed = true;
    return origSuspend.call(this);
  };

  Native.prototype.resume = function () {
    const pending = origResume.call(this);
    if (meta(this).kickArmed) openGate(this);
    return pending;
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
      kickArmed: row.kickArmed,
      rms,
      detail: document.querySelector("[data-audio-detail]")?.textContent || "",
      health: document.querySelector("[data-audio-health]")?.textContent || "",
      status: document.querySelector("[data-status-audio]")?.textContent || "",
    };
  };
})();
