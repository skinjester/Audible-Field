# Audible Field

Audible Field is a browser instrument that turns activity in a three-dimensional field into sound. It began as a browser version of Mike Wilcox's Max/MSP patch for interactive audio installations at Colgate University. The browser version uses the Web Audio API and local [Web Audio Modules](https://www.webaudiomodules.org/) (WAMs) in place of the original VST effects.

## Features

- Four sound samples mixed across four corners
- Mouse, keyboard, touchscreen, gamepad, and DualSense controls
- Local browser effects with stick-controlled parameters
- A Falling Blocks simulation that turns material behavior into sound
- Sample and effect selection while the app is running

Input support differs by view. Diagnostics supports mouse, keyboard, and gamepad input. Falling Blocks also supports touchscreen navigation and an on-screen Emit control. Chrome or Edge is required for DualSense touchpad input through WebHID. DualSense sticks, triggers, shoulders, and face buttons use the standard Gamepad API.

## Run

Install [Node.js](https://nodejs.org/) and npm, then run:

```bash
npm install --prefix web-visualizer
npm start --prefix web-visualizer
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080). The start command builds `web-visualizer/dist` and serves it. Set the `PORT` environment variable to use another port.

## Views

### Diagnostics

Diagnostics is a control panel for testing gamepad input, choosing samples, and assigning effects. Its four-quadrant pad changes the level of each sample. Triggers, shoulder buttons, face buttons, and sticks control filters, delay, reverb, panning, and the selected effect.

Click a quadrant name to choose another sample. The menu lists the same library as before: the pieces whose masters live in `sample-master/`, including the nature beds. Playback uses the mono WebM/Opus copy of each listed piece. The build creates the catalog used by the menu and does not publish the masters.

### Falling Blocks

Falling Blocks pours materials onto a plane divided into four sound quadrants. Wider piles become louder and brighter. Taller resting piles sound darker, heavier, and more saturated. Rising Diffuse atoms create a long reverb tail. Material rules decide how atoms fall, spread, transform, and disappear.

Falling Blocks supports mouse, keyboard, touchscreen, and DualSense input. See [Falling Blocks](documentation/falling-blocks.md) for controls and the complete world-to-sound mapping.

## App structure

`app.js` is the browser entry point. It starts audio, switches tabs, polls controller input, and updates the status line. Each tab has a small lifecycle for showing, hiding, updating, and handling controller commands. All tabs share one mixer and one audio engine.

`mixer-core.js` owns shared position and controller state. `audio-engine.js` turns that state into sound through four looping channels, effects, filters, panning, compression, and output limiting. Falling Blocks can write its own channel levels into the same engine. See [The audio graph](documentation/audio-graph.md) for the full routing and the extra steps required by iOS Safari.

### Main modules

- **App and tabs:** `app.js`, `diagnostics.js`, and `falling-tab.js`
- **Audio:** `audio-engine.js`, `wam-host.js`, `wam-catalog.js`, and `wam-stick-maps.js`
- **Samples and effects:** `sample-picker.js` and `fx-picker.js`
- **Input:** `gamepad-input.js`, `dualsense-hid.js`, `touch-input.js`, and `input-bindings.js`
- **Falling Blocks:** `falling-blocks.js`, `falling-input.js`, `rule-engine.js`, and `grid-sonify.js`
- **Shared UI:** `ui-scroll.js`

Vendored WAMs are stored under `web-visualizer/public/wams/` and loaded locally. The app does not need a plugin service or content-delivery network while it runs.

## Build and assets

The source application is under `web-visualizer/public/`. The build script:

1. Recreates `web-visualizer/dist/`.
2. Copies the application and the encoded playback files.
3. Creates the sample and WAM catalogs.
4. Copies the required Three.js module.

Build without starting the server:

```bash
npm run build --prefix web-visualizer
```

`web-visualizer/dist` is generated output. Do not edit it directly. Edit files under `web-visualizer/public/`, add masters under `sample-master/`, and rebuild. New or replaced masters need `npm run encode-beds --prefix web-visualizer` before that rebuild. The command writes the mono playback files under `sample-runtime/`. The app requests those files at `/sample-runtime/`, and the local server reads that folder directly. A local build does not copy them into `dist`. Vercel only publishes `web-visualizer/dist`, so that build includes `sample-runtime/` in the published site and nowhere else in the project. `sample-master/` stays on this machine: it is gitignored, and the build does not copy it into `dist`. A build without that folder, including Vercel, rebuilds the menu from the committed playback map. The Vercel build only copies files already committed, and it serves those `.webm` files as `audio/webm`.

## Repository layout

| Path | Purpose |
| --- | --- |
| `web-visualizer/public` | Application source, audio engine, views, and vendored WAMs |
| `web-visualizer/dist` | Generated site used for local serving and deployment |
| `sample-master` | Local sample masters, including Beach, Forest, and River. Not committed and not deployed. The diagnostics menu lists these names |
| `sample-runtime` | The only copy of the mono WebM and AAC playback files. The app requests this folder directly |
| `EchoScape Max patch files` | Original Max patch and plugin presets |
| `documentation` | Project guides and technical references |

## Documentation

- [Falling Blocks](documentation/falling-blocks.md): controls, simulation, and sound mapping
- [The audio graph](documentation/audio-graph.md): routing, voices, effects, and iOS Safari playback
- [Web Audio Modules](documentation/web-audio-modules.md): local plugin integration and maintenance

## Acknowledgements

Falling Blocks is inspired in part by [TodePond's SandPond](https://github.com/TodePond/Sandpond), a three-dimensional cellular automaton in which simple rules create complex material behavior.

## Deploy

The repository is configured for Vercel. Installation and building run inside `web-visualizer`, and Vercel publishes `web-visualizer/dist`.
