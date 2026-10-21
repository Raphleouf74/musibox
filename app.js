// ---------- State (saved in the browser for now; a database comes later) ----------
let playlist = JSON.parse(localStorage.getItem('musicbox:playlist') || '[]');
let playlistName = localStorage.getItem('musicbox:name') || 'My playlist';
const audio = new Audio();
let playingId = null;

const $ = (id) => document.getElementById(id);
const API_BASE = 'https://musibox.onrender.com';
const api = async (path) => {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
};

// ---------- Rendering ----------
function trackRow(t, { action, onAction }) {
  const li = document.createElement('li');
  li.className = 'track';

  const img = document.createElement('img');
  img.src = t.cover || ''; img.alt = ''; img.loading = 'lazy';

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

const addOpts = {
  action: 'add',
  onAction: (t, li) => {
    addTrack(t);
    li.classList.add('leaving');
    setTimeout(() => li.remove(), 250);
  }
};

function renderPlaylist() {
  renderList($('playlist'), playlist, {
    action: 'remove',
    onAction: (t, li) => { li.classList.add('leaving'); setTimeout(() => removeTrack(t.id), 220); }
  });
  $('count').textContent = playlist.length;
  $('empty').hidden = playlist.length > 0;
  $('sugSlot').hidden = $('sugBox').hidden = playlist.length === 0;
  updateSuggestionsStickyState();
}

// ---------- Actions ----------
function save() { localStorage.setItem('musicbox:playlist', JSON.stringify(playlist)); }

function addTrack(t) {
  if (playlist.some((p) => p.id === t.id)) return;
  playlist.push(t); shownSuggestionIds.clear(); save(); renderPlaylist(); loadSuggestions();
  const c = $('count'); c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump');
}

function removeTrack(id) {
  playlist = playlist.filter((p) => p.id !== id); shownSuggestionIds.clear(); save(); renderPlaylist(); renderResults(); loadSuggestions();
}

function togglePreview(t) {
  if (playingId === t.id) { audio.pause(); playingId = null; }
  else { audio.src = t.preview; audio.play(); playingId = t.id; }
  renderPlaylist(); refreshResults();
}
audio.onended = () => { playingId = null; renderPlaylist(); refreshResults(); };

// ---------- Data loading ----------
let currentResults = [];
let currentSuggestions = [];
const shownSuggestionIds = new Set();
const inPlaylist = (t) => playlist.some((p) => p.id === t.id);
function renderResults() {
  renderList($('results'), currentResults.filter((t) => !inPlaylist(t)), addOpts);
}
function renderSuggestions() {
  renderList($('suggestions'), currentSuggestions.filter((t) => !inPlaylist(t)), addOpts);
}
function refreshResults() {
  renderResults();
  renderSuggestions();
}

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
    // The slot has a fixed height, so this test doesn't depend on the box's own
    // height. The box is "stuck" while the bottom of its slot is below the sticky line.
    const stickyBottom = parseFloat(getComputedStyle(slot).getPropertyValue('--sticky-bottom'));
    const slotBottom = slot.getBoundingClientRect().bottom;
    box.classList.toggle('is-sticky', slotBottom > window.innerHeight - stickyBottom + 1);
  });
}

window.addEventListener('scroll', updateSuggestionsStickyState, { passive: true });
window.addEventListener('resize', updateSuggestionsStickyState);

async function showTrending() {
  $('findTitle').textContent = 'Trending now';
  try { currentResults = await api('/api/trending'); } catch { currentResults = []; }
  renderResults();
}

let searchTimer;
$('q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) return showTrending();
  searchTimer = setTimeout(async () => {
    $('findTitle').textContent = `Results for “${q}”`;
    try { currentResults = await api('/api/search?q=' + encodeURIComponent(q)); }
    catch { currentResults = []; }
    renderResults();
  }, 300);
});

function shuffleTracks(tracks) {
  const shuffled = [...tracks];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function loadSuggestions({ refresh = false } = {}) {
  if (!playlist.length) {
    currentSuggestions = [];
    renderSuggestions();
    return;
  }

  const button = $('newRecsBtn');
  if (refresh) {
    button.disabled = true;
    button.textContent = 'Loading…';
  }
  const artists = [...new Set(playlist.map((t) => t.artistId))].slice(-3);
  const inList = new Set(playlist.map((t) => t.id));
  const previousSuggestionIds = new Set(currentSuggestions.map((t) => t.id));
  try {
    const sug = await api('/api/suggestions?artists=' + artists.join(','));
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
  } catch (error) {
    currentSuggestions = [];
    console.error('Could not load recommendations:', error);
  } finally {
    if (refresh) {
      button.disabled = false;
      button.textContent = 'New recommendations';
    }
    renderSuggestions();
  }
}

// ---------- Playlist name ----------
$('plName').value = playlistName;
$('plName').addEventListener('input', (e) => localStorage.setItem('musicbox:name', e.target.value));

// ---------- Start ----------
renderPlaylist(); showTrending(); loadSuggestions();

const newRecsBtn = $('newRecsBtn');
newRecsBtn.addEventListener('click', () => {
  loadSuggestions({ refresh: true });
});