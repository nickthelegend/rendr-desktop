# What's left

Rendr has **63 MCP tools**, all with a handler, a registry entry, and a live run
against the app. This is the specification for the rest, written so a session
with full context can build them quickly and get them right.

Two rules that produced the current 63, and are worth keeping:

1. **Compose from what already renders.** Transitions are fades. Ducking is
   volume keyframes. Cursor-following crop is position keyframes. None of them
   needed new code in the preview or the encoder, which is why none of them
   disagree between the two.
2. **Run it before claiming it.** Seven of the last fourteen tools shipped with
   a bug that a passing test suite had not caught. Every one was found by
   calling the tool against the live app and reading what came back.

---

## Ready to build — composes from existing machinery

### `add_freeze_frame`
Hold a frame. `capture_frame` already renders a still into the library, so this
is: capture at the playhead, `insert_clips` the PNG for N frames, ripple the
rest. **Trap:** clip speed is clamped to 0.1–8, so a freeze cannot be done by
setting speed to 0 — it has to be a still.

### `set_track_properties`
Mute, solo, lock, height, rename. `manage_tracks` covers rename and add/remove;
the flags exist on `TrackModel` and `setTrackFlag` already writes them.
**Trap:** solo is not "mute the others" — `isAudible` in mixdown.ts already
implements the real rule, so use it rather than reimplementing.

### `batch_export`
Export several aspect/length variants in one call — the actual short-form case.
Compose `reframe_timeline` + `fit_to_duration` + `export_project` per variant,
restoring the timeline between each. **Trap:** each variant must start from the
same timeline; running them in sequence without restoring compounds the retimes.

### `find_scene_changes`
Cut points from picture rather than cursor. `measureScopes` already gives per
frame luma and colour means; a scene change is a large frame-to-frame delta.
**Trap:** a zoom punch-in produces exactly that delta, so regions from
`suggest_zooms` must be excluded or every zoom reads as a cut.

### `apply_look` / `save_look`
Named grade presets. The `ColorGrade` model is already serialisable; store an
array of them beside `workflows` in the project file. **Trap:** `parseProject`
must drop malformed entries rather than throw — see `parseComments`.

---

## Needs new machinery — a session each

### `stabilize`
Motion estimation between frames, then counter-transform via position/scale
keyframes. The keyframe path already renders, so the work is entirely in the
estimator. Phase correlation on a downscaled luma plane is enough for screen
recordings. **Trap:** a screen recording is mostly static; a global estimator
will lock onto scrolling content and fight it.

### `multicam`
Sync several takes by audio (`findSyncOffset` already exists and works), then an
angle-switching model on top. The sync half is done; the switching model is new.

### `speed_ramp`
Speed varying over a clip. Needs `speed` as a keyframeable property and the
decode cursor to honour a non-constant rate. **Trap:** `frameToClipSourceMs`
assumes constant speed — it becomes an integral, and every caller of it needs
checking.

### Generative — `generate_image`, `generate_video`, `generate_audio`, `list_models`
The only four Palmier has that Rendr does not. Each needs a provider and a key.
`generate_audio` is partly done: Kokoro already runs locally for speech, so that
one only needs a music/SFX model. **Trap:** these are the only tools here that
can fail from something outside the machine, so they need the refusal discipline
the rest already use — say what is missing, never return a success-shaped
response for work that did not happen.

---

## Verifying anything added here

```bash
# parity — every declared tool has a handler and a registry entry
node -e 'const fs=require("fs");
const n=[...fs.readFileSync("electron/mcp/toolDefinitions.ts","utf8")
  .matchAll(/^\t\tname: "(\w+)"/gm)].map(m=>m[1]);
const impl=new Set([...fs.readFileSync("src/palmier-ui/agentTools.ts","utf8")
  .matchAll(/^\t\t(?:async )?(\w+)\(/gm)].map(m=>m[1]));
const reg=fs.readFileSync("src/lib/agent/registry.ts","utf8");
console.log(n.length, n.filter(x=>!impl.has(x)), n.filter(x=>!new RegExp(`"${x}"`).test(reg)));'
```

Then call the tool over MCP against the running app and read the response. A
green test suite is necessary and has not once been sufficient.
