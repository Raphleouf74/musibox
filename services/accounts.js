// Cloud sync for people logged in with an oifeel. account.
// Musibox never sees passwords: it forwards the Bearer token to oifeel.'s /api/auth/me to learn who it is.
import { userData } from './db.js';
import { fail } from './shares.js';

const cache = new Map(); // token -> { user, at }

export async function authenticate(req) {
  const base = (process.env.OIFEEL_API || '').replace(/\/$/, '');
  if (!base) throw fail(503, 'Accounts are not set up on this server');
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) throw fail(401, 'Please log in');
  const token = auth.slice(7);
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.user;
  let res;
  try { res = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }); }
  catch { throw fail(503, 'Couldn’t reach the account server'); }
  if (!res.ok) throw fail(401, 'Please log in again');
  const { user } = await res.json();
  if (!user?.id || String(user.id).startsWith('guest_')) throw fail(401, 'A full account is needed to sync');
  const found = { id: String(user.id), name: user.displayName };
  cache.set(token, { user: found, at: Date.now() });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return found;
}

const str = (v, max) => String(v ?? '').slice(0, max);
const cleanTrack = (t) => ({
  id: str(t.id, 20), title: str(t.title, 200), artist: str(t.artist, 200), artistId: str(t.artistId, 20),
  cover: typeof t.cover === 'string' ? t.cover.slice(0, 500) : null, duration: Math.max(0, parseInt(t.duration, 10) || 0)
});

export async function getLists(req) {
  const u = await authenticate(req);
  const doc = await (await userData()).findOne({ _id: u.id });
  return { lists: doc?.lists || [], tombstones: doc?.tombstones || {} };
}

export async function putLists(req) {
  const u = await authenticate(req);
  const { lists, tombstones = {} } = req.body || {};
  if (!Array.isArray(lists) || lists.length > 30) throw fail(400, 'Too many playlists');
  const clean = lists.map((l) => {
    if (!/^[a-z0-9]{3,16}$/.test(String(l?.id)) || !Array.isArray(l.tracks) || l.tracks.length > 100) throw fail(400, 'Invalid playlist');
    return { id: l.id, name: str(l.name, 40) || 'Playlist', updatedAt: Number(l.updatedAt) || 0,
      tracks: l.tracks.filter((t) => /^\d+$/.test(String(t?.id))).map(cleanTrack) };
  });
  const tombs = Object.fromEntries(Object.entries(tombstones).slice(-100)
    .filter(([id, ts]) => /^[a-z0-9]{3,16}$/.test(id) && Number(ts)).map(([id, ts]) => [id, Number(ts)]));
  await (await userData()).updateOne({ _id: u.id }, { $set: { lists: clean, tombstones: tombs, updatedAt: new Date() } }, { upsert: true });
  return { ok: true };
}
