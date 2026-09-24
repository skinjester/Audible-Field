/**
 * Minimal WAM2 host for EchoScape browser audio.
 * Plugins are vendored under /wams/ (no CDN).
 */

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

/** Faust param addresses used by OWLShimmer Gui (and OwlShimmer-named JSON). */
export const OWL_SHIMMER_PARAMS = {
  decay: ["/untitled/DECAY", "/OwlShimmer/DECAY"],
  mix: ["/untitled/MIX", "/OwlShimmer/MIX"],
  shimmer: ["/untitled/SHIMMER", "/OwlShimmer/SHIMMER"],
  tone: ["/untitled/TONE", "/OwlShimmer/TONE"],
  bypass: ["/untitled/bypass", "/OwlShimmer/bypass"],
};

/**
 * @param {{ setParamValue?: (name: string, value: number) => void }} audioNode
 * @param {string[]} names
 * @param {number} value
 */
export function setWamParam(audioNode, names, value) {
  if (!audioNode?.setParamValue) return;
  for (const name of names) {
    try {
      audioNode.setParamValue(name, value);
      return;
    } catch {
      /* try next alias */
    }
  }
}
