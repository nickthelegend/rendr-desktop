# What's left

Rendr has **108 MCP tools**, every one with a handler, a registry entry, and a
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

## Creator editing: what the live runs on camera footage caught

The creator tools were built by running the whole talking-head pipeline on a
real take: captions from local Whisper, retakes, cuts, a 9:16 reframe,
punch-ins, a thumbnail, and an exported MP4. Each of these got past the unit
tests and was caught by looking at the output:

- **Whisper rarely ends an abandoned attempt with a full stop.** "so today
  we're going to, so today we're going to…" comes back as one sentence, so
  retake detection has to treat commas and short pauses as places a speaker
  can start over. It then has to tell that apart from rhetoric ("we want to
  win, we want to grow").
- **Zero-length words.** Local Whisper gives some tokens no duration, and
  `remove_words` dropped them from the rebuilt captions. Cutting "I think"
  silently took "punch" out of the subtitles.
- **Per-project cursor telemetry.** A project with any screen recording drew
  its mouse pointer over camera footage, and reframing panned camera footage
  along it.
- **A graphic took the backdrop with it.** A mind map placed behind a
  green-screened speaker carried the green, so when the map ended the speaker
  sat on black. The backdrop is now its own clip.
- **A static crop can't hold a moving speaker.** A 9:16 crop shows a third of
  the picture. Reframes now follow the face, with a dead zone.
- **Reloads lost everything.** Blob URLs die with the window, so assets now
  keep their path on disk, and reopened projects relink themselves.

### Next for creators

- **Background removal off macOS.** Vision is macOS-only. The cross-platform
  route is transformers.js (already a dependency via kokoro-js) running MODNet
  or RMBG in the main process, writing the same matte video. This needs a
  one-time model download, which should be opt-in.
- **Inspector controls for text style.** Outline, shadow and active-word pop
  are agent-only for now.
- **B-roll.** Search and place stock footage on keywords from the transcript.
  This needs a provider API key (Pexels has a free tier).
- **Chapters and descriptions.** YouTube chapter timestamps from caption
  groups, mapped back through cuts.
- **A limiter.** `normalize_audio` caps its gain rather than limiting peaks,
  so peaky takes land short of −14 LUFS.

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
