---
name: rendr-demo
description: Record a narrated, zoomed, subtitled demo video of a web app with zero manual editing. Use when the user says "record a demo", "make a demo video", "film this for the hackathon", "record the app and narrate it", or wants a walkthrough video of something they just built. Drives a browser, records the screen through Rendr's MCP server, cuts zooms from the real cursor, narrates with local TTS, and burns karaoke subtitles.
---

# Recording a demo with Rendr

The point: somebody finished building something and does not want to record and
edit a walkthrough by hand. This produces a finished MP4 — punch-in zooms on
what was clicked, a drawn cursor, spoken narration, word-timed subtitles — from
a description of the product.

## The one thing that will catch you out

**Browser-tool clicks do not move the real mouse.** `mcp__Claude_Browser__computer`
injects events into the page through CDP. The OS pointer never moves, so Rendr's
native cursor telemetry records nothing — which means **no drawn cursor and no
zooms**, because zooms are cut from telemetry.

So use both, each for what it is good at:

| Job | Tool | Why |
|---|---|---|
| Find elements, read the page, verify state | browser tools | Semantic and reliable; no coordinate guessing |
| Move and click during the take | real pointer driver | The only thing native telemetry sees |
| Type text | `osascript` keystroke | Goes to the focused field, and is real input |

The pattern is: **ask the browser where things are, then move the real pointer
there.** `read_page` returns `ref_N` handles; `computer` with `action: "zoom"` or
a screenshot gives you pixel coordinates to aim at.

## Setup

Build the pointer driver once per session. `osascript` has **no** mouse-position
command — an AppleScript "set the position of the mouse" silently does nothing,
which will make you think you moved the pointer when you did not.

```bash
cat > /tmp/pointer.c <<'EOF'
#include <ApplicationServices/ApplicationServices.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc < 3) return 1;
  if (strcmp(argv[1], "s") == 0) {            /* smooth scroll: N pixel ticks */
    int n = atoi(argv[2]);
    for (int i = 0; i < n; i++) {
      CGEventRef e = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 1, -14);
      CGEventPost(kCGHIDEventTap, e); CFRelease(e); usleep(16000);
    }
    return 0;
  }
  CGPoint p = CGPointMake(atof(argv[2]), atof(argv[3]));
  if (strcmp(argv[1], "m") == 0) {
    CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, p, kCGMouseButtonLeft));
  } else {
    CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, p, kCGMouseButtonLeft));
    usleep(70000);
    CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, p, kCGMouseButtonLeft));
  }
  return 0;
}
EOF
clang -framework ApplicationServices -o /tmp/pointer /tmp/pointer.c
```

`/tmp/pointer m X Y` moves · `c X Y` clicks · `s N` scrolls N ticks.

Rendr must be running (`npm run dev`), serving MCP on `127.0.0.1:19790`.
See [reference/mcp.md](reference/mcp.md) for the call helper and the tool list.

## Workflow

### 1. Open what you are demoing

```
mcp__Claude_Browser__preview_start  { url: "http://localhost:3000" }
mcp__Claude_Browser__read_page      → note where the things you'll click are
```

### 2. Get a fresh capture source, then start

Source ids **rotate** — a stale one fails with `No capture source`. Always list
first, in the same breath as starting.

```bash
SRC=$(mcp list_capture_sources '{"kind":"screen"}' | jq -r '.sources[0].sourceId')
mcp start_recording "{\"sourceId\":\"$SRC\",\"countdownSeconds\":0,\"captureCursor\":true}"
```

`captureCursor: true` is what makes zooms possible. Without it there is no
telemetry and nothing to cut from.

### 3. Perform the demo with the real pointer

Glide, don't teleport — telemetry needs travel to read as movement, and **pauses
are what become zooms**. See [reference/choreography.md](reference/choreography.md)
for timings that read well.

```bash
# glide to a target over ~0.6s
for i in $(seq 1 16); do /tmp/pointer m $((x0+(x1-x0)*i/16)) $((y0+(y1-y0)*i/16)); sleep 0.04; done
sleep 0.35
/tmp/pointer c $x1 $y1        # a real click → an explicit zoom candidate
sleep 1.9                     # a real dwell → a heuristic zoom candidate
osascript -e 'tell application "System Events" to keystroke "search text"'
osascript -e 'tell application "System Events" to key code 36'   # Return
/tmp/pointer s 30             # smooth scroll
```

**Hold still for ~1.5–2 s on anything you want zoomed.** A dwell of 450–2600 ms
is a zoom candidate; sweeping past something produces nothing.

### 4. Stop, place, zoom

```bash
REF=$(mcp stop_recording '{}' | jq -r .mediaRef)
mcp add_clips "{\"entries\":[{\"mediaRef\":\"$REF\",\"startFrame\":0}]}"
CLIP=$(mcp get_timeline | jq -r '.tracks[0].clips[0].id')
mcp suggest_zooms '{}'        # reports reason: "click" or "dwell" per region
mcp add_zoom_regions "{\"clipId\":\"$CLIP\",\"regions\":[…]}"
```

Strip `reason` from each proposal before passing it back; it is a receipt field,
not an input.

### 5. Narrate, which also writes the subtitles

Notes are the script — one per beat of the demo, pinned to the frame it should
be spoken over.

```bash
mcp manage_comments '{"action":"add","frame":5,"text":"This is the app I built."}'
mcp manage_comments '{"action":"add","frame":240,"text":"Here is the part that matters."}'
mcp setup_voice '{"install":true}'      # ~90 MB, once per machine, local
mcp narrate_timeline '{"voice":"af_heart"}'
```

Subtitles are on by default: karaoke word-by-word on a `CC` track, cut from the
narration text with length-weighted word timing. Pass `subtitles: false` for
narration without them.

Watch the `overruns` field — a line longer than the gap to the next note will
overlap it. Move the notes apart or shorten the line.

### 6. Export

```bash
mcp export_project '{"format":"mp4","resolution":"720p"}'
# poll manage_exports until status is done; the path is in the job
```

## Verify before you claim it worked

Do not trust a still frame. **Pull frames from the exported file** and look:

```bash
ffmpeg -v error -y -ss 3 -i out.mp4 -frames:v 1 /tmp/f.png     # is it zoomed?
ffmpeg -hide_banner -i out.mp4 -af volumedetect -f null - 2>&1 | grep mean_volume
```

Narration should read around **−20 to −25 dB**. Silence reads −91 dB.

A frame where the pointer sits over *plain background* is the only one that
proves the cursor is right — over text you cannot tell a captured I-beam from
page content. This cost several wrong "it's fixed" claims.

## Traps

- **`manage_project create` wipes the library.** Never call it after recording;
  the take becomes offline and every render comes out black.
- `inspect_timeline` takes **`startFrame`**, not `frames`. A wrong key silently
  renders frame 0.
- A black rendered frame almost always means the asset is offline, not that the
  renderer failed. Check `get_media` for `offline: true`.
- Multiple `CC` tracks stack — `narrate_timeline` replaces its own group, but a
  caption track from an older session stays and can sit above yours.
