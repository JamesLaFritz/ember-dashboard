// router.js — the Jarvis brain, per the Chase AI architecture: regex first
// (free, instant), then a chosen responder for anything murky.
// Responders: local LM Studio (with read-only vault tools + skill runs),
// or headless Claude (haiku/sonnet/opus — full vault skills, costs credits).
// "auto" picks: local for lookups/questions, Claude Sonnet for generation.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SKILL_ALIASES = {
  'plan today': 'plan-today', 'plan my day': 'plan-today', 'morning brief': 'plan-today',
  'trend watch': 'trend-watch', 'run trends': 'trend-watch',
  'vault health': 'vault-health', 'check the vault': 'vault-health',
  'weekly review': 'weekly-review',
  'session log': 'session-log', 'log this session': 'session-log', 'wrap up': 'session-log',
  'ingest': 'ingest', 'process the inbox': 'ingest',
  'devlog': 'devlog',
};

// Signals that the request wants real generation/mutation → Claude territory.
const GENERATION_RE = /\b(write|create|generate|draft|build|make|update|plan out|refactor|fix|add|wikify|summari[sz]e .{20,}|report on)\b/i;

const VAULT_TOOLS = [
  { name: 'vault_list', description: 'List markdown files and folders at a vault-relative path (e.g. "Wiki" or "Wiki/Procedural Generation"). Root = "".',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'vault_read', description: 'Read a markdown note by vault-relative path, e.g. "Wiki/index.md" or "Home.md". Returns up to 12000 chars.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'vault_search', description: 'Case-insensitive regex search across vault markdown. Returns up to 40 matching lines as path:line.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, folder: { type: 'string', description: 'optional folder to limit the search' } }, required: ['pattern'] } },
  { name: 'run_skill', description: 'Trigger a vault skill the user asked for (plan-today, ingest, wikify, session-log, weekly-review, vault-health, trend-watch, devlog). Runs async; the HUD shows progress.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, args: { type: 'string' } }, required: ['id'] } },
];

export class Router {
  constructor({ vault, lm, routerModel, skillRunner, vitalsFn, claudeCommand, allowedTools = [], broadcast, skills = [] }) {
    this.vault = vault;
    this.lm = lm;
    this.routerModel = routerModel;
    this.skillRunner = skillRunner;
    this.vitalsFn = vitalsFn;
    this.claudeCommand = claudeCommand ?? 'claude';
    this.allowedTools = allowedTools;
    this.broadcast = broadcast ?? (() => {});
    this.skills = skills;
  }

  // Skill runs triggered outside the deck (regex aliases, the local agent's
  // run_skill tool) still honor whatever model was configured for that skill.
  #modelFor(skillId) { return this.skills.find(s => s.id === skillId)?.model; }

  async handle(text, modelPref = 'auto') {
    const t = text.trim().toLowerCase().replace(/[.!?]+$/, '');

    // 1 — regex intents (deterministic, no tokens burned)
    if (/\b(rundown|briefing|what'?s (going on|happening)( today)?|catch me up)\b/.test(t)) {
      return this.rundown();
    }
    const open = t.match(/^open (.+)$/);
    if (open) return this.openNote(open[1]);
    // Spoken commands rarely match an alias verbatim ("hey ember, run vault
    // health for me please"). Substring-match short, imperative inputs; leave
    // question-shaped text ("how does vault health work?") to the responders.
    const questionShaped = /\b(what|what's|how|why|explain|when|where|who|should|did|does|is there)\b/.test(t);
    for (const [alias, skillId] of Object.entries(SKILL_ALIASES)) {
      if (t === alias || t === `run ${alias}` || t === `run the ${alias}` ||
          (!questionShaped && t.length <= 64 && t.includes(alias))) {
        const id = this.skillRunner.run(skillId, '', this.#modelFor(skillId));
        return { kind: 'skill', skillId, runId: id, reply: `Running ${skillId} now — watch the deck.`, model: 'skill' };
      }
    }

    // 2 — pick a responder
    const responder = this.#pickResponder(text, modelPref);
    if (responder === 'local') return this.localAgentAnswer(text);
    return this.claudeAnswer(text, responder); // haiku | sonnet | opus
  }

  #pickResponder(text, pref) {
    if (pref && pref !== 'auto') return pref;
    // auto: generation-shaped or long/multi-step → sonnet; otherwise local.
    if (GENERATION_RE.test(text) || text.length > 220) return 'sonnet';
    return 'local';
  }

  // ---- responders -------------------------------------------------------

  // Local model with read-only vault tools + skill trigger: Ember can actually
  // look things up (indexes, notes) instead of claiming it cannot.
  async localAgentAnswer(text) {
    const vitals = this.vitalsFn();
    const messages = [
      { role: 'system', content:
`You are Ember, the resident intelligence of James LaFritz's agentic OS (an Obsidian vault called JamesMind).
You HAVE tools: vault_list, vault_read, vault_search, run_skill. Use them — never claim you cannot look something up. Never answer "I can't enumerate/check that" — call a tool instead. If a read errors, vault_list the folder and retry with the right path.
Navigation: Wiki/index.md lists all wikis; each wiki folder has its own index.md; Home.md is the command center; System/Memory holds sessions/decisions.
If the user asks for an action a skill covers (vault health, plan today, ingest, trend watch, wikify, devlog, weekly review, session log), call run_skill for it.
Answer in at most 4 sentences, direct and concrete, no sycophancy.
Snapshot: Aralon BRIEF ${vitals.aralon.brief?.done}/${vitals.aralon.brief?.total}; ${vitals.vault.wikiPages} wiki pages; last session ${vitals.vault.lastSessionName}.` },
      { role: 'user', content: text },
    ];
    const startedSkills = [];
    try {
      for (let hop = 0; hop < 8; hop++) {
        // Streamed to the HUD transcript live over the websocket; the HTTP
        // response still carries the authoritative final reply.
        const { content, toolCalls } = await this.lm.chatStream({
          model: this.routerModel, messages,
          tools: VAULT_TOOLS.map(t => ({ type: 'function', function: t })),
          onDelta: (d) => this.broadcast({ type: 'assistant_delta', text: d }),
        });
        if (!toolCalls.length) {
          return { kind: 'answer', reply: content.trim(), model: 'local', popups: startedSkills };
        }
        messages.push({ role: 'assistant', content: content || null,
          tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })) });
        for (const tc of toolCalls) {
          const result = this.#vaultTool(tc, startedSkills);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
      }
      return { kind: 'answer', reply: 'That took more digging than a quick answer allows — try the workbench for deep work.', model: 'local' };
    } catch (err) {
      return { kind: 'answer', reply: `Local model unavailable (${String(err).slice(0, 120)}). Switch the HUD model to a Claude tier or start LM Studio (lms server start).`, model: 'local' };
    }
  }

  #vaultTool(tc, startedSkills) {
    let args;
    try { args = JSON.parse(tc.args || '{}'); } catch { return 'ERROR: bad tool arguments'; }
    try {
      switch (tc.name) {
        case 'vault_list': {
          const rel = (args.path ?? '').replace(/\.\./g, '');
          const dir = this.vault.abs(rel);
          if (!fs.existsSync(dir)) return `ERROR: no such folder ${rel}`;
          return fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isDirectory() || e.name.endsWith('.md'))
            .map(e => (e.isDirectory() ? 'dir  ' : 'note ') + path.join(rel, e.name).replaceAll('\\', '/'))
            .slice(0, 120).join('\n') || '(empty)';
        }
        case 'vault_read': {
          const text = this.vault.read((args.path ?? '').replace(/\.\./g, ''));
          if (text == null) return `ERROR: not found: ${args.path}`;
          return text.slice(0, 12000);
        }
        case 'vault_search': {
          const re = new RegExp(args.pattern, 'i');
          const hits = [];
          for (const f of this.vault.listMarkdown(args.folder ?? '', { recurse: true })) {
            if (hits.length >= 40) break;
            const lines = (this.vault.read(f.rel) ?? '').split('\n');
            lines.forEach((l, i) => { if (hits.length < 40 && re.test(l)) hits.push(`${f.rel}:${i + 1}: ${l.trim().slice(0, 160)}`); });
          }
          return hits.join('\n') || 'no matches';
        }
        case 'run_skill': {
          const id = String(args.id ?? '').trim();
          const runId = this.skillRunner.run(id, args.args ?? '', this.#modelFor(id));
          startedSkills.push({ title: `${id.toUpperCase()} · QUEUED`, progressRun: runId });
          return `Skill ${id} started (run ${runId}). Tell the user it is running; results will appear as a card.`;
        }
        default: return `ERROR: unknown tool ${tc.name}`;
      }
    } catch (err) { return `ERROR: ${String(err).slice(0, 300)}`; }
  }

  // Headless Claude in the vault: full tool access, full skill library —
  // the "just do it" tier. Costs API-pool credits; only reached when James
  // picked a Claude tier or auto classified the ask as generation.
  claudeAnswer(text, tier) {
    const model = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus' }[tier] ?? 'sonnet';
    const prompt = `${text}\n\n(Answer for the Ember OS HUD: lead with the result, max 6 sentences unless producing a document. If a vault skill fits, invoke it.)`;
    return new Promise((resolve) => {
      // Same non-interactive reality as the skill runner: pre-allow gated
      // tools or Claude silently loses web access and vault writes.
      const child = spawn(this.claudeCommand, ['-p', prompt, '--model', model, '--output-format', 'json',
        '--permission-mode', 'acceptEdits',
        ...(this.allowedTools.length ? ['--allowedTools', this.allowedTools.join(',')] : [])],
        { cwd: this.vault.root, shell: true });
      let out = '';
      child.stdout.on('data', c => out += c);
      child.on('close', () => {
        try {
          const parsed = JSON.parse(out);
          resolve({ kind: 'answer', reply: (parsed.result ?? '').trim() || '(no result)', model: `claude-${model}` });
        } catch {
          resolve({ kind: 'answer', reply: out.trim().slice(0, 1200) || 'Claude returned nothing parseable.', model: `claude-${model}` });
        }
      });
      child.on('error', err => resolve({ kind: 'answer', reply: `Claude spawn failed: ${err}`, model: `claude-${model}` }));
    });
  }

  // ---- intents -----------------------------------------------------------

  async rundown() {
    const vitals = this.vitalsFn();
    const popups = [];
    const pieces = [];

    if (vitals.daily.exists) {
      pieces.push(`Today's plan:\n${this.vault.section(this.vault.read(vitals.daily.rel), 'Top 3') ?? ''}`);
      popups.push({ title: `DAILY · ${vitals.daily.rel.slice(6, 16)}`, rel: vitals.daily.rel, uri: vitals.daily.uri });
    }
    if (vitals.news.exists) {
      pieces.push(`Latest trends report (${vitals.news.name}):\nAI: ${vitals.news.ai.join(' | ')}\nUnity: ${vitals.news.unity.join(' | ')}\nUnreal: ${vitals.news.unreal.join(' | ')}`);
      popups.push({ title: 'TRENDS · AI/UNITY/UNREAL', rel: vitals.news.rel, uri: vitals.news.uri });
    }
    const session = vitals.vault.lastSessionName;
    if (session) pieces.push(`Last session log: ${session} (${vitals.vault.lastSessionAgeDays}d ago).`);
    pieces.push(`Aralon setup brief: ${vitals.aralon.brief?.done ?? 0}/${vitals.aralon.brief?.total ?? 0} done, ${vitals.aralon.openLoops} open loops, ` +
      (vitals.aralon.daysSinceDevlog == null ? 'no devlog yet.' : `last devlog ${vitals.aralon.daysSinceDevlog}d ago.`));
    pieces.push(`Writing: ${vitals.writing.articlesThisMonth}/${vitals.writing.target} articles this month, ${vitals.writing.parkedIdeas} ideas parked.`);

    let reply;
    try {
      reply = await this.lm.complete({
        model: this.routerModel,
        system: 'You are Ember, James LaFritz\'s direct, concise game-dev copilot. Turn the following status notes into a spoken-style rundown of at most 6 sentences. Lead with what matters most for shipping his game Echoes of Aralon. No greetings longer than three words, no bullet points, no sycophancy.',
        user: pieces.join('\n\n'),
        maxTokens: 4096,
      });
    } catch {
      reply = pieces.join(' ');
    }
    return { kind: 'rundown', reply: reply.trim(), popups, model: 'local' };
  }

  openNote(query) {
    const all = this.vault.listMarkdown('', { recurse: true });
    const q = query.toLowerCase();
    const hit = all.find(f => f.name.toLowerCase() === q) ?? all.find(f => f.name.toLowerCase().includes(q));
    if (!hit) return { kind: 'answer', reply: `No note matching "${query}" in the vault.`, model: 'regex' };
    return {
      kind: 'open', reply: `Opening ${hit.name} in Obsidian.`, model: 'regex',
      popups: [{ title: hit.name.toUpperCase(), rel: hit.rel, uri: this.vault.obsidianUri(hit.rel) }],
      uri: this.vault.obsidianUri(hit.rel),
    };
  }
}
