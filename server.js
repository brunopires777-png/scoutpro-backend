const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');
const fs   = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANTE: Configure seu token aqui ou nas variáveis de ambiente do Render
const BSD_TOKEN = process.env.BSD_TOKEN || 'dddbf69d96a0efa0ffeb9f8d0c791528b61d1c1d';
const BASE_URL = 'https://sports.bzzoiro.com/api/v2';

app.use(cors());
app.use(express.json());

// Serve os arquivos estáticos da pasta raiz
app.use(express.static(path.join(__dirname)));

// ─────────────────────────────────────────────
// SERVE O FRONTEND UNIFICADO
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─────────────────────────────────────────────
// HELPER: chamada autenticada para a BSD v2
// ─────────────────────────────────────────────
async function bsd(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Token ${BSD_TOKEN}`,
      'Accept': 'application/json'
    }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Erro BSD (${res.status}): ${errText}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────
// API ENDPOINTS
// ─────────────────────────────────────────────

// Busca (Jogadores / Times)
app.get('/api/search', async (req, res) => {
  try {
    const { q, type } = req.query; 
    const endpoint = type === 'player' ? '/players/' : '/teams/';
    const data = await bsd(endpoint, { search: q, limit: 10 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Partidas (Events)
app.get('/api/matches', async (req, res) => {
  try {
    const { date_from, date_to, league_id, status } = req.query;
    const data = await bsd('/events/', { date_from, date_to, league_id, status });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/match/:id', async (req, res) => {
  try {
    const data = await bsd(`/events/${req.params.id}/`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Jogadores (Detalhes e Stats)
app.get('/api/player/:id', async (req, res) => {
  try {
    const data = await bsd(`/players/${req.params.id}/`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/player/:id/stats', async (req, res) => {
  try {
    const data = await bsd(`/players/${req.params.id}/stats/`, { season_id: req.query.season_id });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Escalações (Lineups)
app.get('/api/lineups/:event_id', async (req, res) => {
  try {
    const data = await bsd('/lineups/', { event_id: req.params.event_id });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Classificação (Standings)
app.get('/api/standings', async (req, res) => {
  try {
    const { league_id, season_id } = req.query;
    const data = await bsd('/standings/', { league_id, season_id });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Odds
app.get('/api/odds', async (req, res) => {
  try {
    const { event_id, league_id, market, bookmaker_slug, limit = 50 } = req.query;
    const data = await bsd('/odds/', { event_id, league_id, market, bookmaker_slug, limit });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// CACHE DE IMAGENS
// ─────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, 'img_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

async function serveImg(type, id, res) {
  const cacheFile = path.join(CACHE_DIR, `${type}_${id}.png`);
  if (fs.existsSync(cacheFile)) return res.sendFile(cacheFile);

  try {
    const r = await fetch(`https://sports.bzzoiro.com/img/${type}/${id}`);
    if (!r.ok) throw new Error(`Status ${r.status}`);
    const buffer = await r.arrayBuffer();
    const buf = Buffer.from(buffer);
    fs.writeFileSync(cacheFile, buf);
    res.set('Content-Type', r.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=2592000');
    res.send(buf);
  } catch (err) {
    res.status(404).end();
  }
}

app.get('/img/team/:id',    (req, res) => serveImg('team',    req.params.id, res));
app.get('/img/league/:id',  (req, res) => serveImg('league',  req.params.id, res));
app.get('/img/player/:id',  (req, res) => serveImg('player',  req.params.id, res));
app.get('/img/manager/:id', (req, res) => serveImg('manager', req.params.id, res));
app.get('/img/venue/:id',   (req, res) => serveImg('venue',   req.params.id, res));

app.listen(PORT, () => {
  console.log(`🚀 SCOUT PRO ATIVO NA PORTA ${PORT}`);
});
