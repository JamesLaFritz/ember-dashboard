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
import { composeSystem, loadIdentity, loadAgentsMd, loadCraft, identityDefault } from './identity.js';
import { addMemory, memoryPrompt, readMemory } from './memory.js';
import { MAX_OUTPUT_TOKENS } from './lmstudio.js';
import { num, str } from './config.js';

// run_command shell. Node's `shell: true` resolves to %ComSpec% (cmd.exe) on
// Windows no matter which terminal launched the dashboard, so an agent could
// be running cmd.exe while a comparison harness ran Git Bash — and models that
// emit POSIX one-liners fail for reasons that have nothing to do with the task.
// Resolve one shell explicitly, prefer Git Bash, and report it per session so
// benchmark runs can record it. Override with EMBER_SHELL.
// Node applies `-c` to a non-cmd shell and `/d /s /c` (verbatim) to cmd.exe.
export const SHELL_PATH = (() => {
  if (process.platform !== 'win32') return str('EMBER_SHELL', 'shell', '/bin/sh');
  const candidates = [
    str('EMBER_SHELL', 'shell'),
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

// What the model is told about its shell. Fix 2 settled WHICH shell runs; it
// never told the model, so models guessed — one benchmark run emitted `dir`,
// `2>nul`, `findstr` and `type` into Git Bash and left two stray files named
// `nul` on disk, one of them outside the workspace. Frontier harnesses do not
// leave this to inference: Claude Code states the platform, the shell and the
// exact syntax traps in the tool description itself.
export const SHELL_SYNTAX_HINT = SHELL_NAME === 'git-bash' || SHELL_NAME === 'sh'
  ? 'use Unix syntax (`ls`, `rm`, `cat`, `grep`, `/dev/null`, forward slashes, `$VAR`, `&&`). '
    + 'cmd.exe builtins are NOT available and fail in confusing ways: `dir`, `type`, `findstr`, `%VAR%`, and especially `2>nul`, '
    + 'which silently creates a FILE named `nul` instead of discarding output — write `2>/dev/null`.'
  : SHELL_NAME === 'cmd'
    ? 'use cmd.exe syntax (`dir`, `type`, `findstr`, `%VAR%`, `2>nul`, backslashes). POSIX tools may not be on PATH.'
    : `use ${SHELL_NAME} syntax.`;

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
  { name: 'run_command', needsApproval: true, description:
    `Run a shell command. THE SHELL IS ${SHELL_NAME.toUpperCase()}${SHELL_NAME === 'git-bash' ? ' (POSIX sh on Windows)' : ''} — ${SHELL_SYNTAX_HINT} `
    + `Every call starts fresh in the workspace root: the working directory does NOT persist between calls, so \`cd\` in one command is forgotten by the next — chain it (\`cd sub && cmd\`) or use paths relative to the root. `
    + `Stay inside the workspace; leaving it is out of scope and is reported. `
    + `Returns stdout+stderr (max 20000 chars; if longer the head and the tail are kept and the middle is dropped — build errors are usually in the tail).`,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'web_search', needsApproval: false, description: 'Search the web (DuckDuckGo). Returns the top results as title / url / snippet blocks.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'remember',   needsApproval: false, description: 'Record a lesson or a decision worth carrying past this session. kind="lesson" for something that cost you time and would cost the next agent time; kind="decision" for a choice made and why, so it is not silently relitigated. One finding per call, stated as a finding, not a narration. Scoped to this workspace and injected into future sessions here.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['lesson', 'decision'] }, text: { type: 'string' } }, required: ['kind', 'text'] } },
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


// 120s was not enough for a cold `npm install` plus a production build, and a
// timeout is indistinguishable from a real failure to the model. Override with
// EMBER_CMD_TIMEOUT_MS.
export const CMD_TIMEOUT_MS = num('EMBER_CMD_TIMEOUT_MS', 'commandTimeoutMs', 600000);

// Runaway-loop guard on tool calls per turn. 16 was too low to be invisible and
// 48 still was not: a measured run wrote 38 files, installed, built, and found
// a real error in its own code — then hit the ceiling before it could repair it,
// which reads exactly like a model that gave up. A full implement → install →
// build → read errors → repair → rebuild → browser-test cycle needs room.
// Override with EMBER_MAX_HOPS.
export const MAX_HOPS = num('EMBER_MAX_HOPS', 'maxHops', 250);

// Hitting the output ceiling is a harness event, not a model decision. Codex and
// Claude Code both continue across a truncation on their own; requiring the
// operator to type "continue" made a local run's continue-count measure a
// protocol the other harnesses never participate in. Continue automatically —
// bounded, so a model that cannot stop still terminates, and recorded, so the
// count stays visible in the transcript. Set EMBER_MAX_AUTO_CONTINUE=0 to
// restore the manual behaviour.
export const MAX_AUTO_CONTINUE = num('EMBER_MAX_AUTO_CONTINUE', 'maxAutoContinue', 3);

// Budget for the compaction summariser. 2048 was silently far too small on a
// reasoning model: summarising a 40,000-char transcript, qwen3.8-27b spent
// 2047 of 2048 tokens on reasoning_content and emitted ZERO content, so the
// handoff note became the tail of an unfinished thought — 83 characters
// standing in for 94,296 tokens of session. Measured on the same input, 8192
// finishes cleanly (3,711 reasoning tokens, a 9,620-char note) in ~117s.
export const SUMMARY_MAX_TOKENS = num('EMBER_SUMMARY_TOKENS', 'summaryMaxTokens', 8192);

// Compaction only fires above ~90k tokens of context, so a usable note is never
// this short. The two observed failures were 83 and 158 chars; a real one was
// 9,620.
export const MIN_SUMMARY_CHARS = num('EMBER_MIN_SUMMARY_CHARS', 'minSummaryChars', 400);

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

// clipOutput only runs once the command is over, so the live accumulator needs
// its own ceiling: a runaway loop or a very chatty installer can produce more
// output than the server can hold long before there is anything to clip. Keep a
// generous multiple of the clip limit, and drop from the HEAD — same reasoning
// as clipOutput, errors land at the end.
const OUT_BUFFER_CAP = OUT_LIMIT * 4;

// Killing the shell does not kill what the shell started. On Windows a
// grandchild (node, vite, a watcher) survives SIGTERM to bash.exe and is simply
// reparented, so it keeps running — and keeps the inherited stdout pipe open.
// taskkill /T walks the parent chain and takes the whole tree, which only works
// while the parent is still alive; call this BEFORE reaping, not after.
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL'); // negative pid = the detached process group
  } catch { /* already gone — nothing to kill */ }
}

// Does this command walk out of the workspace? Deliberately NOT a security
// boundary: a shell is Turing-complete and `cd $(echo ..)` defeats any pattern
// match, so a real boundary would mean a container or a Windows job object.
// This guards ACCIDENTS, which is the failure actually observed — a benchmark
// run did `cd .. && npm install`, scanned an unrelated tree for 5MB of output,
// and left a stray file one directory above the workspace root. Warn, do not
// block: the model self-corrects and the transcript records what happened.
const GIT_BASH_DRIVE = /^\/([a-zA-Z])(\/|$)/;   // Git Bash spells C:\x as /c/x
function nativePath(q) {
  const m = GIT_BASH_DRIVE.exec(q);
  return m ? m[1].toUpperCase() + ':' + path.sep + q.slice(3).split('/').join(path.sep) : q;
}
export function escapesWorkspace(command, workspace) {
  const root = path.resolve(workspace);
  const re = /(?:^|[;&|(]|&&|\|\|)\s*(?:cd|pushd)(\s+[^\s;&|)]+)?/g;
  for (const m of String(command).matchAll(re)) {
    let target = (m[1] ?? '').trim();
    if (!target || target === '~' || target.startsWith('~/')) return target || '~';
    if (/[$`]/.test(target)) continue;                 // computed — cannot resolve, do not guess
    target = target.replace(/^["']|["']$/g, '');
    if (target === '-') continue;                      // previous dir; unknowable here
    const abs = path.resolve(root, nativePath(target));
    if (abs !== root && !abs.startsWith(root + path.sep)) return target;
  }
  return null;
}


// Run one shell command in `cwd` and resolve with a model-readable transcript.
// Exported separately from the tool dispatch so the harness tests can drive it
// directly; three of its properties were each worth a mis-scored benchmark run.
export function runCommand(command, cwd, { timeoutMs = CMD_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: SHELL_PATH,
        // Default stdio gives the child an stdin pipe that never reaches EOF, so
        // anything that reads stdin — `npm init`, an npx "Ok to proceed? (y)", a
        // git credential prompt, a `read` in a script — blocks until the command
        // timeout and then reports as a hang. Measured: 8s+ and killed with the
        // default, 24ms with 'ignore'. CI=1 additionally makes most JS tooling
        // skip prompts and progress spinners.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: '1', npm_config_yes: 'true' },
        detached: process.platform !== 'win32', // gives POSIX a killable process group
      });
    } catch (err) {
      resolve(`ERROR: ${err}`);
      return;
    }

    let out = '';
    let droppedHead = 0;
    const push = (c) => {
      out += c;
      if (out.length > OUT_BUFFER_CAP) {
        droppedHead += out.length - OUT_BUFFER_CAP;
        out = out.slice(-OUT_BUFFER_CAP);
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const escaped = escapesWorkspace(command, cwd);

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);

    let settled = false;
    const finish = (head) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach from streams an orphan may still be writing to.
      child.stdout.destroy(); child.stderr.destroy();
      const note = droppedHead
        ? `…[${droppedHead} chars dropped from the head — the buffer is capped and the tail is kept because errors land there]…\n`
        : '';
      // Not a block: the observed failure was carelessness, not malice, and a
      // warning the model reads is worth more than a guard it can trivially evade.
      const warn = escaped
        ? `\nWARNING: this command left the workspace (\`cd ${escaped}\`). Everything outside the workspace root is out of scope — `
          + `work relative to the root instead, and remember the working directory resets on every call.`
        : '';
      resolve(`${head}${warn}\n${note}${clipOutput(out)}`);
    };

    // 'exit' fires when the process dies. 'close' waits for every inherited
    // stdio pipe to drain — and a grandchild that outlives the kill holds those
    // pipes open. Measured with a surviving grandchild: exit at 4.0s, close at
    // 25.1s; with a dev server, close never fires at all and the tool call
    // parks forever, past its own timeout. Resolve on exit.
    child.on('exit', (code, signal) => finish(
      timedOut || signal
        ? `TIMED OUT after ${timeoutMs / 1000}s (killed with ${signal ?? 'SIGTERM'}, whole process tree). `
          + `A server or watcher started in the foreground never exits — run it in the background or use a one-shot build instead.`
        : `exit ${code}`
    ));
    child.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); resolve(`ERROR: ${err}`); } });
  });
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


// The environment block every session opens with. Claude Code and Codex both
// state the platform, the shell and the working directory outright rather than
// letting the model infer them; a model that has to guess its shell is being
// scored on a coin flip. Kept short — it is re-sent every single turn.
export function environmentPrompt(workspace) {
  const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  return [
    '## Environment',
    '',
    `- **Platform:** ${os} (${process.platform})`,
    `- **Workspace root:** \`${workspace}\`  — every path you pass to a file tool is relative to this, and paths outside it are rejected.`,
    `- **run_command shell:** ${SHELL_NAME}${SHELL_NAME === 'git-bash' ? ' — POSIX sh, *not* cmd.exe or PowerShell' : ''}. ${SHELL_SYNTAX_HINT}`,
    '- **Working directory does not persist** between commands. Each one starts at the workspace root.',
  ].join("\n");
}

// Full system prompt for a session: identity + method + project rules + role,
// then this workspace's accumulated memory, then its skill list.
export function systemFor(preset, workspace, stateDir, useIdentity = identityDefault()) {
  const p = PRESETS[preset] ?? PRESETS['coding-agent'];
  const mem = stateDir ? memoryPrompt(stateDir, workspace) : '';
  return composeSystem(`${environmentPrompt(workspace)}

---

${p.role}`, workspace, useIdentity)
    + (mem ? `

---

${mem}` : '')
    + skillPrompt(workspace);
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
  constructor({ id, lm, mcp, model, workspace, preset, mode, broadcast, onDirty, stateDir, identity }) {
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
    this.stateDir = stateDir ?? null;   // memory + archives live here, not in the workspace
    this.createdAt = Date.now();
    // Per session, because it is a property of the comparison, not of the box:
    // an identity file is part of the prompt, so two models under different
    // identities are two prompts. Benchmark sessions turn it off; the same
    // server can keep an exploratory session with it on.
    this.identity = identity ?? identityDefault();
    this.messages = [{ role: 'system', content: systemFor(preset, workspace, this.stateDir, this.identity) }];
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
    this.keepRecentHops = 6;      // tool-call hops kept verbatim when folding mid-turn
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
      maxOutputTokens: MAX_OUTPUT_TOKENS, maxAutoContinue: MAX_AUTO_CONTINUE,
      contextWindow: this.contextWindow,
      identityOn: this.identity,
      identity: loadIdentity(this.identity).sources,   // which SOUL/USER files this run used
    };
  }

  // Machine-generated configuration block for a benchmark writeup. Every field
  // here was previously copied by hand out of the UI, and hand-copying already
  // put three wrong model keys into run records — two of which would have
  // silently run the same model twice. Emit the numbers from the session itself.
  async report() {
    const n = (kind, pred = () => true) => this.history.filter(h => h.kind === kind && pred(h)).length;
    const compactions = this.history.filter(h => h.kind === 'compacted');
    const tools = this.history.filter(h => h.kind === 'tool');
    const byTool = new Map();
    for (const t of tools) byTool.set(t.tool, (byTool.get(t.tool) ?? 0) + 1);
    const ceilingBail = this.history.find(h => h.kind === 'bail' && h.reason === 'output_ceiling');
    const hopBail = this.history.find(h => h.kind === 'bail' && h.reason === 'max_hops');
    const mems = this.history.filter(h => h.kind === 'memory');

    // Loaded context is the most important pinned value in a benchmark record,
    // so "unknown" is not an acceptable answer. Prefer the value cached during
    // the run; otherwise read it now and SAY it was read now — a session
    // restored after a restart may describe a model that has since been
    // reloaded at a different context length.
    let ctx = this.contextWindow;                       // recorded during the run
    let ctxCell;
    if (ctx) {
      ctxCell = `**${ctx.toLocaleString()}** _(recorded during the run)_`;
    } else {
      let m = null;
      try { m = (await this.lm.models()).find(x => x.key === this.model) ?? null; } catch { /* LM Studio down */ }
      if (m?.loadedContextLength) {
        ctx = m.loadedContextLength;
        ctxCell = `**${ctx.toLocaleString()}** _(read now, not during the run — confirm the model was not reloaded since)_`;
      } else if (m) {
        // The advertised max is NOT the run's window. Printing it here as if it
        // were is the misdiagnosis already recorded against this project, so
        // report the absence instead of a plausible wrong number.
        ctxCell = `⚠️ **unknown** — the session never compacted and \`${this.model}\` is **not loaded now**. `
          + `Its advertised max is ${(m.maxContextLength ?? 0).toLocaleString()}, which is *not* the window this run used. `
          + `Load it at the pinned context and regenerate, or leave this blank.`;
      } else {
        ctxCell = '⚠️ **unknown** — LM Studio did not return this model.';
      }
    }

    // Identity is part of the prompt. Comparing models under different
    // identities compares prompts, not models, so a benchmark run is supposed
    // to set EMBER_IDENTITY=off. Surface it here rather than leaving it to be
    // noticed later in a table of file paths.
    const idSources = loadIdentity(this.identity).sources;
    // Enabled but with no file on disk injects nothing, so report what actually
    // reached the prompt rather than what was requested.
    const idOn = this.identity && Object.values(idSources).some(v => v && v !== 'off');

    const rows = [
      ['Session', `\`${this.id}\``],
      ['Model / LM Studio key', `\`${this.model}\``],
      ['Harness', 'EmberOS Workbench (local)'],
      ['Workspace', `\`${this.workspace}\``],
      ['Preset / approval mode', `${this.preset} / ${this.mode}`],
      ['Shell', `${SHELL_NAME} (\`${SHELL_PATH}\`)`],
      ['Loaded context length', ctxCell],
      ['Compaction threshold', ctx ? `${Math.round(ctx * this.compactRatio).toLocaleString()} tokens (${this.compactRatio} × window)` : '—'],
      ['Max output tokens / response', MAX_OUTPUT_TOKENS.toLocaleString()],
      ['Auto-continues allowed', String(MAX_AUTO_CONTINUE)],
      ['Max tool hops', String(MAX_HOPS)],
      ['Command timeout', `${CMD_TIMEOUT_MS / 1000}s`],
      ['**Identity layer**', idOn
        ? `⚠️ **ON** — ${Object.entries(idSources).filter(([, v]) => v && v !== 'off').map(([k, v]) => `${k}: \`${v}\``).join(' · ')}`
        : this.identity ? 'on, but no SOUL/USER file was found — nothing was injected'
        : 'off — correct for a comparison run'],
      ['Auto-compact', this.autoCompact ? 'on' : 'off'],
      ['Started', new Date(this.createdAt).toISOString()],
    ];

    const outcome = [
      ['Model turns', String(this.stats.turns)],
      ['Tool hops', String(tools.length)],
      ['Prompt tokens processed (cumulative)', this.stats.in.toLocaleString()],
      ['Completion tokens generated', this.stats.out.toLocaleString()],
      ['Last measured tok/s', String(this.stats.tps)],
      ['Peak prompt size', `${this.lastPromptTokens.toLocaleString()} tokens (most recent turn)`],
      ['Compactions', String(compactions.length)],
      ['**Auto-continues used**', `${n('autocontinue')}${ceilingBail ? ' — **hit the ceiling bail**' : ''}`],
      ['**Truncated segments**', String(n('assistant', h => h.truncated))],
      ['Approvals denied', String(n('approval', h => h.decision === 'deny'))],
      ['Plan-mode blocks', String(n('approval', h => h.decision === 'plan-blocked'))],
      ['**Harness bail**', hopBail ? `**yes — hop ceiling (${MAX_HOPS})**, do not score axis 8`
        : ceilingBail ? '**yes — output ceiling**, reply incomplete' : 'no'],
    ];

    const table = (r) => ['| Field | Value |', '|---|---|', ...r.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');

    return [
      `# RUN — ${this.model}`,
      '',
      `_Generated from session \`${this.id}\` on ${new Date().toISOString()}. Configuration is read from the running harness, not transcribed._`,
      '',
      ...(idOn ? [
        '> ⚠️ **Parity warning: the identity layer was ON for this run.** SOUL/USER are part of the prompt,',
        '> so a run carrying them is not comparable to one without. Set `EMBER_IDENTITY=off` for roster runs,',
        '> or state here that every model in the comparison ran with the same identity files.',
        '',
      ] : []),
      '## Configuration',
      '',
      table(rows),
      '',
      '## Outcome',
      '',
      table(outcome),
      '',
      '## Tool usage',
      '',
      byTool.size
        ? ['| Tool | Calls |', '|---|---|', ...[...byTool.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `| \`${t}\` | ${c} |`)].join('\n')
        : '_(no tool calls)_',
      '',
      '## Compaction log',
      '',
      compactions.length
        ? ['| # | At turn | Tokens before | Tokens after | Turns folded | Window | Summary chars |', '|---|---|---|---|---|---|---|',
           ...compactions.map((c, i) => `| ${i + 1} | ${c.atTurn ?? '—'} | ${c.before ?? '—'} | ${c.after ?? '—'} | ${c.folded ?? '—'} | ${c.window ?? '—'} | ${c.summaryChars ?? '—'} |`)].join('\n')
        : '_(none — the run stayed inside the window)_',
      '',
      '## Recorded by the model',
      '',
      mems.length ? mems.map(m => `- **${m.memKind}:** ${m.text}`).join('\n') : '_(nothing recorded)_',
      '',
      '## Scoring notes',
      '',
      '- [ ] Did it run a build/test at all?',
      '- [ ] Did it **re-run** verification after repairing? (one build + one fix + stop is axis 8 = 3, not 5)',
      '- [ ] Files written that the plan did not call for?',
      '',
    ].join('\n');
  }

  static fromJSON(data, deps) {
    const s = new AgentSession({ ...deps, id: data.id, model: data.model, workspace: data.workspace, preset: data.preset, mode: data.mode, identity: data.identityOn });
    s.createdAt = data.createdAt ?? Date.now();
    s.messages = data.messages ?? s.messages;
    s.history = data.history ?? [];
    s.stats = { tps: 0, in: 0, out: 0, turns: 0, ...(data.stats ?? {}) };
    if (s.stats.tokens != null) { s.stats.out ||= s.stats.tokens; delete s.stats.tokens; } // pre-in/out sessions
    s.allowlist = new Set(data.allowlist ?? []);
    s.mcpServers = data.mcpServers ?? [];
    s.autoCompact = data.autoCompact ?? true;
    s.lastPromptTokens = data.lastPromptTokens ?? 0;
    // Restored so a report written after a restart quotes the window the run
    // actually used, not whatever is loaded now.
    s.contextWindow = data.contextWindow ?? null;
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
      // Text already emitted in segments the output ceiling cut short. The API
      // return value carries the whole reply; the UI is fed segment by segment.
      let carry = '';
      let autoContinues = 0;
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        // Between hops, not just between user messages. A single implementation
        // turn can run 20+ hops, each re-sending the whole conversation; checking
        // only at send() meant nothing watched the window while it grew.
        if (this.autoCompact && hop > 0) await this.#maybeCompact();
        const started = Date.now();
        const { content, reasoning, toolCalls, approxTokens, promptTokens, serverTps, finishReason } = await this.lm.chatStream({
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

        // A generation that hit the token ceiling is truncated, not finished.
        // Saying so is the difference between "the model stopped here" and
        // "the harness stopped it" — the same distinction the hop-ceiling bail
        // draws, and just as invisible if left unreported. Any tool calls in a
        // truncated turn are dropped: their argument JSON is cut mid-string and
        // cannot be parsed, so there is nothing safe to execute.
        if (finishReason === 'length') {
          this.messages.push({ role: 'assistant', content: stripThink(content) || '[no output before the ceiling]' });
          this.#record({ kind: 'assistant', text: content, truncated: true });
          carry += content;
          if (autoContinues < MAX_AUTO_CONTINUE) {
            autoContinues++;
            this.messages.push({ role: 'user', content:
              'Your previous message hit the output ceiling and was cut off mid-sentence. '
              + 'Continue from exactly where it stopped — do not restart, do not re-summarize, '
              + 'and do not repeat text you already emitted. If you were mid-way through a tool call, issue it again in full.' });
            this.#record({ kind: 'autocontinue', n: autoContinues, max: MAX_AUTO_CONTINUE, ceiling: MAX_OUTPUT_TOKENS });
            this.broadcast({ type: 'agent_tool', session: this.id, tool: 'auto-continue',
              args: `output ceiling hit (${MAX_OUTPUT_TOKENS} tokens) — continuing ${autoContinues}/${MAX_AUTO_CONTINUE}` });
            continue;
          }
          const note = `

[truncated at the ${MAX_OUTPUT_TOKENS}-token output ceiling ${MAX_AUTO_CONTINUE + 1} times in a row — stopping. This reply is incomplete. Send "continue", raise EMBER_MAX_TOKENS, or raise EMBER_MAX_AUTO_CONTINUE.]`;
          this.#record({ kind: 'bail', reason: 'output_ceiling', autoContinues, text: note.trim() });
          this.broadcast({ type: 'agent_done', session: this.id, text: content + note });
          return carry + note;
        }

        if (!toolCalls.length) {
          this.messages.push({ role: 'assistant', content: stripThink(content) });
          this.#record({ kind: 'assistant', text: content });
          // Broadcast only the final segment: the UI overwrites the live bubble
          // with this text, and earlier segments already rendered into their own
          // bubbles when the auto-continue marker closed the stream.
          this.broadcast({ type: 'agent_done', session: this.id, text: content });
          return carry + content;
        }

        // Record the assistant turn (content + tool calls), then execute each call.
        this.messages.push({
          role: 'assistant', content: stripThink(content) || null,
          tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })),
        });
        for (const tc of toolCalls) {
          const result = await this.#execute(tc);
          this.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          this.#evictWritePayload(tc, result);
        }
      }
      // Recorded, not just broadcast: hop exhaustion is a HARNESS limit, and a
      // run scored later must be able to tell it apart from the model stopping
      // on its own.
      const bail = `Stopped after ${MAX_HOPS} tool hops (harness limit, not a model decision) — the turn was cut off mid-task. Raise EMBER_MAX_HOPS or split the task.`;
      this.#record({ kind: 'bail', reason: 'max_hops', hops: MAX_HOPS, text: bail });
      this.broadcast({ type: 'agent_done', session: this.id, text: bail });
      return carry + bail;
    } finally {
      this.busy = false;
      this.onDirty(this);
    }
  }

  // Where to fold. Two regimes, because the old one covered only half the cases:
  //
  //   Between turns — cut on a user-message boundary, keeping the last
  //   `keepRecentTurns` requests verbatim. Unchanged behavior.
  //
  //   Mid-turn — a long implementation turn contains ONE user message, so the
  //   user-boundary rule found nothing to fold and returned false while the
  //   context ran away. Fall back to hop boundaries: an assistant message that
  //   opens a tool_calls block. Cutting immediately before one keeps that block
  //   with its tool results, so a tool_call/tool pair is still never split.
  #cutPoint() {
    const userIdxs = this.messages.map((m, i) => (i > 0 && m.role === 'user' ? i : -1)).filter(i => i > 0);
    if (userIdxs.length > this.keepRecentTurns) return userIdxs[userIdxs.length - this.keepRecentTurns];

    const hopIdxs = this.messages
      .map((m, i) => (i > 0 && m.role === 'assistant' && m.tool_calls?.length ? i : -1))
      .filter(i => i > 0);
    if (hopIdxs.length <= this.keepRecentHops) return 0;   // too short to be worth folding
    return hopIdxs[hopIdxs.length - this.keepRecentHops];
  }

  // A write_file payload is the entire file, and it sits in the assistant
  // message's tool_call arguments for the rest of the session — even though the
  // file is on disk the instant the call succeeds. Measured on a real run: 22
  // calls, 78,592 chars, 68% of the whole context. That is what pushed a 22-hop
  // implementation turn past a 32k window.
  //
  // Once the write succeeds the argument is pure redundancy: replace it with a
  // stub that says where the content went. Failed calls keep their payload —
  // the model needs to see what it tried in order to fix it.
  #evictWritePayload(tc, result) {
    if (!['write_file', 'edit_file'].includes(tc.name)) return;
    if (typeof result !== 'string' || /^(ERROR|DENIED|BLOCKED)/.test(result)) return;
    const msg = this.messages.find(m => m.tool_calls?.some(t => t.id === tc.id));
    if (!msg) return;
    const call = msg.tool_calls.find(t => t.id === tc.id);
    let p = null;
    try { p = JSON.parse(call.function.arguments || '{}').path ?? null; } catch { /* keep null */ }
    const before = call.function.arguments?.length ?? 0;
    call.function.arguments = JSON.stringify({
      path: p,
      _elided: `content written to disk and removed from history (${before} chars); use read_file to see it`,
    });
  }

  // Loaded context window for this session's model (cached). null if unknown.
  async #ctxWindow() {
    if (this.contextWindow) return this.contextWindow;
    try {
      const m = (await this.lm.models()).find(x => x.key === this.model);
      // Cache only a REAL loaded window. The advertised max is a different
      // number, and caching it would freeze a wrong value into the session
      // permanently — including into any run report generated from it. Fall
      // back to the max for compaction sizing without recording it.
      if (m?.loadedContextLength) { this.contextWindow = m.loadedContextLength; return this.contextWindow; }
      return m?.contextLength ?? null;
    } catch { return null; /* compaction just won't auto-fire */ }
  }

  // Auto-compaction gate: fold old turns if the last prompt exceeded the ratio
  // of the loaded window. No-op when the window is unknown or history is short.
  async #maybeCompact() {
    if (!this.lastPromptTokens) return;
    const win = await this.#ctxWindow();
    if (win && this.lastPromptTokens > this.compactRatio * win) {
      try { await this.compact('auto'); }
      catch (err) {
        // A broadcast is a transient UI notice: nothing that reads the session
        // afterwards can see it. An auto-compaction that fails silently leaves
        // the run reporting "Compactions: 0" while the context was in fact
        // folded, which is exactly the attribution the forensic record exists
        // to support — so record the failure the same way the success is.
        const text = `Auto-compaction FAILED: ${String(err.message ?? err).slice(0, 300)}`;
        this.#record({ kind: 'compact_failed', reason: 'auto', text, atTurn: this.stats.turns, before: this.lastPromptTokens });
        this.broadcast({ type: 'agent_tool', session: this.id, tool: 'compact', args: `failed: ${String(err.message ?? err).slice(0, 120)}` });
        console.error(`agent: auto-compaction failed for ${this.id}: ${err?.stack ?? err}`);
      }
    }
  }

  // Summarize the older portion of the conversation into one context note,
  // keeping the system prompt and the most recent `keepRecentTurns` user turns
  // verbatim. The cut lands on a user-message boundary, so an assistant
  // tool_calls block and its tool results are never split. Touches only the
  // model-facing `messages`; the UI transcript (`history`) is left whole.
  async compact(reason = 'manual') {
    if (this.busy && reason === 'manual') throw new Error('Cannot compact mid-turn.');
    const cut = this.#cutPoint();
    if (cut <= 1) return false;

    // How many whole user turns this fold swallows. Must be measured BEFORE the
    // fold, because #cutPoint() also cuts on HOP boundaries when a single turn
    // is what ran the context hot — so a fold can legitimately swallow zero user
    // turns, and the expression this replaces assumed it never could.
    const foldedUsers = this.messages.slice(1, cut).filter(m => m.role === 'user').length;

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
      maxTokens: SUMMARY_MAX_TOKENS,
      temperature: 0.2,
      salvage: false,   // '' rather than a fragment of unfinished reasoning
    });

    // Never trade real context for a bad note. A compaction is irreversible for
    // the model — the folded turns are gone from its view — so a summariser that
    // returned nothing usable must abort the fold, not complete it. The turn may
    // then overflow the window, which is a loud, diagnosable error; silent
    // amnesia is neither.
    if (summary.trim().length < MIN_SUMMARY_CHARS) {
      const text = `Compaction ABORTED: the summariser returned ${summary.trim().length} chars `
        + `(minimum ${MIN_SUMMARY_CHARS}). Context left intact rather than replaced with an unusable note. `
        + `On a reasoning model this means the token budget went entirely to thinking — raise summaryMaxTokens.`;
      this.#record({ kind: 'compact_failed', reason, text, atTurn: this.stats.turns, before });
      this.broadcast({ type: 'agent_tool', session: this.id, tool: 'compact', args: 'aborted: summary unusable' });
      console.error(`agent: ${text} (session ${this.id})`);
      this.onDirty(this);
      return false;
    }

    // Merge the summary into the first kept turn when that turn is a user
    // message — keeps clean role alternation (no back-to-back user messages,
    // which some local chat templates dislike). When the cut lands mid-turn the
    // first kept message is an assistant tool_calls block, which must not be
    // rewritten: the summary goes in as its own user message ahead of it.
    const tail = this.messages.slice(cut);
    if (tail[0].role === 'user') {
      const firstText = typeof tail[0].content === 'string' ? tail[0].content : JSON.stringify(tail[0].content);
      tail[0] = { role: 'user', content: `[Earlier turns were compacted to save context. Summary of the session so far:]\n\n${summary.trim()}\n\n[End of summary — current request:]\n${firstText}` };
    } else {
      tail.unshift({ role: 'user', content: `[Earlier turns were compacted to save context. Summary of the work so far:]\n\n${summary.trim()}\n\n[End of summary — continue from here. Files already written are on disk; use read_file rather than assuming their contents.]` });
    }
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
      folded: foldedUsers,
      before, after,                              // model-visible tokens; `after` is an estimate
      window: this.contextWindow ?? null,
      ratio: this.compactRatio,
      keptTurns: this.keepRecentTurns,
      atTurn: this.stats.turns,
      summaryChars: summary.length,
      summary: summary.trim(),
    });
    this.broadcast({ type: 'agent_compacted', session: this.id, reason, before, after });
    this.#writeSessionLog({ reason, before, after, folded: foldedUsers, summary: summary.trim() });
    this.onDirty(this);
    return true;
  }

  // A compaction is the moment history stops being recoverable from the model's
  // context, so it is exactly when a durable log is worth writing. The handoff
  // note is the log's body — it is already a summary written for a successor.
  #writeSessionLog({ reason, before, after, folded, summary }) {
    if (!this.stateDir) return;
    try {
      const dir = path.join(this.stateDir, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const now = new Date();
      const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const mems = this.history.filter(h => h.kind === 'memory');
      const body = [
        `# Session log — ${this.id}`,
        '',
        `- **When:** ${now.toISOString()}`,
        `- **Trigger:** compaction (${reason})`,
        `- **Model:** ${this.model}`,
        `- **Workspace:** ${this.workspace}`,
        `- **Preset / mode:** ${this.preset} / ${this.mode}`,
        `- **Context:** ~${before} → ~${after} tokens · ${folded} user turn(s) folded`,
        `- **Turns so far:** ${this.stats.turns} · in ${this.stats.in} / out ${this.stats.out}`,
        '',
        '## Handoff summary',
        '',
        summary || '_(empty)_',
        '',
        '## Recorded this session',
        '',
        mems.length ? mems.map(m => `- **${m.memKind}:** ${m.text}`).join('\n') : '_(nothing recorded — use the `remember` tool)_',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(dir, `${stamp}-${this.id}.md`), body, 'utf8');
      this.#record({ kind: 'session_log', file: `logs/${stamp}-${this.id}.md` });
    } catch (err) {
      // A log failure must never take down the turn that triggered it.
      console.error(`agent: session log failed for ${this.id}: ${err}`);
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
        case 'remember': {
          const r = addMemory(this.stateDir, this.workspace, {
            kind: args.kind, text: args.text, session: this.id,
          });
          if (!r.ok) return `ERROR: ${r.error}`;
          this.#record({ kind: 'memory', memKind: String(args.kind).toLowerCase(), text: String(args.text).trim() });
          return r.duplicate
            ? 'Already recorded — no duplicate written.'
            : `Recorded as a ${String(args.kind).toLowerCase()} for this workspace (${r.count} total).`;
        }
        case 'web_search': return await webSearch(String(args.query ?? ''));
        case 'web_fetch':  return await webFetch(String(args.url ?? ''));
        case 'run_command': return await runCommand(String(args.command ?? ''), this.workspace);
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
  #deps() { return { lm: this.lm, mcp: this.mcp, broadcast: this.broadcast, stateDir: this.stateDir, onDirty: (s) => this.#persist(s) }; }
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

  create({ model, workspace, preset, mode, identity }) {
    if (!this.workspaces.includes(workspace)) throw new Error('Workspace not in the configured allowlist.');
    const id = randomUUID().slice(0, 8);
    const s = new AgentSession({ id, model, workspace, preset, mode, identity, ...this.#deps() });
    this.sessions.set(id, s);
    this.#persist(s);
    return s;
  }
  get(id) { return this.sessions.get(id) ?? null; }

  // Clear ≠ delete. The session survives — same id, model, workspace, preset,
  // allowlist, MCP servers — but its conversation is archived and reset, so the
  // next turn starts on a clean context without losing the setup around it.
  // The archive is the point: "start over" should never mean "lose the trail".
  clear(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.busy) throw new Error('Agent is mid-turn; wait for it to finish before clearing.');
    if (s.pending) s.resolveApproval('deny');

    let archive = null;
    if (this.stateDir && (s.messages.length > 1 || s.history.length)) {
      try {
        const dir = path.join(this.stateDir, 'archive');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        archive = `archive/${stamp}-${s.id}.json`;
        fs.writeFileSync(path.join(this.stateDir, archive),
          JSON.stringify({ archivedAt: new Date().toISOString(), ...s.toJSON() }, null, 2), 'utf8');
      } catch (err) {
        // Refuse to clear if the archive failed — silently discarding the
        // transcript is the one outcome this method exists to prevent.
        throw new Error(`Archive failed, session left intact: ${err.message ?? err}`);
      }
    }

    const turns = s.stats.turns;
    s.messages = [{ role: 'system', content: systemFor(s.preset, s.workspace, s.stateDir, s.identity) }];
    s.history = [];
    s.stats = { tps: 0, in: 0, out: 0, turns: 0 };
    s.lastPromptTokens = 0;
    this.#persist(s);
    return { cleared: true, archive, turns };
  }

  // Archived transcripts, newest first — so a cleared session can be found again.
  archives(sessionId = null) {
    if (!this.stateDir) return [];
    const dir = path.join(this.stateDir, 'archive');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(n => n.endsWith('.json'))
      .filter(n => !sessionId || n.includes(`-${sessionId}.json`))
      .sort().reverse()
      .map(name => {
        const st = fs.statSync(path.join(dir, name));
        return { name, rel: `archive/${name}`, bytes: st.size, at: st.mtime.toISOString() };
      });
  }

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
    s.messages[0] = { role: 'system', content: systemFor(preset, s.workspace, s.stateDir, s.identity) };
    this.#persist(s);
    return preset;
  }

  // Identity on/off for one session. Rewrites the system message in place, so
  // it takes effect on the next turn without clearing the conversation — but a
  // mid-run flip means the transcript was produced under two different prompts.
  // Refuse while the agent is mid-turn; warn about the rest in the UI.
  setIdentity(id, on) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.busy) throw new Error('Agent is mid-turn; wait for it to finish before changing the identity layer.');
    s.identity = !!on;
    s.messages[0] = { role: 'system', content: systemFor(s.preset, s.workspace, s.stateDir, s.identity) };
    this.#persist(s);
    return { identity: s.identity, sources: loadIdentity(s.identity).sources, turnsSoFar: s.stats.turns };
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
      autoCompact: s.autoCompact, lastPromptTokens: s.lastPromptTokens, identity: s.identity,
    })).sort((a, b) => b.createdAt - a.createdAt);
  }
}
