# The audio graph

Audible Field uses one Web Audio graph for every view. The graph is built by `audio-engine.js` and normally stays in place until the page closes. Tabs change its controls instead of creating separate mixers.

Two terms are important in this guide:

- A **bed** is the looping sample played for one quadrant.
- A **stem** is that bed plus its gain, pan, filters, and effect sends.

Diagnostics and Visualize mix the four stems from a pointer or stick position. Falling Blocks measures the field and writes its own levels, pitch, pan, and extra voices into the same graph. See [Falling Blocks](falling-blocks.md) for the world-to-sound mapping.

## Main files

| Responsibility | File |
| --- | --- |
| Graph, beds, extra voices, and iOS recovery | [`audio-engine.js`](../web-visualizer/public/audio-engine.js) |
| Shared mix and controller state | [`mixer-core.js`](../web-visualizer/public/mixer-core.js) |
| Gesture listeners and serialized audio tasks | [`app.js`](../web-visualizer/public/app.js) |
| WAM loading and parameter control | [`wam-host.js`](../web-visualizer/public/wam-host.js) |
| Falling Blocks audio updates | [`falling-tab.js`](../web-visualizer/public/falling-tab.js) |

`audioEngine` is the single shared engine instance.

## Four-corner mix

The corner IDs are `tl`, `tr`, `bl`, and `br`: top-left, top-right, bottom-left, and bottom-right.

Diagnostics and Visualize use `equalPowerMix` from `mixer-core.js`. It starts with four corner weights, makes the nearest corner more distinct, and then balances their power. This keeps the center from sounding much louder than the corners.

Falling Blocks does not use the pointer position for stem levels. The field sets each stem directly. It closes the master output when there are no atoms, audible measurements, or extra voices left.

## Signal path

Read this diagram from top to bottom. It shows the active path to the speakers and the point where extra Falling Blocks voices enter.

```mermaid
flowchart TB
  beds[Four processed stems]
  sum[Stem sum]
  dry[Dry level]
  wetInput[Effect input]
  faceFx[Selected face effect]
  wet[Wet level]
  filters[LT low-pass and RT high-pass]
  shoulderFx[L1 hall and R1 delay]
  extraVoices[Landings and rising grains]
  globalPan[Right-stick pan]
  dynamics[Compressor and limiter]
  master[Master level]
  camera[Camera distance stage]
  speakers[Speakers]

  beds --> sum
  sum --> dry
  sum --> wetInput
  wetInput --> faceFx
  faceFx --> wet
  dry --> filters
  wet --> filters
  filters --> shoulderFx
  extraVoices --> shoulderFx
  shoulderFx --> globalPan
  globalPan --> dynamics
  dynamics --> master
  master --> camera
  camera --> speakers
```

The dry path and selected face effect meet before the trigger filters. L1 and R1 add parallel effects after those filters. Landing and rising voices bypass the face effect and trigger filters, then join the shoulder bus. Everything then passes through global pan, dynamics, the master level, and the camera stage.

## One stem

Each stem starts from the same sample but has independent processing.

| Branch | Path and purpose |
| --- | --- |
| Main bed | Loop → level → mono fold → pan → weight filters and soft clip → brightness filter → stem sum |
| Diffuse tail | Pan → Grey Hole send → Grey Hole return → stem sum |
| Native hall | Pan → shared hall → stem sum. These sends are currently held at zero |

The source samples are stereo. The graph folds each one to mono before its stem panner so Falling Blocks can place a pile in the stereo field. Diagnostics and Visualize leave this stem pan centered.

### From media element to looping buffer

Each bed begins as an HTML media element. This lets a trusted tap call `play()` before the file has finished decoding. When the decoded `AudioBuffer` is ready, the engine switches to a looping `AudioBufferSourceNode` and pauses the media element.

The buffer loop avoids the gap that an HTML media loop can leave at its wrap point. It also avoids keeping a second media decoder active.

Falling Blocks may report several connected piles in one quadrant. In that case, the normal loop stops and each pile receives its own pitched copy of the same sample.

### Weight and brightness

A resting pile controls filters and saturation on the main bed:

- More ground coverage raises the stem level and opens its brightness filter from about 6 kHz toward 20 kHz.
- More height lowers a weight filter from 18 kHz toward 2.5 kHz.
- Height also adds up to 6 dB of low shelf and blends in a level-matched soft clip.
- Ten full-size atoms reach maximum weight. Greater height stays at that maximum.

Resting height does not open reverb. That behavior is disabled because moving Grey Hole's delay while audio was playing caused glitches.

### Diffuse tail

Each stem has its own Grey Hole WAM for rising Diffuse atoms. The send leaves before the weight filters, so the tail remains bright.

The plugin uses a fixed delay and size. The live controls change the send, return, and feedback. Moving delay or size would make the plugin crossfade a long internal buffer, which can interrupt playback. An empty quadrant closes the wet return and feedback quickly.

## Shared controls

| Control or stage | Behavior |
| --- | --- |
| Cross | Bypasses face effects: dry 1, wet 0 |
| Square, Triangle, Circle | Opens the selected face effect: dry 0.85, wet 0.45 |
| Left trigger | Low-pass; open at 20 kHz, then sweeps up from about 200 Hz |
| Right trigger | High-pass; open at 20 Hz, then sweeps down from about 8 kHz |
| L1 | Parallel hall with about 0.12 s attack and 0.45 s release |
| R1 | 0.9 s damped delay with about 0.03 s attack and 0.06 s release |
| Right stick | Global pan, limited to ±0.9 |
| Compressor | −12 dB threshold and 3.5 ratio |
| Limiter | −2 dB threshold and 20 ratio |
| Master | Normal level 0.28, after dynamics |

The shoulder effects change only when their buttons are pressed or released. Starting a new ramp on every frame would prevent a natural release.

Square, Triangle, and Circle begin with native Web Audio effects. A selected [Web Audio Module](web-audio-modules.md) replaces the native effect in that slot. WAM preferences are restored after the beds start, so a slow plugin cannot delay the first sound.

## Landings and rising grains

These voices use the decoded sample from their quadrant. They keep the stem's pan, bypass the face effect and trigger filters, and join the shoulder bus directly.

- **Phrase** is the default landing mode. The first landing starts a sample phrase in step with the bed. Later landings on the same pile extend that phrase. A brief octave-high layer adds brightness.
- **Grain** plays a short sample slice.
- **Tick** plays a short, filtered noise sound.
- Grain and Tick ignore another landing on the same pile for 110 milliseconds.
- Rising atoms can play a drifting scrap, loose loop, flake, thread, shed, or octave-high halo. More simultaneous atoms make each voice slightly quieter.

## Camera distance

The camera stage comes after the master level. At the default distance it does not change the sound.

- Moving farther away lowers the level and closes a low-pass filter.
- Moving closer raises the level and blends in soft clipping.

Falling Blocks updates this stage from its zoom. Other views leave it at the default.

## How views update the graph

Diagnostics and Visualize call `sync(mixState, controller)`. This updates the four stem levels, selected effect, effect parameters, global pan, triggers, and shoulder buttons.

Falling Blocks calls `sync` with `stems: false`, then writes field measurements through these main methods:

| Method | Purpose |
| --- | --- |
| `setStemGains` | Stem level, pan, and brightness |
| `setStemPitch` | One pitch or one looping note per pile |
| `setPileBody` | Weight filters and saturation |
| `setDiffuseGreyhole` | Grey Hole send, return, and feedback |
| `playSplash` | Landing voices |
| `syncRiseGrains` | Rising-atom voices |
| `setOutputLevel` | Master silence for an empty field |
| `setCameraPresence` | Zoom-based level, filtering, and drive |

`stems: false` prevents `sync` from briefly writing the center mix to all four stems. That one audio frame could click when the field should be silent.

The helper `writeParam` also avoids writing the same value every frame. Repeated Web Audio parameter events can create clicks in a quiet graph.

## Start, pause, and sample replacement

`start` builds the graph and loads the four beds one at a time. It starts audible beds before restoring WAM preferences. `app.js` places start, resume, and suspend work on one promise chain so those operations cannot overlap.

`suspendPlayback` pauses media elements and suspends the `AudioContext` without destroying the graph. Falling Blocks uses it when field audio is turned off.

`replaceStem` silences one old bed, builds the new stem, and reapplies the shared mix. Other stems keep their current samples.

## iOS Safari

A tap resumes the context and starts notes immediately. `playSplash`, pile notes, and rise grains do not wait for a later timer.

`glideParam` schedules a ramp only after `currentTime` has moved. Until then it assigns `.value`. A ramp scheduled at a frozen `currentTime` of 0 never applies, which is what silenced the first Emit after the morning of October 4.

The press also starts a short quiet proof buffer straight to the speakers. When that buffer ends, the engine snaps the master gain and restarts any bed that was started while the context was suspended. It does not stop the notes the tap already started.

`pagehide` and a hidden document clear that proof. The next press resumes playback.

### Avoid the iPhone silent switch

The iPhone silent switch can mute an HTML media element. It does not mute decoded Web Audio buffers.

On a phone-class touchscreen, the media element stays at volume zero and its `MediaElementSource` is not connected to the audible stem. The engine still calls `play()` during the gesture because Safari requires it. The decoded buffer provides the audible bed.

On desktop, the media element can remain audible until the buffer is ready.

### Phone checks

- The first sound requires a tap, touch, or key press.
- After lock or background sleep, the next touch resumes the beds.
- The silent switch does not mute decoded bed and impact voices.
- Falling Blocks ignores unlock gestures while its audio toggle is off.
