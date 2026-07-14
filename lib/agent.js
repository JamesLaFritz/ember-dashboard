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

export const TOOL_DEFS = [
  { name: 'read_file',  needsApproval: false, description: 'Read a UTF-8 text file. Returns at most 40000 chars.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the workspace root' } }, required: ['path'] } },
  { name: 'list_dir',   needsApproval: false, description: 'List files and folders at a path (non-recursive).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep',       needsApproval: false, description: 'Search file contents with a regex. Returns matching lines with file:line prefixes (max 100).',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Folder to search, relative; default "."' } }, required: ['pattern'] } },
  { name: 'glob',       needsApproval: false, description: 'Find files by name pattern (e.g. "**/*.cs", "Enemy*.md"). A pattern without "/" matches filenames at any depth. Returns relative paths, newest first (max 200).',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Folder to search, relative; default "."' } }, required: ['pattern'] } },
  { name: 'use_skill',  needsApproval: false, description: 'Load a skill — a stored step-by-step procedure from .claude/skills (listed in your system prompt). Returns its instructions; follow them with your other tools.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Skill name exactly as listed' } }, required: ['name'] } },
  { name: 'write_file', needsApproval: true,  description: 'Create or overwrite a file with the given content.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file',  needsApproval: true,  description: 'Replace an exact text snippet in a file. old_text must match exactly once.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'run_command', needsApproval: true, description: 'Run a shell command in the workspace root. Returns stdout+stderr (max 20000 chars).',
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

export const PRESETS = {
  'coding-agent': {
    label: 'Coding Agent',
    description: 'Unity/C#-fluent implementer. Reads before editing, minimal diffs, one step at a time, terse reports. Writes and commands always gated on your approval.',
    system: `You are Ember Workbench, a local coding agent for James LaFritz (Unity/C# game developer). You operate on files inside one workspace via tools.
Rules, in order:
1. Never invent file contents — read before you edit. Never claim an action you did not take.
2. Plan briefly (one or two sentences), then act with tools. One logical step at a time.
3. Prefer minimal diffs via edit_file; write_file only for new files. Match the existing code style; XML doc comments on public C# APIs.
4. Writes and commands need user approval; if denied, adjust your approach rather than retrying the same call.
5. Be terse. Report what changed, not how hard you worked. No flattery, no filler.`,
  },
  'vault-librarian': {
    label: 'Vault Librarian',
    description: 'Obsidian vault work: filing, indexes, links, note hygiene. Honors the vault contract (indexes updated with every move), never deletes — only proposes.',
    system: `You are Ember Librarian, working inside James's Obsidian vault (JamesMind). Markdown only.
Follow the vault contract: update the relevant index.md in the same task whenever you add, move, or rename a note; outputs belong in predictable places (Projects/<project>/...). Wiki concepts follow the OKF format (YAML frontmatter with type/title/description/tags, Citations section). Read CLAUDE.md at the vault root if in doubt. Never delete content — propose deletions instead. Be terse and concrete.`,
  },
  'design-brainstorm': {
    label: 'Design Brainstorm',
    description: 'Creative partner mode for Echoes of Aralon — mechanics, enemies, dungeon beats, corruption theming. Reads for context, avoids writes, guards against scope creep.',
    system: `You are Ember, creative partner to James LaFritz on Echoes of Aralon (top-down digital-fantasy action-adventure — grammar of Zelda, expression original; brand voice: forged in darkness, built for discovery). Riff concretely: mechanics, enemies, dungeon beats, corruption theming. Push back on scope creep — the mission is shipping the prototype. You may read files for context; avoid writes unless asked.`,
  },
  'researcher': {
    label: 'Researcher',
    description: 'Web research: searches the internet, reads the actual sources, and returns a cited brief. Saving a note into the workspace still gates on your approval.',
    system: `You are Ember Research, a web research agent for James LaFritz (Unity/C# game developer, indie studio Mythic Valorbreak).
Method, in order:
1. web_search the topic — 2 to 4 focused queries beat one vague one.
2. web_fetch the 2–5 most promising results. Never cite a page you did not fetch.
3. Cross-check claims across sources; flag disagreements and dates explicitly (docs go stale).
Output: a tight brief — key findings first, then supporting detail — with numbered inline citations [1] and a final "Sources" section listing every fetched URL. Synthesize; quote sparingly.
If asked to save the research: write one markdown note in the workspace (in the vault that means under Raw/, with title/source/published/tags YAML frontmatter). Writes require user approval.
Be terse and factual. If results are thin or contradictory, say so plainly instead of padding.`,
  },
};

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
  }

  // Everything needed to resurrect the session after a server restart.
  // A pending approval cannot survive a restart — the model turn it belongs
  // to is gone — so it is deliberately not serialized.
  toJSON() {
    return {
      id: this.id, model: this.model, workspace: this.workspace, preset: this.preset,
      mode: this.mode, createdAt: this.createdAt, messages: this.messages, history: this.history,
      stats: this.stats, allowlist: [...this.allowlist], mcpServers: this.mcpServers,
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
    this.messages.push({ role: 'user', content: userText });
    this.#record({ kind: 'user', text: userText });
    try {
      const tools = [
        ...TOOL_DEFS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        ...await this.#mcpToolDefs(),
      ];
      for (let hop = 0; hop < 16; hop++) {
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
        this.stats.in += promptTokens ?? Math.round(JSON.stringify(this.messages).length / 4);
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
      const bail = 'Stopped after 16 tool hops — task likely needs to be split.';
      this.broadcast({ type: 'agent_done', session: this.id, text: bail });
      return bail;
    } finally {
      this.busy = false;
      this.onDirty(this);
    }
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
          if (!skill) return `ERROR: no skill named "${args.name}". Available: ${skills.map(s => s.name).join(', ') || '(none in this workspace)'}`;
          const text = fs.readFileSync(skill.file, 'utf8');
          const body = text.length > 20000 ? text.slice(0, 20000) + `\n…truncated (${text.length} chars total)` : text;
          // A skill may lean on MCP tools; warn when its servers aren't live
          // in this session so the model asks instead of failing blind.
          const norm = (s) => s.replace(/[-_]/g, '');
          const wanted = [...new Set([...body.matchAll(/mcp__([a-zA-Z0-9_-]+?)__/g)].map(m => m[1]))];
          const missing = wanted.filter(w => !this.mcpServers.some(e => norm(e) === norm(w)));
          const warn = missing.length
            ? `NOTE: this skill uses MCP server(s) [${missing.join(', ')}] that are not enabled for this session — ask the user to enable them in the workbench MCP rail before running the MCP steps.\n\n`
            : '';
          return `SKILL ${skill.name} — follow these instructions with your tools. Side files it references live in ${skill.dir}${path.sep}.\n\n${warn}${body}`;
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
            const child = spawn(args.command, { cwd: this.workspace, shell: true, timeout: 120000 });
            let out = '';
            child.stdout.on('data', c => out += c);
            child.stderr.on('data', c => out += c);
            child.on('close', code => resolve(`exit ${code}\n${out.slice(0, 20000)}`));
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
  list() {
    return [...this.sessions.values()].map(s => ({
      id: s.id, preset: s.preset, model: s.model, workspace: s.workspace, mode: s.mode,
      title: s.title(), createdAt: s.createdAt, messages: s.history.length,
      busy: s.busy, pendingApproval: !!s.pending, stats: s.stats,
      allowlist: [...s.allowlist], mcpServers: s.mcpServers,
    })).sort((a, b) => b.createdAt - a.createdAt);
  }
}
