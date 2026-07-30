<div align="center">

<img src="public/branding/rendr-logo.svg" alt="Rendr" width="360" />

**Record and edit in one app — driven by humans and agents alike.**

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-2563eb?style=for-the-badge)](LICENSE.md)
[![MCP](https://img.shields.io/badge/MCP-50%20tools-7c3aed?style=for-the-badge)](#the-mcp-server)

</div>

Rendr is an open-source Electron app that captures screen video and edits it in the
same place. Every capability is exposed twice: once as a UI a person uses, and once
as an [MCP](https://modelcontextprotocol.io) tool an agent calls. Neither is a
wrapper around the other — a recording an agent starts runs through exactly the
same pipeline as one a person starts, and the preview and the exported file are
rendered by the same functions.

---

## Where it comes from

Rendr is assembled from two existing open-source projects rather than written from
scratch. **Both are copyleft, and Rendr is licensed accordingly.**

| Project | License | What Rendr takes |
|---|---|---|
| [Recordly](https://github.com/webadderallorg/Recordly) | **AGPL-3.0** | Capture pipeline, cursor telemetry, the zoom camera, and the follow-camera model |
| [Palmier Pro](https://palmier.io) | **GPL-3.0** | The agent editing surface — the MCP tool contract |

> **A note on licensing.** Recordly is **AGPL-3.0**, not MIT. Rendr is therefore
> AGPL-3.0 too, and cannot be relicensed under a permissive license or offered as a
> closed hosted service without releasing the source. If you fork this, the same
> applies to you. Palmier Pro is GPL-3.0; its contribution here is the tool
> *contract* (names, schemas, descriptions), which is transcribed rather than
> compiled, since Palmier Pro is Swift/AppKit/Metal and Rendr is
> Electron/TypeScript.

Recordly's zoom machinery is used directly rather than reimplemented — Rendr
imports `computeZoomTransform`, `findDominantRegion` and `computeCursorFollowFocus`
from the upstream tree. That is deliberate: a reimplementation would drift, and the
feel of the zoom is the reason to start from Recordly at all.

---

## The zoom camera

This is the part worth understanding, because it is what makes a screen recording
watchable and it is not obvious.

**A zoom is a region, not a keyframe.** Each region carries a start and end in
*source* milliseconds, a depth (which maps to a scale), a focus point, and a mode.
Regions live on the clip, so trimming or sliding the clip carries its zooms with it.

**The camera holds still.** A naive follow points the camera at the cursor, which
makes the picture swim under a still hand and lurch on every small movement.
Recordly's camera instead keeps a persistent centre and only recenters when the
cursor leaves an inner **safe zone** — 25% inset from the edges of the zoomed
view — and then moves just far enough to bring it back inside. While a zoom is
releasing, the camera **freezes** where it was rather than drifting home.

That behaviour is stateful, so the state is carried across frames: the preview
holds one in a ref, an export holds one for the run. Both call the same function,
so what you scrub is what gets encoded.

**Zooms are cut automatically**, from **dwells as well as clicks**. A dwell is
the pointer resting somewhere for 450–2600 ms, and it is most of what is worth
punching in on — reading a diff, watching a log, hovering a menu, none of which
involve a click. Recordly exports `buildInteractionZoomSuggestions`, but that
function filters to explicit clicks and discards every dwell, so Rendr calls
`detectInteractionCandidates` directly and keeps both.

This depends on the capture recording a *stationary* pointer. Pointer events only
fire on movement, so a resting cursor writes no samples and a dwell degrades into
a single time gap between two distant points — invisible to the detector. The
capture emits a heartbeat sample at the same interval it thins moves to, which is
what makes "somebody stopped and read something" a zoomable moment at all.

**The camera is spring-driven.** The zoom curve gives a target; the camera does
not jump to it. Scale, x and y are each eased toward that target by a damped
harmonic oscillator (Hooke's law, solved analytically for all three damping
regimes) stepped once per frame. This is what gives a punch-in weight, and what
stops each recentre being a hard cut — on realistic cursor telemetry it reduces
peak frame-to-frame jerk from **525 px to 9.6 px**.

The spring is stepped in the animation frame, never during React render: a
render can happen for reasons unrelated to time passing, and under StrictMode it
happens twice, which would advance the spring twice per frame. While paused or
scrubbing the camera snaps instead, so the frame on screen is the frame you
asked for.

**Motion is tunable**, and matches Recordly's defaults to the millisecond:

| Setting | Default | What it does |
|---|---|---|
| Smoothness | 0.5 | How much the spring eases toward the curve. 0 cuts straight to it |
| Punch in | 1522.6 ms | Time to reach full strength |
| Release | 1015.1 ms | Time to let go |
| Connect zooms | on | Two nearby zooms pan between each other instead of releasing and punching in again |

The drawn cursor uses the same solver, springing toward the raw sample rather
than lagging behind it — a fixed lag reproduces every jitter faithfully, just
late.

---

## Panels

The take-wide settings live in the media rail and in the inspector when nothing is
selected — one implementation, two places, so they cannot drift.

### Background

A raw capture fills the frame edge to edge and reads as a document. Insetting it,
rounding its corners, dropping a shadow under it and putting something behind is
most of what makes it read as a shot.

- **Backdrop** — none, colour, gradient, or a custom image
- **10 gradient presets**, chosen dark enough that white UI stays readable
- **Padding** measured off the frame's *short* edge, so a 9:16 project gets the
  same visual margin as 16:9
- **Radius** and **shadow**, the shadow scaled to canvas height so 720p and 4K match

A custom backdrop is embedded in the project file as a data URI (capped at 8 MB),
so it survives a save rather than dying with the session.

### Cursor

A capture records the pointer as a few hard pixels that vanish at any zoom. Rendr
captures its position separately and draws its own, which is what makes it
scalable, smoothable and clickable-looking.

The capture is opened with `cursor: "never"` (and Chromium's `googCaptureCursor`,
which is the one the desktop pipeline actually reads) whenever telemetry is being
recorded — otherwise the take contains *two* pointers, the small real one the OS
drew and the big one Rendr draws over it. With telemetry off the hardware pointer
is kept, because then it is the only pointer there will ever be.

- **Style** — arrow, arrow with shadow, solid arrow, dot, pointer
- **Size, smoothing, sway** — smoothing springs the drawn pointer toward the raw
  sample, which is what turns jittery hardware sampling into a glide
- **Motion blur**, default **0** — and *directional* when turned up: the smear runs
  along the direction of travel and the perpendicular edges stay sharp. A symmetric
  `blur()` reads as the pointer being out of focus rather than moving
- **Click bounce** and its speed
- **Spotlight** — dims everything outside a soft radial falloff around the pointer
- **Click ring** — expands and fades over 520 ms, deliberately outliving the bounce,
  because on a fast click the pop is over before your eye lands on it

### Webcam

The camera is recorded to its **own file** alongside the screen, not burnt into the
capture — so its size, corner and shape stay editable afterwards. The two share a
clock, so the encoder lines them up without drift correction.

- Position (9-cell grid), shape (rounded/circle/square), size, margin, mirror
- **Reacts to zoom** — the bubble grows a little while the camera is punched in, so
  the presenter doesn't shrink away against the magnified detail
- Per-side crop, applied before the bubble's own centre-crop-to-fill

---

## The MCP server

Rendr runs an MCP server on `127.0.0.1:19790` so **Claude Code, or any agent-driven
IDE**, can drive the editor. It speaks streamable HTTP JSON-RPC.

### Connecting from Claude Code

```bash
claude mcp add --transport http rendr http://127.0.0.1:19790/mcp
```

Any other MCP-capable client works the same way — point it at that URL while Rendr
is running.

### What the agent can do — 101 tools

Every one has a handler, is advertised over MCP, and has been run against the
running app. None is a stub.

**Read** · `get_timeline` `inspect_timeline` `get_media` `inspect_media`
`search_media` `capture_frame` `inspect_color` `get_transcript`
`get_recording_status` `manage_exports` `project_stats` `find_text`
`find_gaps` `check_timeline`

**Look at it** · `view_frame` `compare_frames` `export_still_sequence`

**Timeline** · `add_clips` `insert_clips` `move_clips` `remove_clips` `split_clips`
`ripple_delete_ranges` `set_clip_properties` `set_keyframes` `apply_layout`
`sync_clips` `manage_tracks` `duplicate_clips` `nudge_clips` `trim_clips`
`add_transition` `fit_to_duration` `trim_dead_air` `undo`

**Arrange** · `align_clips` `distribute_clips` `stagger_clips` `close_gaps`
`copy_clip_style` `add_freeze_frame` `replace_media`

**Project** · `create_timeline` `set_active_timeline` `set_project_settings`
`manage_project` `organize_media` `import_media` `export_project`
`batch_export` `remove_unused_media`

**Colour** · `apply_color` `auto_color` `match_color` `apply_lut` `reset_grade`
`save_look` `apply_look` `manage_looks` `check_color_consistency`
`find_scene_changes`

**Motion and framing** · `add_ken_burns` `add_motion_preset` `crop_clips`
`reframe_timeline` `apply_effect`

**Sound** · `denoise_audio` `normalize_audio` `duck_audio` `remove_silence`
`find_silence` `fade_audio` `set_track_volume` `measure_audio`
`check_audio_sync` `align_to_beats` `detect_beats` `mix_to_asset`

**Text and captions** · `add_texts` `add_title` `add_countdown` `update_text`
`add_captions` `style_captions` `export_subtitles` `remove_words`

**Recording** · `list_capture_sources` `start_recording` `stop_recording`
`set_cursor` `set_webcam` `set_background`

**Zoom** · `suggest_zooms` `add_zoom_regions` `update_zoom_regions`

**Notes and narration** · `manage_comments` `setup_voice` `narrate_timeline`

**Workflows** · `manage_workflows` `edit_workflow` `run_workflow`

### The contract

Tools **refuse rather than pretend**. A capability this build genuinely can't do
returns a structured refusal naming what to use instead — never a success-shaped
response for work that didn't happen. Three examples:

- `apply_color` accepts hue targets and 3D LUTs because both now render identically
  in the preview and the file. Anything that would only appear on export is refused,
  because a grade you can't see while editing is worse than none.
- `set_webcam` reports that opening a camera is asynchronous and tells you to read
  the state back before recording, rather than claiming the camera is on.
- `export_project` reports which encoder took the job — `webcodecs-offline` or
  `mediarecorder-realtime` — because they write different containers.

---

## Notes and narration

**Notes** are pinned to timeline frames, on their own lane above the media.
Double-click the Notes track to write one. A note is not a clip — no picture, no
trimming, and it never affects what renders — so it lives beside the timelines
rather than inside them.

They are also the **narration script**. Write one note per beat of the demo, then
`narrate_timeline` speaks them in order and lays each line on a Narration track
starting at its note's frame.

**Speech is local.** Kokoro-82M runs on this machine through onnxruntime — no API
key, no account, and nothing about the project is uploaded, which matters because
narration is usually written against something unreleased. The model is ~90 MB
quantised and is not shipped with the app; `setup_voice` (or **Install voices** in
the inspector) downloads it once into the app's data directory. 28 voices.

A note remembers the words it was spoken from. Edit the wording and the line is
marked **stale** — dashed on the timeline, flagged in `manage_comments` — because
audio that silently disagrees with the script is the kind of mismatch nobody
catches until export. Re-running narration skips notes whose audio is already
current, so it is cheap to run repeatedly.

Lines that would run into the note after them are **reported, not fixed**:
shortening the wording is a writing decision and moving the note is an editing
one, and guessing which was wanted is how narration ends up out of step.

---

## Review speed

A continuous bar in the transport, 0.25×–4×, rather than 1×/2× presets — the rate
that keeps a passage readable is one you find by dragging. Click the number to
snap back to 1×. It multiplies onto each clip's own speed for playback only, so
nothing it does can reach the export.

---

## Export

Two paths, chosen automatically:

**Offline (default)** — WebCodecs `VideoEncoder` into an MP4 (H.264 + AAC).
Frame timestamps come from the timeline, so the file's duration is exact. Source
frames are decoded through a WebCodecs cursor rather than by seeking a `<video>`.

Measured on a 1080p screen take:

| approach | ms/frame |
|---|---|
| decode cursor | **5.5** |
| `<video>` seek | 11.2 |
| `getCanvas(t)` per frame | 104.9 |

A 12-second 1080p export takes about **2 seconds**.

**Real-time (fallback)** — MediaRecorder into WebM (VP9), used when no WebCodecs
encoder accepts the frame size. Takes about as long as the video runs.

---

## Development

```bash
npm install
npm run dev
```

```bash
npm test
```

**1165 tests across 109 files**, including an end-to-end suite that drives the real
editor state through a whole session — import, place, split, undo, grade, save,
reopen — and a pointer-geometry suite that drives real drag gestures.

---

## License

**AGPL-3.0.** See [LICENSE.md](LICENSE.md).

This is inherited, not chosen: Recordly is AGPL-3.0 and Palmier Pro is GPL-3.0.
Network use counts as distribution under the AGPL — if you host Rendr as a service,
you must offer its source to your users.
