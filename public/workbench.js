// workbench.js — agentic chat against local LM Studio models with
// Claude-Code-style approval cards, switchable sessions, and live LM status.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const state = { session: null, streamEl: null, presets: [], tools: [], allow: [] };

init();
async function init() {
  const cfg = await (await fetch('/api/config')).json();
  state.presets = cfg.presets;
  state.tools = cfg.tools;
  renderWorkspaces(cfg.workspaces);
  $('preset').innerHTML = cfg.presets.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
  $('preset').onchange = showPresetDesc;
  showPresetDesc();
  renderTools();
  renderAllow();
  await refreshModels();
  const sessions = await refreshSessions();
  // Sessions survive server restarts now — reopen where you left off.
  if (sessions.length) await switchSession(sessions[0].id);
  setInterval(refreshModels, 30_000);
  connectWS();
  $('newSession').onclick = newSession;
  $('sessionPicker').onchange = () => switchSession($('sessionPicker').value);
  $('loadBtn').onclick = () => lmAction('load');
  $('unloadBtn').onclick = () => lmAction('unload');
  $('wsAdd').onclick = addWorkspace;
  $('wsRemove').onclick = removeWorkspace;
  $('mode').onchange = changeMode;
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
}

// ---------- workspaces ----------
function renderWorkspaces(list, select) {
  $('workspace').innerHTML = list.map(w => `<option ${w === select ? 'selected' : ''}>${esc(w)}</option>`).join('');
}
async function addWorkspace() {
  const p = prompt('Folder to add as a workspace (absolute path):');
  if (!p?.trim()) return;
  const res = await (await fetch('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p.trim() }) })).json();
  if (res.error) return addMsg('reason', `Workspace error: ${res.error}`);
  renderWorkspaces(res.workspaces, res.workspaces[res.workspaces.length - 1]);
  addMsg('reason', `Workspace added: ${res.workspaces[res.workspaces.length - 1]}`);
}
async function removeWorkspace() {
  const w = $('workspace').value;
  if (!w || !confirm(`Remove workspace from the list?\n${w}\n(The folder itself is untouched.)`)) return;
  const res = await (await fetch('/api/workspaces/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: w }) })).json();
  if (res.error) return addMsg('reason', `Workspace error: ${res.error}`);
  renderWorkspaces(res.workspaces);
}

// ---------- permission mode / tools / allowlist ----------
async function changeMode() {
  if (!state.session) return; // no session yet — the value seeds the next New Session
  const res = await (await fetch(`/api/agent/${state.session}/mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: $('mode').value }) })).json();
  if (res.error) return addMsg('reason', `Mode error: ${res.error}`);
  addMsg('reason', `Permissions → ${res.mode.toUpperCase()}${res.mode === 'auto' ? ' — every write and command now runs without asking.' : res.mode === 'plan' ? ' — writes and commands are blocked; the agent can only read and propose.' : ''}`);
}

// Tools with a gate can be flipped per session: click toggles ask ↔ auto
// (an allowlist entry "tool:<name>"). Read-only tools are always auto.
function renderTools() {
  $('tools').innerHTML = state.tools.map(t => {
    const auto = !t.needsApproval || state.allow.includes(`tool:${t.name}`);
    const clickable = t.needsApproval && state.session;
    return `<div class="row ${clickable ? 'tog' : ''}" ${clickable ? `data-tool="${esc(t.name)}" title="click to toggle ask / auto for this session"` : ''}>
      <span class="when ${auto ? 'gold' : ''}">${auto ? 'auto' : 'ask'}</span><span class="mono">${esc(t.name)}</span></div>`;
  }).join('');
}
$('tools').addEventListener('click', async (e) => {
  const tool = e.target.closest('[data-tool]')?.dataset.tool;
  if (!tool || !state.session) return;
  const entry = `tool:${tool}`;
  const action = state.allow.includes(entry) ? 'remove' : 'add';
  const res = await (await fetch(`/api/agent/${state.session}/allowlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, entry }) })).json();
  if (res.allowlist) { state.allow = res.allowlist; renderTools(); renderAllow(); }
});

function renderAllow() {
  $('allowlist').innerHTML = state.allow.length
    ? state.allow.map(a => `<div class="row"><span class="when gold">✓</span><span class="mono">${esc(a)}</span><button class="x" data-entry="${esc(a)}" title="revoke">✕</button></div>`).join('')
    : '<span class="meta">empty — approvals build it</span>';
}
$('allowlist').addEventListener('click', async (e) => {
  const entry = e.target.dataset?.entry;
  if (!entry || !state.session) return;
  const res = await (await fetch(`/api/agent/${state.session}/allowlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove', entry }) })).json();
  if (res.allowlist) { state.allow = res.allowlist; renderTools(); renderAllow(); }
});

function showPresetDesc() {
  const p = state.presets.find(x => x.id === $('preset').value);
  $('presetDesc').textContent = p?.description ?? '';
}

// ---------- LM Studio status ----------
async function refreshModels() {
  const [res, gpu] = await Promise.all([
    (await fetch('/api/lm/models')).json(),
    (await fetch('/api/gpu')).json(),
  ]);
  // Card-level used/total — with one loaded model this is model weights + KV
  // cache (LM Studio's APIs don't report per-model VRAM).
  const gpuRow = gpu.ok
    ? `<div class="row"><span class="when gold">GPU</span><span class="mono">${(gpu.usedMB / 1024).toFixed(1)} / ${(gpu.totalMB / 1024).toFixed(1)} GB<br><span class="meta">${esc(gpu.name)}</span></span></div>`
    : '';
  $('chip-lm').classList.toggle('on', !!res.ok);
  if (!res.ok) {
    $('model').innerHTML = '<option>LM Studio offline</option>';
    $('lmstatus').innerHTML = gpuRow + `<span class="meta">offline — run: lms server start</span>`;
    return;
  }
  const llms = res.models.filter(m => m.type === 'llm');
  const current = $('model').value;
  $('model').innerHTML = llms.map(m =>
    `<option value="${esc(m.key)}" ${m.key === current ? 'selected' : ''}>${esc(m.name)}${m.loaded ? ' ●' : ''}</option>`).join('');
  const loaded = llms.filter(m => m.loaded);
  $('lmstatus').innerHTML = gpuRow + (loaded.length
    ? loaded.map(m => `<div class="row"><span class="when gold">●</span><span class="mono">${esc(m.name)}<br>
        <span class="meta">${esc(m.quant ?? '?')} · ${m.sizeGB ?? '?'}GB file · ctx ${fmtK(m.contextLength)} / ${fmtK(m.maxContextLength)} · ${esc(m.arch ?? '')}</span></span></div>`).join('')
    : '<span class="meta">server up · no model loaded</span>');
}
const fmtK = (n) => n ? (n >= 1000 ? (n / 1000).toFixed(0) + 'k' : n) : '?';
const fmtTok = (n) => n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n ?? 0);
const statLine = (s) => s && (s.in || s.out || s.tps)
  ? `${s.tps ? s.tps + ' tok/s · ' : ''}in ${fmtTok(s.in ?? 0)} · out ${fmtTok(s.out ?? s.tokens ?? 0)}`
  : '';

async function lmAction(kind) {
  const model = $('model').value;
  addMsg('reason', `${kind}ing ${model}…`);
  await fetch(`/api/lm/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
  await refreshModels();
  addMsg('reason', `${model} ${kind} complete.`);
}

// ---------- sessions ----------
async function refreshSessions(selectId) {
  const res = await (await fetch('/api/agent/sessions')).json();
  const list = res.sessions ?? [];
  refreshSessions.last = list;
  $('sessionPicker').innerHTML = '<option value="">— none —</option>' + list.map(s =>
    `<option value="${s.id}" ${s.id === (selectId ?? state.session) ? 'selected' : ''}>${s.id} · ${esc(s.title)}</option>`).join('');
  $('sessions').innerHTML = list.length
    ? list.map(s => `<div class="row" style="cursor:pointer" data-id="${s.id}">
        <span class="when ${s.id === state.session ? 'gold' : ''}">${s.busy ? '…' : s.pendingApproval ? '?' : '·'}</span>
        <span style="flex:1"><span class="mono">${s.id}</span> <span class="meta">${esc(s.preset)} · ${esc(s.mode ?? 'ask')}</span><br><span class="meta">${esc(s.title)}</span>${statLine(s.stats) ? `<br><span class="meta gold">${statLine(s.stats)}</span>` : ''}</span>
        <button class="x" data-del="${s.id}" title="delete session">✕</button></div>`).join('')
    : '<span class="meta">none yet</span>';
  return list;
}
$('sessions').addEventListener('click', async (e) => {
  const del = e.target.dataset?.del;
  if (del) {
    if (!confirm(`Delete session ${del}? Its transcript is gone for good.`)) return;
    await fetch(`/api/agent/${del}`, { method: 'DELETE' });
    if (state.session === del) {
      state.session = null;
      $('composer-input').disabled = true;
      $('chat').innerHTML = '';
      $('tps').textContent = '';
      state.allow = [];
      renderTools(); renderAllow();
      addMsg('reason', `Session ${del} deleted.`);
    }
    return refreshSessions();
  }
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id) switchSession(id);
});
async function switchSession(id) {
  if (!id) return;
  const h = await (await fetch(`/api/agent/${id}/history`)).json();
  if (h.error) return addMsg('reason', `Could not reopen session ${id}: ${h.error}`);
  state.session = id;
  $('sessionBadgeUpdate')?.remove();
  $('composer-input').disabled = false;
  $('tps').textContent = statLine(h.stats);
  $('mode').value = h.mode ?? 'ask';
  $('chat').innerHTML = '';
  addMsg('reason', `Session ${id} · ${h.preset} · ${h.workspace} · model ${h.model} · perms ${(h.mode ?? 'ask').toUpperCase()}`);
  for (const e of h.history ?? []) {
    if (e.kind === 'user') addMsg('user', e.text);
    else if (e.kind === 'assistant') addMsg('assistant', e.text);
    else if (e.kind === 'tool') toolCard(e.tool, e.args);
    else if (e.kind === 'approval') toolCard(e.tool, `${e.args} → ${e.decision.toUpperCase()}`);
  }
  state.allow = h.allowlist ?? [];
  renderTools();
  renderAllow();
  await refreshSessions(id);
}

async function newSession() {
  const res = await (await fetch('/api/agent/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: $('model').value, workspace: $('workspace').value, preset: $('preset').value, mode: $('mode').value }),
  })).json();
  if (res.error) return addMsg('reason', `Session error: ${res.error}`);
  state.session = res.session;
  $('composer-input').disabled = false;
  $('chat').innerHTML = '';
  $('tps').textContent = '';
  state.allow = [];
  renderTools();
  renderAllow();
  addMsg('reason', `Session ${res.session} · ${$('preset').value} · ${$('workspace').value} · perms ${$('mode').value.toUpperCase()}`);
  await refreshSessions(res.session);
}

// ---------- chat ----------
async function send() {
  const text = $('composer-input').value.trim();
  if (!text || !state.session) return;
  $('composer-input').value = '';
  addMsg('user', text);
  state.streamEl = addMsg('assistant', '');
  state.streamEl.innerHTML = '<span class="caret"></span>';
  const res = await (await fetch(`/api/agent/${state.session}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  })).json();
  if (res.error) addMsg('reason', `Error: ${res.error}`);
  refreshSessions();
}

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (m) => {
    const evt = JSON.parse(m.data);
    if (evt.session && evt.session !== state.session) { if (evt.type === 'agent_approval') refreshSessions(); return; }
    if (evt.type === 'agent_delta') {
      if (!state.streamEl) { state.streamEl = addMsg('assistant', ''); }
      state.streamEl.dataset.raw = (state.streamEl.dataset.raw ?? '') + evt.text;
      state.streamEl.innerHTML = esc(state.streamEl.dataset.raw) + '<span class="caret"></span>';
      scrollDown();
    }
    if (evt.type === 'agent_stats') $('tps').textContent = statLine(evt);
    if (evt.type === 'agent_done') {
      if (state.streamEl) { state.streamEl.innerHTML = esc(evt.text ?? state.streamEl.dataset.raw ?? ''); state.streamEl = null; }
      scrollDown();
    }
    if (evt.type === 'agent_tool') { finishStream(); toolCard(evt.tool, evt.args); }
    if (evt.type === 'agent_approval') approvalCard(evt);
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}
function finishStream() {
  if (state.streamEl) { state.streamEl.innerHTML = esc(state.streamEl.dataset.raw ?? ''); state.streamEl = null; }
}

function toolCard(tool, args) {
  const el = document.createElement('div');
  el.className = 'toolcard';
  el.innerHTML = `<span class="name">TOOL · ${esc(tool)}</span><br><span class="meta">${esc(args ?? '')}</span>`;
  $('chat').appendChild(el);
  scrollDown();
}

function approvalCard(evt) {
  finishStream();
  const el = document.createElement('div');
  el.className = 'toolcard';
  let body = `<span class="name">APPROVAL REQUIRED · ${esc(evt.tool)}</span><br><span class="meta">${esc(evt.detail ?? '')}</span>`;
  if (evt.diff) {
    const del = evt.diff.old ? evt.diff.old.split('\n').map(l => `<span class="del">- ${esc(l)}</span>`).join('\n') : '';
    const add = (evt.diff.new ?? '').split('\n').map(l => `<span class="add">+ ${esc(l)}</span>`).join('\n');
    body += `<div class="diff">${del}${del ? '\n' : ''}${add}</div>`;
  }
  body += `<div class="approve-actions">
    <button class="ghost primary" data-d="approve">Approve</button>
    <button class="ghost" data-d="deny">Deny</button>
    <button class="ghost" data-d="always">Always Allow</button></div>`;
  el.innerHTML = body;
  el.addEventListener('click', async (e) => {
    const d = e.target.dataset?.d; if (!d) return;
    await fetch(`/api/agent/${state.session}/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: d }) });
    el.querySelector('.approve-actions').innerHTML = `<span class="meta">→ ${d.toUpperCase()}</span>`;
    if (d === 'always') {
      const entry = evt.tool === 'run_command' ? `cmd:${(evt.detail ?? '').trim().split(/\s+/).slice(0, 2).join(' ')}` : `tool:${evt.tool}`;
      if (!state.allow.includes(entry)) state.allow.push(entry);
      renderTools();
      renderAllow();
    }
  });
  $('chat').appendChild(el);
  scrollDown();
}

function addMsg(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  $('chat').appendChild(el);
  scrollDown();
  return el;
}
// The chat pane scrolls; the page never does (menu and rail stay on screen).
const scrollDown = () => { const c = $('chat'); c.scrollTop = c.scrollHeight; };
