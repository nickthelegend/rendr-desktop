---
name: rendr-demo
description: Record a narrated, zoomed, subtitled demo video of a web app with zero manual editing. Use when the user says "record a demo", "make a demo video", "film this for the hackathon", "record the app and narrate it", or wants a walkthrough video of something they just built. Drives a headless browser, authors the cursor path, cuts zooms from it, narrates with local TTS, and burns karaoke subtitles. Never touches the real mouse or screen.
---

# Recording a demo with Rendr

Somebody finished building something and does not want to record and edit a
walkthrough by hand. This turns a storyboard file into a finished MP4: punch-in
zooms that follow the cursor, a drawn pointer, spoken narration, word-timed
subtitles.

## Using it in a project

Install once, in whatever repo you want to film:

```bash
npx degit nickthelegend/rendr-desktop/.claude/skills/rendr-demo .claude/skills/rendr-demo
npm i -D playwright && npx playwright install chromium
cp .claude/skills/rendr-demo/HACKATHON_DEMO.template.md HACKATHON_DEMO.md
```

Write the flow in `HACKATHON_DEMO.md` in plain English, start the app you want
filmed, then ask:

> Record my demo from HACKATHON_DEMO.md

Rendr itself must be running (`npm run dev` in the rendr-desktop checkout),
serving MCP on `127.0.0.1:19790`. It is the editor — it does not need to be the
project being filmed.

## What to do when asked

1. **Read `HACKATHON_DEMO.md`.** It is prose, not config: an app URL, a rough
   length, and a numbered flow of what should happen and what should be said.
2. **Check the app is up.** Curl the URL. If it is not running, say so and stop
   — do not record a connection-refused page.
3. **Turn it into a storyboard.** One beat per numbered step. The `say` is the
   narration for that step, rewritten to be spoken rather than read: short
   sentences, no bullet fragments, no markdown. The `do` is the steps that make
   it happen.
4. **Find the real selectors** before writing them. Open the page and look —
   `read_page` or a Playwright evaluate. Guessed selectors are the main reason a
   run comes back with beats skipped.
5. **Record, build, export**, then check the exported file and report where it
   landed.

Write the storyboard to `demos/<name>.json` so a re-run does not start over.

```bash
node .claude/skills/rendr-demo/scripts/record-demo.mjs demos/my-app.json demo-out
node .claude/skills/rendr-demo/scripts/build-demo.mjs demo-out --export
```

See [reference/mcp.md](reference/mcp.md) for the call helper and the tool list.

## The thing to understand first

**Nothing here touches the real mouse or records the real screen.** An earlier
version of this skill drove the OS pointer with a compiled CoreGraphics binary
and captured the desktop. That works, and it is the wrong tool: it takes over
the machine, and whatever is on the desktop goes into the video — one take
ended up with the user's personal Google autocomplete on screen.

Instead: Playwright drives a headless browser, and **the pointer path is
authored rather than observed.** A script knows something no screen recorder
does — where it is about to click, before it clicks — so the path is generated,
eased, and handed to Rendr through `import_telemetry`. Rendr draws its own
cursor over the video and cuts zooms from that path exactly as it would from a
native capture, because nothing downstream cares where the points came from.

The result is better than a real recording: the motion is smooth by
construction, nothing shakes, and no desktop is in frame.

## The storyboard

`HACKATHON_DEMO.md` compiles to this. Beats are what gets said; steps are what
happens on screen. Write it out even when the source was prose — it is the
artefact that makes a re-run reproducible, and the thing to edit when one beat
is wrong rather than re-deriving the lot.

```json
{
  "url": "http://localhost:3000",
  "width": 1280, "height": 720, "fps": 30,
  "colorScheme": "dark",
  "beats": [
    { "say": "This is the thing I built.", "do": [{ "wait": 2000 }] },
    {
      "say": "You start by searching for a project.",
      "do": [
        { "click": "input[name=q]" },
        { "type": "hello world" },
        { "press": "Enter", "settle": 2000 }
      ]
    },
    { "say": "And here is the part that matters.", "do": [{ "scroll": 600 }] }
  ]
}
```

Steps: `goto`, `move`, `click`, `type`, `press`, `scroll`, `wait`. A selector
that is not visible is skipped with a warning rather than failing the run — so
a demo still produces a video when the app changed underneath it.

## Two rules that produce a watchable video

### Beats are held for as long as their line takes to say

The recorder estimates each line's spoken length from its word count and holds
the beat at least that long. Do not remove this. Rendr pins each line to the
frame its beat began, so if a beat is shorter than its line, **the lines
overlap** — the narration track stacks, the caption clips stack with it, and
the lower clip of each pair never renders. That is the single most common way
this pipeline produces a broken-looking video.

`check_timeline` catches it: look for "is stacked on … the lower one never
appears".

### The pointer has to actually go somewhere

Zooms are cut from where the pointer **rests**. If it never moves, every dwell
shares one focus point and every punch-in lands on the same spot — which reads
as "it only zooms to the centre". This is exactly what happened when the
storyboard was all scroll-and-talk with no targets: telemetry stayed at
cx 0.38–0.57, cy 0.9–1.0, and all eleven zooms framed the same place.

The recorder handles it now: after a scroll, and during any time spent holding
for narration, it finds a heading or link near the middle of the viewport and
glides to it. Pass `"stay": true` on a beat to suppress that when you genuinely
want the pointer still.

A rest only counts if it lasts **450–2600 ms**. Longer is not a longer zoom, it
is *no zoom* — the run is discarded. Long pauses are automatically broken into
several rests with a nudge between them.

## Subtitles

`narrate_timeline` writes karaoke word timings, and `style_captions` picks the
look:

| preset | what it is |
|---|---|
| `karaoke` | each word lights as it is spoken, no background |
| `shorts` | heavy uppercase with a yellow hot word, the short-form look |
| `pop` | words scale in on their own beat |
| `typewriter` | character by character |
| `clean` | quiet whole-line fade, no per-word motion |
| `emphasis` | line stays still, only the colour moves |
| `plate` | white text on a dark rounded scrim — the default |

`RENDR_CAPTIONS=shorts node scripts/build-demo.mjs demo-out` switches it.

The per-word presets need word timings. `narrate_timeline` writes them; an
imported SRT may not, and the tool warns and falls back to a whole-line fade
rather than silently doing nothing.

## Traps

- **Google serves a reCAPTCHA to headless browsers.** So do some other large
  sites. Do not attempt to solve it — point the demo at the user's own app.
- **Bare text captions depend on the footage's brightness.** White text vanishes
  on a docs site, dark text vanishes on a dark app, and picking a colour from
  the shot's average brightness fails on anything light in one half and dark in
  the other. The `plate` preset — a dark rounded scrim behind the text — is the
  default for exactly this reason, and it also sidesteps an unresolved bug where
  preview and export disagreed about a dark caption colour on light footage.
  Use `backgroundColor: "none"` for bare text when the footage is controlled.
- **Comments live on the project, not the timeline.** An earlier demo's script
  is still there and `narrate_timeline` will happily speak it over the new one.
  `build-demo.mjs` clears them first.
- **`manage_project create` wipes the library.** Never call it after recording;
  the take goes offline and every render comes out black.
- `inspect_timeline` takes **`startFrame`**, not `frames`. A wrong key silently
  renders frame 0.
- A black rendered frame almost always means the asset is offline, not that the
  renderer failed. Check `get_media` for `offline: true`.

## Writing the narration

The `say` lines are spoken, so they have to survive being heard once with no
ability to re-read. Short sentences. One idea each. Expand initialisms the way
they are said — "M C P", not "MCP", or Kokoro runs them together. No brackets,
no lists, no markdown; it all gets read literally.

Say what the thing does and why it matters, not what is on screen. "Here is the
dashboard" is wasted narration when the viewer can see the dashboard. "The
scoring is computed on ingest, so this is current" is the sentence a judge
remembers.

## Verify before claiming it worked

Pull frames from the **exported file**, not the preview:

```bash
ffmpeg -v error -y -ss 12 -i out.mp4 -frames:v 1 /tmp/f.png
ffmpeg -hide_banner -i out.mp4 -af volumedetect -f null - 2>&1 | grep mean_volume
```

Narration reads around **−20 to −25 dB**. Silence reads −91 dB. `view_frame` is
the quick in-app equivalent and returns the composite as an image, which is the
fastest way to check a zoom framed what it should.
