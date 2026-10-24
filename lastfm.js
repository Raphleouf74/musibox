// Last.fm: "similar tracks" and mood/genre picks. Needs LASTFM_API_KEY (free at last.fm/api).
// Every song is then looked up on Deezer so it has an id and a playable preview.
import * as music from './deezer.js';

const TTL = 30 * 60 * 1000;
const cache = new Map();
export const enabled = () => !!process.env.LASTFM_API_KEY;

// key shown on the chip -> Last.fm tag
export const TAGS = {
  chill: 'chill', happy: 'feel good', sad: 'sad', energetic: 'energetic', party: 'party', focus: 'study',
  workout: 'workout', romantic: 'romantic', pop: 'pop', rock: 'rock', 'hip-hop': 'hip-hop',
  electronic: 'electronic', jazz: 'jazz', indie: 'indie', 'r&b': 'rnb'
};

async function call(method, params) {
  const qs = new URLSearchParams({ method, api_key: process.env.LASTFM_API_KEY, format: 'json', ...params });
  const url = `https://ws.audioscrobbler.com/2.0/?${qs}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Last.fm ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.message || 'Last.fm error');
  cache.set(url, { data, at: Date.now() });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}

const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const artistName = (t) => t.artist?.name || t.artist || '';

export async function suggest({ trackIds = [], mood = '' }) {
  let picks;
  if (mood) {
    const data = await call('tag.getTopTracks', { tag: TAGS[mood], limit: 50 });
    const list = data.tracks?.track || data.toptracks?.track || [];
    const label = mood[0].toUpperCase() + mood.slice(1);
    picks = shuffle(list).slice(0, 8).map((t) => ({ artist: artistName(t), title: t.name, why: `${label} pick` }));
  } else {
    const seeds = await music.tracks(trackIds);
    const lists = await Promise.all(seeds.map((s) =>
      call('track.getSimilar', { artist: s.artist, track: s.title, limit: 6, autocorrect: 1 })
        .then((d) => (d.similartracks?.track || []).map((t) => ({ artist: artistName(t), title: t.name, why: `Similar to “${s.title}”` })))
        .catch(() => [])));
    picks = shuffle(lists.flat()).slice(0, 10);
  }
  const found = await music.mapLimit(picks, 5, async (p) => {
    const t = await music.findTrack(p.artist, p.title).catch(() => null);
    return t && { ...t, why: p.why };
  });
  const seen = new Set();
  return found.filter((t) => t && t.preview && !seen.has(t.id) && seen.add(t.id));
}
