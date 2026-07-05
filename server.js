// Ember OS Dashboard — local server. Vault in, markdown out, everything else
// is a thin layer: vitals parsing, skill runs (headless claude), the Jarvis
// router (regex → local LM), the agent workbench, and a voice-sidecar proxy.
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
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
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

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
const skillRunner = new SkillRunner({ claudeCommand: config.claudeCommand, vaultPath: config.vaultPath, broadcast });
const router = new Router({ vault, lm, routerModel: config.routerModel, skillRunner, vitalsFn: () => collectVitals(vault) });
const agents = new AgentManager({ lm, broadcast, workspaces: config.workspaces });

// ---- HUD ----
app.get('/api/config', (_req, res) => res.json({
  skills: config.skills, vaultName: config.vaultName,
  workspaces: config.workspaces, presets: Object.keys(PRESETS),
  tools: TOOL_DEFS.map(t => ({ name: t.name, needsApproval: t.needsApproval })),
}));

app.get('/api/vitals', (_req, res) => res.json(collectVitals(vault)));

app.post('/api/assistant', async (req, res) => {
  try { res.json(await router.handle(String(req.body.text ?? ''))); }
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

// ---- Agent workbench ----
app.post('/api/agent/session', (req, res) => {
  try {
    const s = agents.create({ model: req.body.model, workspace: req.body.workspace, preset: req.body.preset ?? 'coding-agent' });
    res.json({ session: s.id });
  } catch (err) { res.status(400).json({ error: String(err.message ?? err) }); }
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
    const upstream = await fetch(config.voiceSidecarUrl + '/stt', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: req, duplex: 'half' });
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
app.get('/api/voice/health', async (_req, res) => {
  try { const r = await fetch(config.voiceSidecarUrl + '/health', { signal: AbortSignal.timeout(1500) }); res.json(await r.json()); }
  catch { res.json({ ok: false }); }
});

server.listen(config.port, () => {
  console.log(`Ember OS dashboard → http://localhost:${config.port}`);
  console.log(`Vault: ${config.vaultPath}`);
});
