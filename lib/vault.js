// vault.js — read-only helpers over the Obsidian vault. The vault is the source
// of truth; the dashboard only ever renders what lives here as markdown.
import fs from 'node:fs';
import path from 'node:path';

export class Vault {
  constructor(root, vaultName) {
    this.root = root;
    this.vaultName = vaultName;
  }

  abs(rel) { return path.join(this.root, rel); }

  exists(rel) { return fs.existsSync(this.abs(rel)); }

  read(rel) {
    const p = this.abs(rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }

  // Obsidian deep link for "Open in Obsidian" actions.
  obsidianUri(rel) {
    const noExt = rel.replace(/\.md$/i, '').replaceAll('\\', '/');
    return `obsidian://open?vault=${encodeURIComponent(this.vaultName)}&file=${encodeURIComponent(noExt)}`;
  }

  // List .md files in a folder (non-recursive unless recurse=true), newest first.
  listMarkdown(rel, { recurse = false } = {}) {
    const dir = this.abs(rel);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) { if (recurse) walk(path.join(d, entry.name)); continue; }
        if (!entry.name.toLowerCase().endsWith('.md')) continue;
        const p = path.join(d, entry.name);
        out.push({
          name: entry.name.replace(/\.md$/i, ''),
          rel: path.relative(this.root, p).replaceAll('\\', '/'),
          mtime: fs.statSync(p).mtimeMs,
        });
      }
    };
    walk(dir);
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  newest(rel, { recurse = false } = {}) {
    return this.listMarkdown(rel, { recurse })[0] ?? null;
  }

  countMarkdown(rel) { return this.listMarkdown(rel, { recurse: true }).length; }

  // Checkbox stats for BRIEF-style notes: { done, open }.
  checkboxStats(rel) {
    const text = this.read(rel);
    if (text == null) return null;
    const done = (text.match(/^\s*- \[x\]/gim) ?? []).length;
    const open = (text.match(/^\s*- \[ \]/gm) ?? []).length;
    return { done, open, total: done + open };
  }

  // Extract one "## Section" body from a note.
  section(text, heading) {
    if (!text) return null;
    const lines = text.split('\n');
    const startRe = new RegExp(`^##\\s+.*${heading}`, 'i');
    const start = lines.findIndex(l => startRe.test(l));
    if (start === -1) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { end = i; break; }
    }
    return lines.slice(start + 1, end).join('\n').trim();
  }

  // Local-date string (Daily notes are named by James's clock, not UTC).
  static today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
