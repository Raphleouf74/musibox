// Turns pasted lines into Deezer songs. A line can be:
//   • a Spotify track link  (https://open.spotify.com/track/…  or  spotify:track:…)
//   • plain text like "2. Get Lucky – Daft Punk"
// Every line gets its own result, so the app can show a review step before anything is added.
import * as music from './deezer.js';
import * as spotify from './spotify.js';
import { fail } from './shares.js';

const clean = (line) => {
  let s = String(line).replace(/^\s*(?:\d+[.)\]]|[-*•])\s*/, '').trim(); // "1." / "2)" / "-" prefixes
  s = /\s[-–—]\s/.test(s) ? s.replace(/\s[-–—]\s/g, ' ') : s.replace(/\s+by\s+/i, ' '); // "Title - Artist" or "Title by Artist"
  return s.replace(/["“”]/g, '').slice(0, 120);
};

async function resolveLine(line) {
  const spotifyId = spotify.parseTrackLink(line);
  if (spotifyId) {
    const meta = await spotify.getMeta(spotifyId);
    if (!meta) return { line, status: 'missing', reason: 'spotify_unreadable' };
    const hint = `${meta.title} – ${meta.artist}`.replace(/ – $/, '');
    const track = await music.matchByMeta(meta).catch(() => null);
    return track ? { line, status: 'ok', via: 'spotify', hint, track } : { line, status: 'missing', via: 'spotify', hint, reason: 'no_match' };
  }
  if (spotify.isSpotifyLink(line) || /^https?:\/\//i.test(line.trim())) return { line, status: 'missing', reason: 'unsupported_link' };

  const text = clean(line);
  const track = await music.searchOne(text).catch(() => null);
  return track ? { line, status: 'ok', via: 'search', hint: text, track } : { line, status: 'missing', hint: text, reason: 'no_match' };
}

export async function importLines(lines) {
  if (!Array.isArray(lines) || !lines.length) throw fail(400, 'Paste at least one song');
  if (lines.length > 50) throw fail(400, 'Please import 50 songs or fewer at a time');
  if (!lines.every((l) => typeof l === 'string' && l.length <= 300)) throw fail(400, 'Invalid lines');
  const results = await music.mapLimit(lines, 4, (l) => resolveLine(l).catch(() => ({ line: l, status: 'missing', reason: 'error' })));
  // `tracks` / `missing` are kept for older versions of the app
  return {
    results,
    tracks: results.filter((r) => r.track).map((r) => r.track),
    missing: results.filter((r) => !r.track).map((r) => r.line)
  };
}