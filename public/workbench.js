// workbench.js — agentic chat against local LM Studio models with
// Claude-Code-style approval cards, switchable sessions, and live LM status.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const state = {
  session: null, streamEl: null, presets: [], tools: [], allow: [], mcp: [], info: null,
  thinkDismissed: false,
  workspaces: [],       // managed list; a session binds one at creation
  models: [],           // last LM Studio inventory, loaded-first
  identityDefault: true, // what a new session starts with
};

init();
async function init() {
  const cfg = await (await fetch('/api/config')).json();
  state.presets = cfg.presets;
  state.tools = cfg.tools;
  state.identityDefault = cfg.identityDefault !== false;
  renderWorkspaces(cfg.workspaces);
  const presetOpts = cfg.presets.map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
  $('preset').innerHTML = presetOpts;
  $('dlgPreset').innerHTML = presetOpts;
  $('preset').onchange = changePreset;
  $('identity').checked = state.identityDefault;
  showPresetDesc();
  renderTools();
  renderAllow();
  renderSkills();
  renderMcp();
  await refreshModels();
  const sessions = await refreshSessions();
  // Sessions survive server restarts now — reopen where you left off.
  if (sessions.length) await switchSession(sessions[0].id);
  setInterval(refreshModels, 30_000);
  connectWS();
  $('newSession').onclick = openNewSession;
  $('dlgCancel').onclick = () => $('newSessionDlg').close();
  $('dlgWsAdd').onclick = () => addWorkspace('dlgWorkspace');
  $('newSessionForm').addEventListener('submit', (e) => { e.preventDefault(); createSession(); });
  $('sessionPicker').onchange = () => switchSession($('sessionPicker').value);
  $('loadBtn').onclick = () => lmAction('load', $('model').value);
  $('wsAdd').onclick = () => addWorkspace();
  $('mode').onchange = changeMode;
  $('compactBtn').onclick = compactNow;
  $('clearBtn').onclick = clearNow;
  $('autoCompact').onchange = toggleAutoCompact;
  $('identity').onchange = toggleIdentity;
  $('thinkpinClose').onclick = closeThinkPin;
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
}

// ---------- workspaces ----------
// Management only. Nothing here "selects" a workspace: a session binds one when
// it is created and keeps it for life, so a global current-workspace would be a
// value that silently fails to apply to the thing in front of you.
function renderWorkspaces(list, select) {
  state.workspaces = list ?? [];
  $('wsCount').textContent = `(${state.workspaces.length})`;
  const inUse = new Set((refreshSessions.last ?? []).map(s => s.workspace));
  $('workspaces').innerHTML = state.workspaces.length
    ? state.workspaces.map(w => `<div class="wsrow">
        <span class="wspath ${inUse.has(w) ? 'in-use' : ''}" title="${esc(w)}${inUse.has(w) ? ' — in use by a session' : ''}">${esc(w)}</span>
        <button class="x" data-ws="${esc(w)}" title="remove from the list (the folder itself is untouched)">✕</button></div>`).join('')
    : '<span class="meta">none</span>';
  // The dialog picks from the same list; keep the caller's choice selected.
  const want = select ?? $('dlgWorkspace').value;
  $('dlgWorkspace').innerHTML = state.workspaces.map(w =>
    `<option ${w === want ? 'selected' : ''}>${esc(w)}</option>`).join('');
}
$('workspaces').addEventListener('click', (e) => {
  const w = e.target.dataset?.ws;
  if (w) removeWorkspace(w);
});

// `target` is the id of a select to point at the new workspace, if any.
async function addWorkspace(target) {
  const p = prompt('Folder to add as a workspace (absolute path):');
  if (!p?.trim()) return;
  const res = await (await fetch('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p.trim() }) })).json();
  if (res.error) return addMsg('reason', `Workspace error: ${res.error}`);
  const added = res.workspaces[res.workspaces.length - 1];
  renderWorkspaces(res.workspaces, added);
  if (target) $(target).value = added;
  addMsg('reason', `Workspace added: ${added}`);
}
async function removeWorkspace(w) {
  // Sessions store an absolute path. Removing a workspace out from under one
  // does not break the session, but it does mean the path can no longer be
  // picked — and New Session validates against this list, so say so first.
  const users = (refreshSessions.last ?? []).filter(s => s.workspace === w);
  const warn = users.length
    ? `\n\n⚠️ ${users.length} session(s) use this workspace (${users.map(s => s.id).join(', ')}). They keep working, but you will not be able to create new ones here.`
    : '';
  if (!confirm(`Remove workspace from the list?\n${w}\n(The folder itself is untouched.)${warn}`)) return;
  const res = await (await fetch('/api/workspaces/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: w }) })).json();
  if (res.error) return addMsg('reason', `Workspace error: ${res.error}`);
  renderWorkspaces(res.workspaces);
}

// ---------- preset / permission mode / tools / allowlist ----------
// Both selects live above the composer and act on the CURRENT session:
// preset swaps the session's system prompt, perms swap the approval mode.
// With no session open they just seed the next New Session.
// ---------- clear (archive + reset) ----------
async function clearNow() {
  if (!state.session) return;
  if (!confirm('Archive this conversation and start fresh?\n\nThe session, model, workspace and approvals stay; the transcript is saved under .sessions/archive/ and can be read back later.')) return;
  const res = await (await fetch(`/api/agent/${state.session}/clear`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  if (res.error) return addMsg('reason', `Clear failed: ${res.error}`);
  $('chat').innerHTML = '';
  addMsg('reason', `Conversation cleared after ${res.turns} turn(s).`
    + (res.archive ? ` Archived to ${res.archive}.` : ' Nothing to archive.'));
}

// ---------- context compaction ----------
async function compactNow() {
  if (!state.session) return;
  addMsg('reason', 'Compacting context…');
  const res = await (await fetch(`/api/agent/${state.session}/compact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  if (res.error) return addMsg('reason', `Compact error: ${res.error}`);
  addMsg('reason', res.compacted
    ? `Context compacted: ~${fmtTok(res.before)} → ~${fmtTok(res.after)} tokens (older turns folded into a summary; your transcript above is unchanged).`
    : 'Nothing to compact yet — not enough prior turns.');
}
async function toggleAutoCompact() {
  if (!state.session) return;
  const res = await (await fetch(`/api/agent/${state.session}/autocompact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: $('autoCompact').checked }) })).json();
  if (res.error) return addMsg('reason', `Auto-compact error: ${res.error}`);
  addMsg('reason', `Auto-compact ${res.autoCompact ? 'on — the agent will summarize old turns as the context fills' : 'off'}.`);
}

// SOUL/USER in the system prompt, per session. Off is the correct setting for
// any comparison run: an identity file is part of the prompt, so two models
// under different identities are two prompts, not two models.
async function toggleIdentity() {
  if (!state.session) { renderSessionBar(); return; }   // pre-session: just the default for the next one
  const on = $('identity').checked;
  const res = await (await fetch(`/api/agent/${state.session}/identity`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }),
  })).json();
  if (res.error) {                       // mid-turn, or no such session — put the box back
    $('identity').checked = !on;
    return addMsg('reason', `Identity: ${res.error}`);
  }
  state.info = { ...(state.info ?? {}), identity: res.identity };
  renderSessionBar();
  const files = Object.entries(res.sources ?? {}).filter(([, v]) => v && v !== 'off').map(([k, v]) => `${k}: ${v}`).join(' · ');
  const said = res.identity
    ? `Identity ON — ${files || 'no SOUL/USER file found, so nothing was injected'}. Not a comparison-safe setting.`
    : 'Identity OFF — role instructions only. This is the correct setting for a benchmark run.';
  // Flipping mid-conversation is allowed but not free: the turns already in the
  // transcript were produced under the other system prompt.
  const warn = res.turnsSoFar
    ? ` ⚠️ ${res.turnsSoFar} turn(s) already ran under the previous setting — this transcript now spans two prompts. Clear the session for a clean run.`
    : '';
  addMsg('reason', said + warn);
}

async function changePreset() {
  showPresetDesc();
  if (!state.session) return;
  const res = await (await fetch(`/api/agent/${state.session}/preset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preset: $('preset').value }) })).json();
  if (res.error) return addMsg('reason', `Preset error: ${res.error}`);
  addMsg('reason', `Preset → ${res.preset} — system prompt swapped; takes effect next message.`);
  if (state.info) { state.info.preset = res.preset; renderSessionBar(); }
  refreshSessions();
}
async function changeMode() {
  if (!state.session) return; // no session yet — the value seeds the next New Session
  const res = await (await fetch(`/api/agent/${state.session}/mode`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: $('mode').value }) })).json();
  if (res.error) return addMsg('reason', `Mode error: ${res.error}`);
  addMsg('reason', `Permissions → ${res.mode.toUpperCase()}${res.mode === 'auto' ? ' — every write and command now runs without asking.' : res.mode === 'plan' ? ' — writes and commands are blocked; the agent can only read and propose.' : ''}`);
  if (state.info) { state.info.mode = res.mode; renderSessionBar(); }
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
// .claude/skills, plus user-level ~/.claude/skills. Follows the ACTIVE
// SESSION's workspace: there is no global workspace any more, and showing
// skills for a workspace no session is using would be showing what the agent
// in front of you cannot reach. Click a skill to prefill the composer.
async function renderSkills(workspace) {
  const ws = workspace ?? state.info?.workspace;
  if (!ws) return $('skills').innerHTML = '<span class="meta">— open a session</span>';
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
    ? `<span>GPU <span class="lm-model">${(gpu.usedMB / 1024).toFixed(1)} / ${(gpu.totalMB / 1024).toFixed(1)} GB</span> ${esc(gpu.name)}</span>`
    : '';
  $('chip-lm').classList.toggle('on', !!res.ok);
  if (!res.ok) {
    state.models = [];
    $('model').innerHTML = '<option>LM Studio offline</option>';
    $('dlgModel').innerHTML = '<option>LM Studio offline</option>';
    $('lmstatus').innerHTML = gpuRow + '<span class="meta">offline — run: lms server start</span>';
    return;
  }
  const llms = res.models.filter(m => m.type === 'llm');
  const labels = disambiguateModelLabels(llms);
  // Loaded models first, in both pickers: those are the ones that will answer
  // immediately, and everything else costs a load before the first token.
  state.models = llms
    .map((m, i) => ({ ...m, label: labels[i] }))
    .sort((a, b) => (b.loaded === true) - (a.loaded === true) || a.label.localeCompare(b.label));
  fillModelSelect('model');
  fillModelSelect('dlgModel');

  const loaded = state.models.filter(m => m.loaded);
  // Loaded models live here, next to the runtime indicator, each with its own
  // unload — the status list knows WHICH instance it is acting on, which a
  // dropdown-plus-button never did.
  $('lmstatus').innerHTML = [
    gpuRow,
    ...(loaded.length
      ? loaded.map(m => `<span title="${esc(m.key)}"><span class="lm-model">● ${esc(m.name)}</span>
          ${esc(m.quant ?? '?')} · ${m.sizeGB ?? '?'}GB · ctx ${fmtK(m.contextLength)}/${fmtK(m.maxContextLength)}<button
          class="x" data-unload="${esc(m.key)}" title="unload ${esc(m.key)}">✕</button></span>`)
      : ['<span class="meta">server up · no model loaded</span>']),
  ].filter(Boolean).join('<span class="lm-sep">·</span>');
}
// Preserves the current choice across a refresh; falls back to the first entry
// (which is a loaded model whenever one exists).
function fillModelSelect(id) {
  const current = $(id).value;
  $(id).innerHTML = state.models.map(m =>
    `<option value="${esc(m.key)}" title="${esc(m.key)}" ${m.key === current ? 'selected' : ''}>${esc(m.label)}${m.loaded ? ' ●' : ''}</option>`).join('');
}
$('lmstatus').addEventListener('click', (e) => {
  const key = e.target.dataset?.unload;
  if (key) lmAction('unload', key);
});
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

// Machine-level, never session-level: loading or unloading a model does not
// change what any running session is bound to.
async function lmAction(kind, model) {
  if (!model) return;
  const users = (refreshSessions.last ?? []).filter(s => s.model === model);
  if (kind === 'unload' && users.some(s => s.busy)
    && !confirm(`${model} is mid-turn in session ${users.find(s => s.busy).id}. Unload anyway?\nThe turn will fail.`)) return;
  addMsg('reason', `${kind}ing ${model}…`);
  const res = await (await fetch(`/api/lm/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) })).json();
  await refreshModels();
  addMsg('reason', res?.error ? `${model} ${kind} failed: ${res.error}` : `${model} ${kind} complete.`);
}

// ---------- sessions ----------
async function refreshSessions(selectId) {
  const res = await (await fetch('/api/agent/sessions')).json();
  const list = res.sessions ?? [];
  refreshSessions.last = list;
  // Which workspaces are spoken for is derived from the sessions, so the rail
  // has to be redrawn when they change — not only when the list itself does.
  if (state.workspaces.length) renderWorkspaces(state.workspaces);
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
      state.info = null; renderSessionBar(); renderSkills();
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
  $('autoCompact').checked = h.autoCompact !== false;
  $('identity').checked = h.identity !== false;
  if ([...$('preset').options].some(o => o.value === h.preset)) $('preset').value = h.preset;
  showPresetDesc();
  $('chat').innerHTML = '';
  state.info = { preset: h.preset, workspace: h.workspace, model: h.model, mode: h.mode ?? 'ask', identity: h.identity !== false };
  renderSessionBar();
  resetThinkPin();
  let lastThink = '';   // reopening a session should pin its newest reasoning
  for (const e of h.history ?? []) {
    if (e.kind === 'user') addMsg('user', e.text);
    else if (e.kind === 'assistant') addAssistant(e.text);
    else if (e.kind === 'reasoning') { addReasoning(e.text); lastThink = e.text; }
    else if (e.kind === 'compacted') addMsg('reason', `— context compacted (${e.reason}, ${e.folded} turn${e.folded === 1 ? '' : 's'} folded) —`);
    else if (e.kind === 'tool') toolCard(e.tool, e.args);
    else if (e.kind === 'approval') toolCard(e.tool, `${e.args} → ${e.decision.toUpperCase()}`);
  }
  if (lastThink) updateThinkPin(lastThink, false);
  state.allow = h.allowlist ?? [];
  state.mcp = h.mcpServers ?? [];
  renderTools();
  renderAllow();
  renderSkills(h.workspace);
  renderMcp();
  await refreshSessions(id);
}

// Workspace and model are bound for the life of the session, so they are chosen
// here and nowhere else. Preset, perms and identity are seeded here too but stay
// changeable in the footer, because all three are legitimately toggled mid-work.
function openNewSession() {
  if (!state.workspaces.length) {
    addMsg('reason', 'No workspaces configured — add one first (Workspaces rail).');
    $('wsFold').open = true;
    return;
  }
  // Seed from the open session: the usual next action is another session much
  // like this one, not one built from page defaults.
  const i = state.info;
  if (i?.workspace && state.workspaces.includes(i.workspace)) $('dlgWorkspace').value = i.workspace;
  if (i?.model && state.models.some(m => m.key === i.model)) $('dlgModel').value = i.model;
  $('dlgPreset').value = i?.preset ?? $('preset').value;
  $('dlgMode').value = i?.mode ?? 'ask';
  $('dlgIdentity').checked = i ? i.identity !== false : state.identityDefault;
  updateDlgNote();
  $('dlgModel').onchange = updateDlgNote;
  $('newSessionDlg').showModal();
}
function updateDlgNote() {
  const m = state.models.find(x => x.key === $('dlgModel').value);
  $('dlgNote').textContent = !m ? ''
    : m.loaded ? `${m.key} is loaded — ctx ${fmtK(m.contextLength)}.`
    : `${m.key} is not loaded. LM Studio will load it on the first message.`;
}

async function createSession() {
  const picked = {
    model: $('dlgModel').value, workspace: $('dlgWorkspace').value,
    preset: $('dlgPreset').value, mode: $('dlgMode').value, identity: $('dlgIdentity').checked,
  };
  const res = await (await fetch('/api/agent/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(picked),
  })).json();
  if (res.error) return addMsg('reason', `Session error: ${res.error}`);
  $('newSessionDlg').close();
  // The footer controls act on the open session, so they follow it.
  $('preset').value = picked.preset;
  $('mode').value = picked.mode;
  $('identity').checked = picked.identity;
  showPresetDesc();
  state.session = res.session;
  $('composer-input').disabled = false;
  $('chat').innerHTML = '';
  $('tps').textContent = '';
  state.allow = [];
  state.mcp = [];
  renderTools();
  renderAllow();
  renderMcp();
  state.info = { ...picked };
  renderSessionBar();
  renderSkills(picked.workspace);
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
      if (!state.streamEl) { state.streamEl = addMsg('assistant', ''); resetThinkPin(); }
      const key = evt.type === 'agent_reasoning' ? 'think' : 'raw';
      state.streamEl.dataset[key] = (state.streamEl.dataset[key] ?? '') + evt.text;
      renderStream();
      scrollDown();
    }
    if (evt.type === 'agent_stats') $('tps').textContent = statLine(evt);
    if (evt.type === 'agent_compacted') {
      finishStream();
      addMsg('reason', `— context ${evt.reason === 'auto' ? 'auto-' : ''}compacted: ~${fmtTok(evt.before)} → ~${fmtTok(evt.after)} tokens —`);
    }
    if (evt.type === 'agent_done') {
      hideThinking();
      $('thinkpinLive').hidden = true;
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

// ---------- pinned reasoning ----------
// A <details> inside the transcript scrolls away exactly when the model is
// mid-thought. This mirrors the newest reasoning above the chat, bounded and
// scrollable so it can never push the conversation off screen.
function updateThinkPin(text, live) {
  if (state.thinkDismissed || !text) return;
  const body = $('thinkpinBody');
  // Only autoscroll when already at the bottom, so scrolling back to read
  // something is not yanked away by the next delta.
  const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  body.textContent = text;
  $('thinkpinLive').hidden = !live;
  $('thinkpinMeta').textContent = `${text.length.toLocaleString()} chars`;
  $('thinkpin').hidden = false;
  if (atEnd) body.scrollTop = body.scrollHeight;
}
function closeThinkPin() {
  state.thinkDismissed = true;
  $('thinkpin').hidden = true;
}
// Dismissal covers the block you closed, not the feature: the next turn that
// reasons brings it back, so closing it once cannot silently disable it.
function resetThinkPin() {
  state.thinkDismissed = false;
  $('thinkpinBody').textContent = '';
  $('thinkpinMeta').textContent = '';
  $('thinkpin').hidden = true;
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
  updateThinkPin(think, stillThinking);
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

// Pinned above the transcript so the workspace you are writing to and the
// permission mode you are running under stay on screen. Previously this was the
// first chat message, which scrolled away the moment work started — exactly when
// "which folder is this touching, and is it gated?" starts to matter.
function renderSessionBar() {
  const bar = $('sessionbar');
  const i = state.info;
  if (!i || !state.session) { bar.hidden = true; bar.innerHTML = ''; return; }
  // constrained, not escaped: it lands in a class attribute as well as in text
  const raw = String(i.mode ?? 'ask').toLowerCase();
  const mode = ['ask', 'plan', 'auto'].includes(raw) ? raw : 'ask';
  const sep = '<span class="sb-sep">·</span>';
  // No session id here — the picker to the left of this line already names it.
  bar.innerHTML = [
    `<span>${esc(i.preset ?? '—')}</span>`,
    `<span>MODEL <b>${esc(i.model ?? '—')}</b></span>`,
    `<span class="sb-ws">${esc(i.workspace ?? '—')}</span>`,
    `<span class="sb-perm ${mode}">${mode.toUpperCase()}</span>`,
    `<span class="sb-soul ${i.identity === false ? 'off' : 'on'}">${i.identity === false ? 'NO SOUL' : 'SOUL'}</span>`,
  ].join(sep);
  bar.hidden = false;
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
