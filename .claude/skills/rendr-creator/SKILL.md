---
name: rendr-creator
description: Edit a creator's camera footage in Rendr — talking-head YouTube videos, Shorts, Reels, TikToks. Use when the user says "edit my video", "cut the pauses", "remove the ums", "make a short", "make it vertical", "add captions", "green screen", "remove my background", "put a mind map behind me", "add a QR code", "punch in on the cuts", or "make the audio louder". Drives the running Rendr app through its MCP server (tools named mcp__rendr__*) or, without MCP, through the `rendr` CLI.
---

# Editing creator footage with Rendr

Rendr is a desktop video editor with ~100 tools for agents. Its server
instructions explain its model (frames vs seconds, tracks, ids). This skill
covers what's specific to **camera footage**.

## Connect

- If `mcp__rendr__*` tools are available, use them.
- If not, Rendr may still be running: `rendr status` (or
  `curl -s http://127.0.0.1:19790/v1/health`). Call tools with
  `rendr call <tool> '<json args>'`. Recipes come from `rendr recipe <name> media=<file>`.
- If neither works, ask the user to open Rendr. To wire it into Claude Code
  permanently: `claude mcp add --transport http --scope user rendr http://127.0.0.1:19790/mcp`.

## The order that works

1. `get_timeline`, `get_media`. Put the footage on a timeline with `add_clips` if needed.
2. **`analyze_footage`** on the camera asset first. It makes the person matte
   and face track on-device, which background removal, face-framed reframes,
   punch-ins and graphic layout all depend on. A long take may answer
   `status: "running"`. Call it again with the same assetId and the job carries on.
3. **Cut**: `remove_silence`, then `get_transcript` + `remove_words` for fillers
   and false starts. Keep the *last* take of a repeated sentence.
4. **Punch in**: `add_punch_ins` *after* cutting (it works per segment).
5. **Shape**: `reframe_timeline` to 9:16 for Shorts/Reels/TikTok. Do this
   after analysis, so the crop follows the face.
6. **Captions**: `add_captions`, then `style_captions`. For vertical video, keep
   them above the bottom fifth, where the platform's buttons sit.
7. **Look**: `remove_background` (color / blur / image / remove) and
   `add_graphic` (mind_map, key_points, lower_third, qr, callout). Add a QR
   code *before* a mind map so the map lays out around it.
8. **Sound**: `normalize_audio` to −14 LUFS; `duck_audio` with `under: "speech"` for music.
9. **Look at it**: `view_frame` at the start, middle and a punched-in moment.
   Check the face isn't covered or cropped and captions are inside the frame.
10. Ask before `export_project`. Use `preset` `youtube` / `shorts` / `reels` / `tiktok` / `square`.

## Recipes

These carry full plans. They're MCP prompts, so in Claude Code they appear as
`/mcp__rendr__<name>`:
- `edit_talking_head`: tight YouTube edit
- `make_short`: best 30–60 s, vertical, captioned
- `explainer_look`: cut-out speaker over a colour, mind map behind, QR code
- `clean_audio`: denoise, loudness, ducking
- `add_key_points`: animated key-point cards at the moments they're said

## Things that trip agents up

- Graphic coordinates are **frame-normalized 0–1**. `at` inside a graphic is
  **seconds after the graphic starts**, while `startFrame` is timeline frames.
- `remove_background` mode `remove` makes the background transparent. Put
  something on a lower track (or use `add_graphic` with `layer: "behind"`) or
  the background is black.
- Background removal and face tracking are **macOS only** (Apple Vision). On
  other platforms, say so and skip those steps rather than retrying.
- Edits are undoable; don't ask permission for each one. Do ask before
  exporting and before starting a screen recording.
