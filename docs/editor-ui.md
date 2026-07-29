# The editor interface

Rendr's editing interface is a React port of Palmier Pro's. Palmier Pro is a
Swift / AppKit / SwiftUI / Metal macOS application, so nothing could be copied
file-for-file — what was carried over is its **architecture and its design
system**, both of which transfer exactly.

Everything lives under `src/palmier-ui/`. Open it at
`/?windowType=editor-next`.

## What was ported 1:1

**Design tokens.** `theme.ts` and `palmier.css` transcribe `UI/AppTheme.swift`
and `Utilities/Constants.swift` value for value — the four background greys
(`#0A0A0A` / `#161616` / `#1E1E1E` / `#2C2C2C`), the warm off-white accent
(`#F5EFE4`), the timecode orange (`#F29933`), the white-alpha text ramp, the
track colours, the spacing / radius / font-size scales, and the layout constants
(28px panel headers, 38px toolbar, 5px panel gap, 50px tracks, 24px ruler,
100px track headers). Swift `CGFloat` points map to CSS `px`.

**Split architecture.** `EditorShell.tsx` reproduces
`EditorSplitViewController`: the root is a horizontal split with the agent
column as a sibling of the preset layout, and all three presets are rebuilt:

| Preset | Arrangement |
| --- | --- |
| Default | `[Media ∣ Preview ∣ Inspector] / [Timeline]` |
| Media | `[Media] ∣ ([Preview ∣ Inspector] / [Timeline])` |
| Vertical | `(([Media ∣ Inspector]) / [Timeline]) ∣ [Preview]` |

`Split.tsx` follows `PaddedDividerSplitViewController` — dividers draw as a
hairline but take a fatter hit area — and honours per-pane minimum thickness.
Collapsing a pane removes it from the flow, matching
`NSSplitViewItem.isCollapsed`. Maximising a panel collapses every sibling up the
ancestor chain, as `applyMaximize()` does.

**Panel shell.** `Panel.tsx` is `makeHosting()`: a surface-filled pane clipped
to a 6px radius, inset by half the panel gap over the base background, with the
`PanelFocusRing` accent stroke fading in at 0.6 opacity on the focused panel.

**Panels.** The timeline panel is assembled in Palmier's exact order —
`TimelineTabBar`, then `ToolbarView`, then `TimelineContainerView` beside
`AudioMeterView`. The toolbar carries the same controls in the same groups
(undo/redo · pointer/razor/trim · split/trim-start/trim-end · add text · zoom),
with the same shortcuts (V / C / T) and the same log-mapped zoom slider. The
media panel has the vertical Media / Captions / Audio tab rail. The inspector
resolves its tabs from the selection the way `InspectorView.ClipTab` does.

## What is Rendr's, not Palmier's

- **Zoom.** A `Zoom` inspector tab, zoom lanes on each clip, an "add zoom at
  playhead" toolbar button, and drag-to-aim in the preview. The camera is not a
  lookalike: `zoom.ts` calls Recordly's own `findDominantRegion` and
  `computeZoomTransform`, so easing, lead-in overlap, early zoom-out, and the
  focus clamp that keeps the frame inside the footage are Recordly's behaviour
  by construction. Palmier has no equivalent — it edits footage it is given.
- **Agent receipts.** The agent panel logs tool calls as visible receipts rather
  than hiding them, so a human can see exactly what an agent changed.

## How an edit flows

Every control writes through a reducer, and every reducer runs inside `commit`:

```
control → reducer (reducers.ts) → commit (state.ts) → undo stack → re-render
```

`reducers.ts` is plain functions over a `TimelineModel` with no React in sight,
so the rules are testable directly and the same operations can back the MCP
tools — Palmier's rule that UI and agent edits share one mutation path and one
history. A reducer that would change nothing returns its input by reference, and
`commit` skips it, so no-ops never leave empty undo steps.

Clamping is a contract, not a rejection: these values come from sliders and
scrub fields, so out-of-range input is pulled into range (`CLIP_LIMITS` in
`model.ts` is the single source of truth for both the UI's bounds and the
reducers'). Structural rules do refuse — an overlapping or sub-600ms zoom region
is rejected outright, leaving the timeline untouched.

## What works

Wired to state and visible in the preview:

| Area | Controls |
| --- | --- |
| Transform | position, scale, rotation, horizontal/vertical flip |
| Crop | all four insets, with opposite pairs kept from hiding the frame |
| Compositing | opacity, blend mode, edge rounding, edge softness |
| Timing | duration, speed, trim start/end, trim-to-playhead |
| Colour | exposure, contrast, saturation, vibrance, temperature, tint, highlights, shadows, whites, blacks, reset |
| Audio | volume, fade in/out, denoise enable + strength |
| Text | content, font, size, tracking, bold/italic/uppercase, alignment, colour, animation preset, highlight colour |
| Zoom | add at playhead, depth, focus (fields or drag in preview), auto/manual mode, remove |
| Timeline | playhead scrub, clip selection, razor split, split at playhead, track mute/hide, timeline zoom |
| History | undo/redo across every one of the above |

Covered by 48 tests in `reducers.test.ts` and `zoom.test.ts` — clamping,
no-op detection, overlap refusal, split arithmetic, and the camera's easing,
focus clamp, and stage centring.

## What is still not done

There is no compositor, no media decode, and no persistence. The preview draws a
stand-in frame rather than decoded video, and `state.ts` seeds a fixture project
instead of loading one from disk. The colour grade is a CSS filter chain
approximating `apply_color`, not a real grading pipeline. Connecting this to
Recordly's actual media pipeline is the remaining work, and it is the same work
as implementing the MCP editing tools.
