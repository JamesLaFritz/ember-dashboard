// hud.js — Jarvis HUD wiring: vitals, deck, assistant, popups, voice.
const $ = (id) => document.getElementById(id);
const state = { runs: new Map(), voiceOk: false, recording: null };

// ---------- boot ----------
init();
async function init() {
  const cfg = await (await fetch('/api/config')).json();
  buildDeck(cfg.skills);
  buildModelPicker(cfg.hudModels ?? ['auto']);
  refreshVitals();
  setInterval(refreshVitals, 60_000);
  probeStatus();
  connectWS();
  $('ask').addEventListener('submit', (e) => { e.preventDefault(); ask($('ask-input').value); });
  wireVoice();
  wireSettings(cfg);
}

// ---------- settings (voice, speed, speak-aloud, STT model, responder) ----------
const settings = {
  voice: localStorage.getItem('emberVoice') ?? 'af_heart',
  speed: +(localStorage.getItem('emberSpeed') ?? 1.05),
  speak: (localStorage.getItem('emberSpeak') ?? '1') === '1',
  stt: localStorage.getItem('emberStt') ?? 'small.en',
};
const STT_MODELS = ['base.en', 'small.en', 'medium.en', 'distil-large-v3'];
// Kokoro v1.0 English voices — fallback when the sidecar is offline.
const FALLBACK_VOICES = ['af_alloy','af_aoede','af_bella','af_heart','af_jessica','af_kore','af_nicole','af_nova','af_river','af_sarah','af_sky','am_adam','am_echo','am_eric','am_fenrir','am_liam','am_michael','am_onyx','am_puck','bf_alice','bf_emma','bf_isabella','bf_lily','bm_daniel','bm_fable','bm_george','bm_lewis'];

async function wireSettings(cfg) {
  $('chip-settings').onclick = () => $('settings').hidden = !$('settings').hidden;
  $('set-close').onclick = () => $('settings').hidden = true;

  $('set-stt').innerHTML = STT_MODELS.map(m => `<option ${m === settings.stt ? 'selected' : ''}>${esc(m)}</option>`).join('');
  $('set-stt').onchange = () => { settings.stt = $('set-stt').value; localStorage.setItem('emberStt', settings.stt); };

  // Default responder mirrors the inline picker next to the ask box — one
  // stored value ('hudModel'), editable from either place.
  const models = cfg.hudModels ?? ['auto'];
  $('set-responder').innerHTML = models.map(m => `<option value="${esc(m)}" ${m === $('hud-model').value ? 'selected' : ''}>${esc(m.toUpperCase())}</option>`).join('');
  $('set-responder').onchange = () => {
    localStorage.setItem('hudModel', $('set-responder').value);
    $('hud-model').value = $('set-responder').value;
  };

  let voices = FALLBACK_VOICES;
  try {
    const res = await (await fetch('/api/voice/voices')).json();
    if (res.voices?.length) voices = res.voices;
  } catch { /* sidecar offline — fallback list */ }
  if (!voices.includes(settings.voice)) voices = [settings.voice, ...voices];
  $('set-voice').innerHTML = voices.map(v => `<option ${v === settings.voice ? 'selected' : ''}>${esc(v)}</option>`).join('');
  $('set-speed').value = settings.speed;
  $('set-speed-v').textContent = `${settings.speed.toFixed(2)}×`;
  $('set-speak').checked = settings.speak;

  $('set-voice').onchange = () => { settings.voice = $('set-voice').value; localStorage.setItem('emberVoice', settings.voice); };
  $('set-speed').oninput = () => {
    settings.speed = +$('set-speed').value;
    $('set-speed-v').textContent = `${settings.speed.toFixed(2)}×`;
    localStorage.setItem('emberSpeed', settings.speed);
  };
  $('set-speak').onchange = () => { settings.speak = $('set-speak').checked; localStorage.setItem('emberSpeak', settings.speak ? '1' : '0'); };
  $('set-test').onclick = () => speak('Forged in darkness. Built for discovery.', true);

  wireSkillModels(cfg.skills);
}

// Which Claude tier each headless skill run uses. Builtin (rundown) is
// answered locally, so it has no model to configure.
const RUN_MODELS = ['haiku', 'sonnet', 'opus'];
function wireSkillModels(skills) {
  const box = $('set-skill-models');
  const configurable = skills.filter(s => !s.builtin);
  box.innerHTML = configurable.map(s => `
    <label class="field">${esc(s.quickLabel ?? s.label)}
      <select data-id="${s.id}">${RUN_MODELS.map(m => `<option ${m === (s.model ?? 'sonnet') ? 'selected' : ''}>${m}</option>`).join('')}</select>
    </label>`).join('');
  box.addEventListener('change', (e) => {
    const sel = e.target.closest('select'); if (!sel) return;
    fetch('/api/skills/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sel.dataset.id, model: sel.value }) });
  });
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
// Quick row: parametrized one-shots (wikify <topic>, devlog <project>, …) —
// typed args required. Grid: the rest of config.json's skills, one click.
function buildDeck(skills) {
  const quick = skills.filter(s => s.quick || s.quickLabel);
  const grid = skills.filter(s => !s.quick);

  $('deck-quick').innerHTML = quick.map(s => `
    <div class="quick-item" data-id="${s.id}">
      <span class="qlabel">${esc(s.quickLabel ?? s.label)}</span>
      <div class="qrow">
        <input class="qinput" placeholder="${esc(s.quickPlaceholder ?? s.placeholder ?? '')}">
        <button class="qrun" title="run ${esc(s.quickLabel ?? s.label)}">→</button>
      </div>
    </div>`).join('');
  $('deck-quick').addEventListener('click', (e) => {
    if (e.target.closest('.qrun')) runQuick(e.target.closest('.quick-item'));
  });
  $('deck-quick').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('qinput')) { e.preventDefault(); runQuick(e.target.closest('.quick-item')); }
  });

  $('deck').innerHTML = grid.map((s, i) =>
    `<button data-id="${s.id}" data-builtin="${s.builtin ? 1 : 0}"><span>${esc(s.label)}</span><span class="idx">${String(i + 1).padStart(2, '0')}</span></button>`).join('');
  $('deck').addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    if (btn.dataset.builtin === '1') return ask('rundown');
    btn.classList.add('running');
    runSkill(btn.dataset.id);
  });
}
function runQuick(item) {
  const input = item.querySelector('.qinput');
  const args = input.value.trim();
  if (!args) { input.focus(); return; }
  item.classList.add('running');
  runSkill(item.dataset.id, args);
  input.value = '';
}
async function runSkill(id, args) {
  const body = args === undefined ? { id } : { id, args };
  const res = await (await fetch('/api/skill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (res.runId) state.runs.set(res.runId, id);
  popup({ title: `${id.toUpperCase()} · QUEUED`, body: 'Headless Claude is on it.', progress: true, id: res.runId });
}

// ---------- assistant ----------
// Who answers: auto (router decides — local for lookups, Claude for
// generation), local (LM Studio only), or a Claude tier. Sticky per browser.
function buildModelPicker(models) {
  const sel = $('hud-model');
  sel.innerHTML = models.map(m => `<option value="${esc(m)}">${esc(m.toUpperCase())}</option>`).join('');
  const saved = localStorage.getItem('hudModel');
  if (saved && models.includes(saved)) sel.value = saved;
  sel.onchange = () => {
    localStorage.setItem('hudModel', sel.value);
    const mirror = $('set-responder');
    if (mirror?.options.length) mirror.value = sel.value;
  };
}

async function ask(text) {
  text = text.trim(); if (!text) return;
  $('ask-input').value = '';
  $('transcript').textContent = '…';
  $('answeredBy').textContent = '';
  state.asking = true;      // arms the websocket to stream deltas into the transcript
  delete $('transcript').dataset.stream;
  const res = await (await fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model: $('hud-model').value }) })).json();
  state.asking = false;
  delete $('transcript').dataset.stream;
  $('transcript').textContent = res.reply ?? '';
  $('answeredBy').textContent = res.model ? `answered by ${res.model}` : '';
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
    // Local-model answers stream in live; the HTTP reply lands last and is
    // authoritative (it also strips any mid-hop chatter around tool calls).
    if (evt.type === 'assistant_delta' && state.asking) {
      const t = $('transcript');
      if (!t.dataset.stream) { t.textContent = ''; t.dataset.stream = '1'; }
      t.textContent += evt.text;
    }
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
      document.querySelector(`.deck-quick .quick-item[data-id="${evt.skillId}"]`)?.classList.remove('running');
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
  stopSpeaking(); // barge-in: talking over Ember cuts her off
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
      const res = await (await fetch('/api/voice/stt?model=' + encodeURIComponent(settings.stt), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob })).json();
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
// Chunked queue from speech.js — long replies start speaking immediately and
// play to the end; a new speak() supersedes whatever is still playing.
speech.onstate = (on) => $('orb').classList.toggle('speaking', on);
function speak(text, force = false) {
  if (!state.voiceOk || !text || (!settings.speak && !force)) return;
  readAloud(text);
}
const stopSpeaking = stopReading;
