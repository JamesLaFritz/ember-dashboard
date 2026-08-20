// identity.js — who the agent is (SOUL) and who it works for (USER).
//
// These were hardcoded into every preset, which made the presets personal to
// one operator. They now live in editable markdown so anyone cloning this repo
// can make the workbench theirs without touching code.
//
// Resolution order, first hit wins:
//   1. EMBER_SOUL_PATH / EMBER_USER_PATH   — explicit file paths
//   2. EMBER_IDENTITY_DIR/{SOUL,USER}.md   — a directory of both
//   3. <repo>/identity/{SOUL,USER}.md      — the shipped defaults
//
// Set EMBER_IDENTITY=off to run with no identity layer at all. That is the
// right setting for benchmarking: an identity file is part of the prompt, so
// comparing models across different identities compares prompts, not models.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(HERE, '..', 'identity');

// A runaway identity file would eat the context window every single turn — on a
// 32k local model that is real budget. Truncate loudly rather than silently.
const MAX_CHARS = 8000;

// Whether the identity layer is on unless a session says otherwise. A session
// can override this either way, so the env var sets the default rather than the
// law — a benchmark box can run EMBER_IDENTITY=off globally and still opt one
// exploratory session back in.
export function identityDefault() {
  return String(process.env.EMBER_IDENTITY ?? '').toLowerCase() !== 'off';
}

function readOne(kind) {
  const explicit = process.env[`EMBER_${kind}_PATH`];
  const dir = process.env.EMBER_IDENTITY_DIR || DEFAULT_DIR;
  const candidates = [explicit, path.join(dir, `${kind}.md`)].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      let text = fs.readFileSync(p, 'utf8').trim();
      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS) + `\n\n[...truncated at ${MAX_CHARS} chars — trim ${path.basename(p)}; it is re-sent every turn]`;
      }
      return { text, source: p };
    } catch { /* unreadable — fall through to the next candidate */ }
  }
  return { text: '', source: null };
}

// Read on every call (files are small) so editing SOUL.md takes effect on the
// next session without restarting the server. mtime-cache would save microseconds
// and cost the thing that makes this pleasant to tune.
export function loadIdentity(enabled = identityDefault()) {
  if (!enabled) return { soul: '', user: '', sources: { soul: 'off', user: 'off' } };
  const soul = readOne('SOUL');
  const user = readOne('USER');
  return { soul: soul.text, user: user.text, sources: { soul: soul.source, user: user.source } };
}

// Order is deliberate: identity (who) → method (how, optional) → project rules
// (where) → role (what, this session). Most specific last, because that is what
// models weight most reliably.
export function composeSystem(role, workspace, useIdentity = identityDefault()) {
  const { soul, user } = loadIdentity(useIdentity);
  const agents = loadAgentsMd(workspace);
  const craft = loadCraft();
  const parts = [];
  if (soul) parts.push(soul);
  if (user) parts.push(`## Who you work for\n\n${user}`);
  if (craft.text) parts.push(`## How to work (CRAFT)\n\n${craft.text}`);
  if (agents.text) parts.push(`## Project instructions (AGENTS.md — ${agents.scope})\n\n${agents.text}`);
  parts.push(role);
  return parts.join('\n\n---\n\n');
}

// Short form for the HUD router, whose prompts are one-liners sized for a small
// fast model and a 4-sentence answer — the full SOUL/USER pair would dwarf them.
// Takes only USER, so the router knows who it is talking to without inheriting
// the whole personality file. Falls back to the caller's generic line.
export function identityPreamble(fallback) {
  const { user } = loadIdentity();
  if (!user) return fallback;
  return `${fallback}\n\nWho you work for:\n${user.slice(0, 1500)}`;
}

// ---- AGENTS.md -----------------------------------------------------------
// Project instructions, following the convention every coding agent now reads:
// a workspace's own AGENTS.md wins, and the workbench default applies when a
// workspace has none. Workspace-specific rules SHOULD override the default —
// that is the whole point — so this returns one or the other, never both.
export function loadAgentsMd(workspace) {
  const candidates = [
    workspace && path.join(workspace, 'AGENTS.md'),
    process.env.EMBER_AGENTS_PATH,
    path.join(HERE, '..', 'AGENTS.md'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      let text = fs.readFileSync(p, 'utf8').trim();
      if (!text) continue;
      // Compare RESOLVED paths: path.join emits backslashes on Windows while a
      // configured workspace is usually forward-slashed, so a raw startsWith
      // mislabels every workspace file as the workbench default.
      const inWorkspace = !!workspace &&
        path.resolve(p).toLowerCase() === path.resolve(workspace, 'AGENTS.md').toLowerCase();
      const scope = inWorkspace ? 'workspace' : 'workbench default';
      if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS) + `\n\n[...truncated at ${MAX_CHARS} chars — trim AGENTS.md; it is re-sent every turn]`;
      }
      return { text, source: p, scope };
    } catch { /* unreadable — try the next candidate */ }
  }
  return { text: '', source: null, scope: null };
}

// ---- CRAFT.md ------------------------------------------------------------
// The working method. ~16k chars — roughly 4k tokens on every single turn,
// which is 12% of a 32k window — so it is OFF by default and referenced from
// AGENTS.md instead. Turn on with EMBER_CRAFT=on when the work is hard enough
// to be worth the budget.
export function loadCraft() {
  if (String(process.env.EMBER_CRAFT ?? '').toLowerCase() !== 'on') return { text: '', source: null };
  const p = process.env.EMBER_CRAFT_PATH || path.join(HERE, '..', 'CRAFT.md');
  try {
    if (fs.existsSync(p)) return { text: fs.readFileSync(p, 'utf8').trim(), source: p };
  } catch { /* fall through */ }
  return { text: '', source: null };
}
