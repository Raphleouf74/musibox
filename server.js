import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as music from './services/deezer.js';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/style.css', (_req, res) => res.sendFile(path.join(__dirname, 'style.css')));

app.use('/api', (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Wraps async routes so errors return clean JSON instead of crashing
const route = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (err) { console.error(err.message); res.status(502).json({ error: 'Music service unavailable' }); }
};

app.get('/api/search', route((req) => music.search(String(req.query.q || '').trim())));
app.get('/api/trending', route(() => music.trending()));
app.get('/api/suggestions', route((req) =>
  music.suggestions(String(req.query.artists || '').split(',').filter(Boolean).slice(0, 4))
));

const ids = (v) => String(v || '').split(',').filter((x) => /^\d+$/.test(x)).slice(0, 100);
app.get('/api/track/:id', route((req) => music.track(ids(req.params.id)[0])));
app.get('/api/tracks', route((req) => music.tracks(ids(req.query.ids))));

app.listen(PORT, () => console.log(`MusicBox running on http://localhost:${PORT}`));