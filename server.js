import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as music from './services/deezer.js';
import * as shares from './services/shares.js';

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

app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
app.get('/api/suggestions', route((req) =>
  music.suggestions(String(req.query.artists || '').split(',').filter(Boolean).slice(0, 4))
));

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
      'POST /api/playlists/:id/open'
    ]
  });
});

app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Bad request' }));

app.listen(PORT, () => console.log(`MusicBox running on http://localhost:${PORT}`));