// memory.js — durable lessons and decisions, scoped per workspace.
//
// A session's hard-won findings used to die with its context. These persist:
// the agent calls `remember`, entries are appended to a per-workspace file, and
// future sessions on that workspace get them injected at creation.
//
// Stored in the dashboard's stateDir, NOT inside the workspace — writing a
// .ember/ folder into a user's project pollutes their repo, and would show up
// inside benchmark runs as a file the model did not create.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KINDS = ['lesson', 'decision'];
// Injected into every new session on this workspace, so it has to stay small.
// Oldest entries fall off the injection first; the file keeps everything.
const INJECT_MAX = 40;

function fileFor(stateDir, workspace) {
  // Hash rather than sanitize: workspace paths collide badly once slashes,
  // drive letters, and spaces are stripped.
  const h = crypto.createHash('sha1').update(path.resolve(workspace)).digest('hex').slice(0, 12);
  return path.join(stateDir, 'memory', `${h}.json`);
}

export function readMemory(stateDir, workspace) {
  if (!stateDir || !workspace) return { workspace, entries: [] };
  try {
    const f = fileFor(stateDir, workspace);
    if (!fs.existsSync(f)) return { workspace, entries: [] };
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { workspace: d.workspace ?? workspace, entries: Array.isArray(d.entries) ? d.entries : [] };
  } catch { return { workspace, entries: [] }; }
}

export function addMemory(stateDir, workspace, { kind, text, session }) {
  if (!stateDir || !workspace) return { ok: false, error: 'no state dir' };
  const k = String(kind ?? '').toLowerCase();
  if (!KINDS.includes(k)) return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` };
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: 'empty text' };

  const mem = readMemory(stateDir, workspace);
  // Same finding recorded twice in one session is common — the model re-derives
  // it after a compaction. Dedupe on exact text rather than growing the file.
  if (mem.entries.some(e => e.text === body && e.kind === k)) {
    return { ok: true, duplicate: true, count: mem.entries.length };
  }
  mem.entries.push({ kind: k, text: body, at: new Date().toISOString(), session: session ?? null });
  const f = fileFor(stateDir, workspace);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ workspace, entries: mem.entries }, null, 2), 'utf8');
  fs.renameSync(tmp, f);
  return { ok: true, count: mem.entries.length };
}

// Markdown block for the system prompt. Empty string when there is nothing to
// say — an empty "Memory" heading just spends tokens telling the model nothing.
export function memoryPrompt(stateDir, workspace) {
  const { entries } = readMemory(stateDir, workspace);
  if (!entries.length) return '';
  const recent = entries.slice(-INJECT_MAX);
  const byKind = (k) => recent.filter(e => e.kind === k).map(e => `- ${e.text}`);
  const lessons = byKind('lesson');
  const decisions = byKind('decision');
  const parts = [`## Memory for this workspace`,
    `Carried from earlier sessions. Treat as established unless you find evidence otherwise.`];
  if (decisions.length) parts.push(`### Decisions\n${decisions.join('\n')}`);
  if (lessons.length) parts.push(`### Lessons\n${lessons.join('\n')}`);
  if (entries.length > INJECT_MAX) parts.push(`_(${entries.length - INJECT_MAX} older entries not shown)_`);
  return parts.join('\n\n');
}
