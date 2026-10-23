// ---------- State (saved in the browser for now; a database comes later) ----------
const slim = ({ preview, ...rest }) => rest; // preview links expire, so they are never stored
let playlist = JSON.parse(localStorage.getItem('musicbox:playlist') || '[]').map(slim);
let playlistName = localStorage.getItem('musicbox:name') || 'My playlist';
const audio = new Audio();
let playingId = null;

const $ = (id) => document.getElementById(id);
const API_BASE = ''; // same origin: the server serves the page and the API
const api = async (path) => {
  try {
    const response = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(45000) }); // free hosts can take a while to wake up
    if (!response.ok) {
      const body = await response.text();
      let details = body.slice(0, 300);
      try {
        const payload = JSON.parse(body);
        details = payload.error || payload.message || details;
      } catch { /* Keep the response text for non-JSON errors. */ }
      throw new Error(`Request failed: ${response.status} ${path}${details ? ` — ${details}` : ''}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`[API] GET ${path} failed:`, error);
    throw error;
  }
};

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- Rendering ----------
function trackRow(t, { action, onAction }) {
  const li = document.createElement('li');
  li.className = 'track';

  const img = document.createElement('img');
  img.src = t.cover || ''; img.alt = ''; img.loading = 'lazy'; img.draggable = false;

  const meta = document.createElement('div'); meta.className = 'meta';
  const title = document.createElement('div'); title.className = 'title'; title.textContent = t.title;
  const artist = document.createElement('div'); artist.className = 'artist'; artist.textContent = t.artist;
  meta.append(title, artist);

  const play = document.createElement('button');
  play.className = 'icon' + (playingId === t.id ? ' playing' : '');
  play.textContent = playingId === t.id ? '❚❚' : '▶';
  play.setAttribute('aria-label', `Preview ${t.title}`);
  play.onclick = () => togglePreview(t);

  const act = document.createElement('button');
  act.className = 'icon ' + action;
  act.textContent = action === 'add' ? '+' : '×';
  act.setAttribute('aria-label', `${action === 'add' ? 'Add' : 'Remove'} ${t.title}`);
  act.onclick = () => onAction(t, li);

  li.append(img, meta, play, act);
  return li;
}

function renderList(ul, tracks, opts) {
  ul.replaceChildren(...tracks.map((t) => trackRow(t, opts)));
}

function skeleton(ul) {
  ul.innerHTML = '<li class="track skeleton"><span class="sk-img"></span><span class="sk-bars"></span></li>'.repeat(5);
}

function stateRow(ul, text, retry) {
  const li = document.createElement('li');
  li.className = 'state'; li.textContent = text;
  if (retry) {
    const b = document.createElement('button');
    b.className = 'ghost'; b.textContent = 'Retry'; b.onclick = retry;
    li.append(b);
  }
  ul.replaceChildren(li);
}

const addOpts = {
  action: 'add',
  onAction: (t, li) => {
    addTrack(t);
    li.classList.add('leaving');
    setTimeout(() => li.remove(), 250);
  }
};

function renderPlaylist() {
  const ul = $('playlist');
  renderList(ul, playlist, {
    action: 'remove',
    onAction: (t, li) => { li.classList.add('leaving'); setTimeout(() => removeTrack(t.id), 220); }
  });
  [...ul.children].forEach((li, i) => { li.draggable = true; li.dataset.id = playlist[i].id; });
  $('count').textContent = playlist.length;
  $('empty').hidden = playlist.length > 0;
  $('exportBtn').disabled = playlist.length === 0;
  $('sugSlot').hidden = $('sugBox').hidden = playlist.length === 0;
  updateSuggestionsStickyState();
}

// ---------- Actions ----------
function save() { localStorage.setItem('musicbox:playlist', JSON.stringify(playlist.map(slim))); }

function addTrack(t) {
  if (playlist.some((p) => p.id === t.id)) return;
  playlist.push(t); shownSuggestionIds.clear(); save(); renderPlaylist(); loadSuggestions();
  const c = $('count'); c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump');
}

function removeTrack(id) {
  playlist = playlist.filter((p) => p.id !== id); shownSuggestionIds.clear(); save(); renderPlaylist(); renderResults(); loadSuggestions();
}

// Preview links expire, so saved songs fetch a fresh one when played
let playSeq = 0;
async function togglePreview(t) {
  if (playingId === t.id) { audio.pause(); playingId = null; renderPlaylist(); refreshResults(); return; }
  const seq = ++playSeq;
  const fresh = async () => (await api('/api/track/' + t.id)).preview;
  try {
    try { audio.src = t.preview || (await fresh()); await audio.play(); }
    catch { audio.src = await fresh(); await audio.play(); }
    if (seq !== playSeq) return;
    playingId = t.id;
  } catch {
    if (seq !== playSeq) return;
    playingId = null; audio.pause();
    toast('No preview available for this song');
  }
  renderPlaylist(); refreshResults();
}
audio.onended = () => { playingId = null; renderPlaylist(); refreshResults(); };

// ---------- Drag to reorder (mouse) ----------
const plUl = $('playlist');
let dragEl = null;
plUl.addEventListener('dragstart', (e) => {
  dragEl = e.target.closest('li.track');
  if (!dragEl) return;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragEl.dataset.id);
  setTimeout(() => dragEl && dragEl.classList.add('dragging'), 0);
});
plUl.addEventListener('dragover', (e) => {
  if (!dragEl) return;
  e.preventDefault();
  const after = [...plUl.children].filter((li) => li !== dragEl)
    .find((li) => { const r = li.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
  plUl.insertBefore(dragEl, after || null);
});
plUl.addEventListener('dragend', () => {
  if (!dragEl) return;
  dragEl.classList.remove('dragging'); dragEl = null;
  const byId = new Map(playlist.map((t) => [t.id, t]));
  playlist = [...plUl.children].map((li) => byId.get(li.dataset.id)).filter(Boolean);
  save();
});

// ---------- Results & suggestions ----------
let currentResults = [];
let currentSuggestions = [];
let resultsState = 'ok'; // ok | loading | error
let sugState = 'ok';
let searchSeq = 0; // makes sure only the latest search can update the list
let sugSeq = 0;
let retryResults = () => { };
const shownSuggestionIds = new Set();
const inPlaylist = (t) => playlist.some((p) => p.id === t.id);

function renderResults() {
  const ul = $('results');
  if (resultsState === 'loading') return skeleton(ul);
  if (resultsState === 'error') return stateRow(ul, 'Couldn’t load songs. The server may be waking up.', retryResults);
  const list = currentResults.filter((t) => !inPlaylist(t));
  if (!list.length) return stateRow(ul, 'No songs found.');
  renderList(ul, list, addOpts);
}
function renderSuggestions() {
  const ul = $('suggestions');
  if (sugState === 'loading') return skeleton(ul);
  const retry = () => loadSuggestions({ refresh: true });
  if (sugState === 'error') return stateRow(ul, 'Couldn’t load suggestions.', retry);
  const list = currentSuggestions.filter((t) => !inPlaylist(t));
  if (!list.length) return stateRow(ul, 'No suggestions right now.', retry);
  renderList(ul, list, addOpts);
}
function refreshResults() {
  renderResults();
  renderSuggestions();
}

async function loadResults(path, title) {
  const seq = ++searchSeq;
  $('findTitle').textContent = title;
  retryResults = () => loadResults(path, title);
  resultsState = 'loading'; renderResults();
  try {
    const data = await api(path);
    if (seq !== searchSeq) return;
    currentResults = data; resultsState = 'ok';
  } catch {
    if (seq !== searchSeq) return;
    currentResults = []; resultsState = 'error';
  }
  renderResults();
}
const showTrending = () => loadResults('/api/trending', 'Trending now');

let searchTimer;
$('q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchSeq++; // invalidates any search still in flight
  const q = e.target.value.trim();
  if (!q) return showTrending();
  searchTimer = setTimeout(() => loadResults('/api/search?q=' + encodeURIComponent(q), `Results for “${q}”`), 300);
});

// ---------- Sticky suggestions box ----------
let stickyStateFrame;
function updateSuggestionsStickyState() {
  if (stickyStateFrame) cancelAnimationFrame(stickyStateFrame);
  stickyStateFrame = requestAnimationFrame(() => {
    const slot = $('sugSlot');
    const box = $('sugBox');
    if (slot.hidden) {
      box.classList.remove('is-sticky');
      return;
    }
    const stickyBottom = parseFloat(getComputedStyle(slot).getPropertyValue('--sticky-bottom'));
    const slotBottom = slot.getBoundingClientRect().bottom;
    box.classList.toggle('is-sticky', slotBottom > window.innerHeight - stickyBottom + 1);
  });
}
window.addEventListener('scroll', updateSuggestionsStickyState, { passive: true });
window.addEventListener('resize', updateSuggestionsStickyState);

function shuffleTracks(tracks) {
  const shuffled = [...tracks];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function loadSuggestions({ refresh = false } = {}) {
  const seq = ++sugSeq;
  if (!playlist.length) {
    currentSuggestions = []; sugState = 'ok';
    renderSuggestions();
    return;
  }

  const button = $('newRecsBtn');
  if (refresh) {
    button.disabled = true;
    button.textContent = 'Loading…';
  }
  if (refresh || !currentSuggestions.length) { sugState = 'loading'; renderSuggestions(); }

  const artists = [...new Set(playlist.map((t) => t.artistId))].slice(-3);
  const inList = new Set(playlist.map((t) => t.id));
  const previousSuggestionIds = new Set(currentSuggestions.map((t) => t.id));
  try {
    const sug = await api('/api/suggestions?artists=' + artists.join(','));
    if (seq !== sugSeq) return;
    const eligible = sug.filter((t) => !inList.has(t.id));
    let unseen = eligible.filter((t) => !shownSuggestionIds.has(t.id));

    if (refresh && unseen.length === 0) {
      shownSuggestionIds.clear();
      unseen = eligible.filter((t) => !previousSuggestionIds.has(t.id));
    }

    currentSuggestions = shuffleTracks(unseen).slice(0, 5);
    if (refresh && currentSuggestions.length < 5) {
      const selected = new Set(currentSuggestions.map((t) => t.id));
      const fallback = eligible.filter((t) =>
        !selected.has(t.id) && !previousSuggestionIds.has(t.id)
      );
      currentSuggestions.push(...shuffleTracks(fallback).slice(0, 5 - currentSuggestions.length));
    }
    currentSuggestions.forEach((t) => shownSuggestionIds.add(t.id));
    sugState = 'ok';
  } catch (error) {
    if (seq !== sugSeq) return;
    currentSuggestions = []; sugState = 'error';
    console.error('Could not load recommendations:', error);
  } finally {
    if (refresh) {
      button.disabled = false;
      button.textContent = 'New recommendations';
    }
    if (seq === sugSeq) renderSuggestions();
  }
}

// ---------- Export & share ----------
const plTitle = () => $('plName').value.trim() || 'My playlist';
const mmss = (d) => `${Math.floor((d || 0) / 60)}:${String((d || 0) % 60).padStart(2, '0')}`;
const asText = () => `${plTitle()}\n` + playlist.map((t, i) => `${i + 1}. ${t.title} – ${t.artist}`).join('\n');
const asCsv = () => {
  const q = (s) => `"${String(s ?? '').replaceAll('"', '""')}"`;
  return '\ufeffTitle,Artist,Duration\n' +
    playlist.map((t) => [q(t.title), q(t.artist), mmss(t.duration)].join(',')).join('\n');
};
const shareUrl = () =>
  `${location.origin}${location.pathname}#n=${encodeURIComponent(plTitle())}&t=${playlist.map((t) => t.id).join(',')}`;
const copy = (text, ok) =>
  navigator.clipboard.writeText(text).then(() => toast(ok), () => toast('Couldn’t copy. Your browser blocked it.'));

const menu = $('exportMenu');
$('exportBtn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
document.addEventListener('click', () => { menu.hidden = true; });
menu.addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (act === 'share') copy(shareUrl(), 'Share link copied');
  if (act === 'text') copy(asText(), 'Playlist copied as text');
  if (act === 'csv') {
    const blob = new Blob([asCsv()], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: plTitle().replace(/[^\w\-]+/g, '_') + '.csv'
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
});

async function loadShared() {
  const params = new URLSearchParams(location.hash.slice(1));
  const ids = (params.get('t') || '').split(',').filter((x) => /^\d+$/.test(x));
  if (!ids.length) return;
  history.replaceState(null, '', location.pathname);
  const name = params.get('n') || 'Shared playlist';
  if (playlist.length && !confirm(`Open the shared playlist “${name}”? It will replace your current playlist.`)) return;
  try {
    const tracks = await api('/api/tracks?ids=' + ids.join(','));
    if (!tracks.length) throw new Error('empty');
    playlist = tracks; playlistName = name;
    $('plName').value = name; localStorage.setItem('musicbox:name', name);
    shownSuggestionIds.clear(); save(); renderPlaylist(); renderResults(); loadSuggestions();
    toast(`Opened “${name}”`);
  } catch {
    toast('Couldn’t open the shared playlist');
  }
}

// ---------- Playlist name ----------
$('plName').value = playlistName;
$('plName').addEventListener('input', (e) => localStorage.setItem('musicbox:name', e.target.value));

// ---------- Theme (the saved theme is applied by a small script in <head> to avoid a flash) ----------
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('musicbox:theme', dark ? 'dark' : 'light');
});

// ---------- Account panel ----------
$('account').addEventListener('click', () => $('accountdiv').classList.toggle('show'));
$('closeAccount').addEventListener('click', () => $('accountdiv').classList.remove('show'));

// ---------- Start ----------
$('newRecsBtn').addEventListener('click', () => loadSuggestions({ refresh: true }));
renderPlaylist(); showTrending(); loadSuggestions(); loadShared();