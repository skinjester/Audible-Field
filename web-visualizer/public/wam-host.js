/**
 * Minimal WAM2 host for EchoScape browser audio.
 * Plugins are vendored under /wams/ (no CDN).
 * Stick axes use hand-editable bindings in wam-stick-maps.js.
 */

import { getWamStickMap } from "./wam-stick-maps.js?v=1";

const WIMMICS_SDK = "/wams/wimmics/utils/sdk/src/initializeWamHost.js";
const WAM_PLUGIN_BASE = "/wams/";

/** @type {string | null} */
let hostGroupId = null;

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

function clamp01(n) {
  return Math.min(1, Math.max(0, Number(n) || 0));
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
 * Map stick axes (0–1) onto WAM params from an explicit X/Y binding.
 * Scale can be a single number (both axes) or `{ x, y }` for per-axis depth.
 * @param {{ setParamValue?: Function }} audioNode
 * @param {StickBinding | null} binding
 * @param {number} x01
 * @param {number} y01
 * @param {number | { x?: number, y?: number }} [scale=1]
 */
export function applyStickToWamParams(audioNode, binding, x01, y01, scale = 1) {
  if (!audioNode || !binding) return;
  const scales =
    scale && typeof scale === "object"
      ? {
          x: Math.max(0.1, Number(scale.x) || 1),
          y: Math.max(0.1, Number(scale.y) || 1),
        }
      : {
          x: Math.max(0.1, Number(scale) || 1),
          y: Math.max(0.1, Number(scale) || 1),
        };
  const mapAxis = (t01, p, axisScale) => {
    const u = clamp01(clamp01(t01) * axisScale);
    return p.min + (p.max - p.min) * u;
  };
  for (const p of binding.x || []) {
    setWamParam(audioNode, p.id, mapAxis(x01, p, scales.x));
  }
  for (const p of binding.y || []) {
    setWamParam(audioNode, p.id, mapAxis(y01, p, scales.y));
  }
  for (const id of binding.forceOff || []) {
    setWamParam(audioNode, id, 0);
  }
}
