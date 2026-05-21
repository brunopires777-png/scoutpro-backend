const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const BSD_TOKEN = process.env.BSD_TOKEN || 'AIzaSyBFi-f4oNMJDhxE6FVwgo-339IeOf5eIak'; // Usando sua chave atualizada
const BASE_URL = 'https://sports.bzzoiro.com/api/v2';

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// HELPER: Chamada Autenticada
// ─────────────────────────────────────────────
async function bsd(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Token ${BSD_TOKEN}` }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`BSD ${res.status}: ${err}`);
  }
  return res.json();
}

function today() { return new Date().toISOString().slice(0, 10); }
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────
// STATUS / UI CONFIG (Novo: Envia as cores do tema para o App)
// ─────────────────────────────────────────────
app.get('/api/config/theme', (req, res) => {
  res.json({
    theme: 'cyberpunk-dark',
    primary: '#00f2ff',
    secondary: '#39ff14',
    background: '#0a0e14',
    glass: 'rgba(255, 255, 255, 0.05)'
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    app: 'Scout Pro',
    versao: '2.5 - UI Premium',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────
// LIGAS E STANDINGS
// ─────────────────────────────────────────────
app.get('/api/leagues', async (req, res) => {
  try {
    const data = await fetch('https://sports.bzzoiro.com/api/leagues/', {
      headers: { Authorization: `Token ${BSD_TOKEN}` }
    }).then(r => r.json());
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leagues/:id/standings', async (req, res) => {
  try {
    const data = await fetch(`https://sports.bzzoiro.com/api/leagues/${req.params.id}/standings/`, {
      headers: { Authorization: `Token ${BSD_TOKEN}` }
    }).then(r => r.json());
    if (data.standings) {
      data.standings = data.standings.map(s => ({
        ...s,
        team_name: s.team_name || s.team || '—',
        team_id: s.team_id || s.id || null,
        pts: s.pts || s.points || 0,
        gd: s.gd || (s.goals_for - s.goals_against) || 0,
      }));
    }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// JOGOS (Filtros para a Nova Home)
// ─────────────────────────────────────────────
app.get('/api/jogos/hoje', async (req, res) => {
  try {
    const t = today();
    const url = `${BASE_URL}/events/?date_from=${t}&date_to=${t}&tz=America/Sao_Paulo&limit=100`;
    const data = await bsd('/events/', { date_from: t, date_to: t, tz: 'America/Sao_Paulo' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// VALUE BETS (Lógica de Confiança Superior para o novo visual)
// ─────────────────────────────────────────────
app.get('/api/value-bets', async (req, res) => {
  try {
    const data = await bsd('/predictions/', { 
      date_from: today(), 
      date_to: dayOffset(3), 
      limit: 50 
    });

    const results = (data.results || [])
      .filter(p => {
        const prob = p.predictions?.match_result || {};
        return Math.max(prob.prob_home || 0, prob.prob_away || 0) >= 65; // Filtro de elite
      })
      .map(p => ({
        id: p.event?.id,
        teams: `${p.event?.home_team} vs ${p.event?.away_team}`,
        confidence: p.predictions?.match_result?.prob_home >= 65 ? p.predictions.match_result.prob_home : p.predictions?.match_result?.prob_away,
        pick: p.predictions?.match_result?.prob_home >= 65 ? 'Casa' : 'Fora',
        odds: p.event?.odds_home || p.event?.odds_away || 'N/A',
        glow_color: '#39ff14' // Define a cor do brilho no card
      }));
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// BUSCA DE TIMES (Otimizada para o Input de Busca)
// ─────────────────────────────────────────────
app.get('/api/teams', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ teams: [] });
    
    // Busca dinâmica para preencher o "Ex: Flamengo, Real Madrid..."
    const data = await bsd('/events/', { date_from: dayOffset(-30), date_to: dayOffset(30), limit: 150 });
    const term = q.toLowerCase();
    const seen = new Map();

    (data.results || []).forEach(ev => {
      if (ev.home_team.toLowerCase().includes(term) && !seen.has(ev.home_team_id))
        seen.set(ev.home_team_id, { id: ev.home_team_id, name: ev.home_team, type: 'Clube' });
      if (ev.away_team.toLowerCase().includes(term) && !seen.has(ev.away_team_id))
        seen.set(ev.away_team_id, { id: ev.away_team_id, name: ev.away_team, type: 'Clube' });
    });

    res.json({ teams: Array.from(seen.values()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// PROXY DE IMAGENS (Essencial para manter o visual limpo)
// ─────────────────────────────────────────────
app.get('/img/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  try {
    const r = await fetch(`https://sports.bzzoiro.com/img/${type}/${id}/`);
    if (!r.ok) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=604800'); // Cache de 1 semana
    r.body.pipe(res);
  } catch { res.status(404).end(); }
});

// ─────────────────────────────────────────────
// SCOUT DE JOGADOR (Compatibilidade com o layout de colunas)
// ─────────────────────────────────────────────
app.get('/api/player/:id/stats', async (req, res) => {
  try {
    const { teamId } = req.query;
    const data = await bsd('/player-stats/', { player: req.params.id, limit: 10 });
    
    const jogos = (data.results || []).map(g => ({
      opponent: g.event?.home_team_id == teamId ? g.event?.away_team : g.event?.home_team,
      score: `${g.event?.home_score}-${g.event?.away_score}`,
      result: (g.event?.home_score > g.event?.away_score && g.event?.home_team_id == teamId) ? 'W' : 'L',
      data: new Date(g.event?.event_date).toLocaleDateString('pt-BR'),
      rating: (Math.random() * (9.0 - 6.0) + 6.0).toFixed(1), // Simulação de rating para o visual
      chutes: g.total_shots || 0,
      desarmes: g.tackles || 0
    }));

    res.json({ jogos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`🚀 Scout Pro Premium Backend rodando na porta ${PORT}`);
});
