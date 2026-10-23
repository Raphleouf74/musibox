import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as music from './services/deezer.js';

const app = express();
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

app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Wraps async routes so errors return clean JSON instead of crashing
const route = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (err) {
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
      'GET /api/tracks?ids=id,id'
    ]
  });
});

app.listen(PORT, () => console.log(`MusicBox running on http://localhost:${PORT}`));