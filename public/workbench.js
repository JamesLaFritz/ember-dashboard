// workbench.js — agentic chat against local LM Studio models with
// Claude-Code-style approval cards for writes and shell commands.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const state = { session: null, streamEl: null };

init();
async function init() {
  const cfg = await (await fetch('/api/config')).json();
  $('workspace').innerHTML = cfg.workspaces.map(w => `<option>${esc(w)}</option>`).join('');
  $('preset').innerHTML = cfg.presets.map(p => `<option>${esc(p)}</option>`).join('');
  $('tools').innerHTML = cfg.tools.map(t =>
    `<div class="row"><span class="when ${t.needsApproval ? '' : 'gold'}">${t.needsApproval ? 'ask' : 'auto'}</span><span class="mono">${t.name}</span></div>`).join('');
  await refreshModels();
  connectWS();
  $('newSession').onclick = newSession;
  $('loadBtn').onclick = () => lmAction('load');
  $('unloadBtn').onclick = () => lmAction('unload');
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
}

async function refreshModels() {
  const res = await (await fetch('/api/lm/models')).json();
  $('chip-lm').classList.toggle('on', !!res.ok);
  if (!res.ok) { $('model').innerHTML = '<option>LM Studio offline</option>'; return; }
  $('model').innerHTML = res.models.filter(m => m.type === 'llm').map(m =>
    `<option value="${esc(m.key)}">${esc(m.name)}${m.loaded ? ' · loaded' : ''}</option>`).join('');
}
async function lmAction(kind) {
  const model = $('model').value;
  addMsg('reason', `${kind}ing ${model}…`);
  await fetch(`/api/lm/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
  await refreshModels();
  addMsg('reason', `${model} ${kind} complete.`);
}

async function newSession() {
  const res = await (await fetch('/api/agent/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: $('model').value, workspace: $('workspace').value, preset: $('preset').value }),
  })).json();
  if (res.error) return addMsg('reason', `Session error: ${res.error}`);
  state.session = res.session;
  $('sessionBadge').textContent = `session ${res.session}`;
  $('composer-input').disabled = false;
  $('chat').innerHTML = '';
  addMsg('reason', `Session ${res.session} · ${$('preset').value} · ${$('workspace').value}`);
}

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
}

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (m) => {
    const evt = JSON.parse(m.data);
    if (evt.session && evt.session !== state.session) return;
    if (evt.type === 'agent_delta') {
      if (!state.streamEl) state.streamEl = addMsg('assistant', '');
      state.streamEl.dataset.raw = (state.streamEl.dataset.raw ?? '') + evt.text;
      state.streamEl.innerHTML = esc(state.streamEl.dataset.raw) + '<span class="caret"></span>';
      scrollDown();
    }
    if (evt.type === 'agent_done') {
      if (state.streamEl) { state.streamEl.innerHTML = esc(evt.text ?? state.streamEl.dataset.raw ?? ''); state.streamEl = null; }
      scrollDown();
    }
    if (evt.type === 'agent_tool') {
      finishStream();
      const el = document.createElement('div');
      el.className = 'toolcard';
      el.innerHTML = `<span class="name">TOOL · ${esc(evt.tool)}</span><br><span class="meta">${esc(evt.args ?? '')}</span>`;
      $('chat').appendChild(el);
      scrollDown();
    }
    if (evt.type === 'agent_approval') approvalCard(evt);
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}
function finishStream() {
  if (state.streamEl) { state.streamEl.innerHTML = esc(state.streamEl.dataset.raw ?? ''); state.streamEl = null; }
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
    if (d === 'always') addAllow(evt.tool, evt.detail);
  });
  $('chat').appendChild(el);
  scrollDown();
}
function addAllow(tool, detail) {
  const a = $('allowlist');
  if (a.firstChild?.nodeName === 'SPAN') a.innerHTML = '';
  a.insertAdjacentHTML('beforeend', `<div class="row"><span class="when gold">✓</span><span class="mono">${esc(tool === 'run_command' ? detail.split(' ').slice(0, 2).join(' ') : tool)}</span></div>`);
}

function addMsg(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  $('chat').appendChild(el);
  scrollDown();
  return el;
}
const scrollDown = () => window.scrollTo({ top: document.body.scrollHeight });
