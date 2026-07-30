# Talking to Rendr over MCP

Streamable HTTP JSON-RPC on `127.0.0.1:19790/mcp`. From Claude Code:

```bash
claude mcp add --transport http rendr http://127.0.0.1:19790/mcp
```

For scripting inside a session, a helper avoids re-typing the envelope:

```python
# /tmp/mcp.py — usage: python3 /tmp/mcp.py TOOL '{"json":"args"}'
import json, sys, urllib.request
name = sys.argv[1]
args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                   "params": {"name": name, "arguments": args}}).encode()
req = urllib.request.Request("http://127.0.0.1:19790/mcp", data=body,
    headers={"Content-Type": "application/json",
             "Accept": "application/json, text/event-stream"})
raw = urllib.request.urlopen(req, timeout=300).read().decode()
try:
    print(json.loads(raw)["result"]["content"][0]["text"])
except Exception:
    print(raw[:3000])
```

Tool calls have a **120 s ceiling**. Anything longer must be started and polled:
`export_project` and `setup_voice` both return immediately and are polled through
`manage_exports` / `setup_voice`. `narrate_timeline` does **not** — it blocks
while speaking, so keep scripts to a handful of lines per run.

## Tools this workflow uses

| Tool | Note |
|---|---|
| `list_capture_sources` | Call immediately before recording; ids rotate |
| `start_recording` | `captureCursor: true` or there are no zooms |
| `stop_recording` | Returns `mediaRef`; does **not** auto-place the clip |
| `add_clips` | Key is `entries`, not `clips` |
| `suggest_zooms` | Returns proposals with a `reason` of `click` or `dwell` |
| `add_zoom_regions` | Strip `reason` before passing proposals back |
| `manage_comments` | `add` needs both `frame` and `text` |
| `setup_voice` | `install: true` downloads ~90 MB once, then returns instantly |
| `narrate_timeline` | Speaks notes, lays audio + subtitles |
| `export_project` | `webcodecs-offline` writes MP4; falls back to WebM |
| `manage_exports` | Poll for `status: "done"`, read `path` |
| `inspect_timeline` | `startFrame`, not `frames` |
| `get_media` | Check `offline` when a render comes out black |

Full contract: every tool's description is written for an agent reading it cold —
read the schema rather than guessing argument names.
