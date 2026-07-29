# Notices and attribution

Rendr is a derivative work. It is licensed under the **GNU Affero General Public
License, version 3 or later** (see `LICENSE.md`). That is not a choice — it is
required by the licenses of the projects Rendr is built from.

## Upstream projects

### Recordly — AGPL-3.0

<https://github.com/webadderallorg/Recordly> — copyright the Recordly authors
(@webadderall).

Rendr is a fork of Recordly. The recording pipeline, capture source selection,
cursor telemetry, and the zoom/auto-zoom camera modules are taken from Recordly
substantially unmodified:

- `electron/ipc/recording/**` — capture orchestration (macOS, Windows, Linux),
  ffmpeg process management, companion audio, diagnostics, pruning
- `electron/ipc/cursor/**` — cursor position and interaction telemetry
- `src/hooks/useScreenRecorder.ts` — renderer-side recording state machine
- `src/components/launch/**` — capture source picker, recording HUD
- `src/components/video-editor/videoPlayback/zoom*.ts` — zoom transform and
  region math, zoom animation
- `src/components/video-editor/videoPlayback/cursorFollowCamera.ts`,
  `cursorSway.ts`, `motionSmoothing.ts` — the auto-zoom camera
- `src/components/video-editor/timeline/zoomSuggestionUtils.ts` — automatic zoom
  region suggestion from cursor telemetry

AGPL-3.0 is a **network** copyleft: if you run a modified Rendr as a network
service, you must offer its complete corresponding source to its users.

### Palmier Pro — GPL-3.0

<https://palmier.io> — copyright the Palmier authors.

Rendr's agent-facing editing layer is derived from Palmier Pro's MCP server.
Palmier Pro is a Swift/AppKit macOS application; Rendr is Electron/TypeScript, so
this is a **port, not a copy**. What is carried over near-verbatim is the part
that is portable and is the actual interface contract:

- `mcpb/server/index.js` — the stdio↔HTTP bridge, adapted from Palmier's shim
- `electron/mcp/toolDefinitions.ts` — the tool names, JSON Schemas, and tool
  descriptions, transcribed from `Sources/PalmierPro/Agent/Tools/ToolDefinitions.swift`
- `electron/mcp/agentInstructions.ts` — the MCP server instructions, transcribed
  from `Sources/PalmierPro/Agent/Tools/AgentInstructions.swift`
- `electron/mcp/httpServer.ts` — session-per-client streamable-HTTP transport,
  reimplemented from `Sources/PalmierPro/Agent/MCP/MCPHTTPServer.swift`
- `src/palmier-ui/**` — the editor interface, reimplemented in React from
  `Editor/EditorView.swift` (split architecture and the three layout presets),
  `UI/AppTheme.swift` and `Utilities/Constants.swift` (design tokens, transcribed
  1:1), `Toolbar/ToolbarView.swift`, `MediaPanel/MediaPanelView.swift`,
  `Inspector/InspectorView.swift`, `Timeline/TimelineTabBar.swift`, and
  `Agent/Panel/AgentPanelView.swift`

Palmier Pro's Metal compositor, AVFoundation pipeline, and tool *executors* are
**not** carried over, and the ported interface is a shell: it renders Palmier's
layout and design system over Rendr's own model, but most inspector controls are
not yet bound to editor state (grep `NOT_WIRED`). See `docs/mcp-tools.md` and
`docs/editor-ui.md`.

## License compatibility

GPL-3.0 code may be combined into an AGPL-3.0 work (GPLv3 §13 permits this
explicitly). The combined result must be distributed under AGPL-3.0. Rendr
therefore cannot be MIT, BSD, or Apache licensed, and cannot be relicensed
without permission from every upstream copyright holder.

Do not remove the attribution comments embedded in the source files carried over
from either project.
