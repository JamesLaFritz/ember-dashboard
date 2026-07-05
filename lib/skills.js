// skills.js — run vault skills through headless Claude Code (`claude -p`).
// Every run is a single user click; nothing here schedules or polls.
// Headless runs bill against the monthly API credit pool, not the Max plan.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export class SkillRunner {
  constructor({ claudeCommand, vaultPath, broadcast }) {
    this.claudeCommand = claudeCommand;
    this.vaultPath = vaultPath;
    this.broadcast = broadcast; // (event) => void, fans out over WebSocket
    this.runs = new Map();
  }

  run(skillId, args = '') {
    const id = randomUUID().slice(0, 8);
    const prompt = `/${skillId} ${args}`.trim();
    const child = spawn(this.claudeCommand, [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
    ], { cwd: this.vaultPath, shell: true });

    const run = { id, skillId, status: 'running', startedAt: Date.now(), summary: '', touched: [] };
    this.runs.set(id, run);
    this.broadcast({ type: 'skill_started', id, skillId });

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.#handleEvent(run, line);
      }
    });
    child.stderr.on('data', (c) => this.broadcast({ type: 'skill_log', id, text: c.toString().slice(0, 400) }));
    child.on('close', (code) => {
      run.status = code === 0 ? 'done' : 'failed';
      run.endedAt = Date.now();
      this.broadcast({ type: 'skill_done', id, skillId, status: run.status, summary: run.summary, touched: run.touched });
    });
    child.on('error', (err) => {
      run.status = 'failed';
      this.broadcast({ type: 'skill_done', id, skillId, status: 'failed', summary: String(err) });
    });
    return id;
  }

  #handleEvent(run, line) {
    let evt;
    try { evt = JSON.parse(line); } catch { return; }
    // stream-json: assistant turns carry content blocks; result carries the final text.
    if (evt.type === 'assistant') {
      for (const block of evt.message?.content ?? []) {
        if (block.type === 'tool_use') {
          const file = block.input?.file_path ?? block.input?.path ?? '';
          if (file && /\.(md|txt)$/i.test(file) && !run.touched.includes(file)) run.touched.push(file);
          this.broadcast({ type: 'skill_progress', id: run.id, tool: block.name, detail: String(file).split(/[\\/]/).pop() });
        }
      }
    } else if (evt.type === 'result') {
      run.summary = (evt.result ?? '').slice(0, 2000);
    }
  }

  status(id) { return this.runs.get(id) ?? null; }
}
