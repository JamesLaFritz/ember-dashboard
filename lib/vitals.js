// vitals.js — the left-rail numbers, all parsed from vault markdown.
// No external APIs here by design: calendar/news flow through skills that
// write reports into the vault first.
//
// Folder conventions (Wiki/, Raw/, Daily/, System/Memory/) are the vault
// contract and stay fixed. What is PERSONAL — which project the HUD tracks,
// where articles live, which report sections to surface — comes from
// config.json's `vitals` block so this file works for any operator.

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (mtime) => mtime ? Math.floor((Date.now() - mtime) / DAY) : null;

const DEFAULTS = {
  project: null,                       // no project configured → the card degrades to "—"
  articles: { folder: 'Projects/Articles', monthlyTarget: 2 },
  newsSections: ['AI', 'Unity', 'Unreal'],
};

export function collectVitals(vault, cfg = {}) {
  const v = { ...DEFAULTS, ...(cfg.vitals ?? {}) };
  return {
    project: project(vault, v.project),
    vault: vaultHealth(vault),
    writing: writing(vault, v.articles ?? DEFAULTS.articles),
    daily: daily(vault),
    news: news(vault, v.newsSections ?? DEFAULTS.newsSections),
    generatedAt: new Date().toISOString(),
  };
}

// The tracked project. `p` is { label, note, brief, devlog } — every field
// optional, so a partial config still renders what it can.
function project(vault, p) {
  if (!p) return { configured: false, label: null, brief: null, openLoops: 0, daysSinceDevlog: null, uri: null };
  const brief = p.brief ? vault.checkboxStats(p.brief) : null;
  const lastDevlog = p.devlog ? vault.newest(p.devlog) : null;
  const note = p.note ? (vault.read(p.note) ?? '') : '';
  const openLoops = (vault.section(note, 'Open Loops')?.match(/^\s*- \[ \]/gm) ?? []).length;
  return {
    configured: true,
    label: p.label ?? null,
    brief,
    openLoops,
    daysSinceDevlog: lastDevlog ? daysAgo(lastDevlog.mtime) : null,
    uri: p.note ? vault.obsidianUri(p.note) : null,
  };
}

function vaultHealth(vault) {
  const lastSession = vault.newest('System/Memory/Sessions');
  const learnings = vault.read('System/Memory/LEARNINGS.md');
  // "Unprocessed" = loose md sitting at Raw/ root awaiting the ingest skill.
  const rawLoose = vault.listMarkdown('Raw').filter(f => f.name !== 'Raw Index').length;
  return {
    wikiPages: vault.countMarkdown('Wiki'),
    rawLoose,
    lastSessionAgeDays: lastSession ? daysAgo(lastSession.mtime) : null,
    lastSessionName: lastSession?.name ?? null,
    learningsLines: learnings ? learnings.split('\n').length : 0,
  };
}

function writing(vault, a) {
  const now = new Date();
  const thisMonth = vault.listMarkdown(a.folder, { recurse: true })
    .filter(f => {
      const d = new Date(f.mtime);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;
  // Parked ideas: unchecked Next-Action boxes across the wikis that mention articles.
  let ideas = 0;
  for (const page of vault.listMarkdown('Wiki', { recurse: true })) {
    const next = vault.section(vault.read(page.rel), 'Next Actions');
    if (!next) continue;
    ideas += (next.match(/^\s*- \[ \].*article/gim) ?? []).length;
  }
  return { articlesThisMonth: thisMonth, target: a.monthlyTarget ?? 2, parkedIdeas: ideas };
}

function daily(vault) {
  const today = vault.constructor.today();
  const rel = `Daily/${today}.md`;
  const text = vault.read(rel);
  if (!text) return { exists: false, rel };
  const lines = (s) => (s ?? '').split('\n').map(l => l.trim()).filter(l => l.startsWith('-')).map(l => l.replace(/^-+\s*(\[.\]\s*)?/, ''));
  return {
    exists: true,
    rel,
    uri: vault.obsidianUri(rel),
    schedule: lines(vault.section(text, 'Schedule')).slice(0, 5),
    directives: lines(vault.section(text, 'Top 3')).slice(0, 3),
  };
}

// Sections come from config so a different trend-watch report shape still
// renders. Returned as an array of { heading, items } rather than fixed keys —
// the UI iterates instead of naming AI/Unity/Unreal.
function news(vault, sections) {
  const latest = vault.listMarkdown('System/Memory/Reports')
    .find(f => /trends/i.test(f.name));
  if (!latest) return { exists: false, sections: [] };
  const text = vault.read(latest.rel);
  const pick = (h) => (vault.section(text, h) ?? '').split('\n')
    .filter(l => l.trim().startsWith('-')).slice(0, 3)
    .map(l => l.replace(/^-+\s*/, '').replace(/\[(.+?)\]\(.+?\)/g, '$1'));
  return {
    exists: true,
    rel: latest.rel,
    name: latest.name,
    uri: vault.obsidianUri(latest.rel),
    sections: sections.map(h => ({ heading: h, items: pick(h) })).filter(s => s.items.length),
  };
}
