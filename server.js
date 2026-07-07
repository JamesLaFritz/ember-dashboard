// Ember OS Dashboard — local server. Vault in, markdown out, everything else
// is a thin layer: vitals parsing, skill runs (headless claude), the Jarvis
// router (regex → local LM), the agent workbench, and a voice-sidecar proxy.
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Vault } from './lib/vault.js';
import { collectVitals } from './lib/vitals.js';
import { SkillRunner } from './lib/skills.js';
import { LMStudio } from './lib/lmstudio.js';
import { Router } from './lib/router.js';
import { AgentManager, PRESETS, TOOL_DEFS } from './lib/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const saveConfig = () => fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const broadcast = (evt) => {
  const msg = JSON.stringify(evt);
  for (const client of wss.clients) if (client.readyState === 1) client.send(msg);
};

const vault = new Vault(config.vaultPath, config.vaultName);
const lm = new LMStudio(config.lmStudioUrl);
const skillRunner = new SkillRunner({ claudeCommand: config.claudeCommand, vaultPath: config.vaultPath, broadcast, allowedTools: config.claudeHeadlessAllow ?? [] });
const router = new Router({ vault, lm, routerModel: config.routerModel, skillRunner, vitalsFn: () => collectVitals(vault), claudeCommand: config.claudeCommand, allowedTools: config.claudeHeadlessAllow ?? [], broadcast });
const agents = new AgentManager({ lm, broadcast, workspaces: config.workspaces, stateDir: path.join(__dirname, '.sessions') });

// ---- HUD ----
app.get('/api/config', (_req, res) => res.json({
  skills: config.skills, vaultName: config.vaultName,
  workspaces: config.workspaces,
  presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, description: p.description })),
  tools: TOOL_DEFS.map(t => ({ name: t.name, needsApproval: t.needsApproval })),
  hudModels: ['auto', 'local', 'haiku', 'sonnet', 'opus'],
}));

app.get('/api/vitals', (_req, res) => res.json(collectVitals(vault)));

// Workspaces are user-editable from the workbench; changes persist to
// config.json. AgentManager holds the same array reference, so push/splice
// keeps session validation in sync without a restart.
app.post('/api/workspaces', (req, res) => {
  const p = path.resolve(String(req.body.path ?? '').trim()).replaceAll('\\', '/');
  if (!req.body.path || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    return res.status(400).json({ error: `not a folder: ${p}` });
  }
  if (!config.workspaces.includes(p)) { config.workspaces.push(p); saveConfig(); }
  res.json({ workspaces: config.workspaces });
});
app.post('/api/workspaces/remove', (req, res) => {
  const i = config.workspaces.indexOf(String(req.body.path ?? ''));
  if (i < 0) return res.status(404).json({ error: 'not in the workspace list' });
  config.workspaces.splice(i, 1);
  saveConfig();
  res.json({ workspaces: config.workspaces });
});

app.post('/api/assistant', async (req, res) => {
  try { res.json(await router.handle(String(req.body.text ?? ''), String(req.body.model ?? 'auto'))); }
  catch (err) { res.status(500).json({ reply: `Router error: ${String(err).slice(0, 200)}` }); }
});

app.post('/api/skill', (req, res) => {
  const { id, args } = req.body;
  if (!config.skills.some(s => s.id === id)) return res.status(400).json({ error: 'unknown skill' });
  res.json({ runId: skillRunner.run(id, args ?? config.skills.find(s => s.id === id)?.args ?? '') });
});

// ---- Reports (archive reader) ----
app.get('/api/reports', (_req, res) => {
  const groups = {
    TRENDS:   vault.listMarkdown('System/Memory/Reports').filter(f => /trends/i.test(f.name)),
    REVIEWS:  vault.listMarkdown('System/Memory/Reviews'),
    DAILY:    vault.listMarkdown('Daily').slice(0, 7),
    SESSIONS: vault.listMarkdown('System/Memory/Sessions').slice(0, 7),
  };
  res.json(Object.fromEntries(Object.entries(groups).map(([k, v]) =>
    [k, v.map(f => ({ ...f, uri: vault.obsidianUri(f.rel) }))])));
});

app.get('/api/report', (req, res) => {
  const rel = String(req.query.rel ?? '');
  if (rel.includes('..')) return res.status(400).json({ error: 'bad path' });
  const text = vault.read(rel);
  if (text == null) return res.status(404).json({ error: 'not found' });
  res.json({ rel, text, uri: vault.obsidianUri(rel) });
});

// ---- LM Studio ----
app.get('/api/lm/models', async (_req, res) => {
  try { res.json({ ok: true, models: await lm.models() }); }
  catch (err) { res.json({ ok: false, error: String(err).slice(0, 200) }); }
});
app.post('/api/lm/load',   async (req, res) => { try { res.json(await lm.load(req.body.model)); }   catch (err) { res.status(500).json({ error: String(err) }); } });
app.post('/api/lm/unload', async (req, res) => { try { res.json(await lm.unload(req.body.model)); } catch (err) { res.status(500).json({ error: String(err) }); } });

// GPU memory, card-level via nvidia-smi. Neither LM Studio API reports real
// VRAM per model, and per-process queries are blocked on Windows — so this is
// total used/total, which with one loaded model is effectively the model+KV.
let gpuCache = { at: 0, data: { ok: false } };
app.get('/api/gpu', (_req, res) => {
  if (Date.now() - gpuCache.at < 5000) return res.json(gpuCache.data);
  execFile('nvidia-smi', ['--query-gpu=name,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 4000 }, (err, out) => {
    let data = { ok: false };
    if (!err) {
      const [name, used, total] = String(out).trim().split('\n')[0].split(',').map(s => s.trim());
      if (name && +total) data = { ok: true, name, usedMB: +used, totalMB: +total };
    }
    gpuCache = { at: Date.now(), data };
    res.json(data);
  });
});

// ---- Agent workbench ----
app.get('/api/agent/sessions', (_req, res) => res.json({ sessions: agents.list() }));
app.get('/api/agent/:id/history', (req, res) => {
  const s = agents.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'no such session' });
  res.json({ id: s.id, preset: s.preset, model: s.model, workspace: s.workspace, mode: s.mode, history: s.history, stats: s.stats, allowlist: [...s.allowlist] });
});
app.post('/api/agent/session', (req, res) => {
  try {
    const s = agents.create({ model: req.body.model, workspace: req.body.workspace, preset: req.body.preset ?? 'coding-agent', mode: req.body.mode });
    res.json({ session: s.id });
  } catch (err) { res.status(400).json({ error: String(err.message ?? err) }); }
});
app.delete('/api/agent/:id', (req, res) => res.json({ ok: agents.delete(req.params.id) }));
app.post('/api/agent/:id/mode', (req, res) => {
  const mode = agents.setMode(req.params.id, String(req.body.mode ?? ''));
  mode ? res.json({ ok: true, mode }) : res.status(400).json({ error: 'bad session or mode' });
});
app.post('/api/agent/:id/allowlist', (req, res) => {
  const list = agents.updateAllowlist(req.params.id, String(req.body.action ?? 'add'), String(req.body.entry ?? ''));
  list ? res.json({ allowlist: list }) : res.status(404).json({ error: 'no such session or empty entry' });
});
app.post('/api/agent/:id/message', async (req, res) => {
  const s = agents.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'no such session' });
  try { res.json({ reply: await s.send(String(req.body.text ?? '')) }); }
  catch (err) { res.status(500).json({ error: String(err.message ?? err) }); }
});
app.post('/api/agent/:id/approval', (req, res) => {
  const s = agents.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'no such session' });
  res.json({ ok: s.resolveApproval(req.body.decision) });
});

// ---- Voice sidecar proxy (Phase 2; degrades gracefully when absent) ----
app.post('/api/voice/stt', async (req, res) => {
  try {
    const model = req.query.model ? '?model=' + encodeURIComponent(String(req.query.model)) : '';
    const upstream = await fetch(config.voiceSidecarUrl + '/stt' + model, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: req, duplex: 'half' });
    res.status(upstream.status).json(await upstream.json());
  } catch { res.status(503).json({ error: 'voice sidecar offline' }); }
});
app.post('/api/voice/tts', async (req, res) => {
  try {
    const upstream = await fetch(config.voiceSidecarUrl + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
    if (!upstream.ok) throw new Error(String(upstream.status));
    res.setHeader('Content-Type', 'audio/wav');
    upstream.body.pipe ? upstream.body.pipe(res) : res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch { res.status(503).json({ error: 'voice sidecar offline' }); }
});
app.get('/api/voice/voices', async (_req, res) => {
  try { const r = await fetch(config.voiceSidecarUrl + '/voices', { signal: AbortSignal.timeout(2500) }); res.json(await r.json()); }
  catch { res.json({ voices: [] }); }
});
app.get('/api/voice/health', async (_req, res) => {
  try { const r = await fetch(config.voiceSidecarUrl + '/health', { signal: AbortSignal.timeout(1500) }); res.json(await r.json()); }
  catch { res.json({ ok: false }); }
});

server.listen(config.port, () => {
  console.log(`Ember OS dashboard → http://localhost:${config.port}`);
  console.log(`Vault: ${config.vaultPath}`);
});
