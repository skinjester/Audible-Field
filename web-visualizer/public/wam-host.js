/**
 * Minimal WAM2 host for EchoScape browser audio.
 * Plugins are vendored under /wams/ (no CDN).
 * Face-button parameters come from the loaded plugin. wam-stick-maps.js
 * only supplies a tighter slider window when a raw AudioParam span is unusable.
 */

import { getWamStickMap } from "./wam-stick-maps.js?v=2";

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

const RAW_SPAN = 1e6;

function clampNum(n, min, max) {
  let v = Number(n);
  if (!Number.isFinite(v)) v = Number.isFinite(min) ? min : 0;
  if (Number.isFinite(min) && v < min) v = min;
  if (Number.isFinite(max) && v > max) v = max;
  return v;
}

function leafName(id, label) {
  const raw = String(label || id || "");
  const leaf = raw.includes("/") ? raw.split("/").pop() : raw;
  return String(leaf || raw).toLowerCase();
}

export function isBypassParam(param) {
  return leafName(param?.id, param?.label).includes("bypass");
}

export function isEnabledParam(param) {
  return leafName(param?.id, param?.label) === "enabled";
}

/**
 * True when min/max are a Web Audio limit rather than an authored musical range.
 * @param {number} min
 * @param {number} max
 */
export function isRawAudioSpan(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return true;
  if (Math.abs(min) >= RAW_SPAN || Math.abs(max) >= RAW_SPAN) return true;
  if (min <= -153600 && max >= 153600) return true;
  if (min <= 0 && max >= 20000) return true;
  return false;
}

function standInWindow(param) {
  const blob = `${param?.id || ""} ${param?.label || ""}`.toLowerCase();
  const def = Number.isFinite(param?.def) ? param.def : 0;
  if (blob.includes("detune")) return { min: -1200, max: 1200 };
  if (blob.includes("freq") || blob.includes("cutoff")) return { min: 20, max: 20000 };
  if (blob.includes("gain")) return { min: def - 24, max: def + 24 };
  const half = Math.max(Math.abs(def), 1);
  return { min: def - half, max: def + half };
}

/**
 * @param {number} low
 * @param {number} high
 * @param {number} stick −1…1
 */
export function valueFromStickRange(low, high, stick) {
  const lo = Number(low);
  const hi = Number(high);
  const s = Math.min(1, Math.max(-1, Number(stick) || 0));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  const rest = (lo + hi) / 2;
  return rest + s * ((hi - lo) / 2);
}

/** @param {string | null | undefined} axis */
export function stickAxisOn(axis, which) {
  if (which !== "x" && which !== "y") return false;
  return axis === which || axis === "xy";
}

/**
 * Toggle one stick axis without clearing the other.
 * @param {string | null | undefined} axis
 * @param {"x" | "y"} which
 * @param {boolean} on
 * @returns {"x" | "y" | "xy" | null}
 */
export function withStickAxis(axis, which, on) {
  const x = which === "x" ? on : stickAxisOn(axis, "x");
  const y = which === "y" ? on : stickAxisOn(axis, "y");
  if (x && y) return "xy";
  if (x) return "x";
  if (y) return "y";
  return null;
}

/**
 * One axis uses that stick direction. Both axes add, then stop at a full throw.
 * @param {string | null | undefined} axis
 * @param {number} stickX
 * @param {number} stickY
 */
function stickForAxes(axis, stickX, stickY) {
  const x = stickAxisOn(axis, "x");
  const y = stickAxisOn(axis, "y");
  if (x && y) {
    const sum = (Number(stickX) || 0) + (Number(stickY) || 0);
    return Math.min(1, Math.max(-1, sum));
  }
  if (x) return stickX;
  if (y) return stickY;
  return 0;
}

/**
 * Ping Pong Delay multiplies the delay input by feedback. A rest of 0
 * on time, feedback, or mix leaves the repeats silent.
 * @param {{ id?: string }} param
 */
function pingPongLevelParam(param) {
  const id = String(param?.id || "");
  return id === "time" || id === "feedback" || id === "mix";
}

/**
 * Value sent while a continuous parameter is not on X or Y.
 * Booleans and choices use this as their initial switch value too.
 * @param {{ id: string, label: string, type?: string, min: number, max: number, def: number, authored?: boolean }} param
 */
export function neutralParamValue(param) {
  if (!param) return 0;
  if (isBypassParam(param)) return 0;
  if (isEnabledParam(param)) return clampNum(1, param.min, param.max);
  if (param.type === "boolean") return clampNum(Number.isFinite(param.def) ? param.def : 0, param.min, param.max);
  if (param.type === "choice") return clampNum(param.def, param.min, param.max);
  if (pingPongLevelParam(param)) return clampNum(param.def, param.min, param.max);
  if (!param.authored) return clampNum(param.def, param.min, param.max);
  if (param.min <= 0 && param.max >= 0) return 0;
  return clampNum(param.def, param.min, param.max);
}

function quantizeParam(value, param) {
  let v = clampNum(value, param.min, param.max);
  const step = Number(param.discreteStep);
  if (step > 0) {
    v = param.min + Math.round((v - param.min) / step) * step;
    v = clampNum(v, param.min, param.max);
  }
  if (param.type === "boolean") v = v >= 0.5 ? 1 : 0;
  if (param.type === "choice") v = Math.round(v);
  return v;
}

/**
 * @param {{ id: string, label?: string, type?: string, min: number, max: number, def: number, choices?: string[], discreteStep?: number, authored?: boolean }} raw
 * @param {{ id: string, min: number, max: number } | null} [mapEntry]
 */
function isTwoStateSpan(min, max, step) {
  if (!(step >= 1) || !Number.isFinite(min) || !Number.isFinite(max)) return false;
  if (Math.abs(min) > 1e-4 || Math.abs(max - 1) > 1e-4) return false;
  return Math.abs(max - min - step) < 1e-4;
}

function faustMetaHas(item, key) {
  if (!Array.isArray(item?.meta)) return false;
  return item.meta.some((entry) => entry && typeof entry === "object" && key in entry);
}

function canonicalUnit(raw) {
  const key = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!key) return "";
  if (key === "hz" || key === "hertz") return "Hz";
  if (key === "khz") return "kHz";
  if (key === "s" || key === "sec" || key === "secs" || key === "second" || key === "seconds") return "s";
  if (key === "ms" || key === "msec" || key === "millisec" || key === "millisecond" || key === "milliseconds") return "ms";
  if (key === "%" || key === "percent" || key === "pct") return "%";
  if (key === "db" || key === "decibel" || key === "decibels") return "dB";
  if (key === "deg" || key === "degree" || key === "degrees") return "deg";
  if (key === "st" || key === "semitone" || key === "semitones") return "st";
  if (key === "cent" || key === "cents" || key === "ct") return "cent";
  return String(raw).trim();
}

function inferUnit(id, label, min, max) {
  const name = `${id || ""} ${label || ""}`.toLowerCase();
  if (/delay|decay/.test(name) && min >= 0 && max > 0 && max <= 30) return "s";
  if (/(^|[^a-z])time([^a-z]|$)/.test(name) && min >= 0 && max >= 0.05 && max <= 5) return "s";
  if (/freq|cutoff/.test(name)) return "Hz";
  if (/\btone\b/.test(name) && max >= 200 && max <= 24000) return "Hz";
  if (/detune/.test(name)) return "cent";
  if (/\bdb\b/.test(name) || (/\bgain\b/.test(name) && (min < 0 || max > 2))) return "dB";
  return "";
}

function fmtQuantityNumber(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return n.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function fmtQuantity(value, unit) {
  if (!Number.isFinite(value)) return "—";
  const u = canonicalUnit(unit);
  if (u === "s") return `${fmtQuantityNumber(value)} s`;
  if (u === "ms") return `${fmtQuantityNumber(value)} ms`;
  if (u === "Hz") {
    const abs = Math.abs(value);
    if (abs >= 1000) return `${fmtQuantityNumber(value / 1000)} kHz`;
    return `${fmtQuantityNumber(value)} Hz`;
  }
  if (u === "kHz") return `${fmtQuantityNumber(value)} kHz`;
  if (u === "%") return `${fmtQuantityNumber(value)}%`;
  if (u === "dB") return `${fmtQuantityNumber(value)} dB`;
  if (u === "deg") return `${fmtQuantityNumber(value)}°`;
  if (u === "st") return `${fmtQuantityNumber(value)} st`;
  if (u === "cent") return `${fmtQuantityNumber(value)} ct`;
  if (u) return `${fmtQuantityNumber(value)} ${u}`;
  return fmtQuantityNumber(value);
}

/**
 * Dial and menu text for a parameter value, including its unit when one applies.
 * @param {number} value
 * @param {{ type?: string, min?: number, max?: number, choices?: string[], units?: string }} param
 */
export function formatParamReadout(value, param) {
  if (param?.type === "boolean") return Number(value) >= 0.5 ? "On" : "Off";
  if (param?.type === "choice") {
    const index = Math.round(Number(value) - Number(param.min || 0));
    return param.choices?.[index] || fmtQuantity(value, "");
  }
  return fmtQuantity(Number(value), param?.units || "");
}

export function finalizeListedParam(raw, mapEntry) {
  let type = raw.type === "boolean" || raw.type === "choice" ? raw.type : "float";
  let min = Number(raw.min);
  let max = Number(raw.max);
  let def = Number(raw.def);
  let authored = raw.authored !== false;
  const step = Number(raw.discreteStep) > 0 ? Number(raw.discreteStep) : 0;
  if (type === "float" && (isBypassParam(raw) || isEnabledParam(raw) || isTwoStateSpan(min, max, step))) {
    type = "boolean";
  }
  if (type === "boolean") {
    min = 0;
    max = 1;
    if (!Number.isFinite(def)) def = 0;
    authored = true;
  } else if (type === "choice") {
    const count = Array.isArray(raw.choices) ? raw.choices.length : 0;
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = count > 0 ? count - 1 : 1;
    if (!Number.isFinite(def)) def = min;
    authored = true;
  } else if (isRawAudioSpan(min, max)) {
    const mapped =
      mapEntry && Number.isFinite(mapEntry.min) && Number.isFinite(mapEntry.max) && mapEntry.max > mapEntry.min
        ? { min: mapEntry.min, max: mapEntry.max }
        : standInWindow({ ...raw, def });
    min = mapped.min;
    max = mapped.max;
    authored = false;
  }
  if (!(max > min)) {
    min = 0;
    max = 1;
  }
  if (!Number.isFinite(def)) def = min;
  def = clampNum(def, min, max);
  return {
    id: String(raw.id),
    label: shortParamLabel(raw.label || raw.id, raw.id),
    type,
    min,
    max,
    def,
    choices: Array.isArray(raw.choices) ? raw.choices.map(String) : [],
    discreteStep: step,
    units: canonicalUnit(raw.units) || inferUnit(raw.id, raw.label, min, max),
    section: typeof raw.section === "string" ? raw.section : "",
    authored,
  };
}

async function readSdkParamInfo(audioNode, moduleInstance) {
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
    const type = p.type === "boolean" || p.type === "choice" ? p.type : "float";
    const min = Number(p.minValue);
    const max = Number(p.maxValue);
    if (type === "float" && (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min))) continue;
    out.push({
      id,
      label: shortParamLabel(p.label || id, id),
      type,
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 1,
      def: Number.isFinite(p.defaultValue) ? Number(p.defaultValue) : Number.isFinite(min) ? min : 0,
      choices: Array.isArray(p.choices) ? p.choices : [],
      discreteStep: Number(p.discreteStep) > 0 ? Number(p.discreteStep) : 0,
      units: typeof p.units === "string" ? p.units : "",
      authored: true,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function faustUiList(audioNode) {
  const lists = [audioNode?.descriptor, audioNode?._output?.descriptor];
  for (const desc of lists) {
    if (!Array.isArray(desc)) continue;
    if (desc.some((item) => item && item.address != null && item.type)) return desc;
  }
  return [];
}

function metaUnit(item) {
  if (!Array.isArray(item?.meta)) return "";
  for (const entry of item.meta) {
    if (entry && typeof entry.unit === "string" && entry.unit.trim()) return entry.unit.trim();
  }
  return "";
}

/** Named Faust groups, when a plugin actually has more than one. */
function faustSectionById(audioNode) {
  const ui = audioNode?.json_object?.ui;
  if (!Array.isArray(ui)) return new Map();
  const found = new Map();
  const names = new Set();
  const walk = (nodes, section) => {
    for (const node of nodes || []) {
      if (!node || typeof node !== "object") continue;
      const kind = String(node.type || "");
      if (kind === "vgroup" || kind === "hgroup" || kind === "tgroup") {
        walk(node.items, String(node.label || "").trim() || section);
        continue;
      }
      if (node.address == null || !section) continue;
      found.set(String(node.address), section);
      names.add(section);
    }
  };
  walk(ui, "");
  if (names.size < 2) return new Map();
  return found;
}

function readFaustParams(audioNode) {
  const desc = faustUiList(audioNode);
  const sections = faustSectionById(audioNode);
  const out = [];
  for (const item of desc) {
    if (!item || item.address == null) continue;
    const kind = String(item.type || "");
    if (kind === "hbargraph" || kind === "vbargraph") continue;
    const id = String(item.address);
    const label = shortParamLabel(item.label || id, id);
    const init = Number(item.init);
    const units = metaUnit(item);
    const section = sections.get(id) || "";
    if (kind === "checkbox" || kind === "button") {
      out.push({
        id,
        label,
        type: "boolean",
        min: 0,
        max: 1,
        def: Number.isFinite(init) ? (init >= 0.5 ? 1 : 0) : 0,
        choices: [],
        discreteStep: 1,
        units,
        section,
        authored: true,
      });
      continue;
    }
    if (kind !== "vslider" && kind !== "hslider" && kind !== "nentry") continue;
    const min = Number(item.min);
    const max = Number(item.max);
    const step = Number(item.step) > 0 ? Number(item.step) : 0;
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) continue;
    const twoState = faustMetaHas(item, "boolean") || isTwoStateSpan(min, max, step);
    out.push({
      id,
      label,
      type: twoState ? "boolean" : "float",
      min: twoState ? 0 : min,
      max: twoState ? 1 : max,
      def: twoState ? (Number.isFinite(init) && init >= 0.5 ? 1 : 0) : Number.isFinite(init) ? init : min,
      choices: [],
      discreteStep: twoState ? 1 : step,
      units,
      section,
      authored: true,
    });
  }
  return out;
}

/**
 * Faust UI order, with each item rewritten onto the SDK id when the group
 * prefix differs (`/stonephaser/Color` vs `/untitled/Color`). SDK-only params
 * stay at the end.
 * @param {object[]} sdk
 * @param {object[]} faust
 */
function mergeListedParams(sdk, faust) {
  if (!faust.length) return sdk;
  const sdkById = new Map(sdk.map((param) => [param.id, param]));
  const sdkByLeaf = new Map();
  for (const param of sdk) {
    const key = leafName(param.id, param.id);
    sdkByLeaf.set(key, sdkByLeaf.has(key) ? null : param);
  }
  const used = new Set();
  const merged = [];
  for (const item of faust) {
    const sdkParam = sdkById.get(item.id) || sdkByLeaf.get(leafName(item.id, item.id));
    if (sdkParam && !used.has(sdkParam)) {
      used.add(sdkParam);
      merged.push({
        ...item,
        id: sdkParam.id,
        label: sdkParam.label || item.label,
        units: item.units || sdkParam.units || "",
        section: item.section || sdkParam.section || "",
      });
    } else if (!sdkParam) {
      merged.push(item);
    }
  }
  for (const param of sdk) {
    if (!used.has(param)) merged.push(param);
  }
  return merged;
}

/**
 * Every parameter a loaded WAM reports. Faust descriptor entries win on id
 * so a checkbox is not turned into an extreme float slider.
 * @param {{ getParameterInfo?: Function, descriptor?: unknown, _output?: { descriptor?: unknown } }} audioNode
 * @param {{ getParameterInfo?: Function }} [moduleInstance]
 * @param {string} [pluginPath]
 */
export async function listWamParams(audioNode, moduleInstance, pluginPath) {
  const sdk = await readSdkParamInfo(audioNode, moduleInstance);
  const faust = readFaustParams(audioNode);
  const map = getWamStickMap(pluginPath);
  const mapById = new Map((map?.params || []).map((p) => [p.id, p]));
  return mergeListedParams(sdk, faust).map((p) => finalizeListedParam(p, mapById.get(p.id) || null));
}

/**
 * @param {ReturnType<typeof finalizeListedParam>[]} params
 * @param {{ ranges?: Record<string, { low: number, high: number }>, axes?: Record<string, string>, switches?: Record<string, number> } | null} [saved]
 * @param {string} [path]
 */
export function createParamModel(params, saved, path) {
  const ranges = {};
  const axes = {};
  const switches = {};
  for (const param of params) {
    const prior = saved?.ranges?.[param.id];
    let low = Number(prior?.low);
    let high = Number(prior?.high);
    if (!Number.isFinite(low)) low = param.min;
    if (!Number.isFinite(high)) high = param.max;
    low = clampNum(low, param.min, param.max);
    high = clampNum(high, param.min, param.max);
    if (high < low) {
      const swap = low;
      low = high;
      high = swap;
    }
    ranges[param.id] = { low, high };
    const axis = saved?.axes?.[param.id];
    axes[param.id] =
      param.type === "float" && (axis === "x" || axis === "y" || axis === "xy") ? axis : null;
    let stored = Number(saved?.switches?.[param.id]);
    // A saved 0 on every Ping Pong level is the old rest position, which mutes the delay.
    const savedPingPong =
      saved?.switches &&
      Number(saved.switches.time) === 0 &&
      Number(saved.switches.feedback) === 0 &&
      Number(saved.switches.mix) === 0;
    if (pingPongLevelParam(param) && savedPingPong) stored = NaN;
    switches[param.id] = quantizeParam(
      Number.isFinite(stored) ? stored : neutralParamValue(param),
      param
    );
  }
  return {
    path: path ? String(path) : "",
    params,
    ranges,
    axes,
    switches,
  };
}

/**
 * Assigned continuous params follow their stick axes across their window.
 * Unassigned continuous params stay at the value set on the dial.
 * Booleans and choices stay at the switch or menu value.
 * @param {ReturnType<typeof finalizeListedParam>} param
 * @param {{ ranges: Record<string, { low: number, high: number }>, axes: Record<string, "x" | "y" | "xy" | null>, switches: Record<string, number> }} model
 * @param {number} stickX
 * @param {number} stickY
 */
export function paramSentValue(param, model, stickX, stickY) {
  if (!param) return 0;
  if (param.type === "float") {
    const axis = model?.axes?.[param.id];
    if (stickAxisOn(axis, "x") || stickAxisOn(axis, "y")) {
      const range = model?.ranges?.[param.id];
      const low = Number.isFinite(range?.low) ? range.low : param.min;
      const high = Number.isFinite(range?.high) ? range.high : param.max;
      return quantizeParam(valueFromStickRange(low, high, stickForAxes(axis, stickX, stickY)), param);
    }
    const manual = Number(model?.switches?.[param.id]);
    return quantizeParam(Number.isFinite(manual) ? manual : neutralParamValue(param), param);
  }
  const stored = Number(model?.switches?.[param.id]);
  return quantizeParam(Number.isFinite(stored) ? stored : neutralParamValue(param), param);
}

/**
 * Write every parameter: stick window, manual value, switch, or menu.
 * @param {{ setParamValue?: Function }} audioNode
 * @param {ReturnType<typeof createParamModel> | null} model
 * @param {number} stickX
 * @param {number} stickY
 */
export function applyWamControls(audioNode, model, stickX, stickY) {
  if (!audioNode || !model?.params) return;
  for (const param of model.params) {
    setWamParam(audioNode, param.id, paramSentValue(param, model, stickX, stickY));
  }
}
