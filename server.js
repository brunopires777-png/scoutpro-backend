const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = 'bfc6e69a18mshb2f15a331d47fc7p1c68a8jsnd86c1b637755';
const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const BASE = `https://${SOFASCORE_HOST}`;

const headers = {
  'x-rapidapi-key': RAPIDAPI_KEY,
  'x-rapidapi-host': SOFASCORE_HOST
};

// Cache simples em memória
const cache = new Map();
function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.exp) { cache.delete(key); return null; }
  return item.data;
}
function cacheSet(key, data, ttlMs) {
  cache.set(key, { data, exp: Date.now() + ttlMs });
}

// ── BUSCAR TIME ──────────────────────────────────
app.get('/api/teams', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Nome do time obrigatório' });

  const ckey = `teams_${q.toLowerCase()}`;
  const cached = cacheGet(ckey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const r = await fetch(`${BASE}/teams/search?name=${encodeURIComponent(q)}`, { headers });
    const data = await r.json();
    const teams = (data.teams || []).slice(0, 8).map(t => ({
      id: t.id,
      name: t.name,
      logo: `https://api.sofascore.app/api/v1/team/${t.id}/image`,
      country: t.country?.name || '',
    }));
    const result = { teams };
    cacheSet(ckey, result, 3600000); // 1h
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ELENCO DO TIME ───────────────────────────────
app.get('/api/squad/:teamId', async (req, res) => {
  const { teamId } = req.params;
  const ckey = `squad_${teamId}`;
  const cached = cacheGet(ckey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const r = await fetch(`${BASE}/teams/${teamId}/players`, { headers });
    const data = await r.json();
    const players = (data.players || []).map(p => ({
      id: p.player.id,
      name: p.player.name,
      position: p.player.position || 'Unknown',
      photo: `https://api.sofascore.app/api/v1/player/${p.player.id}/image`,
    }));
    const result = { players };
    cacheSet(ckey, result, 86400000); // 24h
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ÚLTIMOS JOGOS DO JOGADOR ─────────────────────
app.get('/api/player/:playerId/stats', async (req, res) => {
  const { playerId } = req.params;
  const { teamId } = req.query;
  const ckey = `stats_${playerId}_${teamId}`;
  const cached = cacheGet(ckey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    // Buscar eventos recentes do jogador
    const r = await fetch(`${BASE}/players/${playerId}/events/last/0`, { headers });
    const data = await r.json();
    const events = (data.events || [])
      .filter(e => e.status?.type === 'finished')
      .slice(0, 5);

    if (!events.length) return res.status(404).json({ error: 'Nenhum jogo encontrado' });

    // Para cada jogo, buscar estatísticas individuais do jogador
    const jogos = [];
    for (const ev of events) {
      const eventId = ev.id;
      const isHome = ev.homeTeam?.id === parseInt(teamId);
      const opponent = isHome ? ev.awayTeam?.name : ev.homeTeam?.name;
      const ghHome = ev.homeScore?.current ?? 0;
      const ghAway = ev.awayScore?.current ?? 0;
      const myScore = isHome ? ghHome : ghAway;
      const oppScore = isHome ? ghAway : ghHome;
      const scoreStr = `${myScore}-${oppScore}`;
      const result = myScore > oppScore ? 'W' : myScore < oppScore ? 'L' : 'D';
      const date = new Date(ev.startTimestamp * 1000);
      const dateStr = `${date.getDate().toString().padStart(2,'0')}/${(date.getMonth()+1).toString().padStart(2,'0')}/${date.getFullYear()}`;
      const comp = ev.tournament?.name || ev.season?.name || '—';

      let stats = { chutes: null, desarmes: null, ftc: null, fts: null, amarelos: null, vermelhos: null, defesas: null };

      try {
        const sr = await fetch(`${BASE}/events/${eventId}/player-statistics`, { headers });
        const sd = await sr.json();

        // Procurar jogador nas estatísticas
        const allPlayers = [
          ...(sd.home?.players || []),
          ...(sd.away?.players || [])
        ];
        const found = allPlayers.find(p => p.player?.id === parseInt(playerId));

        if (found?.statistics) {
          const s = found.statistics;
          stats = {
            chutes:    s.totalShots ?? s.shots ?? null,
            desarmes:  s.tackles ?? null,
            ftc:       s.fouls ?? null,
            fts:       s.wasFouled ?? null,
            amarelos:  s.yellowCards ?? null,
            vermelhos: s.redCards ?? null,
            defesas:   s.saves ?? null,
          };
        }
      } catch(e) { /* mantém null */ }

      jogos.push({ date: dateStr, opponent, score: scoreStr, result, comp, ...stats });
    }

    const result = { jogos };
    cacheSet(ckey, result, 43200000); // 12h
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH CHECK ─────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Scout Pro API ok', version: '1.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scout Pro backend rodando na porta ${PORT}`));
