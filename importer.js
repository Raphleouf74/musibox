// Turns pasted lines like "2. Get Lucky – Daft Punk" into Deezer tracks.
import * as music from './deezer.js';
import { fail } from './shares.js';

const clean = (line) => {
  let s = String(line).replace(/^\s*(?:\d+[.)\]]|[-*•])\s*/, '').trim(); // "1." / "2)" / "-" prefixes
  s = /\s[-–—]\s/.test(s) ? s.replace(/\s[-–—]\s/g, ' ') : s.replace(/\s+by\s+/i, ' '); // "Title - Artist" or "Title by Artist"
  return s.replace(/["“”]/g, '').slice(0, 120);
};

export async function importLines(lines) {
  if (!Array.isArray(lines) || !lines.length) throw fail(400, 'Paste at least one song');
  if (lines.length > 50) throw fail(400, 'Please import 50 songs or fewer at a time');
  if (!lines.every((l) => typeof l === 'string' && l.length <= 200)) throw fail(400, 'Invalid lines');
  const results = await music.mapLimit(lines, 5, (l) => music.searchOne(clean(l)).catch(() => null));
  const tracks = [], missing = [], seen = new Set();
  results.forEach((t, i) => {
    if (!t) return missing.push(lines[i]);
    if (!seen.has(t.id)) { seen.add(t.id); tracks.push(t); }
  });
  return { tracks, missing };
}
