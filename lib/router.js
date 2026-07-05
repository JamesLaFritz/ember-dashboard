// router.js — the Jarvis brain, per the Chase AI architecture: regex first
// (free, instant), then the local LM Studio model for anything murky.
// Headless Claude is reserved for skill runs the user actually triggers.

const SKILL_ALIASES = {
  'plan today': 'plan-today', 'plan my day': 'plan-today', 'morning brief': 'plan-today',
  'trend watch': 'trend-watch', 'trends': 'trend-watch', 'news': 'trend-watch',
  'vault health': 'vault-health', 'check the vault': 'vault-health',
  'weekly review': 'weekly-review',
  'session log': 'session-log', 'log this session': 'session-log', 'wrap up': 'session-log',
  'ingest': 'ingest', 'process the inbox': 'ingest',
  'devlog': 'devlog',
};

export class Router {
  constructor({ vault, lm, routerModel, skillRunner, vitalsFn }) {
    this.vault = vault;
    this.lm = lm;
    this.routerModel = routerModel;
    this.skillRunner = skillRunner;
    this.vitalsFn = vitalsFn;
  }

  async handle(text) {
    const t = text.trim().toLowerCase().replace(/[.!?]+$/, '');

    // 1 — regex intents (deterministic, no tokens burned)
    if (/\b(rundown|briefing|what'?s (going on|happening)( today)?|catch me up)\b/.test(t)) {
      return this.rundown();
    }
    const open = t.match(/^open (.+)$/);
    if (open) return this.openNote(open[1]);
    for (const [alias, skillId] of Object.entries(SKILL_ALIASES)) {
      if (t === alias || t === `run ${alias}` || t === `run the ${alias}`) {
        const id = this.skillRunner.run(skillId);
        return { kind: 'skill', skillId, runId: id, reply: `Running ${skillId} now — watch the deck.` };
      }
    }

    // 2 — local model handles the murky remainder, grounded in vault state
    return this.localAnswer(text);
  }

  // "Give me the rundown" — summarize what the vault already knows.
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
        maxTokens: 400,
      });
    } catch {
      reply = pieces.join(' ');
    }
    return { kind: 'rundown', reply: reply.trim(), popups };
  }

  openNote(query) {
    const all = this.vault.listMarkdown('', { recurse: true });
    const q = query.toLowerCase();
    const hit = all.find(f => f.name.toLowerCase() === q) ?? all.find(f => f.name.toLowerCase().includes(q));
    if (!hit) return { kind: 'answer', reply: `No note matching "${query}" in the vault.` };
    return {
      kind: 'open', reply: `Opening ${hit.name} in Obsidian.`,
      popups: [{ title: hit.name.toUpperCase(), rel: hit.rel, uri: this.vault.obsidianUri(hit.rel) }],
      uri: this.vault.obsidianUri(hit.rel),
    };
  }

  async localAnswer(text) {
    const vitals = this.vitalsFn();
    const context = [
      `Aralon BRIEF ${vitals.aralon.brief?.done}/${vitals.aralon.brief?.total} done; ${vitals.aralon.openLoops} open loops; last devlog ${vitals.aralon.daysSinceDevlog ?? 'never'}d.`,
      `Vault: ${vitals.vault.wikiPages} wiki pages, ${vitals.vault.rawLoose} loose raw items, last session ${vitals.vault.lastSessionName}.`,
      vitals.daily.exists ? `Today's directives: ${vitals.daily.directives.join('; ')}` : 'No daily note yet today.',
    ].join('\n');
    try {
      const reply = await this.lm.complete({
        model: this.routerModel,
        system: 'You are Ember, the resident intelligence of James LaFritz\'s agentic OS. Direct, concrete, game-dev fluent, never sycophantic. Answer in at most 4 sentences. If the request needs a vault skill (plan-today, ingest, wikify, session-log, weekly-review, vault-health, trend-watch, devlog), say which one to run instead of pretending to do it. Current state:\n' + context,
        user: text,
        maxTokens: 300,
      });
      return { kind: 'answer', reply: reply.trim() };
    } catch (err) {
      return { kind: 'answer', reply: `Local model unavailable (${String(err).slice(0, 120)}). Regex intents still work: try "rundown" or a skill name.` };
    }
  }
}
