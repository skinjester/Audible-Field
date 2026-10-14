# The work behind Audible Field

Written 12 October 2026 from the git history and the Cursor chats for this project.

The repository has **163 commits**, from 18 August 2026 through 10 October 2026. The chats that produced that work live in three places, because the project folder was moved and then renamed:

- `D:\Users\Gary\PROJECTS\ECHOSCAPE` — 17 August through 23 September
- `D:\Users\Gary\PROJECTS\DEV\ECHOSCAPE` — 23 September through 3 October
- `D:\Users\Gary\PROJECTS\DEV\AUDIOFIELD` — 3 October onward

Renaming the folder on 3 October split Cursor’s chat index. The older conversations were not deleted. They stayed with the old folder names.

## Earlier documents

| Document | What it is |
| --- | --- |
| `Docs/Project_Description.md` | Written 2 September 2026, kept locally and not in git. It describes EchoScape as a product: the meditation-game thesis, the Max patch, the DualSense control scheme, and a timeline that stops on 24 August. |
| `Docs/ECHOSCAPE Project_Description.md` | An earlier copy of that description, from before the browser could make sound without Max. |
| This file | The work history through 10 October. On 1 October there was a request to write a design story in `documentation/`. That chat ended before a file was saved. |

`Docs/` also holds the venture material: vision canvas, SWOT, pitch decks, budgets, and the engineering one-sheet. Those describe the Steam game. This repository is the instrument those materials depend on.

## What the work became

Audible Field is a browser instrument. Activity in a field of four sound quadrants becomes a mix. It began as a window onto Mike Wilcox’s Max/MSP patch for interactive audio installations at Colgate University, built for EchoScape, an interactive meditation game whose line is that calm comes from having something to do with your hands.

The browser app no longer needs Max. It plays four looping samples, hosts local Web Audio Modules in place of the original VST effects, draws a Three.js landscape from the same mix, and runs Falling Blocks, a material simulation whose piles, height, and rising grains are the mix.

Three views share one mixer and one audio engine:

- **Diagnostics** tests input, chooses samples, and assigns effects.
- **Visualize** turns the four-way mix into a landscape.
- **Falling Blocks** is the play surface the later work is about. The app opens there.

## 1. A window onto the Max patch

**17–24 August 2026.** First chat, 17 August: a web visualizer for a Max project whose DualSense touchpad is a four-corner mixer. Each quadrant is a sound. Dragging the pad sets the ratios. The D-pad snaps toward a quadrant, and holding a direction eases the mix across.

The first commits, 18 August, stand the repo up around the Max patches, the control-scheme PDF, the soundscape files, and a Node bridge. Max sends OSC to `127.0.0.1:9000`. The server turns that into WebSocket messages. The browser draws a diagnostics pad and, a day later, effect names read live from the `vst~` objects in the patch.

19–20 August bring the rest of the controller onto the diagnostics tab and a Three.js landscape that morphs between sphere, cube, torus, and cylinder as the mix moves. Face-button effects become ripples, waves, drift, and rings. There is also a short experiment in sending values back to Max, so dragging the on-screen pad could drive the patch the way the touchpad does.

By 24 August the demo patch layout is cleaned up and the visualizer is a documented mirror of the installation instrument: same controller language, same four beds, a picture of the mix. The 2 September project description calls this week the turn from a Max sound instrument into a bridged, visually mirrored DualSense performance system.

## 2. The browser learns to make the sound itself

**22–24 September 2026.** After a quiet stretch, the question on 22 September is how to stop needing Max. The new mode uses the Gamepad API, an on-screen pad, and the Web Audio API: four beds, an equal-power mix, and browser approximations of the VST paths. Browsers cannot load VST3, so the effects become native Web Audio nodes and, within a day, vendored Web Audio Modules stored under `web-visualizer/public/wams/`.

The same days add a sample picker over the loops and one-shots, stick-to-parameter maps for the face-button effects, and DualSense touchpad input through WebHID. The Gamepad API does not expose that pad. Chrome or Edge is required for it. Sticks, triggers, shoulders, and face buttons stay on the normal gamepad path.

A GitHub repository is created on 23 September. `Docs/` is tracked briefly, then ignored again on the same day so the pitch videos and business files stay on this machine.

On 24 September the falling-blocks idea is scoped as audio-as-gameplay rather than a one-to-one picture of the mixer, and a branch named `falling-blocks-environment` is cut to build the smallest version of it.

## 3. Falling Blocks becomes the instrument

**24 September–1 October 2026.** This is the densest stretch. Falling Blocks pours small material cells, called atoms, onto a plane divided into the same four sound quadrants. The camera is fixed, looking down at about 60 degrees. The right stick, and later the pointer, turns the plane instead of orbiting the camera.

The materials are rules, written as small diagrams in `materials.json` and run by `rule-engine.js`. The palette that survived:

- **Block** falls, and a stack ages out from the top so a pile loses height.
- **Sand** falls and slides into gaps, and is allowed to accumulate.
- **Diffuse** falls, slides, rises when exposed, and converts neighbors it touches, so a pile can dissolve.
- **Erode** clears what it touches and is left out of the sound measurements.

Slime, etch, water, and an experimental sliding block were tried and then commented out of the palette. Water in particular was rebuilt once and set aside. Emitter height, atom size, and the ground size were separated after changing one kept resizing the other. A target on the ground shows where the pour will land. Atoms that leave the field are deleted.

Sound mapping, mostly settled between 26 and 30 September and written up in `documentation/falling-blocks.md`:

- Wider ground coverage is louder and brighter.
- A taller resting pile is darker, heavier, and more saturated. Ten atoms reach the full weight.
- Each connected pile plays its own pitched copy of that quadrant’s sample. The center of a quadrant is an octave up. The outer corner keeps the sample’s pitch. The intervals are meant to be musical.
- Sliding the plane pans the stems.
- Rising Diffuse grains open a long Greyhole tail. Resting height does not.
- Moving the camera closer makes the whole mix louder. Moving it farther makes the mix quieter and darker.
- A landing draws a ring and plays an impact. The default is Phrase: the quadrant sample starts in step with the bed, and another landing on the same pile extends the phrase instead of stacking copies. Grain and Tick remain in the engine as developer modes.

Input is reworked almost daily. The right trigger pours a pressure-sensitive clump. The left trigger pours a single stream. On a mouse, click pours the wide clump and Shift-click pours the stream. The emitter follows the pointer. Yaw, zoom-to-emitter, and zoom-to-center are each tried. Shoulder buttons change material. Circle clears the field. An About panel lists mouse, keyboard, and gamepad controls in the same order.

On 28 September the Max bridge is removed. OSC, the “waiting for Max” status, and the plugin-name helper leave the running app. The original patches stay in `EchoScape Max patch files/` as the lineage, not as a dependency. The same night the app is put on Vercel.

Branches from this period — `falling-blocks-audio`, `falling-blocks-mechanics`, `audio-mapping`, `audio-refinement`, `touchscreen-support` — are where the simulation and the mix were developed, then brought back to `main` for deploy.

## 4. A phone, a public URL, and a new name

**28 September–3 October 2026.** Touch is the new input. One finger slides the plane under a centered emitter. Two fingers turn it. Pinch zooms. An on-screen Emit control pours, and dragging it up or down chooses a wider or narrower clump. A long press is required so a drag that is only changing size does not start a pour. The DualSense touchpad, on this tab, steers the emitter instead of the four-corner mixer: a circle on the pad is a circle of atoms.

Phone testing is done on the LAN address printed by the server, then on the Vercel deploy. Audio on a phone cuts out in ways the desktop does not. That becomes the next week’s main problem.

On 29 September the visible name changes from Web Visualizer, and before that Touchpad Mixer, to **Audible Field**. The README is rewritten the same day. On 3 October the root folder is renamed from `ECHOSCAPE` to `AUDIOFIELD`. User-facing copy drops the line that still explained the old name. Folder names and a few code identifiers keep EchoScape where they refer to the original patches.

The same days produce the three guides now linked from the README: Falling Blocks, the audio graph, and Web Audio Modules. The audio-graph guide is written specifically so the iOS playback rules are in one place.

## 5. Getting sound out of a phone

**3–6 October 2026.** Playing Falling Blocks on a phone often produces a silent field until some later gesture, a tab change, or an audio toggle. The cause is iOS Safari’s rule that an `AudioContext` has to be created and resumed inside a user gesture, and that a context can be replaced or suspended underneath a running graph.

The fixes, committed across 4–5 October and written into `documentation/audio-graph.md`:

- Create the context inside the gesture that starts the app.
- Keep one context for the life of the page.
- A start screen on touch devices that the listener has to pass through.
- A speaker-proof tone so the unlock is real, not only a resumed context flag.
- An audio trace the app can show and share, posted to the local server as `trace.log`, so a phone failure can be read after the fact.
- Audible-voice counts in the debug panel, so four silent bed sources are not reported as four playing voices.

On 5 October the start screen also takes the help text, the default tab is Falling Blocks with no memory of the last tab, and the type is set to Segoe UI and system fonts. Open Graph tags and a share image are added so a link preview shows the app. The image URL has to change when the picture changes, or clients keep the old preview.

A separate bug from the same days: switching from Falling Blocks to Diagnostics can leave the beds silent. Bed restart and context handling in `audio-engine.js` are the response.

Diffuse feedback is tuned several times. It was rising too fast for the number of grains in the air, and on a phone it was quieter than on desktop. A settings switch can disable the Diffuse reverb. On 6 October the default rise behavior is named thread, with reverb off until it is chosen.

## 6. The instrument gets a body

**1–10 October 2026.** With the simulation and the phone path in place, the work is feel.

The Emit control gets a hold of about 280 ms, a fill that shows the hold, and a drag that sets clump size. A brief experiment with instant emission is reverted the same day. On desktop, right-drag slides the plane and keeps the pointer locked until release, so the emitter does not jump when the drag ends. Middle-drag turns the plane. Wheel zoom is ignored while that turn is held, because the wheel often moves with the middle button. The right stick is biased so a small deflection turns or zooms, and does not do both at once. Pointer yaw turns about the center of the view. A two-finger twist still turns about the emitter.

Materials are labeled with a one-line description. The settings panel is stacked so it does not sit under the left-hand controls, and on a narrow screen it centers. The clear action sits with the diffusion settings. The Options button on a gamepad opens and closes that panel. Touch devices hide hover-only chrome. The start screen is centered, and on a phone it is required on every load, including a reload when the audio context is already running.

Diagnostics is tightened so the exposed effect parameters are on screen at a desktop width. Stick readouts are aligned. Ping Pong Delay and a stronger Diffuse Greyhole path are added to the effect set.

On 9–10 October the sample payload is cut down after feedback from Thiago. The four default beds were about 32 MB of WAV (Bowed Guitar G, Industry-01, River, and the fourth stem). Masters stay in `sample-master/`, which is not committed and not deployed. Playback uses mono WebM/Opus files in `sample-runtime/`, with AAC as the other encoded copy. The build publishes the encoded files, not the masters. Vercel serves those `.webm` files as `audio/webm`. Loop trimming has to respect codec delay, or the bed, the pile notes, and the landing phrases lose their tails or keep a gap.

A Brave-on-iOS report from the same week: Emit can stick down and keep pouring after release. That is treated as a pointer-capture edge case in the touch path.

## What is still sitting beside main

`main` is the deployed line. Two local branches hold work that is not the current app:

- `garden-setup` is one commit ahead, from 7 October. It adds a Growing Things tab and a cursor-lock change in the falling-blocks input. That tab is not in the running app.
- `audio-optimization` was opened on 10 October for the bed-payload work. That work landed on `main`. The branch tip matches `main`.

Commented-out materials (slime, etch, water, block-exp) remain in `materials.json` as experiments, not as the palette.

The Steam and Unreal path described in `Docs/` is still the venture. This repository is the controller, the mix, and Falling Blocks: the part you can play in a browser.
