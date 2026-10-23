// ---------- State (saved in the browser for now; a database comes later) ----------
const slim = ({ preview, why, ...rest }) => rest; // preview links expire and "why" is only a hint, so neither is stored
const uid = () => Math.random().toString(36).slice(2, 9);
function loadLists() {
  try {
    const raw = JSON.parse(localStorage.getItem('musicbox:lists'));
    if (raw?.lists?.length) return raw;
  } catch { /* fall through to a fresh start */ }
  // First run, or upgrading from the single-playlist version
  const old = JSON.parse(localStorage.getItem('musicbox:playlist') || '[]').map(slim);
  const id = uid();
  return { activeId: id, lists: [{ id, name: localStorage.getItem('musicbox:name') || 'My playlist', tracks: old }] };
}
const store = loadLists();
const activeList = () => store.lists.find((l) => l.id === store.activeId) || store.lists[0];
let playlist = activeList().tracks;
const audio = new Audio();
let playingId = null;

const $ = (id) => document.getElementById(id);
const API_BASE = 'https://musibox.onrender.com';
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

const apiPost = async (path, body, opts = {}) => {
  const response = await fetch(`${opts.base ?? API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status, data });
  return data;
};

let toastTimer;
function toast(msg, actionLabel, onAction) {
  const el = $('toast');
  el.replaceChildren(document.createTextNode(msg));
  if (actionLabel) {
    const b = document.createElement('button');
    b.className = 'toast-action'; b.textContent = actionLabel;
    b.onclick = () => { onAction(); el.classList.remove('show'); };
    el.append(b);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), actionLabel ? 7000 : 2600);
}

// ---------- Rendering ----------
function trackRow(t, { action, onAction }) {
  const li = document.createElement('li');
  li.className = 'track';

  const img = document.createElement('img');
  img.src = t.cover || ''; img.alt = ''; img.loading = 'lazy'; img.draggable = false;

  const meta = document.createElement('div'); meta.className = 'meta';
  const title = document.createElement('div'); title.className = 'title'; title.textContent = t.title;
  const artist = document.createElement('div'); artist.className = 'artist'; artist.textContent = t.why ? `${t.artist} · ${t.why}` : t.artist;
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
  const secs = totalSeconds();
  $('total').textContent = secs ? `· ${fmtTotal(secs)}` : '';
  $('playAllBtn').disabled = playlist.length === 0;
  renderLists();
  $('empty').hidden = playlist.length > 0;
  $('exportBtn').disabled = playlist.length === 0;
  $('sugSlot').hidden = $('sugBox').hidden = playlist.length === 0;
  updateSuggestionsStickyState();
}

// ---------- Actions ----------
function persist() {
  localStorage.setItem('musicbox:lists', JSON.stringify({
    activeId: store.activeId,
    lists: store.lists.map((l) => ({ ...l, tracks: l.tracks.map(slim) }))
  }));
}
function save() { activeList().tracks = playlist; persist(); }

function addTrack(t) { addTracks([t]); }
function addTracks(ts) {
  const fresh = ts.filter((t) => !playlist.some((p) => p.id === t.id));
  if (!fresh.length) return;
  playlist.push(...fresh); shownSuggestionIds.clear(); save(); renderPlaylist(); loadSuggestions();
  const c = $('count'); c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump');
}

function removeTrack(id) {
  const index = playlist.findIndex((p) => p.id === id);
  if (index < 0) return;
  const track = playlist[index], listId = store.activeId;
  playlist = playlist.filter((p) => p.id !== id); shownSuggestionIds.clear(); save(); renderPlaylist(); renderResults(); loadSuggestions();
  toast(`Removed “${track.title}”`, 'Undo', () => {
    if (store.activeId !== listId || playlist.some((p) => p.id === id)) return;
    playlist.splice(Math.min(index, playlist.length), 0, track);
    shownSuggestionIds.clear(); save(); renderPlaylist(); renderResults(); loadSuggestions();
  });
}

// Preview links expire, so saved songs fetch a fresh one when played
let playSeq = 0;
let nowPlaying = null;
const repaint = () => { renderPlaylist(); refreshResults(); updatePlayer(); };
const queueIndex = () => playlist.findIndex((t) => t.id === nowPlaying?.id);

// Starts a song from the beginning. Resolves true when it is playing (or when a newer click took over).
async function startTrack(t) {
  const seq = ++playSeq;
  const fresh = async () => (await api('/api/track/' + t.id)).preview;
  try {
    try { audio.src = t.preview || (await fresh()); await audio.play(); }
    catch { audio.src = await fresh(); await audio.play(); }
  } catch {
    return seq !== playSeq;
  }
  if (seq !== playSeq) return true;
  playingId = t.id; nowPlaying = t; repaint();
  return true;
}

async function togglePreview(t) {
  if (playingId === t.id) { audio.pause(); playingId = null; return repaint(); }
  if (nowPlaying?.id === t.id && audio.paused && audio.currentTime > 0 && !audio.ended) {
    try { await audio.play(); playingId = t.id; } catch { /* ignore */ }
    return repaint();
  }
  if (!(await startTrack(t))) toast('No preview available for this song');
}

// Plays playlist[i], skipping songs without a preview, moving in direction dir (1 or -1)
async function playIndex(i, dir = 1) {
  for (let k = i; k >= 0 && k < playlist.length; k += dir) if (await startTrack(playlist[k])) return true;
  return false;
}
async function step(dir) {
  const i = queueIndex();
  if (i < 0) return;
  if (dir < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (!(await playIndex(i + dir, dir))) { audio.pause(); playingId = null; repaint(); }
}
audio.onended = () => { if (queueIndex() >= 0 && queueIndex() < playlist.length - 1) step(1); else { playingId = null; repaint(); } };

// ---------- Player bar ----------
function updatePlayer() {
  document.body.classList.toggle('has-player', !!nowPlaying);
  $('player').hidden = !nowPlaying;
  updateSuggestionsStickyState();
  if (!nowPlaying) return;
  $('pCover').src = nowPlaying.cover || '';
  $('pTitle').textContent = nowPlaying.title;
  $('pArtist').textContent = nowPlaying.artist;
  $('pPlay').textContent = playingId === nowPlaying.id ? '❚❚' : '▶';
  $('pPrev').disabled = $('pNext').disabled = queueIndex() < 0;
}
audio.addEventListener('timeupdate', () => { if (audio.duration) $('pSeek').value = audio.currentTime / audio.duration; });
$('pSeek').addEventListener('input', (e) => { if (audio.duration) audio.currentTime = e.target.value * audio.duration; });
$('pPlay').addEventListener('click', () => nowPlaying && togglePreview(nowPlaying));
$('pPrev').addEventListener('click', () => step(-1));
$('pNext').addEventListener('click', () => step(1));
$('pClose').addEventListener('click', () => { audio.pause(); playingId = null; nowPlaying = null; repaint(); });
$('playAllBtn').addEventListener('click', async () => {
  if (!(await playIndex(0, 1))) toast('No previews available for this playlist');
});

// ---------- Keyboard shortcuts: Space play/pause, N next, P previous, / search ----------
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, select, textarea, button, a')) return;
  if (document.querySelector('.modal:not([hidden])')) return;
  if (e.key === ' ') { e.preventDefault(); if (nowPlaying) togglePreview(nowPlaying); else if (playlist.length) playIndex(0, 1); }
  else if (e.key === 'n' || e.key === 'ArrowRight') step(1);
  else if (e.key === 'p' || e.key === 'ArrowLeft') step(-1);
  else if (e.key === '/') { e.preventDefault(); $('q').focus(); }
});

// ---------- Playlist length ----------
const totalSeconds = () => playlist.reduce((sum, t) => sum + (t.duration || 0), 0);
const fmtTotal = (s) => {
  const min = Math.max(1, Math.round(s / 60));
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
};

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
const copy = (text, ok) =>
  navigator.clipboard.writeText(text).then(() => toast(ok), () => toast('Couldn’t copy. Your browser blocked it.'));

const menu = $('exportMenu');
$('exportBtn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
document.addEventListener('click', () => { menu.hidden = true; });
menu.addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (act === 'share') openShareModal();
  if (act === 'oifeel') openPublishModal();
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

// ---------- Modals ----------
function showModal(el) {
  el.hidden = false;
  const f = el.querySelector('select, input:not([type=checkbox])');
  if (f) setTimeout(() => f.focus(), 50);
}
const hideModal = (el) => { el.hidden = true; };
document.querySelectorAll('.modal').forEach((m) =>
  m.addEventListener('mousedown', (e) => { if (e.target === m) hideModal(m); }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => hideModal(m));
});

// ---------- Share: create a short link ----------
function openShareModal() {
  $('shareStep1').hidden = false; $('shareStep2').hidden = true;
  $('shareError').textContent = '';
  $('sharePwOn').checked = false; $('sharePwRow').hidden = true; $('sharePw').value = '';
  showModal($('shareModal'));
}
$('sharePwOn').addEventListener('change', (e) => {
  $('sharePwRow').hidden = !e.target.checked;
  if (e.target.checked) $('sharePw').focus();
});
$('shareCancel').addEventListener('click', () => hideModal($('shareModal')));
$('shareDone').addEventListener('click', () => hideModal($('shareModal')));
$('shareCopy').addEventListener('click', () => copy($('shareLink').value, 'Link copied'));

$('shareForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('shareError'); err.textContent = '';
  const usePw = $('sharePwOn').checked;
  const pw = $('sharePw').value;
  if (usePw && pw.length < 4) { err.textContent = 'The password needs at least 4 characters.'; return; }

  const btn = $('shareSubmit');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const body = { name: plTitle(), trackIds: playlist.map((t) => t.id), expiresIn: $('shareExpiry').value };
    if (usePw) body.password = pw;
    const res = await apiPost('/api/playlists', body);
    $('shareLink').value = `${location.origin}/playlist/${res.id}`;
    $('shareInfo').textContent =
      (res.expiresAt ? `This link expires on ${new Date(res.expiresAt).toLocaleString()}.` : 'This link never expires.') +
      (res.protected ? ' It is protected by your password.' : '');
    $('shareStep1').hidden = true; $('shareStep2').hidden = false;
    $('shareLink').select();
  } catch (error) {
    err.textContent = error.status ? error.message : 'Couldn’t reach the server. Please try again.';
  } finally {
    btn.disabled = false; btn.textContent = 'Create link';
  }
});

// ---------- Opening shared playlists ----------
function applyShared(tracks, name) {
  createList(name, tracks);
  toast(`Saved as a new playlist: “${name}”`);
  return true;
}

// New short links: /playlist/XXXXXXX
let pendingShareId = null;
async function openSharedById(id, password = '') {
  const err = $('unlockError'); err.textContent = '';
  try {
    const data = await apiPost(`/api/playlists/${id}/open`, password ? { password } : {});
    hideModal($('unlockModal'));
    history.replaceState(null, '', '/');
    if (!data.tracks.length) return toast('Couldn’t load the songs. Please try again.');
    applyShared(data.tracks, data.name);
  } catch (e) {
    if (e.status === 401) {
      pendingShareId = id; $('unlockPw').value = '';
      showModal($('unlockModal'));
    } else if (e.status === 403 || e.status === 429) {
      err.textContent = e.status === 403 ? 'Wrong password. Try again.' : e.message;
      $('unlockPw').select();
    } else {
      hideModal($('unlockModal'));
      history.replaceState(null, '', '/');
      toast(e.status === 404 ? 'This playlist link has expired or doesn’t exist.' : 'Couldn’t open this playlist. Please try again.');
    }
  }
}
$('unlockForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (pendingShareId) openSharedById(pendingShareId, $('unlockPw').value);
});
$('unlockCancel').addEventListener('click', () => {
  hideModal($('unlockModal'));
  history.replaceState(null, '', '/');
});
function openSharedFromPath() {
  const m = location.pathname.match(/^\/playlist\/([A-Za-z0-9]{4,16})\/?$/);
  if (m) openSharedById(m[1]);
}

// Old long links (#n=...&t=...) keep working
async function loadShared() {
  const params = new URLSearchParams(location.hash.slice(1));
  const ids = (params.get('t') || '').split(',').filter((x) => /^\d+$/.test(x));
  if (!ids.length) return;
  history.replaceState(null, '', location.pathname);
  try {
    const tracks = await api('/api/tracks?ids=' + ids.join(','));
    if (!tracks.length) throw new Error('empty');
    applyShared(tracks, params.get('n') || 'Shared playlist');
  } catch {
    toast('Couldn’t open the shared playlist');
  }
}

// ---------- Playlist name ----------
$('plName').value = activeList().name;
$('plName').addEventListener('input', (e) => { activeList().name = e.target.value.slice(0, 40); persist(); renderLists(); });

// ---------- Theme (the saved theme is applied by a small script in <head> to avoid a flash) ----------
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('musicbox:theme', dark ? 'dark' : 'light');
});

// ---------- Account panel ----------
$('account').addEventListener('click', () => $('accountdiv').classList.toggle('show'));
$('closeAccount').addEventListener('click', () => $('accountdiv').classList.remove('show'));

// ---------- Multiple playlists ----------
function renderLists() {
  const sel = $('plSelect');
  sel.replaceChildren(...store.lists.map((l) => {
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = `${l.name} (${l.id === store.activeId ? playlist.length : l.tracks.length})`;
    return o;
  }));
  sel.value = store.activeId;
}
function switchTo(id, saveFirst = true) {
  if (saveFirst) save();
  store.activeId = id;
  playlist = activeList().tracks;
  $('plName').value = activeList().name;
  currentSuggestions = []; shownSuggestionIds.clear(); persist();
  renderPlaylist(); renderResults(); loadSuggestions();
}
function createList(name, tracks) {
  save();
  store.lists.push({ id: uid(), name: (name || 'New playlist').slice(0, 40), tracks });
  switchTo(store.lists[store.lists.length - 1].id, false);
}
$('plSelect').addEventListener('change', (e) => switchTo(e.target.value));
$('plNew').addEventListener('click', () => createList('New playlist', []));
$('plDup').addEventListener('click', () => createList(`${plTitle()} (copy)`, playlist.map((t) => ({ ...t }))));
$('plClear').addEventListener('click', () => {
  if (!playlist.length) return;
  const prev = playlist, listId = store.activeId;
  playlist = []; shownSuggestionIds.clear(); save(); renderPlaylist(); renderResults(); loadSuggestions();
  toast('Playlist cleared', 'Undo', () => {
    if (store.activeId !== listId) return;
    playlist = prev; save(); renderPlaylist(); renderResults(); loadSuggestions();
  });
});
$('plDelete').addEventListener('click', () => {
  if (!confirm(`Delete “${plTitle()}”? This can’t be undone.`)) return;
  const i = store.lists.findIndex((l) => l.id === store.activeId);
  store.lists.splice(i, 1);
  if (!store.lists.length) store.lists.push({ id: uid(), name: 'My playlist', tracks: [] });
  switchTo(store.lists[Math.min(i, store.lists.length - 1)].id, false);
});

// ---------- Suggestions: add them all at once ----------
$('addAllBtn').addEventListener('click', () => {
  const list = currentSuggestions.filter((t) => !inPlaylist(t));
  if (!list.length) return;
  currentSuggestions = []; // shows the loading state while fresh ones arrive
  addTracks(list);
});

// ---------- Publish to oifeel. ----------
// Set `api` to your oifeel. server URL (the one that serves /api/auth/login and /api/posts).
const OIFEEL = { api: 'https://moodshare-7dd7.onrender.com' }; // e.g. 'https://your-oifeel-server.onrender.com'
const getOifeel = () => { try { return JSON.parse(localStorage.getItem('musicbox:oifeel')); } catch { return null; } };
function showPublishStep(acc) {
  $('pubLogin').hidden = !!acc; $('pubForm').hidden = !acc;
  if (acc) $('pubUser').textContent = acc.name;
}
function openPublishModal() {
  if (!OIFEEL.api) return toast('Publishing isn’t set up yet: add your oifeel. server URL in app.js');
  $('pubError').textContent = ''; $('pubLoginError').textContent = '';
  showPublishStep(getOifeel());
  showModal($('pubModal'));
}
$('pubCancel').addEventListener('click', () => hideModal($('pubModal')));
$('pubLoginCancel').addEventListener('click', () => hideModal($('pubModal')));
$('pubLogout').addEventListener('click', (e) => { e.preventDefault(); localStorage.removeItem('musicbox:oifeel'); showPublishStep(null); });

$('pubLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('pubLoginError'); err.textContent = '';
  try {
    const data = await apiPost('/api/auth/login', { displayName: $('pubName').value.trim(), password: $('pubPass').value }, { base: OIFEEL.api });
    if (data.requires2FA) throw Object.assign(new Error('2fa'), { userMessage: 'This account uses two-step verification, which isn’t supported here yet.' });
    localStorage.setItem('musicbox:oifeel', JSON.stringify({ token: data.token, name: data.user.displayName }));
    $('pubPass').value = '';
    showPublishStep(getOifeel());
  } catch (error) {
    err.textContent = error.userMessage || (error.status ? error.message : 'Couldn’t reach oifeel. Please try again.');
  }
});

$('pubForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const acc = getOifeel(), err = $('pubError'), btn = $('pubSubmit');
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Publishing…';
  try {
    // 1) a public, never-expiring Musibox link  2) a post on oifeel. that points to it
    const share = await apiPost('/api/playlists', { name: plTitle(), trackIds: playlist.map((t) => t.id), expiresIn: 'never' });
    await apiPost('/api/posts', {
      text: $('pubText').value.trim() || `🎧 ${plTitle()}`,
      emoji: '🎧', color: '#3b2ff0', textColor: '#ffffff',
      anonymous: $('pubAnon').checked,
      playlist: {
        shareId: share.id, name: plTitle(), count: playlist.length, durationSec: totalSeconds(),
        covers: playlist.map((t) => t.cover).filter(Boolean).slice(0, 4)
      }
    }, { base: OIFEEL.api, headers: { Authorization: `Bearer ${acc.token}` } });
    hideModal($('pubModal'));
    $('pubText').value = '';
    toast('Published to oifeel. 🎉');
  } catch (error) {
    if (error.status === 401) {
      localStorage.removeItem('musicbox:oifeel'); showPublishStep(null);
      $('pubLoginError').textContent = 'Your session expired. Please log in again.';
    } else {
      err.textContent = error.status ? error.message : 'Couldn’t reach the server. Please try again.';
    }
  } finally {
    btn.disabled = false; btn.textContent = 'Publish';
  }
});

// ---------- Start ----------
$('newRecsBtn').addEventListener('click', () => loadSuggestions({ refresh: true }));
renderPlaylist(); showTrending(); loadSuggestions(); loadShared(); openSharedFromPath();