// speech.js — chunked read-aloud shared by the reading rooms (reports.js, reader.js).
// Kokoro renders a whole request to WAV before any audio returns, so a full
// article in one call means a long silent wait. Instead: split at sentence
// boundaries, play chunks back-to-back, and synthesize the next chunk while
// the current one plays. Voice/speed follow the HUD settings (localStorage).
const speech = { session: 0, playing: false, audio: null, resolve: null, button: null, label: '', onstate: null };

function speechChunks(text, max = 500) {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/);
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > max) { chunks.push(cur); cur = s; }
    else cur = cur ? cur + ' ' + s : s;
    while (cur.length > max) { chunks.push(cur.slice(0, max)); cur = cur.slice(max); } // pathological run-on
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function fetchTtsChunk(text) {
  return fetch('/api/voice/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voice: localStorage.getItem('emberVoice') ?? 'af_heart',
      speed: +(localStorage.getItem('emberSpeed') ?? 1.05),
    }),
  }).then(res => res.ok ? res.blob() : null);
}

async function readAloud(text, button) {
  if (speech.playing) {
    const sameButton = speech.button === button;
    stopReading();
    if (sameButton) return; // same button = plain stop; another doc's button = switch to it
  }
  const chunks = speechChunks(text);
  if (!chunks.length) return;
  const session = ++speech.session; // a newer readAloud invalidates this loop even mid-await
  speech.playing = true;
  speech.onstate?.(true);
  if (button) { speech.button = button; speech.label = button.textContent; button.textContent = 'Stop'; }
  try {
    let next = fetchTtsChunk(chunks[0]);
    for (let i = 0; i < chunks.length; i++) {
      const blob = await next;
      if (speech.session !== session || !speech.playing || !blob) break;
      if (i + 1 < chunks.length) next = fetchTtsChunk(chunks[i + 1]); // prefetch during playback
      const url = URL.createObjectURL(blob);
      await new Promise((done) => {
        speech.resolve = done; // lets stopReading() unblock a chunk that pause() would otherwise leave hanging
        const audio = new Audio(url);
        speech.audio = audio;
        audio.onended = audio.onerror = () => { URL.revokeObjectURL(url); done(); };
        audio.play().catch(done);
      });
      if (speech.session !== session || !speech.playing) return; // stopped or superseded — cleanup already ran
      speech.resolve = null;
    }
  } catch { /* voice is optional garnish */ }
  if (speech.session === session) stopReading();
}

function stopReading() {
  speech.playing = false;
  speech.onstate?.(false);
  if (speech.audio) { speech.audio.pause(); speech.audio = null; }
  if (speech.button) { speech.button.textContent = speech.label; speech.button = null; }
  if (speech.resolve) { const r = speech.resolve; speech.resolve = null; r(); }
}
