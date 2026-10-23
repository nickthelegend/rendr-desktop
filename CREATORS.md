# Rendr for creators

Rendr is an open-source video editor you drive by talking to an AI agent:
the agent you already pay for, or a free one. Drop in your footage, say what
you want, and watch the timeline change. Every edit is a normal, undoable
edit you can tweak by hand.

It works on **talking-head camera footage** (YouTube videos, Shorts, Reels,
TikToks) as well as screen recordings, and it does the jobs that usually
take an afternoon:

| You say | Rendr does |
|---|---|
| "Tighten this up" | Cuts dead air and "um / uh / like", keeps the last take of a repeated line |
| "Punch in on the cuts" | Jump-cut zooms on alternate segments, centred on your face |
| "Caption it" | Word-by-word captions from local Whisper; nothing is uploaded |
| "Make it a Short" | Picks the strongest 30–60 s, reframes 9:16 on your face, captions above the app buttons |
| "Green background behind me" | On-device background removal: colour, blur, image, or transparent |
| "Mind map of the topics behind me" | Animated cards and lines laid out around you, between backdrop and you |
| "QR code to my link" | A scannable QR code that pops in, in the corner you want |
| "Make the audio sound right" | Platform loudness (−14 LUFS), denoise, music ducked under your voice |
| "Export for TikTok" | 1080×1920 at the right bitrate, or a clear error if the edit isn't vertical yet |

## 1. Pick your agent

Open the **Agent** panel and click the sliders icon. Rendr has no model of its
own. It uses one you already have:

- **Claude Code**: your Claude Pro or Max plan (`claude` CLI)
- **Codex**: your ChatGPT plan (`codex` CLI)
- **Gemini CLI, OpenCode, Goose, Qwen Code**: any agent that speaks ACP
- **An API key**: OpenAI, Anthropic, OpenRouter (it has free models),
  Google Gemini, Groq, DeepSeek, Mistral, xAI
- **A local model**: Ollama or LM Studio, fully offline

Or keep the agent you already use and connect it to Rendr instead: open the
plug icon → **Apps** for one-click setup in Claude Code, Codex, Gemini CLI,
OpenCode, Cursor, VS Code, Windsurf, Claude Desktop and LM Studio. To use
**claude.ai or ChatGPT in the browser**, turn on **Cloud** and paste the URL
it gives you into their "custom connector" box.

## 2. Bring in footage

Drag your video into the Media panel and onto the timeline. A vertical phone
video gives you a vertical project, and a 4K camera file gives you a 4K one.

## 3. Ask

Some prompts that work well:

> Edit this into a tight talking-head video: cut the pauses and filler
> words, punch in on every other cut, add clean captions, and get the audio to
> YouTube loudness.

> Find the best 45 seconds of this and make it a YouTube Short with bold
> word-by-word captions.

> Put me on a deep green background with a mind map of Ideas, Storylines,
> Numbers, Brands, Editing and Thumbnails behind me, and a QR code to
> https://example.com in the top right.

In clients that support MCP prompts, the same plans are slash commands:
**/edit_talking_head**, **/make_short**, **/explainer_look**, **/clean_audio**,
**/add_key_points**.

## Privacy

Analysis happens on your Mac. That covers transcription, background removal,
face tracking, loudness and voice detection, and nothing is uploaded for any
of it. The only network traffic is to the AI model you chose, and with Ollama
or LM Studio there is none.

## Good to know

- **Background removal and face tracking use Apple's Vision framework, so
  they run on macOS only for now.** Everything else is cross-platform.
- Analysing a long take runs at about half real time. The agent waits for it
  and picks it back up if it takes longer than one call.
- Edits are undoable (⌘Z), whether you made them or the agent did.
- Every tool call the agent makes shows up in the panel as a receipt, so you
  can always see what changed.
