import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as music from './services/deezer.js';
import * as shares from './services/shares.js';
import * as lastfm from './services/lastfm.js';
import * as importer from './services/importer.js';
import * as accounts from './services/accounts.js';

const app = express();
app.set('trust proxy', 1); // behind Render's proxy, so req.ip is the visitor
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestPath = req.path;
  res.on('finish', () => {
    if (requestPath.startsWith('/api') || res.statusCode >= 400) {
      console.log(JSON.stringify({
        type: 'http',
        method: req.method,
        path: requestPath,
        status: res.statusCode,
        durationMs: Date.now() - startedAt
      }));
    }
  });
  next();
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/style.css', (_req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/playlist/:id', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/embed/:id', (_req, res) => res.sendFile(path.join(__dirname, 'embed.html')));

app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Wraps async routes so errors return clean JSON instead of crashing
const route = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...err.extra }); // expected errors (404, 401...)
    console.error(`[API] ${req.method} ${req.path} failed:`, err);
    res.status(502).json({ error: 'Music service unavailable' });
  }
};

app.get('/api/health', async (_req, res) => {
  try {
    await music.trending();
    res.json({
      status: 'ok',
      service: 'musibox-api',
      upstream: 'available',
      uptimeSeconds: Math.floor(process.uptime())
    });
  } catch (err) {
    console.error('[API] Health check failed:', err);
    res.status(502).json({
      status: 'degraded',
      service: 'musibox-api',
      upstream: 'unavailable'
    });
  }
});

app.get('/api/search', route((req) => music.search(String(req.query.q || '').trim())));
app.get('/api/trending', route(() => music.trending()));
app.get('/api/suggestions', route(async (req) => {
  const artists = String(req.query.artists || '').split(',').filter(Boolean).slice(0, 4);
  const trackIds = ids(req.query.tracks).slice(-3);
  const mood = Object.hasOwn(lastfm.TAGS, String(req.query.mood)) ? String(req.query.mood) : '';
  if (lastfm.enabled() && (mood || trackIds.length)) {
    try {
      const list = await lastfm.suggest({ trackIds, mood });
      if (list.length >= 3) return list;
    } catch (err) { console.error('[Last.fm]', err.message); } // fall back to the Deezer-based suggestions
  }
  return music.suggestions(artists);
}));

// What this server can do, so the app can show or hide features
app.get('/api/capabilities', (_req, res) => res.json({
  lastfm: lastfm.enabled(), moods: Object.keys(lastfm.TAGS), oifeel: (process.env.OIFEEL_API || '').replace(/\/$/, '')
}));

const ids = (v) => String(v || '').split(',').filter((x) => /^\d+$/.test(x)).slice(0, 100);
app.get('/api/track/:id', route((req) => music.track(ids(req.params.id)[0])));
app.get('/api/tracks', route((req) => music.tracks(ids(req.query.ids))));

// ---- Short share links (MongoDB) ----
const hits = new Map();
const limited = (key, max, windowMs) => {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  return ++h.n > max;
};
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 60000).unref();

app.use('/api/me', express.json({ limit: '1mb' })); // synced playlists are bigger than the 20kb default
app.use('/api', express.json({ limit: '20kb' }));
app.post('/api/playlists', route((req) => {
  if (limited(`create:${req.ip}`, 20, 60 * 60e3)) throw shares.fail(429, 'Too many links created. Try again in a while.');
  return shares.createShare(req.body || {});
}));
app.post('/api/playlists/:id/open', route((req) => {
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 64) : '';
  if (password && limited(`pw:${req.ip}:${req.params.id}`, 10, 15 * 60e3)) throw shares.fail(429, 'Too many attempts. Try again in a few minutes.');
  return shares.openShare(req.params.id, password);
}));
app.post('/api/import', route((req) => {
  if (limited(`import:${req.ip}`, 15, 60 * 60e3)) throw shares.fail(429, 'Too many imports. Try again in a while.');
  return importer.importLines(req.body?.lines);
}));
app.get('/api/me/playlists', route((req) => accounts.getLists(req)));
app.put('/api/me/playlists', route((req) => {
  if (limited(`sync:${req.ip}`, 200, 60 * 60e3)) throw shares.fail(429, 'Syncing too often. Try again in a while.');
  return accounts.putLists(req);
}));

app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'API route not found',
    method: req.method,
    path: `${req.baseUrl}${req.path}`,
    availableEndpoints: [
      'GET /api/health',
      'GET /api/search?q=artist-or-track',
      'GET /api/trending',
      'GET /api/suggestions?artists=id,id',
      'GET /api/track/:id',
      'GET /api/tracks?ids=id,id',
      'POST /api/playlists',
      'POST /api/playlists/:id/open',
      'POST /api/import',
      'GET /api/capabilities',
      'GET|PUT /api/me/playlists'
    ]
  });
});

app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Bad request' }));

app.listen(PORT, () => console.log(`MusicBox running on http://localhost:${PORT}`));