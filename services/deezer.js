// Data source #1: Deezer public API (no key needed). Swap or add sources here later
// (Last.fm, MusicBrainz...) without touching server.js or the frontend.
const BASE = 'https://api.deezer.com';
const cache = new Map();
const TTL = 5 * 60 * 1000;

async function get(endpoint) {
  const hit = cache.get(endpoint);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const res = await fetch(BASE + endpoint);
  if (!res.ok) throw new Error(`Deezer ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Deezer error');
  cache.set(endpoint, { data, at: Date.now() });
  return data;
}

// One shape for every track, whatever the source
const toTrack = (t) => ({
  id: String(t.id),
  title: t.title,
  artist: t.artist?.name,
  artistId: String(t.artist?.id),
  cover: t.album?.cover_medium || t.album?.cover,
  preview: t.preview,
  duration: t.duration
});

export async function search(q) {
  if (!q) return [];
  const { data } = await get(`/search?q=${encodeURIComponent(q)}&limit=20`);
  return data.map(toTrack);
}

export async function trending() {
  const { data } = await get('/chart/0/tracks?limit=20');
  return data.map(toTrack);
}

// "More like this": top tracks from artists related to the ones in the playlist
export async function suggestions(artistIds) {
  const lists = await Promise.all(artistIds.map(async (id) => {
    const { data: related } = await get(`/artist/${id}/related?limit=2`);
    const tops = await Promise.all(related.map((a) => get(`/artist/${a.id}/top?limit=3`)));
    return tops.flatMap((t) => t.data.map(toTrack));
  }));
  const seen = new Set();
  return lists.flat().filter((t) => !seen.has(t.id) && seen.add(t.id));
}
