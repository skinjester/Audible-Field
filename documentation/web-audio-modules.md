# Web Audio Modules

Audible Field uses [Web Audio Modules](https://www.webaudiomodules.org/) (WAMs) as browser-native audio plugins. A WAM is a JavaScript module that creates an audio node and exposes parameters for automation or user control.

The original Max patch used VST plugins. Browsers cannot load VST or VST3 files, so Audible Field uses native Web Audio effects and locally stored WAMs instead.

All runtime plugins are stored under `web-visualizer/public/wams/`. The application does not download plugins from a public catalog while it runs.

## Main files

| Responsibility | File |
| --- | --- |
| Load and initialize a WAM | [`wam-host.js`](../web-visualizer/public/wam-host.js) |
| Native defaults and legacy shortlists | [`wam-catalog.js`](../web-visualizer/public/wam-catalog.js) |
| Stick-to-parameter maps | [`wam-stick-maps.js`](../web-visualizer/public/wam-stick-maps.js) |
| Effect picker | [`fx-picker.js`](../web-visualizer/public/fx-picker.js) |
| Insert slots and saved preferences | [`audio-engine.js`](../web-visualizer/public/audio-engine.js) |
| Generated catalog | [`build-static.js`](../web-visualizer/scripts/build-static.js) |
| Local `.wasm` MIME type | [`server.js`](../web-visualizer/server.js) |

See [The audio graph](audio-graph.md) for the complete signal path. This page covers only plugin loading and control.

## Current slot behavior

All four face slots start with native Web Audio behavior:

| Face | Default behavior | WAM picker |
| --- | --- | --- |
| Cross | Bypass face; closes the wet path | No |
| Square | Comb filter | Yes |
| Triangle | Formant filter | Yes |
| Circle | Crystallizer-style modulated delay | Yes |

Square, Triangle, and Circle each show every plugin in the generated WAM catalog. They are not limited to the older recommendations in `SLOT_WAM_PATHS`.

Selecting a plugin replaces the native nodes in that slot. Only the selected face has an audible output, but WAM instances assigned to other faces remain loaded. Pressing Cross bypasses the wet path; it does not unload those plugins.

If a WAM fails to load, the engine rebuilds the native effect for that face. All faces also return to native effects when `disableAllWams` is called.

## Saved choices

Assignments, parameter ranges, axis switches, and stick scales are stored in browser `localStorage` under `echoscape.fxPrefs`.

The engine starts the four beds before restoring these preferences. This keeps a slow or broken plugin from delaying the first sound. Startup waits no longer than 12 seconds for preference restoration.

## How the catalog is created

The build script scans `web-visualizer/public/wams/` for `descriptor.json` files. A plugin enters the catalog only when:

1. Its descriptor is valid JSON.
2. An `index.js` file exists beside the descriptor.
3. It is not inside a skipped `utils` or `node_modules` folder.

The build writes the result to:

```text
web-visualizer/dist/catalog/wams.json
```

`fx-picker.js` loads `/catalog/wams.json`, groups plugins by vendor, and shows them in the Square, Triangle, and Circle menus.

Because the catalog is generated, this guide does not keep a second hand-written inventory that can become stale.

## Local folder layout

Wimmics plugins share local SDK files:

```text
web-visualizer/public/wams/
  wimmics/
    OwlShimmer/
      descriptor.json
      index.js
      OwlShimmer.wasm
    utils/
      sdk/
      sdk-parammgr/
      webaudio-controls.js
```

The Wimmics host SDK is served from:

```text
/wams/wimmics/utils/sdk/src/initializeWamHost.js
```

Plugins from another vendor may use a different folder structure and different shared files. Keep their expected relative paths intact.

## Add a plugin

1. Copy the complete plugin folder into the correct vendor folder under `web-visualizer/public/wams/`.
2. Keep its `descriptor.json`, `index.js`, WebAssembly files, images, and other relative assets together.
3. Reuse the existing `wimmics/utils/` folder for a Wimmics plugin. Do not copy a second SDK into each plugin.
4. Run `npm run build --prefix web-visualizer`.
5. Confirm that the plugin appears in `web-visualizer/dist/catalog/wams.json`.
6. Open Diagnostics and confirm that it appears in a face-effect menu.
7. Add or verify its stick mapping in `wam-stick-maps.js`.
8. Test loading, parameter movement, bypass behavior, and fallback to the native effect.

The local server sends `.wasm` files as `application/wasm`. A different server or deployment must do the same.

## Parameter control

`wam-host.js` asks a loaded plugin for its parameter metadata. `createParamModel` combines that metadata with any saved ranges and axis choices.

`wam-stick-maps.js` provides known parameter details when a plugin's reported metadata is incomplete or difficult to use. Each map can define:

- `params`: parameter ID, label, range, and default
- `x`: parameters controlled by the horizontal stick axis
- `y`: parameters controlled by the vertical stick axis
- `forceOff`: bypass parameters that must stay off while the plugin is active

The stick starts at a multiplier of 1. Diagnostics can change each axis scale and choose which parameters an axis controls.

To inspect plugin metadata, run:

```bash
node web-visualizer/scripts/probe-wam-params.mjs
```

Run the local server first. The script uses a browser to load each plugin and writes `web-visualizer/scripts/wam-params-probe.json`.

## OWLShimmer example

OWLShimmer is available as a WAM choice; it is not the default Circle effect. Its current map is:

| Parameter | Address | Range | Axis |
| --- | --- | --- | --- |
| Shimmer | `/untitled/SHIMMER` | 0–0.7 | X |
| Tone | `/untitled/TONE` | 900–8000 Hz | X |
| Decay | `/untitled/DECAY` | 0.5–1 | Y |
| Mix | `/untitled/MIX` | 0–1 | Y |
| Bypass | `/untitled/bypass` | 0 or 1 | Forced off |

If OWLShimmer cannot load, Circle falls back to the native Crystallizer-style effect.

## Per-stem Grey Hole

Falling Blocks also loads one Grey Hole WAM for each stem. These are separate from the face-effect slots.

Rising Diffuse atoms open the corresponding stem's Grey Hole send. The engine fixes delay and size at stable values, then changes send level, return level, and feedback. This avoids repeated long-buffer crossfades inside the plugin.

This use is wired directly in `audio-engine.js` through `GREYHOLE_PATH`; it does not depend on a face-effect assignment.

## Maintenance rules

- Keep every runtime plugin local.
- Keep native effects as fallbacks.
- Let the build generate the plugin inventory from descriptors.
- Add stick maps only where they improve the reported plugin metadata.
- Treat plugin GUIs as optional. Audible Field controls the audio node directly.
- Test heavy WAMs on a phone-class device before making them part of a default experience.
