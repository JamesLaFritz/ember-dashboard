// vitals.js — James's left-rail numbers, all parsed from vault markdown.
// No external APIs here by design: calendar/news flow through skills that
// write reports into the vault first.

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (mtime) => mtime ? Math.floor((Date.now() - mtime) / DAY) : null;

export function collectVitals(vault) {
  return {
    aralon: aralon(vault),
    vault: vaultHealth(vault),
    writing: writing(vault),
    daily: daily(vault),
    news: news(vault),
    generatedAt: new Date().toISOString(),
  };
}

function aralon(vault) {
  const brief = vault.checkboxStats('Projects/Echoes of Aralon/project-setup/BRIEF.md');
  const lastDevlog = vault.newest('Projects/Echoes of Aralon/Devlog');
  const note = vault.read('Projects/Echoes of Aralon/Echoes of Aralon.md') ?? '';
  const openLoops = (vault.section(note, 'Open Loops')?.match(/^\s*- \[ \]/gm) ?? []).length;
  return {
    brief,
    openLoops,
    daysSinceDevlog: lastDevlog ? daysAgo(lastDevlog.mtime) : null,
    uri: vault.obsidianUri('Projects/Echoes of Aralon/Echoes of Aralon.md'),
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

function writing(vault) {
  const now = new Date();
  const thisMonth = vault.listMarkdown('Projects/Articles', { recurse: true })
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
  return { articlesThisMonth: thisMonth, target: 2, parkedIdeas: ideas };
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

function news(vault) {
  const latest = vault.listMarkdown('System/Memory/Reports')
    .find(f => /trends/i.test(f.name));
  if (!latest) return { exists: false };
  const text = vault.read(latest.rel);
  const pick = (h) => (vault.section(text, h) ?? '').split('\n')
    .filter(l => l.trim().startsWith('-')).slice(0, 3)
    .map(l => l.replace(/^-+\s*/, '').replace(/\[(.+?)\]\(.+?\)/g, '$1'));
  return {
    exists: true,
    rel: latest.rel,
    name: latest.name,
    uri: vault.obsidianUri(latest.rel),
    ai: pick('AI'), unity: pick('Unity'), unreal: pick('Unreal'),
  };
}
