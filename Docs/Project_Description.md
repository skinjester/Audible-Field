# EchoScape — Project Description

## Positioning

**EchoScape** is an interactive meditation *game*: players sculpt living soundscapes with a game controller and arrive at calm through play—not guided sessions, narration, or a subscription wellness app.

> “ECHOSCAPE is for everyone who has always wanted to meditate and just needed something to do with their hands.”

---

## What it is trying to accomplish

### Problem

Anxiety is widespread; meditation helps, but many people abandon apps when the mind wanders, they need to move, or practice feels like a chore.

### Answer

Give the hands something meaningful to do. Calm is earned through **agency**—selecting an environment, shaping audio in real time, feeling immediate feedback, entering flow, then returning.

### Core loop

**Select → Shape → Feel → Flow → Return**

The win condition is sustained flow, not finishing a level. The goal is not to finish; it is to return.

### Design pillars

| Pillar | Meaning |
|--------|---------|
| **Agency** | The player always makes a choice. Nothing is passive. |
| **Immersion** | Sound responds to the player’s input immediately. |
| **Flow** | Designed to produce calm, not simulate it. |
| **Simplicity** | Minimal controls. Minimal friction. |
| **Authenticity** | Grounded intent—not wellness theater. |

### What this is not

- A meditation app (no guided sessions, no narrator)
- Passive ambient audio
- A subscription service (one-time purchase intent)
- A clinical product (no medical claims)

### Audience and go-to-market intent

- **Primary:** Gamers 18–35 experiencing anxiety, ADHD, burnout, or stress; fans of ambient / flow games
- **Platforms:** Steam Early Access → full release; mobile TBD
- **Monetization:** Premium one-time purchase (~$15–20); optional post-launch DLC soundscapes

This repository is the **interactive audio / control / visualization R&D spine**—the DualSense-driven sound instrument the game fantasy depends on—alongside product and production docs for the broader venture.

---

## What it connects with

| Layer | Connection |
|-------|------------|
| **Input** | Sony DualSense (touchpad XY mix, face buttons, sticks, triggers, shoulders, D-pad; gyroscope in the Max control path) |
| **Audio engine** | Cycling ’74 **Max/MSP** (`EchoScape-demo`, Vault installation patch with light control) |
| **Effects** | Hosted VST3s: FabFilter (Saturn 2, Pro-C / Pro-R / Pro-L 2, Volcano 3, Timeless 3), Soundtoys (Crystallizer, Decapitator, Little AlterBoy), Kilohearts (Comb / Formant), ValhallaVintageVerb; curated presets including Thesis-era reverb/send names |
| **Content** | Field / designed beds: Beach, Forest, River, Meditation Synth, singing bowls; plus loop and one-shot sample libraries |
| **Installation / lights** | OSC/UDP to network lighting and local control targets—physical/installation lineage (“Vault”) |
| **Web bridge** | Max → OSC UDP `127.0.0.1:9000` → Node.js → WebSocket → browser diagnostics + Three.js visualizer |
| **Browser audio mode** | Optional Max-free path: Gamepad API + on-screen pad → Web Audio (4 Vault beds, equal-power mix, FX approximations) |
| **Product stack (venture)** | Unreal Engine called out in business docs for the Steam game path; this Max + web stack is the high-fidelity sound and controller interaction lab |

### Team context

Founder **Mike Ahearn Wilcox** (vision, soundscape composition, interactive design). Advisors and ops support (including Omer, Greg, Justin). Small remote team working part-time / pro-bono with Slack and a planned two-week sprint cadence.

---

## How it works

### 1. Four-corner soundscape mixer

Touchpad (or mouse) position on a 2D pad is bilinearly mixed into four corner weights (TL / TR / BL / BR). In the web UI those map to Sphere / Square / Torus / Cylinder; in Max they drive the live mix of soundscape stems. D-pad presses ease the cursor to a corner over ~2 seconds so players can snap into a dominant bed without precision aiming.

### 2. Face-button FX slots

Cross / Square / Triangle / Circle select the active plugin path. Left-stick values are scaled per-effect and sent as parameter X/Y (e.g. Saturn, Comb, Formant, Crystallizer). A Max JS helper (`echoscape_fx_names.js`) reads live `vst~` plugin names so the UI stays accurate about what is loaded.

### 3. Full DualSense surface

Right stick, LT / RT, L1 / R1, and stick clicks stream over OSC. The web app is both a live **diagnostics console** (“Waiting for Max” → “Live from Max”) and a **Visualize** mode.

### 4. OSC ↔ Web pipeline

`EchoScape-web-bridge.maxpat` packs Max receives (`mixer_x` / `mixer_y`, D-pad, FX selects, sticks, names, …) into OSC addresses (`/mixer/xy`, `/fx/select/...`, `/pad/...`). `web-visualizer/server.js` parses OSC, broadcasts JSON on `/ws`, and serves the static UI plus Three.js.

### 5. Real-time 3D “echo” of the mixer

`visualize.js` morphs a high-resolution sphere between four radial shapes (sphere / cube / torus / cylinder) using GPU shaders. Active FX modes (ripple, waves, drift, rings) respond to stick drive—so the visualizer mirrors the same agency loop as the audio.

### 6. Installation DNA

The Vault Max patch and light-control UDP show the same controller language used for spatial audio and environment lighting: the controller as the single performative interface across studio demo and installation.

---

## Repository layout (relevant pieces)

```
EchoScape Max patch files/     Audio engine, DualSense mapping, web bridge, presets, beds
  EchoScape-demo.maxpat
  EchoScape-web-bridge.maxpat
  EchoScape-Vault Installation-with light control … .maxpat
  EchoScape Control Scheme.pdf
  echoscape_fx_names.js
  Plugin Presets/
web-visualizer/                OSC → WebSocket bridge + diagnostics + Three.js viz
  server.js
  public/
samples/                       Loops and one-shots
Docs/                          Vision, pitch, schedule, competitive, and this description
```

---

## Progress timeline (this repo)

| Date | Milestone |
|------|-----------|
| **2026-08-18** | Repo standup: Max demo + Vault installation, DualSense control-scheme PDF, soundscape WAVs, plugin presets, first OSC → web mixer UI |
| **2026-08-19** | Web bridge + FX selection/display; `echoscape_fx_names.js`; richer OSC surface |
| **2026-08-20** | Full controller mapping; Three.js visualizer; shared `mixer-core`; Playwright layout audit / motion tests |
| **2026-08-20** | Terrain naming / height functions refined (sphere / cube / torus / cylinder morph) |
| **2026-08-24** | Demo patch visual polish (layout / color / saturation); stylesheet version bump |

About a week of concentrated work turning a Max sound instrument into a **documented, bridged, visually mirrored DualSense performance system**.

---

## Skills this project demonstrates

- Designing **controller-driven real-time audio systems** (Max + VST chain + XY mix semantics)
- Building **cross-runtime bridges** (OSC, Node, WebSockets, browser UI)
- Mapping **gamepad affordances** to expressive parameters with diagnostics and visual feedback
- Shipping under **product intent**: Steam-bound meditation game, validated concept, lean remote team, installation-to-product continuity

### Example resume bullets

- Designed and implemented a DualSense-driven interactive soundscape mixer in Max/MSP, mapping touchpad, sticks, face buttons, and D-pad to multi-stem mix and VST parameter control.
- Built an OSC → WebSocket bridge and browser diagnostics/visualizer (Node, Three.js) so controller state and four-corner mix morphology are visible in real time.
- Integrated commercial VST chains and field-recorded environments into a playable “select → sculpt → flow” loop for an interactive meditation game targeting Steam.
- Collaborated within a small remote product team with vision docs, MVP scoping, and pitch materials aligned to Early Access go-to-market.

---

## Related Docs

| Document | Location |
|----------|----------|
| Vision Canvas | `Docs/Vision, MVP, & Design/ECHOSCAPE_VisionCanvas.docx` |
| SWOT | `Docs/Vision, MVP, & Design/ECHOSCAPE_SWOT.docx` |
| Onboarding | `Docs/ECHOSCAPE_Onboarding.docx` |
| Engineering one-sheet | `Docs/ECHOSCAPE_Engineering_One_Sheet.pdf` |
| Control scheme | `EchoScape Max patch files/EchoScape Control Scheme.pdf` |
| Pitch materials | `Docs/Pitch Decks & Materials/` |
