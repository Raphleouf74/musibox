// Reads a song's title, artist and length from a public Spotify track link — no Spotify account, API key
// or developer app needed. open.spotify.com serves this info in the page's link-preview tags (the same
// ones WhatsApp or Discord use to show a preview), so we read just those tags.
//
// (Spotify's own Web API now needs a Premium developer account and limits apps to a handful of users,
// which is why it isn't used here.)

const TTL = 60 * 60 * 1000;
const cache = new Map();

// "https://open.spotify.com/track/ID?si=…", ".../intl-fr/track/ID" or "spotify:track:ID"  →  ID (or null)
export function parseTrackLink(text) {
  const s = String(text || '').trim();
  let m = s.match(/^spotify:track:([A-Za-z0-9]{22})$/);
  if (m) return m[1];
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' && u.hostname === 'open.spotify.com') {
      m = u.pathname.match(/^\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})\/?$/);
      if (m) return m[1];
    }
  } catch { /* not a URL */ }
  return null;
}

// Any other Spotify link (album, playlist, short link…): recognised, but not supported yet
export const isSpotifyLink = (text) => /^(https?:\/\/(open\.spotify\.com|spotify\.link|spoti\.fi)\/|spotify:)/i.test(String(text || '').trim());

const decode = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function metaContent(html, key) {
  const tag = html.match(new RegExp(`<meta\\b[^>]*?(?:property|name)=["']${key}["'][^>]*>`, 'i'));
  if (!tag) return '';
  const content = tag[0].match(/content=("([^"]*)"|'([^']*)')/i);
  return content ? decode(content[2] ?? content[3] ?? '').trim() : '';
}

export function parseMeta(html) {
  if (metaContent(html, 'og:type') && metaContent(html, 'og:type') !== 'music.song') return null; // album, playlist, artist…
  const title = metaContent(html, 'og:title');
  if (!title) return null;
  // og:description looks like "Artist · Title · Song · 2022"
  const desc = metaContent(html, 'og:description').split(' · ');
  const artist = metaContent(html, 'music:musician_description') || desc[0] || '';
  const durationSec = parseInt(metaContent(html, 'music:duration'), 10) || 0;
  return { title: title.slice(0, 200), artist: artist.slice(0, 200), durationSec };
}

export async function getMeta(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.meta;
  let meta = null;
  try {
    const res = await fetch(`https://open.spotify.com/track/${id}`, {
      headers: { 'User-Agent': 'MusiboxImport/1.0 (+playlist import)', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) meta = parseMeta((await res.text()).slice(0, 600000));
  } catch { /* unreachable: reported as "couldn't read this link" */ }
  if (meta) {
    cache.set(id, { at: Date.now(), meta });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  return meta;
}
