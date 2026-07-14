// workbench.js — agentic chat against local LM Studio models with
// Claude-Code-style approval cards, switchable sessions, and live LM status.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const state = { session: null, streamEl: null, presets: [], tools: [], allow: [], mcp: [] };

init();
async function init() {
  const cfg = await (await fetch('/api/config')).json();
  state.presets = cfg.presets;
  state.tools = cfg.tools;
  renderWorkspaces(cfg.workspaces);
  $('preset').innerHTML = cfg.presets.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
  $('preset').onchange = changePreset;
  showPresetDesc();
  renderTools();
  renderAllow();
  renderSkills();
  renderMcp();
  $('workspace').onchange = () => renderSkills();
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
  renderSkills();
  addMsg('reason', `Workspace added: ${res.workspaces[res.workspaces.length - 1]}`);
}
async function removeWorkspace() {
  const w = $('workspace').value;
  if (!w || !confirm(`Remove workspace from the list?\n${w}\n(The folder itself is untouched.)`)) return;
  const res = await (await fetch('/api/workspaces/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: w }) })).json();
  if (res.error) return addMsg('reason', `Workspace error: ${res.error}`);
  renderWorkspaces(res.workspaces);
}

// ---------- preset / permission mode / tools / allowlist ----------
// Both selects live above the composer and act on the CURRENT session:
// preset swaps the session's system prompt, perms swap the approval mode.
// With no session open they just seed the next New Session.
async function changePreset() {
  showPresetDesc();
  if (!state.session) return;
  const res = await (await fetch(`/api/agent/${state.session}/preset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preset: $('preset').value }) })).json();
  if (res.error) return addMsg('reason', `Preset error: ${res.error}`);
  addMsg('reason', `Preset → ${res.preset} — system prompt swapped; takes effect next message.`);
  refreshSessions();
}
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

// Skills the agent can load with use_skill — read from the workspace's
// .claude/skills. Follows the active session's workspace when one is open,
// otherwise the workspace selector. Click a skill to prefill the composer.
async function renderSkills(workspace) {
  const ws = workspace ?? $('workspace').value;
  if (!ws) return $('skills').innerHTML = '<span class="meta">—</span>';
  const res = await (await fetch(`/api/skills/library?workspace=${encodeURIComponent(ws)}`)).json();
  const list = res.skills ?? [];
  $('skills').innerHTML = list.length
    ? list.map(s => `<div class="row tog" data-skill="${esc(s.name)}" title="${esc(s.description)}">
        <span class="when gold">◆</span><span class="mono">${esc(s.name)}</span></div>`).join('')
    : '<span class="meta">none in this workspace</span>';
}
$('skills').addEventListener('click', (e) => {
  const name = e.target.closest('[data-skill]')?.dataset.skill;
  if (!name) return;
  $('composer-input').value = `Use the ${name} skill: `;
  $('composer-input').focus();
});

// MCP servers (same config Claude Code reads). Off by default per session —
// each enabled server's tools are resent to the model every hop, so cost is
// opt-in. Click toggles for the active session; enabling starts the server.
async function renderMcp() {
  const res = await (await fetch('/api/mcp/servers')).json();
  const servers = res.servers ?? [];
  if (!servers.length) return $('mcp').innerHTML = '<span class="meta">none configured</span>';
  $('mcp').innerHTML = servers.map(sv => {
    const on = state.mcp.includes(sv.name);
    const detail = on && sv.tools != null ? ` · ${sv.tools} tools` : '';
    return `<div class="row ${state.session ? 'tog' : ''}" ${state.session ? `data-mcp="${esc(sv.name)}" title="click to ${on ? 'disable' : 'enable'} for this session"` : ''}>
      <span class="when ${on ? 'gold' : ''}">${on ? 'on' : 'off'}</span><span class="mono">${esc(sv.name)}${detail}</span></div>`;
  }).join('');
}
$('mcp').addEventListener('click', async (e) => {
  const server = e.target.closest('[data-mcp]')?.dataset.mcp;
  if (!server || !state.session) return;
  const enabled = !state.mcp.includes(server);
  if (enabled) addMsg('reason', `Starting MCP server ${server}…`);
  const res = await (await fetch(`/api/agent/${state.session}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server, enabled }) })).json();
  if (res.error) return addMsg('reason', `MCP ${server}: ${res.error}`);
  state.mcp = res.mcpServers;
  addMsg('reason', enabled ? `MCP ${server} enabled — ${res.tools} tools available (each call still needs approval).` : `MCP ${server} disabled.`);
  renderMcp();
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
  const labels = disambiguateModelLabels(llms);
  $('model').innerHTML = llms.map((m, i) =>
    `<option value="${esc(m.key)}" title="${esc(m.key)}" ${m.key === current ? 'selected' : ''}>${esc(labels[i])}${m.loaded ? ' ●' : ''}</option>`).join('');
  const loaded = llms.filter(m => m.loaded);
  $('lmstatus').innerHTML = gpuRow + (loaded.length
    ? loaded.map(m => `<div class="row"><span class="when gold">●</span><span class="mono">${esc(m.name)}<br>
        <span class="meta">${esc(m.quant ?? '?')} · ${m.sizeGB ?? '?'}GB file · ctx ${fmtK(m.contextLength)} / ${fmtK(m.maxContextLength)} · ${esc(m.arch ?? '')}</span></span></div>`).join('')
    : '<span class="meta">server up · no model loaded</span>');
}
// LM Studio's own "name" metadata is not guaranteed unique — several
// finetunes of the same base model (or different quants of the same
// finetune) can share an identical display name. Disambiguate in tiers:
// plain name -> name+quant+size -> name+quant+size+key (the key is always
// unique, so this tier always terminates).
function disambiguateModelLabels(models) {
  const byName = groupIndexesBy(models, m => m.name);
  return models.map((m, i) => {
    if (byName[m.name].length === 1) return m.name;
    const tag = `${m.quant ?? '?'}, ${m.sizeGB ?? '?'}GB`;
    const bySpec = groupIndexesBy(byName[m.name].map(j => models[j]), x => `${x.quant}|${x.sizeGB}`);
    const specKey = `${m.quant}|${m.sizeGB}`;
    if (bySpec[specKey].length === 1) return `${m.name} (${tag})`;
    return `${m.name} (${tag}) — ${m.key}`;
  });
}
function groupIndexesBy(items, keyFn) {
  const groups = {};
  items.forEach((item, i) => { const k = keyFn(item); (groups[k] ??= []).push(i); });
  return groups;
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
        <span style="flex:1"><span class="mono">${s.id}</span> <span class="meta">${esc(s.preset)} · ${esc(s.mode ?? 'ask')}</span><br><span class="meta" title="${esc(s.workspace ?? '')}">⌂ ${esc((s.workspace ?? '').split('/').pop())}</span><br><span class="meta">${esc(s.title)}</span>${statLine(s.stats) ? `<br><span class="meta gold">${statLine(s.stats)}</span>` : ''}</span>
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
      state.mcp = [];
      renderTools(); renderAllow(); renderMcp();
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
  if ([...$('preset').options].some(o => o.value === h.preset)) $('preset').value = h.preset;
  showPresetDesc();
  $('chat').innerHTML = '';
  addMsg('reason', `Session ${id} · ${h.preset} · ${h.workspace} · model ${h.model} · perms ${(h.mode ?? 'ask').toUpperCase()}`);
  for (const e of h.history ?? []) {
    if (e.kind === 'user') addMsg('user', e.text);
    else if (e.kind === 'assistant') addAssistant(e.text);
    else if (e.kind === 'reasoning') addReasoning(e.text);
    else if (e.kind === 'tool') toolCard(e.tool, e.args);
    else if (e.kind === 'approval') toolCard(e.tool, `${e.args} → ${e.decision.toUpperCase()}`);
  }
  state.allow = h.allowlist ?? [];
  state.mcp = h.mcpServers ?? [];
  renderTools();
  renderAllow();
  renderSkills(h.workspace);
  renderMcp();
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
  state.mcp = [];
  renderTools();
  renderAllow();
  renderMcp();
  addMsg('reason', `Session ${res.session} · ${$('preset').value} · ${$('workspace').value} · perms ${$('mode').value.toUpperCase()}`);
  await refreshSessions(res.session);
}

// ---------- chat ----------
async function send() {
  const text = $('composer-input').value.trim();
  if (!text || !state.session) return;
  $('composer-input').value = '';
  addMsg('user', text);
  showThinking();
  const res = await (await fetch(`/api/agent/${state.session}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  })).json();
  if (res.error) { hideThinking(); addMsg('reason', `Error: ${res.error}`); }
  refreshSessions();
}

// Persistent "something is happening" cue for the gaps a streaming caret
// can't cover: the initial round-trip, and every hop between one tool call
// finishing and the next delta or tool call starting.
function showThinking() {
  if ($('thinking')) return;
  const el = document.createElement('div');
  el.id = 'thinking';
  el.className = 'msg reason thinking';
  el.innerHTML = 'Ember is thinking<span class="dots"><i></i><i></i><i></i></span>';
  $('chat').appendChild(el);
  scrollDown();
}
function hideThinking() { $('thinking')?.remove(); }

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (m) => {
    const evt = JSON.parse(m.data);
    if (evt.session && evt.session !== state.session) { if (evt.type === 'agent_approval') refreshSessions(); return; }
    if (evt.type === 'agent_delta' || evt.type === 'agent_reasoning') {
      hideThinking();
      if (!state.streamEl) { state.streamEl = addMsg('assistant', ''); }
      const key = evt.type === 'agent_reasoning' ? 'think' : 'raw';
      state.streamEl.dataset[key] = (state.streamEl.dataset[key] ?? '') + evt.text;
      renderStream();
      scrollDown();
    }
    if (evt.type === 'agent_stats') $('tps').textContent = statLine(evt);
    if (evt.type === 'agent_done') {
      hideThinking();
      if (state.streamEl) {
        if (evt.text) state.streamEl.dataset.raw = evt.text;
        finishStream();
      }
      scrollDown();
    }
    if (evt.type === 'agent_tool') { hideThinking(); finishStream(); toolCard(evt.tool, evt.args); showThinking(); }
    if (evt.type === 'agent_approval') { hideThinking(); approvalCard(evt); }
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}
function finishStream() {
  if (state.streamEl) { renderStream(true); state.streamEl = null; }
}

// ---------- reasoning rendering ----------
// Reasoning arrives two ways: separate reasoning_content deltas (dataset.think)
// or inline <think> tags in content (parsed out of dataset.raw). Both land in
// one collapsible block — open while the model is still thinking, collapsed
// once the answer starts.
function parseThink(raw) {
  let think = '', answer = '', rest = raw ?? '', streaming = false;
  while (rest) {
    const open = rest.indexOf('<think>'), close = rest.indexOf('</think>');
    if (close >= 0 && (open < 0 || close < open)) { // template swallowed the opening tag
      think += rest.slice(0, close); rest = rest.slice(close + 8); continue;
    }
    if (open >= 0) {
      answer += rest.slice(0, open);
      const c = rest.indexOf('</think>', open);
      if (c < 0) { think += rest.slice(open + 7); rest = ''; streaming = true; break; }
      think += rest.slice(open + 7, c); rest = rest.slice(c + 8); continue;
    }
    answer += rest; rest = '';
  }
  return { think: think.trim(), answer: answer.trim(), streaming };
}
const thinkHTML = (think, open) => think
  ? `<details class="think"${open ? ' open' : ''}><summary>reasoning</summary><div class="think-body">${esc(think)}</div></details>`
  : '';
function renderStream(final = false) {
  const el = state.streamEl; if (!el) return;
  const p = parseThink(el.dataset.raw ?? '');
  const extra = (el.dataset.think ?? '').trim();
  const think = extra && p.think ? `${extra}\n${p.think}` : extra || p.think;
  const stillThinking = !final && (p.streaming || (think && !p.answer));
  el.innerHTML = thinkHTML(think, stillThinking)
    + `<span class="answer">${esc(p.answer)}${final ? '' : '<span class="caret"></span>'}</span>`;
}
function addAssistant(text) {
  const el = addMsg('assistant', '');
  const p = parseThink(text);
  el.innerHTML = thinkHTML(p.think, false) + `<span class="answer">${esc(p.answer)}</span>`;
  return el;
}
function addReasoning(text) {
  const el = addMsg('assistant', '');
  el.innerHTML = thinkHTML(text, false);
  return el;
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
