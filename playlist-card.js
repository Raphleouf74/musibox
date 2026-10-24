// Drop-in card for posts that carry a Musibox playlist (post.playlist).
// Usage:  if (post.playlist) postElement.append(renderPlaylistCard(post.playlist));
// Everything is set with textContent / validated URLs, so nothing from the post is ever parsed as HTML.
function renderPlaylistCard(pl) {
  const a = document.createElement('a');
  a.className = 'mb-card';
  const safe = typeof pl.url === 'string' && pl.url.startsWith('https://musibox.netlify.app/playlist/');
  a.href = safe ? pl.url : '#'; a.target = '_blank'; a.rel = 'noopener noreferrer';

  const covers = document.createElement('div'); covers.className = 'mb-covers';
  (pl.covers || []).slice(0, 4).forEach((src) => {
    const img = document.createElement('img'); img.src = src; img.alt = ''; img.loading = 'lazy'; covers.append(img);
  });
  const info = document.createElement('div'); info.className = 'mb-info';
  const name = document.createElement('strong'); name.textContent = pl.name || 'Playlist';
  const mins = Math.max(1, Math.round((pl.durationSec || 0) / 60));
  const meta = document.createElement('span'); meta.textContent = `${pl.count || 0} songs · ${mins} min`;
  const cta = document.createElement('em'); cta.textContent = 'Open in Musibox ↗';
  info.append(name, meta, cta);
  a.append(covers, info);

  if (!document.getElementById('mb-card-style')) {
    const st = document.createElement('style'); st.id = 'mb-card-style';
    st.textContent = `.mb-card{display:flex;gap:12px;align-items:center;margin-top:10px;padding:10px;border-radius:16px;background:rgba(59,47,240,.12);color:inherit;text-decoration:none}
.mb-covers{display:grid;grid-template-columns:1fr 1fr;width:64px;height:64px;border-radius:10px;overflow:hidden;flex:none;background:#3b2ff0}
.mb-covers img{width:100%;height:100%;object-fit:cover}
.mb-info{display:grid;gap:2px;min-width:0}.mb-info span{opacity:.7;font-size:.85em}.mb-info em{font-style:normal;font-weight:600;font-size:.85em}`;
    document.head.append(st);
  }
  return a;
}
