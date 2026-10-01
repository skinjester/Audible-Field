/**
 * Minimal WAM2 host for EchoScape browser audio.
 * Plugins are vendored under /wams/ (no CDN).
 * Stick axes use hand-editable bindings in wam-stick-maps.js.
 */

import { getWamStickMap } from "./wam-stick-maps.js?v=2";

const WIMMICS_SDK = "/wams/wimmics/utils/sdk/src/initializeWamHost.js";
const WAM_PLUGIN_BASE = "/wams/";

/** @type {string | null} */
let hostGroupId = null;
let connectPatched = false;

/**
 * Faust WAMs often pin a mono worklet to channelCountMode "explicit".
 * A normal stereo GainNode then throws on connect, and the slot falls back
 * to the native effect — the WAM the user picked never stays selected.
 * Match the source to that explicit count and retry once.
 */
function installWamConnectPatch() {
  if (connectPatched || typeof AudioNode === "undefined") return;
  connectPatched = true;
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function connect(destination, output, input) {
    try {
      return orig.call(this, destination, output, input);
    } catch (err) {
      const count = destination?.channelCount;
      if (
        !destination ||
        destination.channelCountMode !== "explicit" ||
        !Number.isFinite(count) ||
        count < 1 ||
        this.channelCount === count
      ) {
        throw err;
      }
      try {
        this.channelCountMode = "explicit";
        this.channelCount = count;
        this.channelInterpretation = destination.channelInterpretation || "speakers";
        return orig.call(this, destination, output, input);
      } catch {
        throw err;
      }
    }
  };
}

/**
 * @param {BaseAudioContext} audioContext
 * @returns {Promise<string>}
 */
export async function ensureWamHost(audioContext) {
  if (hostGroupId) return hostGroupId;
  const { default: initializeWamHost } = await import(WIMMICS_SDK);
  const [groupId] = await initializeWamHost(audioContext, "echoscape-host");
  hostGroupId = groupId;
  return hostGroupId;
}

/**
 * @param {BaseAudioContext} audioContext
 * @param {string} pluginPath path under /wams/ e.g. "wimmics/OwlShimmer/index.js"
 */
export async function loadWam(audioContext, pluginPath) {
  installWamConnectPatch();
  const groupId = await ensureWamHost(audioContext);
  const url = pluginPath.startsWith("/") || pluginPath.startsWith("http")
    ? pluginPath
    : `${WAM_PLUGIN_BASE}${pluginPath.replace(/^\/+/, "")}`;

  const { default: WAM } = await import(/* webpackIgnore: true */ url);
  if (typeof WAM?.createInstance !== "function") {
    throw new Error(`Not a WAM constructor: ${url}`);
  }

  const instance = await WAM.createInstance(groupId, audioContext);
  if (!instance?.audioNode) {
    throw new Error(`WAM created without audioNode: ${url}`);
  }
  return instance;
}

export const OWL_SHIMMER_PATH = "wimmics/OwlShimmer/index.js";

/**
 * @param {{ setParamValue?: (name: string, value: number) => void }} audioNode
 * @param {string|string[]} names
 * @param {number} value
 */
export function setWamParam(audioNode, names, value) {
  if (!audioNode?.setParamValue) return;
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    try {
      audioNode.setParamValue(name, value);
      return;
    } catch {
      /* try next alias */
    }
  }
}

/**
 * Left stick −1…1 → multiplier. Rest (0) is 1.
 * Full +stick is `maxMult`. Full −stick is 1/maxMult, which stays above 0.
 * A max of 1 leaves the multiplier at 1 for every stick position.
 * @param {number} stick
 * @param {number} maxMult
 */
export function stickMultiplier(stick, maxMult) {
  const s = Math.min(1, Math.max(-1, Number(stick) || 0));
  const maxM = Math.max(1, Number(maxMult) || 1);
  if (s === 0 || maxM === 1) return 1;
  if (s > 0) return 1 + (maxM - 1) * s;
  return 1 / (1 + (maxM - 1) * -s);
}

/**
 * default × multiplier, clamped to the param's [min, max].
 * Default 0 cannot be scaled by multiplication, so +stick uses
 * (multiplier − 1) × max and −stick falls toward min.
 * Values at or below 0 are not sent when min is 0 or greater — they clamp to min.
 * @param {{ min: number, max: number, def: number }} param
 * @param {number} mult
 */
export function paramFromMultiplier(param, mult) {
  const min = Number(param.min);
  const max = Number(param.max);
  const def = Number(param.def);
  const m = Number(mult);
  let value;
  if (!Number.isFinite(def) || Math.abs(def) <= 1e-8) {
    const span = Number.isFinite(max) ? max : 0;
    value = (Number.isFinite(m) ? m : 1) - 1;
    value *= span;
  } else {
    value = def * (Number.isFinite(m) ? m : 1);
  }
  if (Number.isFinite(min) && value < min) value = min;
  if (Number.isFinite(max) && value > max) value = max;
  return value;
}

/**
 * Continuous, automatable params from live getParameterInfo (fallback / debug).
 * Prefer resolveStickBinding(pluginPath) for stick control.
 * @param {{ getParameterInfo?: Function }} audioNode
 * @param {{ getParameterInfo?: Function }} [moduleInstance]
 * @returns {Promise<{ id: string, label: string, min: number, max: number, def: number }[]>}
 */
export async function listStickParams(audioNode, moduleInstance) {
  const targets = [audioNode, moduleInstance, audioNode?._wamNode].filter(Boolean);
  let info = {};
  for (const target of targets) {
    if (typeof target.getParameterInfo !== "function") continue;
    try {
      const next = await target.getParameterInfo();
      if (next && typeof next === "object" && Object.keys(next).length) {
        info = next;
        break;
      }
    } catch {
      /* try next */
    }
  }
  const out = [];
  for (const [id, p] of Object.entries(info)) {
    if (!p || typeof p !== "object") continue;
    const lid = String(id).toLowerCase();
    const label = String(p.label || id);
    if (lid.includes("bypass") || label.toLowerCase().includes("bypass")) continue;
    if (p.type === "boolean" || p.type === "choice") continue;
    const min = Number(p.minValue);
    const max = Number(p.maxValue);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) continue;
    out.push({
      id,
      label: shortParamLabel(label, id),
      min,
      max,
      def: Number.isFinite(p.defaultValue) ? Number(p.defaultValue) : min,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function shortParamLabel(label, id) {
  const raw = String(label || id);
  const leaf = raw.includes("/") ? raw.split("/").pop() : raw;
  return leaf || raw;
}

/**
 * @typedef {{ id: string, label: string, min: number, max: number, def: number }} StickParam
 * @typedef {{
 *   x: StickParam[],
 *   y: StickParam[],
 *   defaults: StickParam[],
 *   forceOff: string[],
 *   mapName: string,
 * }} StickBinding
 */

/**
 * Resolve hand-editable X/Y bindings for a plugin path.
 * @param {string} pluginPath
 * @returns {StickBinding | null}
 */
export function resolveStickBinding(pluginPath) {
  const map = getWamStickMap(pluginPath);
  if (!map) return null;
  const byId = new Map(map.params.map((p) => [p.id, p]));
  const toStick = (id) => {
    const p = byId.get(id);
    if (!p) return null;
    return {
      id: p.id,
      label: p.label || shortParamLabel(p.id, p.id),
      min: p.min,
      max: p.max,
      def: p.default,
    };
  };
  return {
    mapName: map.name,
    x: (map.x || []).map(toStick).filter(Boolean),
    y: (map.y || []).map(toStick).filter(Boolean),
    defaults: map.params
      .filter((p) => !String(p.id).toLowerCase().includes("bypass"))
      .map((p) => ({
        id: p.id,
        label: p.label || shortParamLabel(p.id, p.id),
        min: p.min,
        max: p.max,
        def: p.default,
      })),
    forceOff: [...(map.forceOff || [])],
  };
}

/**
 * Apply table defaults (and force bypass off) once when a WAM is loaded.
 * @param {{ setParamValue?: Function }} audioNode
 * @param {StickBinding} binding
 */
export function applyWamDefaults(audioNode, binding) {
  if (!audioNode || !binding) return;
  for (const p of binding.defaults || []) {
    setWamParam(audioNode, p.id, p.def);
  }
  for (const id of binding.forceOff || []) {
    setWamParam(audioNode, id, 0);
  }
}

/**
 * Map raw stick axes (−1…1) onto WAM params.
 * `scale` is the max multiplier at full +stick (per axis, or one number for both).
 * Stick rest sends each param's default. The result is clamped to [min, max].
 * @param {{ setParamValue?: Function }} audioNode
 * @param {StickBinding | null} binding
 * @param {number} stickX
 * @param {number} stickY
 * @param {number | { x?: number, y?: number }} [scale=1]
 */
export function applyStickToWamParams(audioNode, binding, stickX, stickY, scale = 1) {
  if (!audioNode || !binding) return;
  const scales =
    scale && typeof scale === "object"
      ? {
          x: Math.max(1, Number(scale.x) || 1),
          y: Math.max(1, Number(scale.y) || 1),
        }
      : {
          x: Math.max(1, Number(scale) || 1),
          y: Math.max(1, Number(scale) || 1),
        };
  for (const p of binding.x || []) {
    setWamParam(audioNode, p.id, paramFromMultiplier(p, stickMultiplier(stickX, scales.x)));
  }
  for (const p of binding.y || []) {
    setWamParam(audioNode, p.id, paramFromMultiplier(p, stickMultiplier(stickY, scales.y)));
  }
  for (const id of binding.forceOff || []) {
    setWamParam(audioNode, id, 0);
  }
}
