// hud.js — Jarvis HUD wiring: vitals, deck, assistant, popups, voice.
const $ = (id) => document.getElementById(id);
const state = { runs: new Map(), voiceOk: false, recording: null };

// ---------- boot ----------
init();
async function init() {
  const cfg = await (await fetch('/api/config')).json();
  buildDeck(cfg.skills);
  refreshVitals();
  setInterval(refreshVitals, 60_000);
  probeStatus();
  connectWS();
  $('ask').addEventListener('submit', (e) => { e.preventDefault(); ask($('ask-input').value); });
  wireVoice();
}

// ---------- vitals ----------
async function refreshVitals() {
  const v = await (await fetch('/api/vitals')).json();
  const b = v.aralon.brief;
  $('v-brief').textContent = b ? `${b.done}/${b.total}` : '—';
  $('v-brief-bar').style.width = b && b.total ? `${(100 * b.done / b.total).toFixed(0)}%` : '0%';
  $('v-loops').textContent = v.aralon.openLoops;
  $('v-devlog').textContent = v.aralon.daysSinceDevlog == null ? 'never' : `${v.aralon.daysSinceDevlog}d ago`;
  $('v-wiki').textContent = v.vault.wikiPages;
  $('v-raw').textContent = v.vault.rawLoose;
  $('v-session').textContent = v.vault.lastSessionAgeDays == null ? '—' : `${v.vault.lastSessionAgeDays}d ago`;
  $('v-articles').textContent = `${v.writing.articlesThisMonth}/${v.writing.target}`;
  $('v-ideas').textContent = v.writing.parkedIdeas;

  $('v-directives').innerHTML = v.daily.exists && v.daily.directives.length
    ? v.daily.directives.map((d, i) => row(String(i + 1).padStart(3, '0'), esc(d))).join('')
    : '<span class="meta">no daily note yet — run Plan Today</span>';
  $('schedule').innerHTML = v.daily.exists && v.daily.schedule.length
    ? v.daily.schedule.map(s => `<div class="row"><span class="when">·</span><span>${esc(s)}</span></div>`).join('')
    : '<span class="meta">—</span>';
  $('news').innerHTML = v.news.exists
    ? ['ai', 'unity', 'unreal'].flatMap(k => v.news[k].slice(0, 2).map(h =>
        `<div class="row"><span class="when gold">${k.toUpperCase()}</span><a href="${v.news.uri}">${esc(h)}</a></div>`)).join('')
    : '<span class="meta">no trends report yet — run Trend Watch</span>';
}
const row = (when, text) => `<div class="row"><span class="when">${when}</span><span>${text}</span></div>`;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- skill deck ----------
function buildDeck(skills) {
  $('deck').innerHTML = skills.map((s, i) =>
    `<button data-id="${s.id}" data-builtin="${s.builtin ? 1 : 0}"><span>${esc(s.label)}</span><span class="idx">${String(i + 1).padStart(2, '0')}</span></button>`).join('');
  $('deck').addEventListener('click', async (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.builtin === '1') return ask('rundown');
    btn.classList.add('running');
    const res = await (await fetch('/api/skill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: btn.dataset.id }) })).json();
    if (res.runId) state.runs.set(res.runId, btn.dataset.id);
    popup({ title: `${btn.dataset.id.toUpperCase()} · QUEUED`, body: 'Headless Claude is on it.', progress: true, id: res.runId });
  });
}

// ---------- assistant ----------
async function ask(text) {
  text = text.trim(); if (!text) return;
  $('ask-input').value = '';
  $('transcript').textContent = '…';
  const res = await (await fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })).json();
  $('transcript').textContent = res.reply ?? '';
  for (const p of res.popups ?? []) popup({ title: p.title, body: '', uri: p.uri, rel: p.rel });
  if (res.uri) location.href = res.uri; // open-in-obsidian intents
  speak(res.reply);
}

// ---------- popups & trail ----------
function popup({ title, body, uri, rel, progress, id }) {
  const el = document.createElement('div');
  el.className = 'card';
  if (id) el.dataset.run = id;
  el.innerHTML = `<div class="t">${esc(title)}</div><div class="b">${esc(body ?? '')}</div>` +
    (progress ? '<div class="progress"><i></i></div>' : '') +
    `<div class="actions">${uri ? `<a class="ghost" href="${uri}">Open in Obsidian</a>` : ''}` +
    (rel ? `<a class="ghost" href="/reports.html#${encodeURIComponent(rel)}">Read</a>` : '') +
    `<button class="ghost" onclick="this.closest('.card').remove()">Dismiss</button></div>`;
  $('popups').prepend(el);
  while ($('popups').children.length > 5) $('popups').lastChild.remove();
  if (rel || uri) trail(title, rel, uri);
}
function trail(title, rel, uri) {
  const t = $('trail');
  if (t.firstChild?.classList?.contains('meta') || t.firstChild?.nodeName === 'SPAN') t.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'row';
  d.innerHTML = `<span class="when">${new Date().toTimeString().slice(0, 5)}</span><a href="${uri ?? '#'}">${esc(title)}</a>`;
  t.prepend(d);
  while (t.children.length > 6) t.lastChild.remove();
}

// ---------- websocket: skill progress ----------
function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (m) => {
    const evt = JSON.parse(m.data);
    if (evt.type === 'skill_progress') {
      const card = document.querySelector(`.card[data-run="${evt.id}"] .b`);
      if (card) card.textContent = `${evt.tool}${evt.detail ? ' · ' + evt.detail : ''}`;
    }
    if (evt.type === 'skill_done') {
      const card = document.querySelector(`.card[data-run="${evt.id}"]`);
      if (card) {
        card.querySelector('.progress')?.remove();
        card.querySelector('.t').textContent = `${evt.skillId.toUpperCase()} · ${evt.status.toUpperCase()}`;
        card.querySelector('.b').textContent = (evt.summary ?? '').slice(0, 260);
      }
      document.querySelector(`.deck button[data-id="${evt.skillId}"]`)?.classList.remove('running');
      refreshVitals();
      if (evt.status === 'done' && evt.summary) speak(summarizeForSpeech(evt.summary));
    }
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}
const summarizeForSpeech = (s) => s.split(/\n+/).slice(0, 2).join(' ').slice(0, 280);

// ---------- status chips ----------
async function probeStatus() {
  const lm = await (await fetch('/api/lm/models')).json();
  $('chip-lm').classList.toggle('on', !!lm.ok);
  const voice = await (await fetch('/api/voice/health')).json();
  state.voiceOk = !!voice.ok;
  $('chip-voice').classList.toggle('ok', state.voiceOk);
}

// ---------- voice (Phase 2 sidecar; push-to-talk) ----------
function wireVoice() {
  const orb = $('orb');
  const start = () => startRec();
  const stop = () => stopRec();
  orb.addEventListener('mousedown', start);
  orb.addEventListener('mouseup', stop);
  document.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target.tagName !== 'INPUT' && !e.repeat) { e.preventDefault(); start(); } });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); stop(); } });
}
async function startRec() {
  if (!state.voiceOk || state.recording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      $('orb').classList.remove('listening');
      const blob = new Blob(chunks, { type: rec.mimeType });
      $('transcript').textContent = 'transcribing…';
      const res = await (await fetch('/api/voice/stt', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob })).json();
      if (res.text) { $('ask-input').value = res.text; ask(res.text); }
      else $('transcript').textContent = 'Voice sidecar could not transcribe that.';
    };
    state.recording = rec;
    rec.start();
    $('orb').classList.add('listening');
    $('transcript').textContent = 'listening…';
  } catch { $('transcript').textContent = 'Microphone unavailable.'; }
}
function stopRec() {
  if (state.recording) { state.recording.stop(); state.recording = null; }
}
async function speak(text) {
  if (!state.voiceOk || !text) return;
  try {
    const res = await fetch('/api/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!res.ok) return;
    new Audio(URL.createObjectURL(await res.blob())).play();
  } catch { /* voice is optional garnish */ }
}
