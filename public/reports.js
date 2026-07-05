// reports.js — the archival reading room. Renders vault markdown as museum plaques.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

init();
async function init() {
  const groups = await (await fetch('/api/reports')).json();
  const archive = $('archive');
  let idx = 0;
  for (const [group, files] of Object.entries(groups)) {
    if (!files.length) continue;
    const grp = document.createElement('div');
    grp.className = 'grp';
    grp.innerHTML = `<h4>${group}</h4>` + files.map(f =>
      `<div class="item" data-rel="${esc(f.rel)}" data-uri="${esc(f.uri)}">
         <span class="idx">${String(++idx).padStart(3, '0')}</span>
         <span><span class="nm">${esc(f.name)}</span><br><span class="meta">${new Date(f.mtime).toISOString().slice(0, 16).replace('T', ' · ')}</span></span>
       </div>`).join('');
    archive.appendChild(grp);
  }
  archive.addEventListener('click', (e) => {
    const item = e.target.closest('.item'); if (!item) return;
    document.querySelectorAll('.item.sel').forEach(i => i.classList.remove('sel'));
    item.classList.add('sel');
    load(item.dataset.rel, item.dataset.uri);
  });
  // deep-link: /reports.html#<rel>
  const target = decodeURIComponent(location.hash.slice(1));
  if (target) document.querySelector(`.item[data-rel="${CSS.escape(target)}"]`)?.click();
}

async function load(rel, uri) {
  const doc = await (await fetch(`/api/report?rel=${encodeURIComponent(rel)}`)).json();
  const name = rel.split('/').pop().replace(/\.md$/i, '');
  $('r-meta').textContent = rel.toUpperCase();
  $('r-title').textContent = name;
  $('r-sub').textContent = rel.split('/').slice(0, -1).join(' · ') || 'Vault';
  $('r-body').innerHTML = md(stripFrontmatter(doc.text));
  $('r-actions').innerHTML =
    `<a class="ghost" href="${esc(uri)}">Open in Obsidian</a>
     <button class="ghost" id="speakBtn">Speak this report</button>
     <button class="ghost" onclick="navigator.clipboard.writeText(document.getElementById('r-body').innerText)">Copy</button>`;
  $('speakBtn').onclick = () => speak($('r-body').innerText.slice(0, 900));
  // TOC from H2s
  const heads = [...$('r-body').querySelectorAll('h2')];
  $('toc').innerHTML = heads.length
    ? heads.map((h, i) => { h.id = `sec${i}`; return `<div class="row"><span class="when gold">§</span><a href="#sec${i}">${esc(h.textContent)}</a></div>`; }).join('')
    : '<span class="meta">—</span>';
}

const stripFrontmatter = (t) => t.replace(/^---\n[\s\S]*?\n---\n/, '');

// Minimal markdown renderer — headings, lists, checkboxes, bold/italic/code,
// links + wikilinks, blockquotes, tables. Enough for vault reports.
function md(src) {
  const lines = src.split('\n');
  let html = '', list = null, quote = false, table = false;
  const closeAll = () => { if (list) { html += `</${list}>`; list = null; } if (quote) { html += '</blockquote>'; quote = false; } if (table) { html += '</table>'; table = false; } };
  for (let raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*$/.test(line)) { closeAll(); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { closeAll(); const l = m[1].length; html += `<h${l + 1}>${inline(m[2])}</h${l + 1}>`; continue; }
    if ((m = line.match(/^>\s?(.*)/))) { if (!quote) { closeAll(); html += '<blockquote>'; quote = true; } html += inline(m[1]) + '<br>'; continue; }
    if (/^\|.*\|$/.test(line)) {
      if (/^\|[\s\-|:]+\|$/.test(line)) continue; // separator row
      if (!table) { closeAll(); html += '<table>'; table = true; }
      const cells = line.slice(1, -1).split('|').map(c => inline(c.trim()));
      html += `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
      continue;
    }
    if ((m = line.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)/i))) { if (list !== 'ul') { closeAll(); html += '<ul>'; list = 'ul'; } html += `<li><span class="${m[1] === ' ' ? 'meta' : 'gold'}">[${m[1]}]</span> ${inline(m[2])}</li>`; continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { closeAll(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { if (list !== 'ol') { closeAll(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
    closeAll();
    html += `<p>${inline(line)}</p>`;
  }
  closeAll();
  return html;
}
function inline(s) {
  return esc(s)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<a>$2</a>')
    .replace(/\[\[([^\]]+)\]\]/g, '<a>$1</a>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

async function speak(text) {
  try {
    const res = await fetch('/api/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (res.ok) new Audio(URL.createObjectURL(await res.blob())).play();
  } catch { /* optional */ }
}
