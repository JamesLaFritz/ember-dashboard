// agent.js — the LM Studio agent workbench loop (Claude-Code-style):
// model proposes tool calls → server executes inside a workspace root →
// writes and commands require explicit approval from the UI first.
// System-prompt patterns distilled from the leaked coding-agent prompts
// (github.com/asgeirtj/system_prompts_leaks): terse output, plan-then-act,
// one tool at a time, never invent file contents.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { composeSystem, loadIdentity } from './identity.js';

export const TOOL_DEFS = [
  { name: 'read_file',  needsApproval: false, description: 'Read a UTF-8 text file. Returns at most 40000 chars.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the workspace root' } }, required: ['path'] } },
  { name: 'list_dir',   needsApproval: false, description: 'List files and folders at a path (non-recursive).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep',       needsApproval: false, description: 'Search file contents with a regex. Returns matching lines with file:line prefixes (max 100).',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Folder to search, relative; default "."' } }, required: ['pattern'] } },
  { name: 'glob',       needsApproval: false, description: 'Find files by name pattern (e.g. "**/*.cs", "Enemy*.md"). A pattern without "/" matches filenames at any depth. Returns relative paths, newest first (max 200).',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Folder to search, relative; default "."' } }, required: ['pattern'] } },
  { name: 'use_skill',  needsApproval: false, description: 'Load a skill — a stored step-by-step procedure from .claude/skills (listed in your system prompt). Returns its instructions plus a list of any bundled side files. Some skills route to a sub-file (e.g. "Vanilla Three.js: skills/three-webgl-game/SKILL.md") — load that by passing its path in `file`.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Skill name exactly as listed' }, file: { type: 'string', description: 'Optional: a side file to load instead of the main SKILL.md, path relative to the skill folder (from the SIDE FILES list a prior use_skill call returned)' } }, required: ['name'] } },
  { name: 'write_file', needsApproval: true,  description: 'Create or overwrite a file with the given content.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file',  needsApproval: true,  description: 'Replace an exact text snippet in a file. old_text must match exactly once.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'run_command', needsApproval: true, description: 'Run a shell command in the workspace root. Returns stdout+stderr (max 20000 chars; if longer, the head and the tail are kept and the middle is dropped — build errors are usually in the tail).',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'web_search', needsApproval: false, description: 'Search the web (DuckDuckGo). Returns the top results as title / url / snippet blocks.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'web_fetch',  needsApproval: false, description: 'Fetch a URL and return its readable text content (HTML stripped, max 20000 chars).',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
];

// Inline <think> blocks (models whose chat template leaves reasoning in
// content) are kept in the UI history but stripped from the transcript sent
// back to the model — stale chain-of-thought just burns context.
const stripThink = (s) => (s ?? '')
  .replace(/<think>[\s\S]*?<\/think>/g, '')
  .replace(/^[\s\S]*?<\/think>/, '') // template swallowed the opening tag
  .trim();

// Session permission modes. 'ask' is the Claude-Code-style default; 'plan'
// hard-blocks every gated tool regardless of allowlist; 'auto' skips approval
// entirely (James's explicit skip-all-permissions switch — use knowingly).
export const MODES = ['ask', 'plan', 'auto'];

// run_command shell. Node's `shell: true` resolves to %ComSpec% (cmd.exe) on
// Windows no matter which terminal launched the dashboard, so an agent could
// be running cmd.exe while a comparison harness ran Git Bash — and models that
// emit POSIX one-liners fail for reasons that have nothing to do with the task.
// Resolve one shell explicitly, prefer Git Bash, and report it per session so
// benchmark runs can record it. Override with EMBER_SHELL.
// Node applies `-c` to a non-cmd shell and `/d /s /c` (verbatim) to cmd.exe.
export const SHELL_PATH = (() => {
  if (process.platform !== 'win32') return process.env.EMBER_SHELL || '/bin/sh';
  const candidates = [
    process.env.EMBER_SHELL,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* unreadable path — keep looking */ }
  }
  return process.env.ComSpec || 'cmd.exe';
})();

export const SHELL_NAME = /bash(\.exe)?$/i.test(SHELL_PATH) ? 'git-bash'
  : /cmd(\.exe)?$/i.test(SHELL_PATH) ? 'cmd'
  : path.basename(SHELL_PATH);

// 120s was not enough for a cold `npm install` plus a production build, and a
// timeout is indistinguishable from a real failure to the model. Override with
// EMBER_CMD_TIMEOUT_MS.
export const CMD_TIMEOUT_MS = Number(process.env.EMBER_CMD_TIMEOUT_MS) || 600000;

// Runaway-loop guard on tool calls per turn. 16 was too low to be invisible:
// a real implement-and-debug cycle (inspect repo → load skill → read sub-skill
// → write files → install → build → read errors → edit → rebuild → Playwright
// → inspect → fix → retest) blows past it, and the turn then ends looking like
// the model gave up. Override with EMBER_MAX_HOPS.
export const MAX_HOPS = Number(process.env.EMBER_MAX_HOPS) || 48;

// Long build logs put the errors at the END, but a head-slice throws exactly
// those away — the model then reads warnings, "fixes" the wrong thing, and
// reports success. Keep enough head to identify the command, then the tail.
const OUT_LIMIT = 20000;
const OUT_HEAD = 4000;
export function clipOutput(s) {
  if (s.length <= OUT_LIMIT) return s;
  const dropped = s.length - OUT_LIMIT;
  return `${s.slice(0, OUT_HEAD)}\n…[${dropped} chars dropped from the middle — the tail is kept because errors land there]…\n${s.slice(-(OUT_LIMIT - OUT_HEAD))}`;
}

// ---- web helpers (Researcher preset; no API keys, plain fetch) ----
const decodeEntities = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim();
const htmlToText = (html) => decodeEntities(
  html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<\/(p|div|section|article|h\d|li|tr|blockquote)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
  .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');

export async function webSearch(query) {
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EmberOS' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return `ERROR: search returned ${res.status}`;
  const html = await res.text();
  const out = [];
  for (const block of html.split(/class="result results_links/).slice(1, 9)) {
    const href = block.match(/class="result__a"[^>]*href="([^"]+)"/)?.[1] ?? '';
    const title = stripTags(block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '');
    const snippet = stripTags(block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '');
    const url = href.includes('uddg=') ? decodeURIComponent(href.match(/uddg=([^&]+)/)?.[1] ?? '') : href;
    if (url && title) out.push(`${title}\n${url}\n${snippet}`);
  }
  return out.join('\n\n') || 'no results';
}

export async function webFetch(url) {
  if (!/^https?:\/\//i.test(url)) return 'ERROR: only http(s) URLs';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EmberOS research' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok) return `ERROR: fetch returned ${res.status}`;
  const type = res.headers.get('content-type') ?? '';
  if (!/text|html|json|xml/i.test(type)) return `ERROR: unsupported content-type ${type}`;
  const raw = await res.text();
  const text = /html/i.test(type) ? htmlToText(raw) : raw;
  return text.length > 20000 ? text.slice(0, 20000) + `\n…truncated (${text.length} chars total)` : text;
}

// Presets carry the ROLE only — what this session is for and how to do it.
// Who the agent is and who it works for come from identity/SOUL.md and
// identity/USER.md (see lib/identity.js), so the presets stay usable by anyone
// who clones this repo. `system` is a getter that composes the two at read time,
// which means editing an identity file applies to the next session without a
// server restart.
export const PRESETS = {
  'coding-agent': {
    label: 'Coding Agent',
    description: 'Implementer. Reads before editing, minimal diffs, verifies its own work before reporting done, terse reports. Writes and commands always gated on your approval.',
    role: `## This session: coding agent

You operate on files inside one workspace via tools.
Rules, in order:
1. Never invent file contents — read before you edit. Never claim an action you did not take.
2. Plan briefly (one or two sentences), then act with tools. Work in small steps, but keep going until the task is actually done — do not stop at the first plausible-looking result.
3. Prefer minimal diffs via edit_file; write_file only for new files. Match the existing code style and document public APIs the way the surrounding code does.
4. Writes and commands need user approval; if denied, adjust your approach rather than retrying the same call.
5. Verify your own work before reporting it done. If what you built can be run — a build, a test suite, a page — run it, read the output, and fix what breaks. Never report completion on code you have not executed. If you could not run it, say so plainly and say why.
6. Be terse. Report what changed and what you verified, not how hard you worked. No flattery, no filler.`,
  },
  'vault-librarian': {
    label: 'Vault Librarian',
    description: 'Markdown knowledge-base work: filing, indexes, links, note hygiene. Honors the vault contract (indexes updated with every move), never deletes — only proposes.',
    role: `## This session: vault librarian

You are working inside a markdown knowledge base. Markdown only.
Follow the vault contract: update the relevant index.md in the same task whenever you add, move, or rename a note; outputs belong in predictable places (Projects/<project>/...). Wiki concepts follow the OKF format (YAML frontmatter with type/title/description/tags, Citations section). Read CLAUDE.md (or the equivalent contract file) at the vault root if in doubt. Never delete content — propose deletions instead. Be terse and concrete.`,
  },
  'design-brainstorm': {
    label: 'Design Brainstorm',
    description: 'Creative partner mode — mechanics, systems, and theming. Reads for context, avoids writes, guards against scope creep.',
    role: `## This session: design partner

Riff concretely on the project the operator names: mechanics, systems, encounters, theming. Ground every idea in something buildable. Push back on scope creep — shipping beats designing. You may read files for context; avoid writes unless asked.`,
  },
  'researcher': {
    label: 'Researcher',
    description: 'Web research: searches the internet, reads the actual sources, and returns a cited brief. Saving a note into the workspace still gates on your approval.',
    role: `## This session: web research

Method, in order:
1. web_search the topic — 2 to 4 focused queries beat one vague one.
2. web_fetch the 2–5 most promising results. Never cite a page you did not fetch.
3. Cross-check claims across sources; flag disagreements and dates explicitly (docs go stale).
Output: a tight brief — key findings first, then supporting detail — with numbered inline citations [1] and a final "Sources" section listing every fetched URL. Synthesize; quote sparingly.
If asked to save the research: write one markdown note in the workspace, with title/source/published/tags YAML frontmatter. Writes require user approval.
Be terse and factual. If results are thin or contradictory, say so plainly instead of padding.`,
  },
};

// `system` stays a property on every preset so existing call sites are untouched,
// but it is a getter: identity is composed at read time, not at module load, so
// editing SOUL.md or USER.md applies to the next session without a restart.
// Non-enumerable — server.js spreads presets to the UI and the full prompt has
// no business going over the wire.
for (const preset of Object.values(PRESETS)) {
  Object.defineProperty(preset, 'system', {
    get() { return composeSystem(this.role); },
    enumerable: false,
  });
}

// ---- skill library (Claude-Code layout: .claude/skills/<name>/SKILL.md) ----
// Workspace skills plus user-level ~/.claude/skills. User skills that call
// hosted claude.ai connectors (mcp__claude_ai_*) are excluded — those tools
// only exist on Anthropic's side and no local transport can reach them.
// On a name collision the workspace skill wins, same as Claude Code.
function scanSkills(dir, origin) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (origin === 'user' && /mcp__claude_ai/i.test(text)) continue;
    const fm = text.slice(0, 2000).match(/^---\n([\s\S]*?)\n---/);
    const get = (k) => fm?.[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1].trim() ?? '';
    out.push({ name: get('name') || e.name, description: get('description'), origin, file, dir: path.dirname(file) });
  }
  return out;
}
export function listSkills(workspace) {
  const out = scanSkills(path.join(workspace, '.claude', 'skills'), 'workspace');
  const seen = new Set(out.map(s => s.name));
  for (const s of scanSkills(path.join(os.homedir(), '.claude', 'skills'), 'user')) {
    if (!seen.has(s.name)) out.push(s);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Files bundled inside a skill folder — reference material and sub-skill
// SKILL.md files (router skills like openai-game-studio point at these).
// Returned relative to the folder, forward-slashed, excluding the top SKILL.md.
// These are loadable via use_skill's `file` arg — the only sanctioned reader
// for a skill dir that lives outside the workspace jail.
function listSkillFiles(skillDir, sub = '', out = []) {
  for (const e of fs.readdirSync(path.join(skillDir, sub), { withFileTypes: true })) {
    if (out.length >= 200) break;
    if (/^(node_modules|\.git|__pycache__)$/.test(e.name)) continue;
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) listSkillFiles(skillDir, rel, out);
    else if (rel !== 'SKILL.md') out.push(rel);
  }
  return out;
}

// When use_skill gets a name that isn't a top-level skill, check whether it's
// actually a side file inside one — the classic router mistake of calling a
// sub-skill (e.g. "three-webgl-game") by bare name instead of via `file`.
// Returns the correct { name, file } targets, sub-skill SKILL.md files first,
// so the error can hand back the exact call to make.
export function findSubSkillSuggestions(skills, wanted) {
  const w = String(wanted ?? '').trim().toLowerCase()
    .replace(/\/?skill\.md$/, '').replace(/\/+$/, '').split('/').pop();
  if (!w) return [];
  const hits = [];
  for (const sk of skills) {
    for (const f of listSkillFiles(sk.dir)) {
      const seg = f.toLowerCase().split('/');
      if (seg.some(s => s === w || s.replace(/\.(md|ya?ml|py|json)$/, '') === w)) {
        hits.push({ name: sk.name, file: f, isSkillMd: f.endsWith('SKILL.md') });
      }
    }
  }
  return hits.sort((a, b) => (b.isSkillMd - a.isSkillMd));
}

// Appended to every preset so the model discovers skills the same way Claude
// does: descriptions up front, full instructions loaded on demand.
function skillPrompt(workspace) {
  const skills = listSkills(workspace);
  if (!skills.length) return '';
  return '\n\nSkills — stored procedures under .claude/skills in this workspace. When a task matches one, call use_skill with its name BEFORE improvising, then follow the returned instructions:\n'
    + skills.map(s => `- ${s.name}: ${s.description.slice(0, 200)}`).join('\n');
}

export class AgentSession {
  constructor({ id, lm, mcp, model, workspace, preset, mode, broadcast, onDirty }) {
    this.id = id;
    this.lm = lm;
    this.mcp = mcp ?? null;       // MCPManager (shared across sessions)
    this.mcpServers = [];         // servers enabled for THIS session
    this.model = model;
    this.workspace = workspace;
    this.preset = preset;
    this.mode = MODES.includes(mode) ? mode : 'ask';
    this.broadcast = broadcast;
    this.onDirty = onDirty ?? (() => {});
    this.createdAt = Date.now();
    this.messages = [{ role: 'system', content: (PRESETS[preset] ?? PRESETS['coding-agent']).system + skillPrompt(workspace) }];
    this.history = [];            // UI-replayable transcript: {kind, ...}
    // in = prompt tokens actually processed (context re-sent every hop, so
    // this is the billing-style total); out = completion tokens generated.
    this.stats = { tps: 0, in: 0, out: 0, turns: 0 };
    this.pending = null;          // { resolve } for an approval wait
    this.allowlist = new Set();   // approved command prefixes / "tool:*" wildcards
    this.busy = false;
    // Context compaction — summarize old turns when the conversation nears the
    // model's LOADED context window, so long sessions don't overflow (the 5xx a
    // too-small context throws). Only whole prior turns are folded (cut on a
    // user-message boundary), so no tool_call/tool-result pair is ever split.
    this.autoCompact = true;
    this.compactRatio = 0.75;     // compact when a turn's prompt exceeds this × window
    this.keepRecentTurns = 3;     // user turns kept verbatim after a compaction
    this.lastPromptTokens = 0;    // real prompt size of the most recent turn (from usage)
    this.contextWindow = null;    // loaded ctx length for this.model, fetched lazily
  }

  // Everything needed to resurrect the session after a server restart.
  // A pending approval cannot survive a restart — the model turn it belongs
  // to is gone — so it is deliberately not serialized.
  toJSON() {
    return {
      id: this.id, model: this.model, workspace: this.workspace, preset: this.preset,
      mode: this.mode, createdAt: this.createdAt, messages: this.messages, history: this.history,
      stats: this.stats, allowlist: [...this.allowlist], mcpServers: this.mcpServers,
      autoCompact: this.autoCompact, lastPromptTokens: this.lastPromptTokens,
      shell: SHELL_NAME, shellPath: SHELL_PATH, maxHops: MAX_HOPS, cmdTimeoutMs: CMD_TIMEOUT_MS,
      identity: loadIdentity().sources,   // which SOUL/USER files this run used
    };
  }

  static fromJSON(data, deps) {
    const s = new AgentSession({ ...deps, id: data.id, model: data.model, workspace: data.workspace, preset: data.preset, mode: data.mode });
    s.createdAt = data.createdAt ?? Date.now();
    s.messages = data.messages ?? s.messages;
    s.history = data.history ?? [];
    s.stats = { tps: 0, in: 0, out: 0, turns: 0, ...(data.stats ?? {}) };
    if (s.stats.tokens != null) { s.stats.out ||= s.stats.tokens; delete s.stats.tokens; } // pre-in/out sessions
    s.allowlist = new Set(data.allowlist ?? []);
    s.mcpServers = data.mcpServers ?? [];
    s.autoCompact = data.autoCompact ?? true;
    s.lastPromptTokens = data.lastPromptTokens ?? 0;
    return s;
  }

  #record(entry) { this.history.push({ at: Date.now(), ...entry }); }

  title() {
    const first = this.history.find(h => h.kind === 'user');
    return first ? first.text.slice(0, 60) : '(empty)';
  }

  #safe(rel) {
    const abs = path.resolve(this.workspace, rel ?? '.');
    const root = path.resolve(this.workspace);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path escapes workspace: ${rel}`);
    return abs;
  }

  async send(userText) {
    if (this.busy) throw new Error('Agent is mid-turn; approve or deny the pending action first.');
    this.busy = true;
    // Proactively compact BEFORE this turn if the last turn already ran the
    // context hot — keeps the request we're about to send under the window.
    if (this.autoCompact) await this.#maybeCompact();
    this.messages.push({ role: 'user', content: userText });
    this.#record({ kind: 'user', text: userText });
    try {
      const tools = [
        ...TOOL_DEFS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        ...await this.#mcpToolDefs(),
      ];
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        const started = Date.now();
        const { content, reasoning, toolCalls, approxTokens, promptTokens, serverTps } = await this.lm.chatStream({
          model: this.model,
          messages: this.messages,
          tools,
          onDelta: (d) => this.broadcast({ type: 'agent_delta', session: this.id, text: d }),
          onReasoning: (d) => this.broadcast({ type: 'agent_reasoning', session: this.id, text: d }),
        });
        if (reasoning) this.#record({ kind: 'reasoning', text: reasoning.slice(0, 8000) });
        const secs = (Date.now() - started) / 1000;
        this.stats.turns++;
        this.stats.out += approxTokens;
        this.lastPromptTokens = promptTokens ?? Math.round(JSON.stringify(this.messages).length / 4);
        this.stats.in += this.lastPromptTokens;
        this.stats.tps = serverTps ? +serverTps.toFixed(1)
          : secs > 0.2 ? +(approxTokens / secs).toFixed(1) : this.stats.tps;
        this.broadcast({ type: 'agent_stats', session: this.id, tps: this.stats.tps, in: this.stats.in, out: this.stats.out, turns: this.stats.turns });

        if (!toolCalls.length) {
          this.messages.push({ role: 'assistant', content: stripThink(content) });
          this.#record({ kind: 'assistant', text: content });
          this.broadcast({ type: 'agent_done', session: this.id, text: content });
          return content;
        }

        // Record the assistant turn (content + tool calls), then execute each call.
        this.messages.push({
          role: 'assistant', content: stripThink(content) || null,
          tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })),
        });
        for (const tc of toolCalls) {
          const result = await this.#execute(tc);
          this.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
      }
      // Recorded, not just broadcast: hop exhaustion is a HARNESS limit, and a
      // run scored later must be able to tell it apart from the model stopping
      // on its own.
      const bail = `Stopped after ${MAX_HOPS} tool hops (harness limit, not a model decision) — the turn was cut off mid-task. Raise EMBER_MAX_HOPS or split the task.`;
      this.#record({ kind: 'bail', reason: 'max_hops', hops: MAX_HOPS, text: bail });
      this.broadcast({ type: 'agent_done', session: this.id, text: bail });
      return bail;
    } finally {
      this.busy = false;
      this.onDirty(this);
    }
  }

  // Loaded context window for this session's model (cached). null if unknown.
  async #ctxWindow() {
    if (this.contextWindow) return this.contextWindow;
    try { this.contextWindow = (await this.lm.models()).find(x => x.key === this.model)?.contextLength ?? null; }
    catch { /* leave null — compaction just won't auto-fire */ }
    return this.contextWindow;
  }

  // Auto-compaction gate: fold old turns if the last prompt exceeded the ratio
  // of the loaded window. No-op when the window is unknown or history is short.
  async #maybeCompact() {
    if (!this.lastPromptTokens) return;
    const win = await this.#ctxWindow();
    if (win && this.lastPromptTokens > this.compactRatio * win) {
      try { await this.compact('auto'); }
      catch (err) { this.broadcast({ type: 'agent_tool', session: this.id, tool: 'compact', args: `failed: ${String(err.message ?? err).slice(0, 120)}` }); }
    }
  }

  // Summarize the older portion of the conversation into one context note,
  // keeping the system prompt and the most recent `keepRecentTurns` user turns
  // verbatim. The cut lands on a user-message boundary, so an assistant
  // tool_calls block and its tool results are never split. Touches only the
  // model-facing `messages`; the UI transcript (`history`) is left whole.
  async compact(reason = 'manual') {
    if (this.busy && reason === 'manual') throw new Error('Cannot compact mid-turn.');
    const userIdxs = this.messages.map((m, i) => (i > 0 && m.role === 'user' ? i : -1)).filter(i => i > 0);
    if (userIdxs.length <= this.keepRecentTurns) return false;  // nothing old enough to fold
    const cut = userIdxs[userIdxs.length - this.keepRecentTurns];
    if (cut <= 1) return false;

    const before = this.lastPromptTokens || Math.round(JSON.stringify(this.messages).length / 4);
    const transcript = this.messages.slice(1, cut).map(m => {
      if (m.role === 'tool') return `[tool result] ${String(m.content).slice(0, 800)}`;
      if (m.role === 'assistant' && m.tool_calls) return `assistant: ${m.content ?? ''}\n[called tools: ${m.tool_calls.map(t => t.function.name).join(', ')}]`;
      return `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
    }).join('\n\n').slice(0, 40000);

    const summary = await this.lm.complete({
      model: this.model,
      system: 'You compress an AI coding-agent conversation into a compact hand-off note for the same agent to keep working from. Preserve everything load-bearing: what the user asked for, decisions made, files created or changed WITH their paths, key findings, errors hit and how they were resolved, and the current state / next step. Drop pleasantries and repetition. Output only the note.',
      user: `Summarize this earlier portion of the session:\n\n${transcript}`,
      maxTokens: 2048,
      temperature: 0.2,
    });

    // Merge the summary into the first kept user turn — keeps clean role
    // alternation (no back-to-back user messages some local templates dislike).
    const tail = this.messages.slice(cut);
    const firstText = typeof tail[0].content === 'string' ? tail[0].content : JSON.stringify(tail[0].content);
    tail[0] = { role: 'user', content: `[Earlier turns were compacted to save context. Summary of the session so far:]\n\n${summary.trim()}\n\n[End of summary — current request:]\n${firstText}` };
    this.messages = [this.messages[0], ...tail];

    const after = Math.round(JSON.stringify(this.messages).length / 4);
    this.lastPromptTokens = after;
    // Full forensic record. A compaction makes the run a test of two systems —
    // the model's context handling AND the quality of this summary — so a later
    // score has to be able to ask "did it forget, or was it never told?".
    // The handoff note is kept verbatim: without it, post-compaction regressions
    // (repeated work, dropped shared utilities, relaxed constraints) can't be
    // attributed to the model rather than to a lossy summary.
    this.#record({
      kind: 'compacted', reason,
      folded: userIdxs.length - this.keepRecentTurns,
      before, after,                              // model-visible tokens; `after` is an estimate
      window: this.contextWindow ?? null,
      ratio: this.compactRatio,
      keptTurns: this.keepRecentTurns,
      atTurn: this.stats.turns,
      summaryChars: summary.length,
      summary: summary.trim(),
    });
    this.broadcast({ type: 'agent_compacted', session: this.id, reason, before, after });
    this.onDirty(this);
    return true;
  }

  // MCP tools of the session's enabled servers, in OpenAI function shape and
  // Claude's naming (mcp__<server>__<tool>). A server that fails to start is
  // skipped with a chat notice rather than killing the turn.
  async #mcpToolDefs() {
    const defs = [];
    for (const server of this.mcpServers) {
      try {
        for (const t of await this.mcp.tools(server)) {
          defs.push({ type: 'function', function: {
            name: `mcp__${server}__${t.name}`,
            description: (t.description ?? '').slice(0, 400),
            parameters: t.inputSchema ?? { type: 'object', properties: {} },
          } });
        }
      } catch (err) {
        this.broadcast({ type: 'agent_tool', session: this.id, tool: 'mcp', args: `${server} unavailable: ${String(err.message ?? err).slice(0, 120)}` });
      }
    }
    return defs;
  }

  async #execute(tc) {
    let args;
    try { args = JSON.parse(tc.args || '{}'); }
    catch { return `ERROR: unparseable tool arguments: ${tc.args?.slice(0, 200)}`; }
    const mcpCall = tc.name.match(/^mcp__(.+?)__(.+)$/);
    // Every MCP tool is gated: they reach outside the workspace jail (browser,
    // web APIs, Unity editor), so they get the same approval flow as writes.
    const def = mcpCall
      ? (this.mcpServers.includes(mcpCall[1]) ? { needsApproval: true } : null)
      : TOOL_DEFS.find(t => t.name === tc.name);
    if (!def) return `ERROR: unknown tool ${tc.name}`;

    this.#record({ kind: 'tool', tool: tc.name, args: this.#preview(tc.name, args) });
    this.broadcast({ type: 'agent_tool', session: this.id, tool: tc.name, args: this.#preview(tc.name, args) });

    if (def.needsApproval && this.mode === 'plan') {
      this.#record({ kind: 'approval', tool: tc.name, args: this.#preview(tc.name, args), decision: 'plan-blocked' });
      return 'BLOCKED: this session is in PLAN mode — no writes or commands, allowlist included. Describe the intended change instead; the user will switch modes to execute.';
    }
    if (def.needsApproval && this.mode !== 'auto' && !this.#preapproved(tc.name, args)) {
      const approval = await this.#askApproval(tc.name, args);
      this.#record({ kind: 'approval', tool: tc.name, args: this.#preview(tc.name, args), decision: approval });
      if (approval === 'deny') return 'DENIED by user. Do not retry this exact action; ask or adjust.';
      if (approval === 'always') this.#remember(tc.name, args);
    }

    try {
      if (mcpCall) return await this.mcp.call(mcpCall[1], mcpCall[2], args);
      switch (tc.name) {
        case 'read_file': {
          const text = fs.readFileSync(this.#safe(args.path), 'utf8');
          return text.length > 40000 ? text.slice(0, 40000) + `\n…truncated (${text.length} chars total)` : text;
        }
        case 'list_dir': {
          return fs.readdirSync(this.#safe(args.path ?? '.'), { withFileTypes: true })
            .map(e => (e.isDirectory() ? 'd ' : 'f ') + e.name).join('\n') || '(empty)';
        }
        case 'grep': {
          const re = new RegExp(args.pattern);
          const hits = [];
          const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (hits.length >= 100) return;
              const p = path.join(dir, e.name);
              if (e.isDirectory()) { if (!/node_modules|\.git|Library|obj|Temp/.test(e.name)) walk(p); continue; }
              if (!/\.(md|cs|js|ts|json|txt|yml|yaml|uxml|uss|shader)$/i.test(e.name)) continue;
              const lines = fs.readFileSync(p, 'utf8').split('\n');
              lines.forEach((l, i) => { if (hits.length < 100 && re.test(l)) hits.push(`${path.relative(this.workspace, p)}:${i + 1}: ${l.trim().slice(0, 200)}`); });
            }
          };
          walk(this.#safe(args.path ?? '.'));
          return hits.join('\n') || 'no matches';
        }
        case 'glob': {
          const pattern = String(args.pattern ?? '').replaceAll('\\', '/');
          // Placeholders keep later replacements from mangling earlier ones
          // (the "**/" expansion itself contains "*").
          const rx = new RegExp('^' + pattern
            .replace(/[.+^${}()|[\]]/g, '\\$&')
            .replace(/\*\*\//g, '\x00').replace(/\*\*/g, '\x01')
            .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
            .replace(/\x00/g, '(?:.*/)?').replace(/\x01/g, '.*') + '$');
          const nameOnly = !pattern.includes('/');
          const hits = [];
          const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (hits.length >= 1000) return;
              const p = path.join(dir, e.name);
              if (e.isDirectory()) { if (!/node_modules|\.git|Library|obj|Temp/.test(e.name)) walk(p); continue; }
              const rel = path.relative(this.workspace, p).replaceAll('\\', '/');
              if (rx.test(nameOnly ? e.name : rel)) hits.push({ rel, mtime: fs.statSync(p).mtimeMs });
            }
          };
          walk(this.#safe(args.path ?? '.'));
          return hits.sort((a, b) => b.mtime - a.mtime).slice(0, 200).map(h => h.rel).join('\n') || 'no matches';
        }
        case 'use_skill': {
          const skills = listSkills(this.workspace);
          const skill = skills.find(s => s.name === String(args.name ?? '').trim());
          if (!skill) {
            // Not a top-level skill — but maybe a sub-skill called by bare name?
            const sug = findSubSkillSuggestions(skills, args.name).slice(0, 4);
            if (sug.length) {
              return `ERROR: "${args.name}" is not a top-level skill — it's a side file inside another skill. Load it by name + file:\n`
                + sug.map(h => `  use_skill  name="${h.name}"  file="${h.file}"`).join('\n');
            }
            return `ERROR: no skill named "${args.name}". Available: ${skills.map(s => s.name).join(', ') || '(none in this workspace)'}`;
          }

          // Optional sub-file load, jailed to the skill's OWN folder. Router
          // skills (openai-game-studio → skills/three-webgl-game/SKILL.md) point
          // at sub-files; this is the sanctioned door to them even though the
          // skill dir lives outside the workspace jail. read_file still can't
          // reach here — only this scoped reader can, and only within one skill.
          let target = skill.file;
          if (args.file) {
            const abs = path.resolve(skill.dir, String(args.file));
            if (abs !== skill.dir && !abs.startsWith(skill.dir + path.sep)) {
              return `ERROR: file "${args.file}" escapes the skill folder.`;
            }
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
              return `ERROR: "${args.file}" not found in skill "${skill.name}". Side files: ${listSkillFiles(skill.dir).join(', ') || '(none)'}`;
            }
            target = abs;
          }

          const text = fs.readFileSync(target, 'utf8');
          const body = text.length > 20000 ? text.slice(0, 20000) + `\n…truncated (${text.length} chars total)` : text;

          // A skill (or sub-file) may lean on MCP tools; warn when servers aren't
          // live in this session so the model asks instead of failing blind.
          const norm = (s) => s.replace(/[-_]/g, '');
          const wanted = [...new Set([...body.matchAll(/mcp__([a-zA-Z0-9_-]+?)__/g)].map(m => m[1]))];
          const missing = wanted.filter(w => !this.mcpServers.some(e => norm(e) === norm(w)));
          const warn = missing.length
            ? `NOTE: this skill uses MCP server(s) [${missing.join(', ')}] not enabled for this session — ask the user to enable them in the workbench MCP rail before running the MCP steps.\n\n`
            : '';

          // Enumerate loadable side files so the model routes without guessing paths.
          const sideFiles = listSkillFiles(skill.dir);
          const footer = sideFiles.length
            ? `\n\n--- SIDE FILES (load with use_skill name="${skill.name}" file="<path>") ---\n${sideFiles.join('\n')}`
            : '';

          const label = args.file ? `${skill.name} → ${args.file}` : skill.name;
          return `SKILL ${label} — follow these instructions with your tools.\n\n${warn}${body}${footer}`;
        }
        case 'write_file': {
          const abs = this.#safe(args.path);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, args.content, 'utf8');
          return `wrote ${args.path} (${args.content.length} chars)`;
        }
        case 'edit_file': {
          const abs = this.#safe(args.path);
          const text = fs.readFileSync(abs, 'utf8');
          const count = text.split(args.old_text).length - 1;
          if (count === 0) return 'ERROR: old_text not found — re-read the file.';
          if (count > 1) return `ERROR: old_text matches ${count} times — provide a longer unique snippet.`;
          fs.writeFileSync(abs, text.replace(args.old_text, args.new_text), 'utf8');
          return `edited ${args.path}`;
        }
        case 'web_search': return await webSearch(String(args.query ?? ''));
        case 'web_fetch':  return await webFetch(String(args.url ?? ''));
        case 'run_command': {
          return await new Promise((resolve) => {
            const child = spawn(args.command, { cwd: this.workspace, shell: SHELL_PATH, timeout: CMD_TIMEOUT_MS });
            let out = '';
            child.stdout.on('data', c => out += c);
            child.stderr.on('data', c => out += c);
            // A timeout arrives as close(null, 'SIGTERM'); say so rather than
            // reporting "exit null", which reads as a plain failure and invites
            // the model to retry the same long-running command.
            child.on('close', (code, signal) => resolve(signal
              ? `TIMED OUT after ${CMD_TIMEOUT_MS / 1000}s (killed with ${signal}). The command may simply need longer.\n${clipOutput(out)}`
              : `exit ${code}\n${clipOutput(out)}`));
            child.on('error', err => resolve(`ERROR: ${err}`));
          });
        }
      }
    } catch (err) {
      return `ERROR: ${String(err).slice(0, 500)}`;
    }
  }

  // Approval flow: broadcast the request, then park until the UI responds.
  #askApproval(tool, args) {
    return new Promise((resolve) => {
      this.pending = { resolve };
      this.broadcast({
        type: 'agent_approval', session: this.id, tool,
        detail: this.#preview(tool, args),
        diff: tool === 'edit_file' ? { old: args.old_text, new: args.new_text, path: args.path } :
              tool === 'write_file' ? { new: args.content.slice(0, 4000), path: args.path } : null,
      });
    });
  }

  resolveApproval(decision) {
    if (!this.pending) return false;
    const { resolve } = this.pending;
    this.pending = null;
    resolve(decision); // 'approve' | 'deny' | 'always'
    return true;
  }

  #preview(tool, args) {
    if (tool === 'run_command') return args.command;
    if (tool.startsWith('mcp__')) return JSON.stringify(args).slice(0, 160);
    return args.path ?? args.pattern ?? args.query ?? args.url ?? args.name ?? '';
  }
  #preapproved(tool, args) {
    if (tool === 'run_command') {
      const head = (args.command ?? '').trim().split(/\s+/).slice(0, 2).join(' ');
      return this.allowlist.has(`cmd:${head}`);
    }
    return this.allowlist.has(`tool:${tool}`);
  }
  #remember(tool, args) {
    if (tool === 'run_command') this.allowlist.add(`cmd:${(args.command ?? '').trim().split(/\s+/).slice(0, 2).join(' ')}`);
    else this.allowlist.add(`tool:${tool}`);
  }
}

export class AgentManager {
  constructor({ lm, mcp, broadcast, workspaces, stateDir }) {
    this.lm = lm;
    this.mcp = mcp ?? null;
    this.broadcast = broadcast;
    this.workspaces = workspaces;
    this.stateDir = stateDir ?? null;
    this.sessions = new Map();
    this.#restore();
  }

  // Sessions persist as one JSON file each so they survive server restarts —
  // "new session" starts a fresh chat, it never buries the old ones.
  #deps() { return { lm: this.lm, mcp: this.mcp, broadcast: this.broadcast, onDirty: (s) => this.#persist(s) }; }
  #restore() {
    if (!this.stateDir) return;
    fs.mkdirSync(this.stateDir, { recursive: true });
    for (const f of fs.readdirSync(this.stateDir).filter(n => n.endsWith('.json'))) {
      try {
        const s = AgentSession.fromJSON(JSON.parse(fs.readFileSync(path.join(this.stateDir, f), 'utf8')), this.#deps());
        this.sessions.set(s.id, s);
      } catch (err) { console.error(`agent: skipping corrupt session file ${f}: ${err}`); }
    }
  }
  #persist(s) {
    if (!this.stateDir) return;
    try {
      const tmp = path.join(this.stateDir, `${s.id}.json.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(s.toJSON()), 'utf8');
      fs.renameSync(tmp, path.join(this.stateDir, `${s.id}.json`));
    } catch (err) { console.error(`agent: persist failed for ${s.id}: ${err}`); }
  }

  create({ model, workspace, preset, mode }) {
    if (!this.workspaces.includes(workspace)) throw new Error('Workspace not in the configured allowlist.');
    const id = randomUUID().slice(0, 8);
    const s = new AgentSession({ id, model, workspace, preset, mode, ...this.#deps() });
    this.sessions.set(id, s);
    this.#persist(s);
    return s;
  }
  get(id) { return this.sessions.get(id) ?? null; }
  delete(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.pending) s.resolveApproval('deny'); // unblock a parked turn before the session vanishes
    this.sessions.delete(id);
    if (this.stateDir) fs.rmSync(path.join(this.stateDir, `${id}.json`), { force: true });
    return true;
  }
  setMode(id, mode) {
    const s = this.sessions.get(id);
    if (!s || !MODES.includes(mode)) return null;
    s.mode = mode;
    this.#persist(s);
    return mode;
  }
  // Preset swap mid-session: replaces the system message (skills addendum
  // included) so the change takes effect on the very next turn.
  setPreset(id, preset) {
    const s = this.sessions.get(id);
    if (!s || !PRESETS[preset]) return null;
    s.preset = preset;
    s.messages[0] = { role: 'system', content: PRESETS[preset].system + skillPrompt(s.workspace) };
    this.#persist(s);
    return preset;
  }

  // Per-session MCP servers. Enabling verifies the server actually starts
  // (spawns it and lists tools) so the UI can show failures immediately.
  async setMcpServer(id, server, enabled) {
    const s = this.sessions.get(id);
    if (!s || !this.mcp || !this.mcp.names().includes(server)) return null;
    if (enabled) {
      const tools = await this.mcp.tools(server); // throws if the server won't start
      if (!s.mcpServers.includes(server)) s.mcpServers.push(server);
      this.#persist(s);
      return { mcpServers: s.mcpServers, tools: tools.length };
    }
    s.mcpServers = s.mcpServers.filter(n => n !== server);
    this.#persist(s);
    return { mcpServers: s.mcpServers };
  }
  updateAllowlist(id, action, entry) {
    const s = this.sessions.get(id);
    if (!s || !entry) return null;
    action === 'remove' ? s.allowlist.delete(entry) : s.allowlist.add(entry);
    this.#persist(s);
    return [...s.allowlist];
  }
  setAutoCompact(id, on) {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.autoCompact = !!on;
    this.#persist(s);
    return s.autoCompact;
  }
  // Manual compaction (button). Returns { compacted, before, after } or null.
  async compact(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const before = s.lastPromptTokens;
    const did = await s.compact('manual');
    return { compacted: did, before, after: s.lastPromptTokens };
  }
  list() {
    return [...this.sessions.values()].map(s => ({
      id: s.id, preset: s.preset, model: s.model, workspace: s.workspace, mode: s.mode,
      title: s.title(), createdAt: s.createdAt, messages: s.history.length,
      busy: s.busy, pendingApproval: !!s.pending, stats: s.stats,
      allowlist: [...s.allowlist], mcpServers: s.mcpServers,
      autoCompact: s.autoCompact, lastPromptTokens: s.lastPromptTokens,
    })).sort((a, b) => b.createdAt - a.createdAt);
  }
}
