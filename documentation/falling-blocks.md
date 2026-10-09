# Falling Blocks

Falling Blocks pours small material cells, called atoms, onto a ground plane. The plane has four quadrants, and each quadrant controls one sound sample. A pile's width, height, position, and behavior change what the listener hears.

Falling Blocks uses the same audio engine as the other Audible Field views. See [The audio graph](audio-graph.md) for signal routing and iOS playback recovery.

## Main files

| Responsibility | File |
| --- | --- |
| Tab lifecycle and audio updates | [`falling-tab.js`](../web-visualizer/public/falling-tab.js) |
| Scene, simulation, and audio snapshot | [`falling-blocks.js`](../web-visualizer/public/falling-blocks.js) |
| Mouse, touch, keyboard, and controller input | [`falling-input.js`](../web-visualizer/public/falling-input.js) |
| Input assignments | [`input-bindings.js`](../web-visualizer/public/input-bindings.js) |
| Materials | [`materials.json`](../web-visualizer/public/materials.json) |
| Material rule processing | [`rule-engine.js`](../web-visualizer/public/rule-engine.js) |
| Field-to-sound mapping | [`grid-sonify.js`](../web-visualizer/public/grid-sonify.js) |
| Shared audio engine | [`audio-engine.js`](../web-visualizer/public/audio-engine.js) |

Falling Blocks is its own tab. It is not a mode inside Visualize.

## How to play

An emitter sits above the plane. Aim it, choose a material, and hold an emit control to pour. The pour continues until the control is released.

### Mouse and keyboard

| Input | Action |
| --- | --- |
| Move the pointer | Aim the emitter |
| Left mouse button or `X` | Pour the widest full-size clump |
| Shift + left mouse button | Pour one half-size stream |
| Right-drag | Slide the plane, holding the emitter on the cursor. The pointer stays locked until the button is released |
| Middle-drag | Turn the plane |
| Shift + right-drag or Alt + right-drag | Turn the plane |
| Mouse wheel | Zoom |
| Tab / Shift+Tab | Next / previous material |

### Touchscreen

| Input | Action |
| --- | --- |
| Drag with one finger on the field | Slide the plane under the centered emitter |
| Twist with two fingers | Turn the plane around the emitter |
| Pinch | Zoom toward or away from the emitter |
| Hold Emit still for 280 ms | Begin pouring |
| Drag Emit upward | Choose a wider clump |
| Drag Emit downward | Choose a narrower or single stream |
| Release Emit | Stop pouring |

Moving the Emit control before the hold finishes restarts the 280 ms wait. The selected size stays in place for the next pour.

### DualSense and other gamepads

| Input | Action |
| --- | --- |
| Left stick or D-pad | Aim; reaching the edge scrolls the plane |
| Cross or DualSense touchpad click | Pour the widest full-size clump |
| Left trigger | Pour one half-size stream |
| Right trigger | Pour a pressure-sensitive stream from narrow to wide |
| Right stick left / right | Turn the plane about the center of the view |
| Right stick up / down | Zoom |
| L1 / R1 | Previous / next material |
| Circle | Clear the field |
| Square | Turn field audio on or off |

On a DualSense touchpad, a finger steers the centered emitter: the pour travels with the stroke, and a circle on the pad is a circle of atoms. A mechanical click pours. The touchpad controls the field instead of the four-corner mixer while this tab is active.

### How clumps form

The widest brush covers an 11 × 11 area. Each cell in a multi-cell brush has a 40% chance to emit an atom. This makes a clump cascade instead of falling as one solid slab. A single-cell stream always emits.

After the brush size changes, the footprint waits about 0.16 seconds before emitting. This prevents a sudden slab while the footprint is resizing.

## Field and camera

Atoms are 0.25 world units wide on a 16-unit plane. The camera stays at a 60-degree downward angle. Its default distance is 30, with a range from 10 to 60.

Pointer yaw and right-stick yaw turn the plane about the center of the view, and the emitter stays on its cell. The Mouse turn setting can put pointer yaw back on the emitter. A two-finger twist turns the plane beneath the emitter. Sliding moves the plane beneath the emitter. The camera does not orbit freely.

The ground and sky stay near black. Each quadrant has a numbered label and the name of its current sample along one edge. Turning the plane moves those labels, but camera direction does not change stem loudness.

## Materials

The palette comes from [`materials.json`](../web-visualizer/public/materials.json). Block is selected by default.

| Material | Behavior |
| --- | --- |
| Block | Falls. A lone floor block shrinks and clears. Blocks in a stack age out, so the pile loses height |
| Sand | Falls and slides into gaps |
| Diffuse | Falls and slides. Exposed grains rise and clear. Contact converts nearby atoms to Diffuse, so a pile can dissolve |
| Erode | Falls, slides, and creeps. It clears atoms it touches and leaves a shrinking mark. Erode is excluded from sound measurements |

Slime, Block Exp, Etch, and Water remain commented out in `materials.json`, so they do not appear in the palette.

## Simulation

Atoms fall at about 28 world units per second until they meet the floor or another atom. Material rules run 22 times per second. Depending on the material, a rule can make an atom fall, slide, creep, age, convert another atom, clear space, or disappear.

Each sound-producing atom receives a lifetime when it is poured. A repeating 0.4-second wave chooses values from 0.1 to 5 seconds. The wave continues even when nothing is pouring. The on-screen display shows the current wave and recent values.

The simulation-to-audio sequence is:

1. Input aims the emitter and pours atoms.
2. Gravity and material rules update the field.
3. `captureAudioSnapshot` measures the field.
4. `fieldFrame` converts those measurements into audio controls.
5. `falling-tab.js` writes the controls to the shared audio engine.

## Sound mapping

Only atoms allowed to produce sound are included in these measurements. Erode is excluded.

| Field measurement | Sound result |
| --- | --- |
| Ground area covered | Wider coverage raises the stem level and opens its brightness filter from about 6 kHz toward 20 kHz |
| Tallest resting column | More height darkens the stem from 18 kHz toward 2.5 kHz, adds up to 6 dB of low tone, and blends in soft clipping. Ten atoms reach maximum weight |
| Connected piles | Each pile plays a separate pitched copy of its quadrant sample |
| Distance from quadrant center | A pile at the center plays one octave higher. A pile at an outer corner keeps the sample's original pitch |
| Pile position after turning and sliding | Moves the stem left or right |
| Rising Diffuse atoms | Opens a bright Grey Hole tail. Feedback rises quickly, then fades slowly while material remains. An empty quadrant closes it quickly |
| Camera closer than default | Makes the full mix louder and adds soft clipping |
| Camera farther than default | Makes the full mix quieter and darker |

Resting height does not add reverb. The reverb tail belongs to rising Diffuse atoms. Rising atoms also do not add weight or change pile pitch.

### Landings

A landing draws a ring and sends an impact to the audio engine at that pile's pitch. The default Phrase mode starts the quadrant sample in step with the bed. Later landings on the same pile extend the phrase instead of starting overlapping copies. A short octave-high layer adds a bright glint.

The phrase opens its filter over about 30 milliseconds and ends shortly after the latest ring fades. Heavier landings are slightly louder.

The engine also contains developer-selectable Grain and Tick modes, although the app has no player control for them. These modes use short one-shot sounds and ignore repeated landings on the same pile for 110 milliseconds.

Face-button effects stay bypassed in Falling Blocks. Clearing the field or turning audio off resets the field measurements and extra voices.

## Out of scope

- Click-to-place as the main editing method
- A separate audio or WAM graph for this view
- Unreal Engine or Steam client
- Multiplayer
- A rigid-body solver for loose pieces
- Melting landed mass into a density field
- Structural collapse beyond what the current material rules clear
