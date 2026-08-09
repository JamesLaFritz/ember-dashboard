# Ember OS Dashboard

A **local-first "Jarvis layer" for an Obsidian vault**: a voice-driven HUD, one-click headless Claude Code skill runs, an approval-gated agent workbench for local LM Studio models (with skills + MCP), and archival reading rooms over your markdown — all served from one Node process on your machine.

![Ember OS HUD](design/stitch/hud.png)

The vault stays the single source of truth: the dashboard **reads and writes markdown, and nothing else owns data**. Voice is fully local (faster-whisper in, Kokoro out — no cloud audio, ever).

> **How this fits together:** this is the dashboard from my article
> [*I Built an AI Operating System in Obsidian So My Game Dev Hours Actually Count*](https://ktmarine1999.medium.com/i-built-an-ai-operating-system-in-obsidian-so-my-game-dev-hours-actually-count-441c2ce19606).
> The Workbench's core pattern has a standalone tutorial + minimal repo: [*Your Local LLM Can Use Tools Too*](https://medium.com/@ktmarine1999/a80ef1b4ab44) / [LMStudioWorkBench](https://github.com/JamesLaFritz/LMStudioWorkBench).

## Pages

- **HUD** (`/`) — push-to-talk voice orb (hold Space; barge-in interrupts Ember mid-sentence), a Jarvis router (regex intents → local model for the rest), a skill deck that fires headless Claude Code runs (per-skill model tier: haiku/sonnet/opus), vault vitals rails (project progress, open loops, writing cadence, news wire), and chunked text-to-speech that reads whole documents with a Stop toggle.
- **Workbench** (`/workbench.html`) — a Claude-Code-style agent on **local LM Studio models**: model load/unload with GPU readout, allowlisted workspaces, session persistence with per-session token/tok-s stats, reasoning collapsibles for `<think>` models, and swappable presets (coding agent, vault librarian, design brainstorm, researcher). Tools: `read_file · list_dir · grep · glob · use_skill` (free) and `write_file · edit_file · run_command` (approval cards with diffs; deny feeds back; "always allow" builds a per-session allowlist; Plan mode is read-only, Auto skips gates). **Skills** load from the workspace's `.claude/skills/` with Claude-style progressive disclosure, and **MCP servers** are read from your own `~/.claude.json` — one registry for Claude Code and the local agent, every MCP call behind the same approval gate.
- **Reports / Research / Wiki** (`/reports.html`, `/research.html`, `/wiki.html`) — museum-style reading rooms over vault folders: grouped archives, rendered markdown, section TOC, Open-in-Obsidian, Copy, and Speak-this-document.

## Architecture

```
Mic → faster-whisper (local) → regex router ─┬→ local LM Studio model (chat / rundown)
                                             └→ headless `claude -p` skill run → report written into the vault
Vault (markdown + indexes) ← the single source of truth → dashboard renders & triggers, never owns data
Workbench: browser ⇄ WS ⇄ agent loop ⇄ LM Studio /v1 ⇄ tools in a workspace jail (+ skills, + MCP via stdio)
Kokoro (local) ← chunked TTS ← replies, reports, articles
```

## Requirements

- **Node 18+** (`express`, `ws` are the only runtime deps)
- **[LM Studio](https://lmstudio.ai)** with the local server on (`lms server start`) and at least one tool-calling model (Qwen-class recommended; the workbench was built on a 24 GB RTX 4090)
- **Python 3.11+** for the optional voice sidecar (faster-whisper + kokoro-onnx; models fetched by `voice-sidecar/setup.ps1`) — the dashboard degrades gracefully without it
- **[Claude Code](https://claude.com/claude-code)** CLI for the skill deck's headless runs — optional; the local workbench works without it
- `nvidia-smi` for the GPU readout — optional

## Setup

```bash
git clone https://github.com/JamesLaFritz/ember-dashboard.git
cd ember-dashboard
npm install
cp config.example.json config.json    # then edit: vault path, workspaces, skills
node server.js                        # → http://localhost:4517
```

Voice (optional):

```powershell
cd voice-sidecar
./setup.ps1        # venv + deps + downloads kokoro model files (~340 MB, local only)
./run.ps1          # FastAPI sidecar on :4518
```

### `config.json` keys

| Key | What it is |
|---|---|
| `vaultPath` / `vaultName` | Your Obsidian vault root and its name (for `obsidian://` links) |
| `lmStudioUrl` | OpenAI-compatible server base (LM Studio default `:1234`) |
| `routerModel` | Local model the HUD router uses for chat/rundowns |
| `claudeCommand` / `claudeHeadlessAllow` | Claude CLI binary + tools pre-allowed for headless skill runs (non-interactive runs silently deny everything else) |
| `workspaces` | Allowlisted roots the workbench agent may operate in |
| `vitals` | What the left rail tracks — see below |
| `skills` | The skill deck: vault skill ids + per-skill Claude model tier |

The `vitals` block is what makes the HUD *yours*. Folder conventions (`Wiki/`, `Raw/`, `Daily/`, `System/Memory/`) are the vault contract and stay fixed; the personal parts are configured:

```json
"vitals": {
  "project": {
    "label":  "Your Project",
    "note":   "Projects/Your Project/Your Project.md",
    "brief":  "Projects/Your Project/BRIEF.md",
    "devlog": "Projects/Your Project/Devlog"
  },
  "articles":     { "folder": "Projects/Articles", "monthlyTarget": 2 },
  "newsSections": ["AI", "Unity", "Unreal"]
}
```

`project` drives the brief progress bar, open-loop count, and days-since-devlog. `newSections` are the headings pulled from the newest `System/Memory/Reports/*Trends*.md` — change them and the news wire follows. Omit the whole block and the project card degrades to `—` rather than breaking.

The vault itself isn't in this repo — the dashboard works over any vault that follows the structure described in the article (`Raw → Wiki → Projects` with indexes, skills in `.claude/skills/`).

### Making the agent yours — `identity/`

The workbench agent's personality and its picture of who it works for live in two editable markdown files, not in code:

| File | What it is |
|---|---|
| `identity/SOUL.md` | Who the agent is — voice, standards, what it never does |
| `identity/USER.md` | Who it works for — your stack, how you like to work, what needs confirming |

Presets (Coding Agent, Vault Librarian, Researcher, Design Brainstorm) supply only the **role** for a session; identity is layered underneath. Edit the files and the next session picks them up — no restart.

| Env var | Effect |
|---|---|
| `EMBER_SOUL_PATH` / `EMBER_USER_PATH` | Point at files you already maintain (e.g. your vault's own SOUL/USER notes) |
| `EMBER_IDENTITY_DIR` | Use a different directory containing `SOUL.md` and `USER.md` |
| `EMBER_IDENTITY=off` | No identity layer — role instructions only |

`identity/USER.md` ships as a **template with placeholders**. Either fill it in locally or, better for a public fork, keep your real profile outside the repo and point `EMBER_USER_PATH` at it.

Both files are re-sent on every turn, so length is context you don't get back — each is truncated at 8,000 chars with a visible marker. On a 32k-context local model, a 4,000-char pair costs roughly 3% of the window per turn.

> **Benchmarking:** use `EMBER_IDENTITY=off`. An identity file is part of the prompt, so comparing models under different identities compares prompts, not models. The session snapshot records which SOUL/USER files a run used.

### Project instructions — `AGENTS.md`

The agent reads an `AGENTS.md` at the **workspace root** if one exists; otherwise it falls back to the workbench's own `AGENTS.md`. A workspace file **replaces** the default rather than adding to it — project rules are supposed to win. Override the fallback with `EMBER_AGENTS_PATH`.

`CRAFT.md` at the repo root is the long-form working method (~16k chars ≈ 4k tokens per turn). It is **off by default** and referenced from `AGENTS.md`; set `EMBER_CRAFT=on` to inject it when the work is hard enough to be worth the budget. `EMBER_CRAFT_PATH` points at a different copy.

System prompt order is identity → method → project rules → session role, most specific last.

### Workbench memory

The agent has a `remember` tool taking `kind: "lesson" | "decision"` and one line of text. Entries are **scoped per workspace**, stored under `.sessions/memory/` (never inside your project), and injected into every future session on that workspace — the most recent 40, decisions before lessons.

| Action | What happens |
|---|---|
| **Compaction** | Writes a session log to `.sessions/logs/<timestamp>-<id>.md` — the handoff summary, token counts, turns folded, and anything `remember`ed. Compaction is the moment history stops being recoverable from context, so that is when a durable record is worth writing |
| **Clear** | Archives the whole transcript to `.sessions/archive/<timestamp>-<id>.json`, then resets the conversation. The session survives — same id, model, workspace, preset, approvals, MCP servers. If the archive write fails, the clear is refused rather than losing the transcript |
| **Delete** | Removes the session entirely. Use Clear when you want a fresh context but the same setup |

Archives are listable at `GET /api/agent/archives` and `GET /api/agent/:id/archives`.

## Security posture

The workbench executes model-chosen file writes and shell commands **on your machine, behind approval cards** — read the card, especially for `run_command`. Workspaces are jailed (every model-supplied path is resolved and checked), MCP and write tools never run un-gated outside Auto mode, and session transcripts stay in the gitignored `.sessions/`. Treat Auto mode as what it is: you, pre-approving everything.

## Credits & provenance

The OS pattern is distilled from talks by **Chase AI**, **Simon Scrapes**, **Ben Fellows**, and **Andrej Karpathy's** knowledge-structure pattern (full references in the article). The dashboard itself was **built with Claude (Fable 5) in the Claude Code terminal** — pair-designed, AI-written, human-approved and live-tested feature by feature. Design system: my Ember Heritage tokens via Google Stitch.

## License

MIT
