# Rendr's MCP tool surface

Rendr runs a local MCP server on `http://127.0.0.1:19790/mcp`, bound to loopback
only. It starts with the app and stops on quit. Agents drive Rendr through it the
same way a human drives the UI.

Connect Claude Desktop by installing the bundle in `mcpb/` (it proxies stdio to the
HTTP server). Any other MCP client can speak streamable HTTP to the endpoint
directly.

## What actually works today

**Everything below is implemented and runs against the real pipeline.**

| Tool | What it does |
| --- | --- |
| `list_capture_sources` | Enumerates screens, windows, and cameras with stable `sourceId`s. |
| `start_recording` | Starts capture through Recordly's own recorder — an agent-started recording is identical to a human-started one. Not undoable. |
| `stop_recording` | Stops, waits for the file to finalize, loads it into the editor. |
| `get_recording_status` | Active state, elapsed time, source. |
| `suggest_zooms` | Reads captured cursor telemetry and proposes zoom regions around real click clusters. Proposes only; applies nothing. |
| `add_zoom_regions` | Adds zoom punch-ins. Validates the whole batch before mutating; rejects overlaps and sub-600ms regions with no partial state. |
| `update_zoom_regions` | Retimes / re-depths / removes existing regions, overlap-checked. |

Zoom timing is in **source milliseconds** of the recording, not project frames, so
zooms survive trimming and moving. Depth is 1–6 → 1.25x, 1.5x, 1.8x, 2.2x, 3.5x, 5x.

## Editing tools that now work

These run against the editor's real model, through the same reducers the panels
use — an agent cannot reach state the UI can't, or skip a validation it enforces:

| Tool | Notes |
| --- | --- |
| `get_timeline` | Tracks, clips, gaps, zoom regions. Defaults omitted, as the contract says. |
| `get_media` | Library inventory, including which assets are offline and need relinking. |
| `inspect_media` | Metadata only — frame sampling and transcription aren't built. |
| `add_clips` | Validates the whole batch first; refuses offline media by name. |
| `remove_clips`, `move_clips`, `split_clips` | Overwrite semantics match the UI's. |
| `set_clip_properties` | Opacity, volume, speed, trims, fades, edges, transform, crop, blend. |
| `apply_color` | Merges onto the clip's grade; knobs clamp to `apply_color`'s ranges. |
| `add_texts`, `update_text` | Real text clips with the editor's own style model. |
| `manage_tracks` | Add, remove, rename, mute, hide, solo. |
| `add_zoom_regions`, `update_zoom_regions` | Refuses overlaps and sub-600ms spans without changing anything. |
| `undo` | The shared history — an agent undoes a human's edit and vice versa. |
| `export_project` | Writes a `.rendr` project file. |
| `get_recording_status`, `list_capture_sources` | Live recording state. |

## What is declared but not built

The remaining tools — `ripple_delete_ranges`, `remove_words`, `add_captions`,
`get_transcript`, `apply_layout`, `apply_effect`, the generation family, and the
rest — are advertised with their full schemas and descriptions, but have **no
implementation**. Calling one returns:

```json
{
  "error": "not_implemented",
  "message": "'add_clips' is declared by Rendr's MCP server but not implemented yet. ..."
}
```

This is deliberate. The tool *contract* is the hard part and the part worth
copying; the engine behind it is a port of a 73k-line Swift/Metal application and
is not done. Declaring the contract now means:

- agents see the intended shape and the schemas stay stable as the engine lands
- a missing capability is reported honestly instead of silently producing nothing

`agentInstructions.ts` tells the model explicitly that `not_implemented` means
"Rendr can't do this yet", not "you called it wrong", and that it must not retry
or report the call as a success.

To check the split in code: `src/lib/agent/registry.ts` — `DECLARED_TOOLS` lists
everything advertised, and the `switch` names everything wired.

## Architecture

```
Claude Desktop ──stdio──▶ mcpb/server/index.js ──HTTP──▶ electron/mcp/httpServer.ts
                                                             │  (main process)
                                                             ▼
                                                    electron/mcp/bridge.ts
                                                             │  IPC, correlated
                                                             ▼
                                                    src/lib/agent/registry.ts
                                                             │  (renderer)
                                                             ├─▶ recordingTools.ts ─▶ useScreenRecorder
                                                             └─▶ zoomTools.ts ─────▶ zoomSuggestionUtils
```

The MCP server lives in the main process; editor state lives in the renderer, so
every tool call is a correlated round trip with a 120s ceiling. A call that finds
no editor window open fails loudly rather than returning an empty result.

## Safety properties carried over from Palmier

- **Loopback only.** The listener binds `127.0.0.1`; non-loopback `Origin` headers
  are rejected outright.
- **Session per client.** Unknown or expired session ids get a `404`, which is the
  signal for the client to re-initialize and refetch tools. Sessions idle out after
  an hour, capped at 32.
- **Validate before mutating.** Batch tools resolve and check every entry first;
  one bad entry rejects the call with no partial state.
- **Structured receipts.** Tools return what changed, with ids — never a bare "ok".

## Rendr's own rules

- Only one recording at a time; a second `start_recording` is refused, not queued.
- While a recording is active, every mutating tool is refused with
  `recording_active`. The list lives in `EDIT_TOOLS_BLOCKED_WHILE_RECORDING`.
- Recording is **not undoable** and writes a real file capturing whatever is on
  screen. The instructions tell agents to confirm with the user before starting one.
