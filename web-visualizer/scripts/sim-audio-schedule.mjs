/**
 * Scheduling contract for a long diffuse run.
 * A creeping field used to write an AudioParam event on every frame.
 * glideParam must stay well under that, and a sliding grain must keep its id.
 */
import { readFileSync } from "node:fs";
import { moveGrain } from "../public/rule-engine.js";

const source = readFileSync(new URL("../public/audio-engine.js", import.meta.url), "utf8");
const start = source.indexOf("let paramWritten");
const end = source.indexOf("/** Equal-power dry/wet.");
if (start < 0 || end < start) throw new Error("could not find the param helpers");
const helpers = new Function(`${source.slice(start, end)}\nreturn { writeParam, glideParam, greyholeIdle, resetParamCaches };`);
const { writeParam, glideParam, greyholeIdle, resetParamCaches } = helpers();

function mockParam() {
  const events = [];
  return {
    events,
    value: 0,
    cancelScheduledValues(time) {
      events.push({ op: "cancel", time });
    },
    setTargetAtTime(value, time, tau) {
      events.push({ op: "target", value, time, tau });
    },
  };
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

// Ten minutes of a creeping send, one update per frame.
{
  const param = mockParam();
  let level = 0;
  const frames = 10 * 60 * 60;
  for (let i = 0; i < frames; i += 1) {
    level = Math.min(1, level + 0.00015);
    glideParam(param, level, i / 60, 0.05, 0.006);
  }
  const targets = param.events.filter((event) => event.op === "target").length;
  if (targets >= frames / 10) fail(`creeping send scheduled ${targets} events in ${frames} frames`);
  else console.log(`creeping send scheduled ${targets} events over ${frames} frames`);
}

// A settled value must not keep inserting events.
{
  const param = mockParam();
  for (let i = 0; i < 36000; i += 1) glideParam(param, 0.42, i / 60, 0.05, 0.006);
  const targets = param.events.filter((event) => event.op === "target").length;
  if (targets !== 1) fail(`settled send scheduled ${targets} events, expected 1`);
  else console.log("settled send scheduled once");
}

// A frozen clock must not schedule. Cancel, then assign .value.
{
  const param = mockParam();
  for (let i = 0; i < 120; i += 1) glideParam(param, 0.42, 0, 0.05, 0.006, false);
  const targets = param.events.filter((event) => event.op === "target").length;
  const cancels = param.events.filter((event) => event.op === "cancel").length;
  if (targets !== 0) fail(`locked glide scheduled ${targets} ramps, expected 0`);
  else if (cancels < 1) fail("locked glide did not cancel");
  else if (param.value !== 0.42) fail(`locked glide left value ${param.value}, expected 0.42`);
  else console.log("locked glide assigned without scheduling");
}

// After caches are cleared, the same number may schedule once on a live clock.
{
  const param = mockParam();
  glideParam(param, 0.42, 0, 0.05, 0.006, false);
  resetParamCaches();
  glideParam(param, 0.42, 1, 0.05, 0.006, true);
  const targets = param.events.filter((event) => event.op === "target").length;
  if (targets !== 1) fail(`live glide after reset scheduled ${targets} events, expected 1`);
  else console.log("live glide after reset scheduled once");
}

// Identical writes stay quiet. That path used to crackle on a resting sheet.
{
  let stored = 0;
  let writes = 0;
  const param = {
    get value() {
      return stored;
    },
    set value(next) {
      writes += 1;
      stored = next;
    },
  };
  for (let i = 0; i < 4000; i += 1) writeParam(param, 0.2, 1e-4);
  if (writes !== 1) fail(`identical writeParam ran ${writes} times, expected 1`);
  else console.log("identical writeParam ran once");
}

if (!greyholeIdle(0, 0, 0)) fail("a dry stem should sleep");
if (!greyholeIdle(0.001, 0.02, 0.02)) fail("a finished tail should sleep");
if (greyholeIdle(0.02, 0, 0)) fail("an open send should stay awake");
if (greyholeIdle(0, 0.2, 0)) fail("a ringing tail should stay awake");
if (greyholeIdle(0, 0, 0.4)) fail("an open return should stay awake");
console.log("greyhole sleep thresholds ok");

{
  const cells = new Map();
  const audio = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const grid = {
    inBounds: () => true,
    get: (x, y, z) => cells.get(key(x, y, z)) || 0,
    set: (x, y, z, value) => {
      if (!value) {
        cells.delete(key(x, y, z));
        audio.set(key(x, y, z), 0);
        return;
      }
      cells.set(key(x, y, z), value);
    },
    getAudioId: (x, y, z) => audio.get(key(x, y, z)) || 0,
    setAudioId: (x, y, z, id) => audio.set(key(x, y, z), id),
    getRiseT: () => 0.4,
    getRiseElapsed: () => 0.2,
    setRise: () => {},
  };
  cells.set(key(1, 0, 2), 4);
  audio.set(key(1, 0, 2), 77);
  if (!moveGrain(grid, 1, 0, 2, 2, 0, 2, null)) fail("slide did not move");
  if (grid.getAudioId(1, 0, 2) !== 0) fail("old cell kept the grain id");
  if (grid.getAudioId(2, 0, 2) !== 77) fail(`slid grain id is ${grid.getAudioId(2, 0, 2)}, expected 77`);
  else console.log("sliding grain kept its voice id");
}

if (!process.exitCode) console.log("audio schedule checks ok");
