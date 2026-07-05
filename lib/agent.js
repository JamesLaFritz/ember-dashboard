// agent.js — the LM Studio agent workbench loop (Claude-Code-style):
// model proposes tool calls → server executes inside a workspace root →
// writes and commands require explicit approval from the UI first.
// System-prompt patterns distilled from the leaked coding-agent prompts
// (github.com/asgeirtj/system_prompts_leaks): terse output, plan-then-act,
// one tool at a time, never invent file contents.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const TOOL_DEFS = [
  { name: 'read_file',  needsApproval: false, description: 'Read a UTF-8 text file. Returns at most 40000 chars.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the workspace root' } }, required: ['path'] } },
  { name: 'list_dir',   needsApproval: false, description: 'List files and folders at a path (non-recursive).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep',       needsApproval: false, description: 'Search file contents with a regex. Returns matching lines with file:line prefixes (max 100).',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Folder to search, relative; default "."' } }, required: ['pattern'] } },
  { name: 'write_file', needsApproval: true,  description: 'Create or overwrite a file with the given content.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file',  needsApproval: true,  description: 'Replace an exact text snippet in a file. old_text must match exactly once.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'run_command', needsApproval: true, description: 'Run a shell command in the workspace root. Returns stdout+stderr (max 20000 chars).',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

export const PRESETS = {
  'coding-agent': `You are Ember Workbench, a local coding agent for James LaFritz (Unity/C# game developer). You operate on files inside one workspace via tools.
Rules, in order:
1. Never invent file contents — read before you edit. Never claim an action you did not take.
2. Plan briefly (one or two sentences), then act with tools. One logical step at a time.
3. Prefer minimal diffs via edit_file; write_file only for new files. Match the existing code style; XML doc comments on public C# APIs.
4. Writes and commands need user approval; if denied, adjust your approach rather than retrying the same call.
5. Be terse. Report what changed, not how hard you worked. No flattery, no filler.`,
  'vault-librarian': `You are Ember Librarian, working inside James's Obsidian vault (JamesMind). Markdown only.
Follow the vault contract: wikilinks between notes; update the relevant Index note in the same task whenever you add, move, or rename a note; outputs belong in predictable places (Projects/<project>/...). Read CLAUDE.md at the vault root if in doubt. Never delete content — propose deletions instead. Be terse and concrete.`,
  'design-brainstorm': `You are Ember, creative partner to James LaFritz on Echoes of Aralon (top-down digital-fantasy action-adventure — grammar of Zelda, expression original; brand voice: forged in darkness, built for discovery). Riff concretely: mechanics, enemies, dungeon beats, corruption theming. Push back on scope creep — the mission is shipping the prototype. You may read files for context; avoid writes unless asked.`,
};

export class AgentSession {
  constructor({ id, lm, model, workspace, preset, broadcast }) {
    this.id = id;
    this.lm = lm;
    this.model = model;
    this.workspace = workspace;
    this.preset = preset;
    this.broadcast = broadcast;
    this.messages = [{ role: 'system', content: PRESETS[preset] ?? PRESETS['coding-agent'] }];
    this.pending = null;          // { resolve } for an approval wait
    this.allowlist = new Set();   // approved command prefixes / "tool:*" wildcards
    this.busy = false;
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
    try {
      for (let hop = 0; hop < 16; hop++) {
        const { content, toolCalls } = await this.lm.chatStream({
          model: this.model,
          messages: this.messages,
          tools: TOOL_DEFS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
          onDelta: (d) => this.broadcast({ type: 'agent_delta', session: this.id, text: d }),
        });

        if (!toolCalls.length) {
          this.messages.push({ role: 'assistant', content });
          this.broadcast({ type: 'agent_done', session: this.id, text: content });
          return content;
        }

        // Record the assistant turn (content + tool calls), then execute each call.
        this.messages.push({
          role: 'assistant', content: content || null,
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
    }
  }

  async #execute(tc) {
    let args;
    try { args = JSON.parse(tc.args || '{}'); }
    catch { return `ERROR: unparseable tool arguments: ${tc.args?.slice(0, 200)}`; }
    const def = TOOL_DEFS.find(t => t.name === tc.name);
    if (!def) return `ERROR: unknown tool ${tc.name}`;

    this.broadcast({ type: 'agent_tool', session: this.id, tool: tc.name, args: this.#preview(tc.name, args) });

    if (def.needsApproval && !this.#preapproved(tc.name, args)) {
      const approval = await this.#askApproval(tc.name, args);
      if (approval === 'deny') return 'DENIED by user. Do not retry this exact action; ask or adjust.';
      if (approval === 'always') this.#remember(tc.name, args);
    }

    try {
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
    return args.path ?? args.pattern ?? '';
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
  constructor({ lm, broadcast, workspaces }) {
    this.lm = lm;
    this.broadcast = broadcast;
    this.workspaces = workspaces;
    this.sessions = new Map();
  }
  create({ model, workspace, preset }) {
    if (!this.workspaces.includes(workspace)) throw new Error('Workspace not in the configured allowlist.');
    const id = randomUUID().slice(0, 8);
    const s = new AgentSession({ id, lm: this.lm, model, workspace, preset, broadcast: this.broadcast });
    this.sessions.set(id, s);
    return s;
  }
  get(id) { return this.sessions.get(id) ?? null; }
}
