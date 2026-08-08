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

function readOne(kind) {
  if (String(process.env.EMBER_IDENTITY ?? '').toLowerCase() === 'off') return { text: '', source: 'off' };
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
export function loadIdentity() {
  const soul = readOne('SOUL');
  const user = readOne('USER');
  return { soul: soul.text, user: user.text, sources: { soul: soul.source, user: user.source } };
}

// Layer identity over a preset's role instructions. Role goes LAST: it is the
// most specific and most operational, and the last thing in a system prompt is
// what models weight most reliably.
export function composeSystem(role) {
  const { soul, user } = loadIdentity();
  const parts = [];
  if (soul) parts.push(soul);
  if (user) parts.push(`## Who you work for\n\n${user}`);
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
