# Choreographing a take that edits itself well

Rendr cuts zooms from what the pointer did. So the recording is a performance,
and the timings below are what make the automatic edit land.

## The rules that matter

**Dwell where you want a zoom.** A pause of 450–2600 ms in one spot is a zoom
candidate. Under 450 ms is noise; over 2600 ms stops counting as a dwell.
**~1.8 s is the sweet spot.**

**Glide, never teleport.** Move in 14–16 steps of ~40 ms. A single jump gives the
follow camera a step input and looks like a cut. It also starves the dwell
detector of the travel that separates one stop from the next.

**Clicks are stronger than dwells.** A click earns a tighter punch-in, and a
double-click tighter still. If a beat matters, click something.

**Leave ~1.2 s between beats.** Candidates closer than 1200 ms merge into one
region — usually right for a double-click, wrong for two separate points.

**Scroll in small ticks.** 14 px per tick at ~16 ms reads as smooth. One large
scroll event jumps and the zoom camera has nothing to follow.

## A shape that works

```
0.0s  glide to first target        (16 steps × 40ms)
0.6s  settle
0.9s  click                        → zoom candidate (click)
1.0s  hold                         → zoom candidate (dwell), ~1.9s
3.0s  type, Return
5.4s  glide to the result you care about
6.0s  hold 1.8s                    → zoom
7.8s  smooth scroll 30 ticks
8.3s  glide to the next thing
8.9s  scroll 22 ticks, hold
10.4s click
11.9s end
```

That produces 3–5 zooms across ~12 s, which is about the density that reads as
deliberate rather than restless.

## Writing the narration

One note per beat, pinned to the frame the beat starts. Keep each line short
enough to fit the gap to the next note — roughly **165 words per minute**, so a
12-word line needs about 4.4 s of room.

`narrate_timeline` reports `overruns` when a line runs past the note after it.
It does not fix them, because shortening the line is a writing decision and
moving the note is an editing one.

Write for someone who has never seen the product:

- First note: what it is, in one sentence
- Middle notes: what you are doing and why it matters
- Last note: what just happened, or the outcome

Avoid reading the UI aloud. "Now I click Search" is what the picture already
shows; "searching pulls the live index, so results are current" is what it
doesn't.
