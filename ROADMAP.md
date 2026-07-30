# What's left

Rendr has **100 MCP tools**, every one with a handler, a registry entry, and a
live run against the running app.

Two rules produced all hundred, and are worth keeping:

1. **Compose from what already renders.** Transitions are fades. Ducking is
   volume keyframes. Ken Burns is position and scale keyframes. Looks are the
   same `setClipColor` a hand grade uses. None of them needed new code in the
   preview or the encoder, which is why none of them disagree between the two.
2. **Run it before claiming it.** Ten tools in this project have shipped a bug
   that a passing suite did not catch. Every one was found by calling the tool
   against the live app and reading what came back — several by looking at the
   rendered frame, which is why `view_frame` exists.

## What the live runs caught that the tests did not

Worth keeping as a record of what this discipline is for.

- `add_freeze_frame` rippled and inserted, leaving the still lying over footage
  that kept playing underneath. `rippleShift` only moves clips starting at or
  after the cut, so a clip spanning the freeze point has to be split first.
- `reset_grade` wrote an empty colour object. `clipFilter` reads
  `color.contrast` directly, so the clip threw mid-render and silently stopped
  appearing. A grade must be reset to a full default, never to `{}`.
- `batch_export`'s second variant took the first's id and overwrote it, while
  the receipt reported both. `createTimeline` built ids from a render-snapshot
  count and `Date.now()`, both identical inside one synchronous caller.
- `batch_export` also left the caller editing the last variant, because
  `createTimeline` makes each new cut active.
- `measure_audio` was documented as reporting LUFS. It reports an unweighted
  program average in dBFS.
- `solo` was already wired; the gap was that `get_timeline` never reported it.
  Adding a second write path broke the working one.

## Still needing new machinery

### `stabilize`
Motion estimation between frames, then a counter-transform through the position
and scale keyframes that already render. The work is entirely in the estimator.
Phase correlation on a downscaled luma plane is enough for screen recordings.
**Trap:** a screen recording is mostly static, so a global estimator locks onto
scrolling content and fights it.

### `multicam`
`findSyncOffset` already works and `check_audio_sync` exposes it. The sync half
is done; the angle-switching model is new.

### `speed_ramp`
Speed varying across a clip. Needs `speed` as a keyframeable property and the
decode cursor to honour a non-constant rate. **Trap:** `frameToClipSourceMs`
assumes constant speed — it becomes an integral, and every caller needs
checking.

### Generative — `generate_image`, `generate_video`, `generate_audio`
The remaining gap against Palmier. Each needs a provider and a key from the
user. `generate_audio` is half done: Kokoro already runs locally for speech, so
only a music and SFX model is missing. **Trap:** these are the only tools here
that can fail for reasons outside the machine, so they need the refusal
discipline the rest already use — say what is missing, and never return a
success-shaped response for work that did not happen.

## Verifying anything added

```bash
node -e 'const fs=require("fs");
const n=[...fs.readFileSync("electron/mcp/toolDefinitions.ts","utf8")
  .matchAll(/name: "(\w+)",\n\t\tdescription/gm)].map(m=>m[1]);
const impl=new Set([...fs.readFileSync("src/palmier-ui/agentTools.ts","utf8")
  .matchAll(/^\t\t(?:async )?(\w+)\(/gm)].map(m=>m[1]));
const reg=fs.readFileSync("src/lib/agent/registry.ts","utf8");
console.log(n.length, n.filter(x=>!impl.has(x)), n.filter(x=>!new RegExp(`"${x}"`).test(reg)));'
```

Then call the tool over MCP against the running app and read what comes back. A
green suite is necessary and has not once been sufficient.
