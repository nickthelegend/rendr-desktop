# Gaps

Every place Rendr was still a shape rather than a working thing. An item leaves
this list when it works end to end, not when it looks right.

**✅ done and exercised · 🟡 built, not yet verified by hand · ⬜ not built**

## Timeline direct manipulation

1. ✅ Drag a clip along its track — verified, 120px drag, one undo entry
2. ✅ Drag a clip between tracks (rejects audio onto video and vice versa)
3. ✅ Drag the left edge to trim the head, source offset moving with it
4. ✅ Drag the right edge to trim the tail — verified, 240px → 160px
5. ✅ Snapping to the playhead, clip edges and zero — verified snapping to frame 0
6. ✅ Snap indicator while dragging
7. ✅ Drag a zoom region to move it
8. ✅ Drag a zoom region's edges to resize it
9. ✅ Marquee selection across tracks
10. ✅ Delete/Backspace removes the selection — verified
11. ✅ Cut, copy and paste — verified paste at a clear playhead
12. ✅ Duplicate — verified
13. ✅ Nudge by frame with arrows, ten frames with shift

## Tracks

14. ✅ Add a video track
15. ✅ Add an audio track
16. ✅ Remove a track (refuses the last of its kind)
17. ✅ Reorder within a kind, refusing to cross zones
18. ✅ Solo, with mute and solo resolved together in `isAudible`
19. ✅ Rename, double-click on the header

## Text

20. ✅ Add Text creates a real clip at the playhead
21. ✅ Text clips carry an editable default and full styling

## Project persistence

22. ✅ Save to a `.rendr` file — verified: v2 JSON, real clips, no blob URLs
23. ✅ Open a `.rendr` file
24. ✅ New project, guarded by a confirm when there are unsaved changes
25. ✅ Rename the project
26. ✅ Autosave and recover after a reload — verified (it recovered a real project)
27. ✅ `beforeunload` warning while dirty

## Export

28. ✅ Export the timeline to a real WebM — verified: a 9 KB VP9 file from 19 frames
29. ✅ Progress with cancel
30. ✅ Settings: resolution and quality
31. ✅ Export the current frame as PNG — verified, a real 53 KB file

## Audio

32. ✅ Waveforms decoded from the real audio — verified painted from a WAV
33. 🟡 Playback through a Web Audio graph (built; not verified audibly here)
34. 🟡 Meter reads the real output level (built; needs audible playback to confirm)
35. ✅ Mute and solo decide what sounds, via `isAudible`

## Zoom

36. ✅ Suggest zooms from cursor telemetry, in the Zoom tab
37. ✅ Capture cursor telemetry while recording
38. ✅ `auto` mode — Recordly's own camera, used directly

## Media

39. ✅ Filter the library by name
40. ✅ Rename an item, double-click on its name
41. ✅ Drop files onto the panel or drag an asset onto the timeline
42. ✅ Undecodable files are reported by name and reason

## Agent / MCP

43. ✅ MCP calls reach this editor, through the same reducers the panels use
44. ✅ `agentConnected` flips on the first real call
45. ✅ Tool receipts appear in the agent panel as calls happen
46. ✅ `get_timeline` — tracks, clips, gaps, zoom regions, defaults omitted
47. ✅ `add_clips`, `remove_clips`, `move_clips`, `split_clips`
48. ✅ `set_clip_properties`
49. ✅ `apply_color`
50. ✅ `add_texts`, `update_text`
51. ✅ `manage_tracks`
52. ✅ `undo` — the shared history
53. ✅ `export_project` (writes a `.rendr` file)
54. ✅ `get_media`, `inspect_media`, `get_recording_status`, `list_capture_sources`

## The 22 declared-but-unbuilt tools

Everything the MCP server advertised but did not implement, closed out.

55. ✅ `apply_effect` — a real effect stack (`effects.ts`), merged by type in a
    canonical render order, rendered identically by the preview and the encoder
    through one `clipFilter()`
56. ✅ `apply_layout` — slot geometry (`layout.ts`) that computes transform and
    crop together so a clip fills its slot without stretching
57. ✅ `set_keyframes` — clip-relative keyframes (`keyframes.ts`) resolved by one
    `clipAtFrame()` that the preview, the encoder and the audio mix all read
58. ✅ `insert_clips` — ripple insert that splits what it opens inside
59. ✅ `ripple_delete_ranges` — merged ranges cut back-to-front so earlier ones
    keep their frame numbers
60. ✅ `inspect_color` — scopes measured off a real rendered frame (`scopes.ts`),
    plus a subject−reference gap in `apply_color`'s own vocabulary
61. ✅ `inspect_timeline`, `capture_frame` — composited frames rendered through
    the same `renderFrame()` the export uses, returned as MCP image parts
62. ✅ `create_timeline`, `set_active_timeline`, `set_project_settings` — with a
    frame-rate change that rescales every clip so the cut keeps its timing
63. ✅ `import_media` (url · path · bytes · matte), `organize_media` (library
    folders), `search_media` (names, folders, and the transcript on the timeline)
64. ✅ `detect_beats`, `remove_silence`, `sync_clips` — energy-flux onsets,
    relative-threshold silence, and envelope cross-correlation (`analysis.ts`)
65. ✅ `denoise_audio` — spectral subtraction over an overlap-added STFT
    (`denoise.ts`), applied in the offline mix
66. ✅ `manage_exports`, `manage_project` — over a real export job list
67. ✅ `suggest_zooms` reaches the editor window, which owns the timeline

## What the tools needed underneath

68. ✅ **Exports carry sound.** A canvas has no audio track, so every export was
    silent. `mixdown.ts` renders the timeline offline — level, fades, volume
    keyframes, speed, denoise — and the desktop build muxes it back in.
69. ✅ **Video clips are audible.** Playback only sounded clips on audio tracks,
    so a screen recording's microphone was never heard.
70. ✅ **Fades and volume keyframes are audible.** Playback read `volumeDb`
    alone; one `clipGainAt()` now drives playback, the meter and the mix.
71. ✅ **UI for all of it** — an Effects tab, keyframe diamonds beside Opacity,
    Rotation and Volume, library folders with drag-to-file, a Project Settings
    sheet, and a Timeline menu that creates, duplicates, renames and switches.

## Declared arguments that were being ignored

A tool that accepts an argument and does nothing with it is the same lie as a
tool that isn't built — worse, because it reports success. An audit comparing
every declared `inputSchema` property against what each handler actually reads
found 12 tools ignoring 40 arguments between them. All of them now either do
something or are refused by name.

72. ✅ `export_project` honoured none of `mode` — it always wrote a `.rendr` and
    said "saved". It now writes real **XMEML** for Premiere and **FCPXML** for
    Resolve and Final Cut (`interchange.ts`), reports what each format could not
    carry, and refuses `video` by pointing at the Export dialog rather than
    pretending a tool call can drive a live canvas.
73. ✅ `apply_color` ignored 15 grading parameters. Tone curves (master and per
    channel) and the three-way lift/gamma/gain balance are now real
    (`curves.ts`), rendered by an SVG `feComponentTransfer` in the preview and
    the identical 256-entry table in the encoder. `lut` and `hueCurves` are
    refused, because both need a pixel's other channels and the preview could
    only fake them.
74. ✅ `remove_words` edited the caption text and left every "um" audible. It
    now cuts the words out of every track and rebuilds the captions from what
    survived — which is what `cutAggressiveness` was always describing.
75. ✅ `get_timeline` gained `startFrame`/`endFrame` windowing and
    `captionDetail`; captions collapse to one row per group by default.
76. ✅ `inspect_media` samples real frames (`overview`, `maxFrames`,
    `startSeconds`, `endSeconds`) and accepts a `clipId`.
77. ✅ `get_transcript` gained `clipId`, a frame window, and `granularity`.
78. ✅ `update_text` gained `captionGroupId`, `transform`, `animation`,
    `highlightColor`; `add_captions` gained `style`, `animation`,
    `highlightColor`, `transform`, `maxWords`.
79. ✅ `manage_tracks` gained `reorder`; `set_clip_properties` gained
    `durationFrames` and fade interpolation; `get_media` gained a folder filter.
80. ✅ Everything genuinely unbuildable — `lut`, `hueCurves`, `fillMode`,
    `censorProfanity`, `wordTimestamps`, timecode sync — is refused with a
    sentence saying why and what to use instead.

**Audit result: 42 of 42 editor tool schemas fully consumed. No tool accepts an
argument it ignores.**

## Fades were audible but invisible

81. ✅ `fadeInFrames`/`fadeOutFrames` moved the audio level and never touched the
    picture — the preview and the encoder both read `clip.opacity` directly. One
    `fadeMultiplierAt()` now drives both, so a fade set in the inspector dips the
    image and the sound together, and a fade-out reaches actual silence instead
    of stopping one frame short.

## Running the Electron app

72. ✅ Electron launches, builds main + preload, serves the editor
73. ✅ Rendr opens its **editor** at launch, not just the recording HUD
74. ✅ MCP server reachable from outside the app — 44 tools listed
75. ✅ `get_timeline` returns the real editor state over MCP
76. ✅ `add_texts` over MCP puts a real clip on the real timeline
77. ✅ The Claude CLI accepts Rendr's exact spawn shape, and Rendr's MCP server
    appears in the CLI's server list

The one thing that can't be verified here is Claude *answering*: the CLI on this
machine isn't signed in. Rendr surfaces that as
"Claude Code isn't signed in. Run `claude` in a terminal and log in" rather than
failing silently. Run `claude` once, log in, and the panel works.

## Bugs found and fixed while doing this

- **Duplicate asset ids.** The id counter restarted on reload, so a recovered
  project and a fresh import both produced `asset-1`. React duplicated rows and
  clips silently attached to the wrong media. Ids now carry a random component.
- **MCP server leaked its port.** `close()` doesn't wait on keep-alive sockets,
  so the port stayed held and a restart could fail. The server now tracks and
  destroys its sockets, and tests bind port 0.
- **Progress bar relayout.** The export bar transitioned `width`, which
  relayouts every frame; it scales a transform now.
- **The timeline was misaligned.** Track headers rendered 113.9px against the
  100px the ruler and playhead assumed — four tool buttons pushed the header
  past its flex-basis. The width is now one number (`Layout.trackHeaderWidth`),
  pushed into CSS as `--pmr-track-header` and pinned so the header can't grow.
  Measured after the fix: lane, tick zero and playhead all at the same x.
- **Three tool receipts lied about React's timing.** `createTimeline`,
  `setActiveTimeline` and `importMedia` each read a value back after
  `setState`, but React runs an updater when it *schedules*, not when it is
  called — so a timeline that was really created came back as
  "The timeline couldn't be created", and a real import as "Rendr couldn't read
  that file". All three now compute the answer from the snapshot in hand and
  commit it, the same shape `mutate()` already used.
- **Ripple insert covered what it landed on.** `insert_clips` pushed clips whose
  *start* was past the insertion point, which is right for a ripple delete but
  leaves a clip spanning the point sitting underneath the inserted footage. It
  splits at the point first now; a regression test asserts no two clips on a
  track ever overlap after an insert followed by a ripple delete.
- **`denoise_audio` accepted stills.** It only refused when every target was
  text, so an image clip stored a denoise setting nothing would ever apply. It
  now checks that the clip's asset actually carries audio, and reports what it
  skipped.
- **`get_media` hid library folders.** `organize_media` filed an asset away and
  the agent had no way to see where it went.
- **The overlap-add denoiser amplified its own edges.** The first and last
  frame's worth of audio was divided by a near-zero window sum, which came back
  ~2× the input peak. The signal is padded by a frame at each end now.
- **Beat detection locked onto the bar, not the beat.** Autocorrelation peaks
  just as hard at half and a quarter the tempo, so a 120 bpm click track read as
  60. It now prefers a subharmonic that scores nearly as well, correlates on
  mean-removed flux (rectified flux is all-positive and correlates with
  everything), and uses ~10 ms frames so a period that isn't a whole number of
  frames still lands.
- **Cross-correlation matched on slivers.** A lag leaving four samples
  overlapping could correlate perfectly by accident and win. Matches now need a
  quarter of the shorter take and are weighted by how much actually overlapped.
- **`remove_words` didn't remove anything from the cut.** It edited the caption
  text and left the filler audible — a subtitle that no longer admits what you
  can hear. It now ripple-deletes each word's span from every track and rebuilds
  the captions from the survivors.
- **Fades never touched the picture.** See above; one resolver now drives both.
- **The fade-out stopped a frame short of silence.** It measured against
  `endFrame` rather than the clip's last frame, so a 10-frame fade bottomed out
  at 10% and cut.
- **Trim to Playhead did nothing.** Q and W wrote the *source* offset instead of
  moving the clip's edge, so they recorded an undo step and changed nothing
  visible. They now call the trim reducers, and skip clips the playhead isn't
  inside so a miss leaves no empty step.
- **Agent edits went to the wrong window.** The MCP bridge targeted
  `mainWindow`, which follows whichever window is current — the recording HUD at
  launch. Editing tools landed there and were refused. The bridge now holds a
  dedicated editor reference, and the legacy registry declines editing tools
  instead of answering them.
- **Tool receipts lied about success.** `mutate` read React state back after
  `commit`, but a state updater runs when React schedules it, not when it is
  called — so a successful `add_texts` reported `changed: false`. The next
  timeline is computed before committing now.
- **The Claude CLI swallowed the prompt.** `--allowed-tools` takes a list, so a
  trailing prompt argument was read as another tool name and the CLI exited with
  "Input must be provided". The prompt goes on stdin.
- **MCP status read as a failure.** Servers attach lazily and report `pending`
  at init; that was treated as "couldn't reach Rendr's tools".

## Captions and transcription

55. ✅ Transcribe a clip to word-level timing (HyperFrames CLI, Parakeet/whisper)
56. ✅ Fall back to Recordly's bundled whisper.cpp when HyperFrames isn't installed
57. ✅ Group a word transcript into readable cues (pause, sentence, line length)
58. ✅ Import `.srt` and `.vtt` — verified end to end
59. ✅ Export captions back out as `.srt`
60. ✅ Captions land on their own CC track, tagged with a group id
61. ✅ Cue list with timecodes; click to jump, edit text inline
62. ✅ `add_captions`, `get_transcript`, `remove_words` over MCP
63. ✅ Text animations actually animate — fade, slide_up, pop, typewriter,
    word_by_word, karaoke — in both the preview and the encoder
64. ✅ Karaoke highlights the spoken word — verified: the highlight travels

## Claude in the agent panel

65. ✅ The panel talks to the user's own `claude` CLI — no API key in Rendr
66. ✅ The CLI is pointed back at Rendr's MCP server, so the model that answers
    is the one that can edit the timeline
67. ✅ Streamed replies merge into one message rather than a spray of fragments
68. ✅ Tool calls appear as receipts as they happen
69. ✅ Reports when the CLI can't reach Rendr's tools, instead of silently chatting
70. ✅ Translates "Not logged in" into something an app user can act on
71. ✅ Says plainly that a browser tab can't reach the CLI

## Verified against a real screen recording

Everything above was checked on generated mattes until this pass. Recording the
screen for real found six defects that no synthetic test would have.

82. ✅ **`list_capture_sources` couldn't list anything.** It read a cache the
    Record panel filled when it opened, so on a machine that captures perfectly
    well it reported "sources are enumerated when the Record panel opens". It
    enumerates through `desktopCapturer` itself now.
83. ✅ **`start_recording` and `stop_recording` weren't implemented in the
    editor at all.** They routed to the "recorder window", which since Rendr
    opens the editor at launch *is* the editor — which had no handler. An agent
    asking to record got "declared but not implemented yet". The editor now
    registers the same capture the Record button drives.
84. ✅ **Capture was refused with a bare "Permission denied".** The inherited
    permission policy trusted exactly one document — `?windowType=hud-overlay` —
    and Rendr records from `?windowType=editor-next`. Both the window check and
    the URL check now name the editor. The rule is otherwise unchanged: one of
    Rendr's own top-level windows, main frame only, exactly one `windowType`
    query parameter from a known set.
85. ✅ **Picking a specific screen opened the OS chooser again.** The picker
    called `getDisplayMedia`, which ignores the source already chosen. Electron
    can capture a `sourceId` directly, and now does — so "Screen 1" records
    screen 1.
86. ✅ **Cursor telemetry only ever saw Rendr's own window.** The whole point of
    `suggest_zooms` is punching in on what the user clicked, and a recording of
    any *other* app yielded nothing. The native whole-desktop hook Recordly
    already bundles is now what the editor uses.
87. ✅ **`hasAudio` was hardcoded `true` for every video.** A silent screen
    recording advertised audio, so the mixer tried to sound it and
    `detect_beats` refused with a confusing error after the fact. Imports probe
    for a real audio track; a recording reads it off the captured stream.
88. ✅ **The export said "finished" and wrote no file.** Electron opens a Save
    As dialog for a download with no save path, so the render completed and the
    dialog sat waiting. Downloads now land in ~/Downloads under a unique name —
    which is what `export_project` always claimed — and the job reports the real
    path.
89. ✅ **The exported video played fast.** MediaRecorder timestamps each frame by
    the wall clock at the moment it arrives, so a render that outran real time
    packed 150 frames of a 5-second cut into 2.8 seconds. The loop is paced to
    the timeline's frame rate; measured after the fix: 5.09s for 150 frames.
90. ✅ **Adding a title cut a hole in the footage.** `add_texts` dropped the text
    on the topmost video track and cleared whatever it landed on, so a caption
    over a screen recording turned that span black in the export. Text goes to a
    video track with room for it, and gets a new track on top when there is none.
91. ✅ **`export_project mode:"video"` refused to run.** It pointed at the Export
    dialog on the belief that the encoder needed a visible canvas — it renders
    into its own offscreen canvas, and the dialog only ever supplied the
    progress bar. It runs from a tool call now and returns a real jobId.

92. ✅ **`start_recording` and `stop_recording` ignored six of their own
    arguments** once implemented — `microphoneDeviceId`, `systemAudio`,
    `captureCursor`, `name`, `recordingId`, `discard`. All wired: the take can
    be named, the cursor left out of the picture, a specific microphone chosen,
    and a bad take discarded without ever entering the library. A
    `recordingId` naming a different take is refused rather than stopping the
    wrong one.

**Audit result after this pass: 44 of 44 declared tools implemented, and 44 of
44 schemas fully consumed. No tool accepts an argument it ignores.**

### What the real take proved

One agent-driven run — `start_recording` → `add_zoom_regions` → `apply_color`
→ `add_texts` → `export_project` — produced `~/Downloads/EndToEnd.webm`:
VP9, 1280×720 (the requested 720p downscale), 5.09s for a 150-frame timeline.
Frame 45 is punched in by the zoom with the title composited over live footage;
frame 140 is the same desktop un-zoomed. Both carry the blue shadow tint
(U 155, V 107 against a neutral 128).

A second run with a real 5-second tone proved the audio path: the file carries
a VP9 stream and an **AAC 48 kHz stereo** stream, and the encoded envelope
measures −48.9 dBFS at the start of the fade-in, −30.4 dBFS through the middle,
and −54.3 dBFS at the end of the fade-out.

## The record surface, ported from Recordly

93. ✅ **Tailwind's config was never loaded outside Electron.** The plugin's own
    discovery looks in the *current working directory*, not the Vite root, so
    launching the browser dev server from a parent directory found no config,
    every theme extension vanished, and `@apply border-border` failed with "the
    `border-border` class does not exist". `postcss.config.cjs` names the file
    explicitly now; the browser build renders the whole editor.
94. ✅ **419 duplicated lines removed from `palmier.css`** — 44 selectors whose
    bodies were byte-identical. Only the *earlier* copy of each pair was
    dropped, which cannot change which declaration wins; a check comparing the
    final winner for all 1427 (selector, property) pairs before and after
    confirmed nothing moved.
95. ✅ **The source picker showed a glyph instead of the screen.** The
    `get-sources` IPC already returned live thumbnails, app icons and owning app
    names — Rendr threw them away and drew a generic monitor outline, so two
    windows called "Untitled" were indistinguishable. Ported Recordly's
    `SourceSelector`: sections for Screens / Windows / Cameras with a count
    badge, a live frame per source, the owning app's icon and name beneath, and
    a PRIMARY badge on the main display. Previews refresh every 3s while the
    picker is open rather than freezing at the moment it was opened.
96. ✅ **The picker was trapped in a 240px column.** It rendered inside the media
    pane and `.pmr-sheet__scrim` was `position: absolute`, so the "modal" dimmed
    one panel and squeezed the thumbnails into a strip. It mounts at the shell's
    top level now, the scrim is `fixed`, and the sheet is 720px wide — enough
    for three previews per row. Closes on Escape or a click outside.

## Recording and zoom, from the user's own report

97. ✅ **Capture began during the countdown.** `createRecorder` called
    `recorder.start()` the moment the stream opened, so "3… 2… 1…" was the head
    of every take. The encoder is now armed but idle, and `beginRecording` calls
    it when the count reaches zero. Measured after the fix: a 3s countdown and a
    ~3s take exports a 2.94s file, not a 6.7s one.
98. ✅ **The elapsed timer double-counted**, found while checking the above — it
    reported 10s for a 6.7s wall clock. `startElapsed` was scheduled from
    *inside* a state updater, and React may run an updater more than once for
    the same tick, so two intervals could both be incrementing. The countdown
    and the elapsed clock are both driven from timestamps now, and starting the
    capture is guarded so it can only happen once.
99. ✅ **The window controls overlapped the File menu.** The editor uses
    `titleBarStyle: "hiddenInset"` with the traffic lights at x=12 — exactly
    where the mark and the menu started. The bar is inset past them on macOS
    only, and doubles as the window's drag handle with every control opting out.
100. ✅ **Zooms had nowhere to live in the timeline.** Regions were drawn as a
    thin stripe inside the footage clip: impossible to click, impossible to drag,
    and invisible on a short clip. There is a **Zoom track** now, above every
    other track — clicking empty space adds a region at that point, each block
    shows its depth (`1.8×`), and the ends drag to retime it. A region is stored
    in its host clip's source milliseconds, so the lane maps every block back
    through that clip's trim and speed.
101. ✅ **The cursor is drawn, not captured** (`cursor.ts`). A screen recording's
    own pointer is a few hard pixels that vanish under a punch-in, so Rendr
    draws its own from the telemetry — with Recordly's controls and Recordly's
    values to the digit: size 2.5×, smoothing 0.67, motion blur 0.4×, click
    bounce 3.5×, bounce speed 350 ms, sway 0.2×, five pointer shapes, show and
    loop toggles. The same resolver runs in the preview and in the encoder, so
    the pointer in the file is the pointer on screen.
102. ✅ **Fullscreen preview.** The preview is its own fullscreen root, so the
    canvas and the transport go fullscreen together — a bare canvas would leave
    nothing to scrub with.
103. ✅ **Cursor settings survive an older project.** Both new panels read
    `state.cursor ?? DEFAULT_CURSOR`; a project saved before the field existed
    would otherwise have crashed the inspector and the preview.

## The round the user reported

104. ✅ **Zooms never actually zoomed the preview.** The camera reported the
    right scale — the engine was fine — but `stage` was `{0, 0}`, and
    `resolveCamera` treats a zero-sized stage as "nothing to do". The
    ResizeObserver was attached in an effect with an empty dependency list, and
    on first mount the preview is showing its *empty state* (a restored project
    arrives a tick later), so there was no canvas to observe and it never
    attached again when one appeared. A callback ref binds whenever the node
    appears, and takes a first measurement from the box itself rather than
    waiting a frame. Verified in the DOM: `scale(3.5)` at a frame inside the
    region, `scale(1)` outside.
105. ✅ **A zoom sat on the middle of the screen instead of the cursor.** This is
    the point of the feature. An `auto` region now follows the pointer: the
    focus is the telemetry averaged over about a second either side with a
    triangular falloff, and a click counts double — so the punch-in lands on
    what the pointer is *doing* rather than twitching with every tremor. A
    `manual` region keeps the focus it was aimed at. New regions also start at
    the cursor, so they are right before the follow takes over.
106. ✅ **The same region was drawn twice** — once in the new Zoom track and
    once as the old stripe inside the footage clip. The stripe is gone.
107. ✅ **The floating record bar is in its own window and stays out of the
    video.** It is always-on-top, transparent, focus-free and
    content-protected, with elapsed time, pause/resume, stop and discard; the
    editor pushes it state and it sends back what was pressed. Proven by
    capturing the screen and the recording at the same moment: the bar is on the
    screen and absent from the file. The in-editor HUD is kept only for the
    browser build, which has no second window to put it in.
108. ✅ **The webcam** (`webcam.ts`): show, reacts-to-zoom, mirror, size, margin,
    shape, a nine-cell position grid and a crop into the camera image. Sized
    against the canvas' *short* edge so a vertical project's bubble isn't
    enormous, and cover-cropped so the camera is never stretched. The stream is
    held by the shell, so turning the inset off actually releases the device.
109. ✅ **The app has its own icon.** `build/icon.svg` → `icon.png` / `icon.icns`,
    wired into electron-builder for mac, win and linux. The existing
    `syncDockIcon` set Recordly's artwork and ran after anything else, so it now
    prefers Rendr's and falls back to the old asset.

## Still not built

Named so nobody mistakes the app for finished:

- **Generation**: `generate_video`, `generate_image`, `generate_audio`,
  `upscale_media`, `list_models` — these need an account and a paid backend.
  They are not declared, so an agent never sees a tool it cannot use.
- **Multicam and nested timelines.** A project holds several timelines and can
  switch between them, but one cannot be placed inside another as a clip.
- **3D LUTs and hue curves.** Both need a pixel's other channels to decide its
  result, and the preview grades through a CSS filter chain that sees one
  channel at a time. Rendering them only on export would mean the preview lying,
  so `apply_color` refuses them and points at the RGB curves and the three-way
  balance, which both renderers apply identically.
- **The webcam is a live inset, not a recorded track.** It composites over the
  capture in the preview and can be positioned, cropped and shaped, but the
  camera is not yet written into the exported file as its own stream — the
  encoder draws the screen, not the bubble.
- **A curve editor in the UI.** The three-way balance has sliders in the
  Inspector; tone curves are set through `apply_color` and shown there as a
  "tone curve set" marker with a reset.
- **Embedded source timecode.** `sync_clips` aligns by audio correlation only;
  `mode: "timecode"` refuses, because reading timecode needs a container parser
  Rendr does not have.
- **Semantic media search.** `search_media` matches names, folders and the
  captions already on the timeline. There is no on-device visual index, and the
  response says so in an `index` block rather than returning an empty list that
  looks like "no such footage".
- **A project registry.** `manage_project` lists the open project only, and
  `action: "open"` refuses — opening a file from disk goes through the user's
  own File → Open.
- **Offline export.** Encoding walks the timeline in real time rather than
  decoding ahead, so a long project takes about as long as it plays — and now
  deliberately so, because the container's frame timing comes from when frames
  were handed to the encoder. WebCodecs plus a muxer would fix both.
- **A real click during an agent-driven recording.** `suggest_zooms` needs
  clicks, and an agent can start a capture but shouldn't drive the user's mouse.
  The telemetry pipeline is proven end to end (`hasCursorTelemetry: true`, and
  `suggest_zooms` reports `no-interactions` rather than `no-telemetry`), but a
  proposal built from real clicks has not been observed.
- **Audio in a browser export.** The picture is encoded from a canvas, which
  carries no sound; the desktop build muxes the rendered mix back in, and the
  browser build says the file is silent instead of shipping one quietly.
- **Cursor telemetry is window-only in a browser.** Recordly captures the whole
  desktop natively; the browser build only sees pointer events over Rendr's own
  window, so zoom suggestions from a browser recording cover less than they do
  in the Electron build.
- **Transcription and the Claude panel are desktop-only.** Both shell out to a
  local binary, which a browser tab cannot do. The browser build says so and
  offers subtitle import instead of pretending.

### Honest about what the words mean

- **Denoise** is a spectral noise gate: the noise floor is measured per
  frequency bin from the clip's own quietest frames and subtracted from every
  frame. It is real processing, not a speech-enhancement model, and the tool
  says so in its receipt. A perfectly steady tone is indistinguishable from
  steady hiss to any spectral method, and this one treats it as noise.
- **Effects** resolve to CSS filter strings, because that is the one
  representation the DOM preview and the canvas encoder both accept. `Sharpen`
  is therefore a contrast/saturation approximation rather than a convolution,
  and the catalog reports the real parameter ranges.
- **Beat detection** reports a confidence. Below 0.45 — where speech and
  ambience land — `detect_beats` returns no grid rather than inventing one.

## Interchange fidelity

`xml` and `fcpxml` carry cuts, trims, speed, transform, crop, opacity and audio
level. FCPXML also carries text as titles. Neither carries zoom regions, the
effect stack, edge treatment, or keyframes — there is nowhere in the schema to
put them, so the writers say so in `warnings` and `.rendr` stays the lossless
format. Assets with no filesystem path (recordings, generated mattes) are named
in a warning rather than written as a `blob:` URL no other app could follow.

## Tool coverage

All 44 declared MCP tools have handlers. Four are served by the recording
window (`list_capture_sources`, `start_recording`, `stop_recording`,
`get_recording_status`); the rest are answered by the editor window through
`src/palmier-ui/agentTools.ts`. Nothing is declared without an implementation,
and nothing returns a success-shaped response it did not earn.
