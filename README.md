# EchoScape

Audible Field is a browser instrument for mixing four sound sources across a field. Pointer, mouse, and DualSense input move the mix. The same audio graph drives three views: a diagnostics mixer, a 3D visualization, and Falling Blocks.

The browser app recreates the EchoScape Max mix path with the Web Audio API. Face-button effects can load local [Web Audio Modules](https://www.webaudiomodules.org/) (WAM2). Native VST plugins stay in the Max patch and are not loaded in the browser.

## Features

- Four-corner, equal-power sample mixing
- Mouse, keyboard, Gamepad API, and DualSense WebHID input
- Local WAM2 effects with stick-to-parameter mappings
- Three.js audio-reactive visualization
- Falling Blocks simulation that turns material behavior into sound
- Runtime sample and plugin selection

## Run

Requires Node.js and npm.

```bash
npm install --prefix web-visualizer
npm start --prefix web-visualizer
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080). The start script builds `web-visualizer/dist` and serves it. Set `PORT` to use another port.

Chrome or Edge is required for DualSense touchpad input (WebHID). Sticks, triggers, and face buttons also work through the Gamepad API.

## Views

**Diagnostics** is the mixer. A pad maps pointer or stick position onto four quadrants. Each quadrant holds a sample. Triggers, shoulders, and face buttons drive tone, reverb, delay, and the active plugin.

**Visualize** uses the same mix and draws it as a Three.js scene.

**Falling Blocks** pours atoms onto a ground plane. Pile width and height drive the four stems. Materials change how piles form. See [documentation/falling-blocks.md](documentation/falling-blocks.md).

Click a quadrant name to choose another sample. Samples are WAV files under `samples/`. The build copies them into the site and writes the library catalog.

## App structure

`app.js` is the browser entry point. It starts audio, polls controller input, switches tabs, and maintains the status line. Each tab exposes a small lifecycle—show, hide, tick, and controller commands—so all views share the same mixer and audio engine.

The main data flow is:

```text
mouse / keyboard / DualSense
          ↓
      mixer-core
       ↙       ↘
 audio-engine  active view
```

`mixer-core.js` owns shared position and controller state. `audio-engine.js` consumes that state and builds the Web Audio graph: four looping stems, equal-power gains, filters, sends, face-button effects, WAM inserts, panning, and output limiting.

### Main modules

- **App and tabs:** `app.js`, `diagnostics.js`, `visualize-tab.js`, and `falling-tab.js` coordinate the UI without duplicating the audio graph.
- **Audio:** `audio-engine.js` loads stems and constructs the graph. `wam-host.js`, `wam-catalog.js`, and `wam-stick-maps.js` load plugins and map stick movement to parameters.
- **Samples and effects:** `sample-picker.js` and `fx-picker.js` provide the quadrant and WAM menus. Selected samples and effects are restored from browser storage.
- **Input:** `gamepad-input.js` handles standard controller data; `dualsense-hid.js` adds touchpad coordinates through WebHID; `input-bindings.js` keeps control mappings in one place.
- **Visualization:** `visualize.js` owns the Three.js scene while `visualize-tab.js` connects it to the shared mixer.
- **Falling Blocks:** `falling-blocks.js` renders and simulates the field, `falling-input.js` interprets controls, `rule-engine.js` applies material rules, and `grid-sonify.js` turns field measurements into stem levels and effects.
- **Shared UI:** `ui-scroll.js` provides the custom scroll behavior used by menus and panels.

Vendored WAMs live under `web-visualizer/public/wams/` and are loaded locally; the app does not depend on a plugin CDN at runtime.

## Build and assets

The source app is a static ES-module site under `web-visualizer/public/`. The build script:

1. Recreates `web-visualizer/dist/`.
2. Copies the public app and sample library.
3. Generates sample and WAM catalogs.
4. Copies the required Three.js module.

Run a build without starting the server:

```bash
npm run build --prefix web-visualizer
```

`dist` is generated output and should not be edited directly. Add samples under `samples/`, edit application code under `web-visualizer/public/`, then rebuild.

## Layout

| Path | What it is |
| --- | --- |
| `web-visualizer/public` | App source: mixer, audio graph, views, vendored WAMs |
| `web-visualizer/dist` | Built site served locally and deployed |
| `samples` | Sample library copied into the build |
| `EchoScape Max patch files` | Max patch and plugin presets for the original instrument |
| `documentation` | Design notes for Falling Blocks, the sample library, and WAMs |

## Documentation

- [Falling Blocks](documentation/falling-blocks.md)
- [Quadrant sample dropdown](documentation/quadrant-sample-dropdown.md)
- [Web Audio Modules](documentation/web-audio-modules.md)
- [Placing Blocks concept](documentation/placing-blocks.md)

## Acknowledgements

Falling Blocks is inspired in part by [TodePond's SandPond](https://github.com/TodePond/Sandpond), a 3D cellular-automata engine in which atoms follow simple spatial rules.

## Deploy

The repo is set up for Vercel. Install and build run inside `web-visualizer`, and the published directory is `web-visualizer/dist`.
