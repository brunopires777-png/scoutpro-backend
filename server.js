const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');
const fs   = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BSD_TOKEN = process.env.BSD_TOKEN || 'dddbf69d96a0efa0ffeb9f8d0c791528b61d1c1d';
const BASE_URL = 'https://sports.bzzoiro.com/api/v2';

app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','Accept','X-Requested-With'],
  credentials: false
}));
// Preflight para Safari/iOS
app.options('*', cors());
app.use(express.json());
// Headers extras de segurança compatíveis com Safari
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ─────────────────────────────────────────────
// SERVE O FRONTEND — acesse via https://seu-app.onrender.com/
// Isso resolve o problema do iOS que bloqueia fetch de arquivo local
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index_green.html'));
});
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'index_green.html'));
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
    headers: { Authorization: `Token ${BSD_TOKEN}` }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`BSD ${res.status}: ${err}`);
  }
  return res.json();
}

// Helper: data de hoje no formato YYYY-MM-DD (UTC)
// Retorna data no fuso de Brasília (UTC-3) — evita bug de "amanhã = segunda" à noite
function toBrasiliaDateStr(d) {
  // Subtrai 3h para converter UTC → Brasília, depois pega YYYY-MM-DD
  const br = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return br.toISOString().slice(0, 10);
}
function today() {
  return toBrasiliaDateStr(new Date());
}
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toBrasiliaDateStr(d);
}


// Debug: ver estrutura raw do endpoint v2 de value bets
app.get('/api/debug/value-bets', async (req, res) => {
  try {
    const r = await fetch('https://sports.bzzoiro.com/api/v2/value-bets/?limit=3', {
      headers: { Authorization: `Token ${BSD_TOKEN}` }
    });
    const txt = await r.text();
    console.log('[debug/value-bets] status:', r.status, 'body:', txt.slice(0, 500));
    res.json({ status: r.status, keys: Object.keys(JSON.parse(txt)||{}), sample: txt.slice(0,800) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ─────────────────────────────────────────────
// STATUS / HEALTH
// ─────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    app: 'Scout Pro',
    versao: '2.0',
    servidor: 'ativo',
    timestamp: new Date().toISOString()
  });
});

// ─────────────────────────────────────────────
// LIGAS
// ─────────────────────────────────────────────
app.get('/api/leagues', async (req, res) => {
  try {
    // BSD v1 /api/leagues/ retorna todas as ligas ativas com current_season embutido
    const data = await fetch('https://sports.bzzoiro.com/api/leagues/', {
      headers: { Authorization: `Token ${BSD_TOKEN}` }
    }).then(r => r.json());
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leagues/:id/standings', async (req, res) => {
  try {
    const data = await fetch(`https://sports.bzzoiro.com/api/leagues/${req.params.id}/standings/`, {
      headers: { Authorization: `Token ${BSD_TOKEN}` }
    }).then(r => r.json());
    // Normaliza: BSD retorna standings[].team (string) e standings[].team_id
    // O frontend espera standings[].team_name — fazemos o mapeamento aqui
    if (data.standings) {
      data.standings = data.standings.map(s => ({
        ...s,
        team_name: s.team_name || s.team || '—',
        team_id:   s.team_id   || s.id  || null,
        pts:       s.pts       || s.points || 0,
        gf:        s.gf        || s.goals_for || 0,
        ga:        s.ga        || s.goals_against || 0,
        gd:        s.gd        || s.goal_diff || (s.goals_for - s.goals_against) || 0,
        played:    s.played    || s.games || 0,
        won:       s.won       || s.wins  || 0,
        drawn:     s.drawn     || s.draws || 0,
        lost:      s.lost      || s.losses|| 0,
        form:      s.form      || '',
      }));
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leagues/:id/season', async (req, res) => {
  try {
    const data = await bsd(`/leagues/${req.params.id}/season/`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DEBUG — ver campos exatos da BSD (remover depois)
app.get('/api/debug/evento', async (req, res) => {
  try {
    const t = today();
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${t}&date_to=${t}&limit=1`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    const ev = (data.results||[])[0] || {};
    res.json({
      todos_campos: Object.keys(ev),
      campos_time: Object.keys(ev).filter(k=>k.includes('team')||k.includes('home')||k.includes('away')||k.includes('_id')),
      valores: {
        home_team: ev.home_team,
        home_team_id: ev.home_team_id,
        away_team: ev.away_team,
        away_team_id: ev.away_team_id,
        home_id: ev.home_id,
        away_id: ev.away_id,
      }
    });
  } catch(e){ res.status(500).json({error: e.message}); }
});
// ─────────────────────────────────────────────
// DIAGNÓSTICO: busca ID real de um time pelo nome
// GET /api/debug/teamid?q=Flamengo
// ─────────────────────────────────────────────
app.get('/api/debug/teamid', async (req, res) => {
  const q = req.query.q || '';
  try {
    const r = await fetch(
      `https://sports.bzzoiro.com/api/teams/?search=${encodeURIComponent(q)}&limit=10`,
      { headers: { Authorization: `Token ${BSD_TOKEN}` } }
    ).then(r => r.json());
    res.json({
      query: q,
      results: (r.results||[]).map(t => ({
        id: t.id,
        name: t.name,
        country: t.country,
        league: t.league || t.competition
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// DIAGNÓSTICO COMPLETO — GET /api/debug/lineup/:teamId
// Testa os 3 endpoints possíveis de lineup para os jogos mais recentes do time
// ─────────────────────────────────────────────
// GET /api/debug/team?q=Palmeiras — mostra qual ID a busca retorna e de onde vem
app.get('/api/debug/team', async (req, res) => {
  const q = (req.query.q||'').toLowerCase();
  const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const term = norm(q);
  const result = { query: q, events_found: [], standings_found: [], players_found: [] };

  // O que a busca de eventos retorna
  try {
    const df = new Date(Date.now()-60*86400000).toISOString().slice(0,10);
    const dt = new Date(Date.now()+14*86400000).toISOString().slice(0,10);
    const evData = await fetch(
      `https://sports.bzzoiro.com/api/events/?date_from=${df}&date_to=${dt}&limit=200`,
      { headers: { Authorization: `Token ${BSD_TOKEN}` } }
    ).then(r => r.json());
    for (const ev of (evData.results||[])) {
      const hid = ev.home_team_id || ev.home_team_obj?.id;
      const aid = ev.away_team_id || ev.away_team_obj?.id;
      if (norm(ev.home_team||'').includes(term))
        result.events_found.push({ side:'home', team: ev.home_team, id: hid, home_team_id: ev.home_team_id, home_team_obj_id: ev.home_team_obj?.id, home_team_obj_full: ev.home_team_obj, event_id: ev.id, event_date: ev.event_date?.slice(0,10) });
      if (norm(ev.away_team||'').includes(term))
        result.events_found.push({ side:'away', team: ev.away_team, id: aid, away_team_id: ev.away_team_id, away_team_obj_id: ev.away_team_obj?.id, away_team_obj_full: ev.away_team_obj, event_id: ev.id, event_date: ev.event_date?.slice(0,10) });
    }
  } catch(e) { result.events_error = e.message; }

  // O que /players/?team=ID retorna para os IDs encontrados
  const ids = [...new Set(result.events_found.map(e=>e.id).filter(Boolean))].slice(0,3);
  result.team_ids_found = ids;
  for (const id of ids) {
    try {
      const r = await fetch(`https://sports.bzzoiro.com/api/players/?team=${id}&limit=5`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
      result.players_found.push({ team_id: id, count: (r.results||[]).length, sample: (r.results||[]).slice(0,3).map(p=>p.name) });
    } catch(e) { result.players_found.push({ team_id: id, error: e.message }); }
  }

  res.json(result);
});

// GET /api/debug/squad/:teamId — mostra RAW de cada etapa do squad
app.get('/api/debug/squad/:teamId', async (req, res) => {
  const teamId = String(req.params.teamId);
  const result = { teamId, steps: {} };

  // Passo 1: /api/players/?team=ID
  try {
    const r = await fetch(`https://sports.bzzoiro.com/api/players/?team=${teamId}&limit=5`,
      { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    result.steps.players_endpoint = {
      count: (r.results||[]).length,
      sample: (r.results||[]).slice(0,5).map(p => ({ id: p.id, name: p.name }))
    };
  } catch(e) { result.steps.players_endpoint = { error: e.message }; }

  // Passo 2: eventos recentes (sem filtro, filtra manualmente)
  const df = new Date(Date.now()-60*86400000).toISOString().slice(0,10);
  const dt = new Date(Date.now()+14*86400000).toISOString().slice(0,10);
  let teamEvents = [];
  try {
    const evData = await fetch(
      `https://sports.bzzoiro.com/api/events/?date_from=${df}&date_to=${dt}&limit=200`,
      { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    teamEvents = (evData.results||[]).filter(ev => {
      const hid = String(ev.home_team_id||ev.home_team_obj?.id||'');
      const aid = String(ev.away_team_id||ev.away_team_obj?.id||'');
      return hid === teamId || aid === teamId;
    });
    result.steps.events_found = teamEvents.map(ev => ({
      id: ev.id, date: ev.event_date?.slice(0,10),
      home: ev.home_team, away: ev.away_team,
      home_id: ev.home_team_id||ev.home_team_obj?.id,
      away_id: ev.away_team_id||ev.away_team_obj?.id,
      status: ev.status
    }));
  } catch(e) { result.steps.events_found = { error: e.message }; }

  // Passo 3: player-stats do primeiro evento encontrado
  if (teamEvents.length > 0) {
    const ev = teamEvents[0];
    try {
      const ps = await fetch(
        `https://sports.bzzoiro.com/api/player-stats/?event=${ev.id}&limit=50`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
      const items = ps.results||[];
      result.steps.player_stats = {
        event_id: ev.id,
        total: items.length,
        fields_sample: items[0] ? Object.keys(items[0]) : [],
        is_home_values: [...new Set(items.map(p => p.is_home))],
        sample: items.slice(0,6).map(p => ({
          name: p.player?.name,
          is_home: p.is_home,
          side: p.side,
          team_id: p.team_id,
          player_id: p.player?.id
        }))
      };
    } catch(e) { result.steps.player_stats = { error: e.message }; }
  }

  res.json(result);
});

app.get('/api/debug/lineup/:teamId', async (req, res) => {
  const teamId = String(req.params.teamId);
  const df = new Date().toISOString().slice(0,10);
  const dt = new Date(Date.now() + 10*86400000).toISOString().slice(0,10);
  const pastFrom = new Date(Date.now() - 14*86400000).toISOString().slice(0,10);
  const result = { teamId, df, pastFrom, dt, steps: {} };

  // Passo 1: próximos jogos (futuro e passado recente)
  const allMatches = [];
  for (const [param, from, to, label] of [
    ['home_team_id', df,       dt,      'futuro_home'],
    ['away_team_id', df,       dt,      'futuro_away'],
    ['home_team_id', pastFrom, df,      'passado_home'],
    ['away_team_id', pastFrom, df,      'passado_away'],
  ]) {
    try {
      const r = await fetch(
        `https://sports.bzzoiro.com/api/events/?${param}=${teamId}&date_from=${from}&date_to=${to}&limit=3&ordering=event_date`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }
      ).then(r => r.json());
      result.steps[label] = (r.results||[]).map(e => ({ id: e.id, date: e.event_date?.slice(0,10), home: e.home_team, away: e.away_team }));
      allMatches.push(...(r.results||[]).map(e => ({ ...e, _side: param.startsWith('home') ? 'home' : 'away' })));
    } catch(e) { result.steps[label] = { error: e.message }; }
  }

  // Passo 2: para os primeiros 3 jogos encontrados, testa 3 endpoints de lineup diferentes
  result.steps.lineup_probes = [];
  const seen = new Set();
  for (const ev of allMatches.filter(e => !seen.has(e.id) && seen.add(e.id)).slice(0,3)) {
    const probe = { event_id: ev.id, date: ev.event_date?.slice(0,10), home: ev.home_team, away: ev.away_team, side: ev._side, endpoints: {} };

    // Endpoint A: /events/{id}/lineups/
    try {
      const r = await fetch(`https://sports.bzzoiro.com/api/events/${ev.id}/lineups/`, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
      probe.endpoints.lineups_endpoint = { top_keys: Object.keys(r), lineup_status: r.lineup_status||r.status||null, has_home: !!(r.lineups?.home||r.home), has_away: !!(r.lineups?.away||r.away), home_player_count: (r.lineups?.home?.players||r.home?.players||[]).length, sample_player: (r.lineups?.home?.players||r.home?.players||[])[0] || null };
    } catch(e) { probe.endpoints.lineups_endpoint = { error: e.message }; }

    // Endpoint B: /events/{id}/?full=true  (mesmo que o modal usa)
    try {
      const r = await fetch(`https://sports.bzzoiro.com/api/events/${ev.id}/?full=true`, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
      const lu = r.lineups || r.lineup;
      probe.endpoints.event_full = {
        top_keys: Object.keys(r),
        has_lineups_key: !!r.lineups,
        has_lineup_key: !!r.lineup,
        lineup_status: r.lineup_status || r.lineups?.lineup_status || null,
        home_player_count: (lu?.home?.players||[]).length,
        away_player_count: (lu?.away?.players||[]).length,
        sample_player: (lu?.home?.players||[])[0] || (lu?.away?.players||[])[0] || null,
      };
    } catch(e) { probe.endpoints.event_full = { error: e.message }; }

    // Endpoint C: /predictions/{id}/  (tem lineup predita?)
    try {
      const r = await fetch(`https://sports.bzzoiro.com/api/events/${ev.id}/prediction/`, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
      probe.endpoints.prediction = {
        top_keys: Object.keys(r),
        has_lineups: !!(r.lineups||r.lineup||r.predicted_lineup||r.home_lineup),
        lineup_keys: Object.keys(r).filter(k => k.toLowerCase().includes('line')||k.toLowerCase().includes('squad')||k.toLowerCase().includes('player')),
      };
    } catch(e) { probe.endpoints.prediction = { error: e.message }; }

    result.steps.lineup_probes.push(probe);
  }

  res.json(result);
});

// que o frontend espera (garante home_team_id etc.)
// ─────────────────────────────────────────────
function normEvento(ev) {
  if (!ev) return ev;
  return {
    ...ev,
    // BSD retorna home_team_obj:{id,name} e away_team_obj:{id,name}
    // NÃO existe home_team_id na raiz — está dentro do objeto
    home_team_id: ev.home_team_id || ev.home_team_obj?.id || ev.home_id || null,
    away_team_id: ev.away_team_id || ev.away_team_obj?.id || ev.away_id || null,
    home_team:    ev.home_team    || ev.home_team_obj?.name || '—',
    away_team:    ev.away_team    || ev.away_team_obj?.name || '—',
    league_name:  ev.league_name  || ev.league?.name || ev.group_name || '—',
    league_id:    ev.league_id    || ev.league?.id   || null,
    status:       ev.status       || (ev.is_live ? 'inprogress' : 'ns'),
    // xG disponível diretamente no evento!
    home_xg:      ev.home_xg      || ev.actual_home_xg || null,
    away_xg:      ev.away_xg      || ev.actual_away_xg || null,
    // Odds já disponíveis na raiz
    odds_home:    ev.odds_home,
    odds_draw:    ev.odds_draw,
    odds_away:    ev.odds_away,
  };
}

// ─────────────────────────────────────────────
// JOGOS — hoje, amanhã, semana, ao vivo
// ─────────────────────────────────────────────
app.get('/api/jogos/hoje', async (req, res) => {
  try {
    const { league_id, date } = req.query;
    // Usa a data passada pelo frontend (horário local do usuário) ou today() como fallback
    const t = date || today();
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${t}&date_to=${t}&tz=America/Sao_Paulo&limit=200${league_id ? `&league=${league_id}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    data.results = (data.results || []).map(normEvento);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/amanha', async (req, res) => {
  try {
    const { league_id } = req.query;
    const t = dayOffset(1);
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${t}&date_to=${t}&tz=America/Sao_Paulo&limit=200${league_id ? `&league=${league_id}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    data.results = (data.results || []).map(normEvento);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/semana', async (req, res) => {
  try {
    const { league_id } = req.query;
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${today()}&date_to=${dayOffset(7)}&tz=America/Sao_Paulo&limit=200${league_id ? `&league=${league_id}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    data.results = (data.results || []).map(normEvento);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/ao-vivo', async (req, res) => {
  try {
    const { league_id } = req.query;
    const url = `https://sports.bzzoiro.com/api/live/?tz=America/Sao_Paulo${league_id ? `&league=${league_id}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    // /api/live/ retorna {events:[...]} ou {results:[...]}
    const lista = data.events || data.results || [];
    const normalized = lista.map(normEvento);
    res.json({ results: normalized, count: normalized.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Detalhes completos de um jogo
app.get('/api/jogos/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [evento, stats, incidents, odds, lineups, playerStats, predicao] = await Promise.allSettled([
      bsd(`/events/${id}/`, { full: 'true' }),  // full=true traz lineups, shotmap, momentum
      bsd(`/events/${id}/stats/`),
      bsd(`/events/${id}/incidents/`),
      bsd(`/events/${id}/odds/`),
      bsd(`/events/${id}/lineups/`),
      bsd(`/events/${id}/player-stats/`),
      bsd(`/events/${id}/prediction/`)
    ]);

    const evData = evento.status === 'fulfilled' ? evento.value : null;
    const statsData = stats.status === 'fulfilled' ? stats.value : null;
    const predData = predicao.status === 'fulfilled' ? predicao.value : null;

    // Extrai xG de todas as fontes possíveis e normaliza no objeto evento
    if (evData) {
      const sh = statsData?.stats?.home || {};
      const sa = statsData?.stats?.away || {};
      // xG pode estar em: stats.home.xg, stats.home.xg.actual, evento.home_xg, predicao.markets.expected_goals
      if (!evData.home_xg) {
        evData.home_xg = sh?.xg?.actual ?? sh?.xg?.value ?? sh?.xg
          ?? predData?.markets?.expected_goals?.home ?? null;
      }
      if (!evData.away_xg) {
        evData.away_xg = sa?.xg?.actual ?? sa?.xg?.value ?? sa?.xg
          ?? predData?.markets?.expected_goals?.away ?? null;
      }
    }

    res.json({
      evento: evData,
      stats: statsData,
      incidents: incidents.status === 'fulfilled' ? incidents.value : null,
      odds: odds.status === 'fulfilled' ? odds.value : null,
      lineups: lineups.status === 'fulfilled' ? lineups.value : null,
      playerStats: playerStats.status === 'fulfilled' ? playerStats.value : null,
      predicao: predData
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Odds comparativo (todas as casas)
app.get('/api/jogos/:id/odds', async (req, res) => {
  try {
    const data = await bsd(`/events/${req.params.id}/odds/comparison/`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Predição ML por jogo
app.get('/api/jogos/:id/predicao', async (req, res) => {
  try {
    const data = await bsd(`/events/${req.params.id}/prediction/`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stats do jogo (xG, shotmap, momentum)
app.get('/api/jogos/:id/stats', async (req, res) => {
  try {
    const data = await bsd(`/events/${req.params.id}/stats/`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Escalações (confirmada ou predita por IA)
app.get('/api/jogos/:id/lineups', async (req, res) => {
  try {
    const data = await bsd(`/events/${req.params.id}/lineups/`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Timeline de gols/cartões/substituições
app.get('/api/jogos/:id/incidents', async (req, res) => {
  try {
    const data = await bsd(`/events/${req.params.id}/incidents/`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stats de jogadores do jogo
app.get('/api/jogos/:id/jogadores', async (req, res) => {
  try {
    const data = await bsd(`/events/${req.params.id}/player-stats/`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Metadata (preview IA, uniformes, curiosidades)
app.get('/api/jogos/:id/metadata', async (req, res) => {
  try {
    const data = await bsd(`/events/${req.params.id}/metadata/`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// PREDIÇÕES — lista geral
// ─────────────────────────────────────────────
app.get('/api/predicoes', async (req, res) => {
  try {
    const { league_id, date_from, date_to } = req.query;
    const dfrom = date_from || today();
    const dto   = date_to   || dayOffset(3);
    const qs = new URLSearchParams({ date_from: dfrom, date_to: dto, limit: 100, tz: 'America/Sao_Paulo' });
    if (league_id) qs.set('league', league_id);
    const data = await fetch(`https://sports.bzzoiro.com/api/predictions/?${qs}`, {
      headers: { Authorization: `Token ${BSD_TOKEN}` }
    }).then(r => r.json());
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// VALUE BETS — endpoint real da BSD v2
// GET /api/v2/value-bets/ com edge, confidence e bookmaker reais
// ─────────────────────────────────────────────
app.get('/api/value-bets', async (req, res) => {
  try {
    const { market, league_id, min_conf = 70, limit = 50 } = req.query;

    const qs = new URLSearchParams({ limit: limit || 100 });
    if (market && market !== '1x2') qs.set('market', market);
    if (league_id) qs.set('league_id', league_id);

    // Tenta endpoint v2 primeiro
    let raw = [];
    try {
      const r2 = await fetch(
        `https://sports.bzzoiro.com/api/v2/value-bets/?${qs}`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }
      );
      const d2 = await r2.json();
      raw = d2.results || d2.value_bets || d2.bets || d2.data || [];
      console.log('[value-bets] v2 response keys:', Object.keys(d2));
      console.log('[value-bets] v2 raw count:', raw.length);
      if (raw.length > 0) console.log('[value-bets] v2 first item keys:', Object.keys(raw[0]));
    } catch(e2) {
      console.log('[value-bets] v2 falhou:', e2.message);
    }

    // Fallback: predictions com confiança alta + odds reais
    if (!raw.length) {
      console.log('[value-bets] usando fallback via predictions...');
      const qs2 = new URLSearchParams({
        date_from: today(), date_to: dayOffset(7), limit: 100, tz: 'America/Sao_Paulo'
      });
      if (league_id) qs2.set('league', league_id);
      const d1 = await fetch(
        `https://sports.bzzoiro.com/api/predictions/?${qs2}`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }
      ).then(r => r.json()).catch(() => ({}));

      raw = (d1.results || [])
        .filter(p => {
          const mr = (p.markets||p.predictions||{}).match_result || {};
          return Math.max(mr.prob_home||0, mr.prob_draw||0, mr.prob_away||0) >= 55;
        })
        .map(p => {
          const ev = p.event || {};
          const mr = (p.markets||p.predictions||{}).match_result || {};
          const ph=mr.prob_home||0, pd=mr.prob_draw||0, pa=mr.prob_away||0;
          const maxP = Math.max(ph,pd,pa);
          const outcome = ph>=pd&&ph>=pa?'home':pa>=ph&&pa>=pd?'away':'draw';
          const outLabel = {home:'Casa',away:'Fora',draw:'Empate'}[outcome];
          const odd = {home:ev.odds_home,away:ev.odds_away,draw:ev.odds_draw}[outcome];
          const recs = p.recommendations || {};
          return {
            event: ev,
            confidence: Math.round((p.model?.confidence||maxP/100)*100),
            market: market||'1x2',
            outcome: outLabel,
            odd: odd||null,
            bookmaker: 'Consenso BSD',
            edge_pct: null,
            fair_odd: null,
          };
        });
      console.log('[value-bets] fallback predictions:', raw.length);
    }

    let results = raw;

    // Normaliza para o formato que o frontend espera
    const normalized = results
      .filter(vb => {
        // Aceita qualquer resultado com pelo menos um campo reconhecível
        return vb && (vb.confidence != null || vb.odd != null || vb.odds != null || vb.market != null);
      })
      .map(vb => {
        const ev  = vb.event || vb.match || {};
        const conf = vb.confidence ?? vb.conf ?? vb.model_confidence ?? 0;
        const edge = vb.edge_pct   ?? vb.edge ?? vb.value_pct ?? null;
        // market/outcome
        const market_name = vb.market || vb.market_key || vb.bet_type || '1x2';
        const outcome = vb.outcome  || vb.pick || vb.outcome_name || vb.bet || '—';
        const odds    = vb.odd      || vb.decimal_odds || vb.odds || null;
        const bookmaker = vb.bookmaker || vb.bookmaker_name || vb.bookmaker_slug || 'Mercado';
        const fair_odd  = vb.fair_odd  || null;

        return {
          home_team:   ev.home_team  || vb.home_team  || '—',
          away_team:   ev.away_team  || vb.away_team  || '—',
          league_name: ev.league_name || vb.league_name || '—',
          league_id:   ev.league_id  || vb.league_id  || null,
          event_date:  ev.event_date  || vb.event_date || null,
          confidence:  Math.round(conf),
          market:      market_name,
          best_odds: [{
            outcome_name:   outcome,
            decimal_odds:   odds ? Number(odds) : null,
            bookmaker_name: bookmaker,
            edge_pct:       edge,
            fair_odd:       fair_odd
          }]
        };
      });

    console.log(`[value-bets] raw: ${raw.length}, normalized: ${normalized.length}`);
    res.json({ results: normalized, total: normalized.length });
  } catch (e) {
    console.error('[value-bets] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Polymarket (predição de mercado)
app.get('/api/polymarket', async (req, res) => {
  try {
    const { league_id, event_id } = req.query;
    const data = await bsd('/odds/', {
      // polymarket via endpoint principal filtrado
      league_id,
      event_id,
      limit: 50
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// ROTAS DE COMPATIBILIDADE (frontend original)
// ─────────────────────────────────────────────

// Busca times via eventos — BSD não tem times brasileiros em /api/teams/
// Busca em eventos recentes + standings + seasons
app.get('/api/teams', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Parâmetro q obrigatório' });
    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const term = norm(q);
    const seen = new Map();

    // Busca em eventos dos últimos 60 dias + próximos 14
    const dateFrom = new Date(Date.now()-60*86400000).toISOString().slice(0,10);
    const dateTo   = new Date(Date.now()+14*86400000).toISOString().slice(0,10);
    const evData = await fetch(
      `https://sports.bzzoiro.com/api/events/?date_from=${dateFrom}&date_to=${dateTo}&limit=200`,
      { headers: { Authorization: `Token ${BSD_TOKEN}` } }
    ).then(r => r.json());

    (evData.results || []).forEach(ev => {
      // BSD v2: ID real pode estar em home_team_obj.id quando home_team_id é null
      const hid = ev.home_team_id || ev.home_team_obj?.id;
      const aid = ev.away_team_id || ev.away_team_obj?.id;
      if (norm(ev.home_team||'').includes(term) && hid && !seen.has(hid))
        seen.set(hid, { id: hid, name: ev.home_team, country: ev.league?.country || ev.home_team_obj?.country || '' });
      if (norm(ev.away_team||'').includes(term) && aid && !seen.has(aid))
        seen.set(aid, { id: aid, name: ev.away_team, country: ev.league?.country || ev.away_team_obj?.country || '' });
    });

    // Se não achou, busca em todas as standings de todas as ligas
    if (seen.size === 0) {
      const ligasData = await fetch('https://sports.bzzoiro.com/api/leagues/', {
        headers: { Authorization: `Token ${BSD_TOKEN}` }
      }).then(r => r.json());
      for (const liga of (ligasData.results||[])) {
        try {
          const std = await fetch(`https://sports.bzzoiro.com/api/leagues/${liga.id}/standings/`, {
            headers: { Authorization: `Token ${BSD_TOKEN}` }
          }).then(r => r.json());
          for (const s of (std.standings||[])) {
            const nome = s.team||s.team_name||'';
            const tid  = s.team_id||s.id;
            if (norm(nome).includes(term) && tid && !seen.has(tid))
              seen.set(tid, { id: tid, name: nome, country: liga.country||'' });
          }
          if (seen.size >= 5) break;
        } catch(_) {}
      }
    }

    console.log(`Teams search "${q}": achou ${seen.size} via eventos/standings`);
    res.json({ teams: Array.from(seen.values()).slice(0,15) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/teams-all', async (req, res) => res.json({ results: [], next: null }));

// ─────────────────────────────────────────────
// ELENCO DO TIME  →  /api/squad/:id
// ─────────────────────────────────────────────
// Estratégia:
//  1. Elenco: /api/players/?team=ID  (europeus)
//             fallback via player-stats dos últimos 90 dias (brasileiros)
//  2. Lineup: busca o PRÓXIMO jogo usando home_team_id + away_team_id separados
//             (BSD não suporta ?team= — esse era o bug raiz dos círculos vazios)
//  3. Cruzamento de IDs — tenta por ID numérico; fallback robusto por nome
// ─────────────────────────────────────────────
app.get('/api/squad/:id', async (req, res) => {
  try {
    const teamId = String(req.params.id);
    let players = [];

    // ── FASE ÚNICA: busca eventos → monta elenco E lineup de uma vez ──────────
    // Uma única busca de 200 eventos evita a paginação aleatória da BSD
    // que fazia F1 e F2 retornarem conjuntos diferentes de eventos

    let lineupStatus    = null;
    let lineupPlayerIds = new Set();
    let confirmedIds    = new Set();
    let nextMatchInfo   = null;

    try {
      const df2      = new Date(Date.now() - 90*86400000).toISOString().slice(0,10);
      const dt2      = new Date(Date.now() + 14*86400000).toISOString().slice(0,10);

      // UMA busca de eventos - reutilizada para elenco e lineup
      const evResp = await fetch(
        `https://sports.bzzoiro.com/api/events/?date_from=${df2}&date_to=${dt2}&limit=200`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }
      ).then(r => r.json());

      const allEvs = evResp.results || [];
      const evSeen = new Set();
      const teamEvs = allEvs
        .filter(ev => {
          const h = String(ev.home_team_id||ev.home_team_obj?.id||'');
          const a = String(ev.away_team_id||ev.away_team_obj?.id||'');
          return (h===teamId||a===teamId) && !evSeen.has(ev.id) && evSeen.add(ev.id);
        })
        .sort((a,b) => new Date(b.event_date)-new Date(a.event_date));

      console.log(`[squad] eventos do time ${teamId}: ${teamEvs.length}`);

      // Busca full=true para cada evento (lineup separada por home/away)
      const pMap     = new Map();
      let   nextMatch = null;
      let   isHomeTeam = false;
      let   lu        = null;

      for (const ev of teamEvs.slice(0,8)) {
        try {
          const h    = String(ev.home_team_id||ev.home_team_obj?.id||'');
          const isH  = h === teamId;
          const full = await fetch(
            `https://sports.bzzoiro.com/api/events/${ev.id}/?full=true`,
            { headers: { Authorization: `Token ${BSD_TOKEN}` } }
          ).then(r => r.json());

          const luObj = full.lineups || full.lineup;
          const side  = luObj ? (isH ? luObj.home : luObj.away) : null;
          const list  = side  ? [...(side.players||[]), ...(side.substitutes||[])] : [];

          console.log(`[squad] ev ${ev.id} (${ev.home_team}x${ev.away_team}) isH=${isH} jugadores=${list.length}`);

          // Adiciona ao elenco
          for (const p of list) {
            const pid = String(p.player_id||p.api_id||p.player?.id||p.id||'');
            if (!pid||pid==='undefined'||pid==='null'||pMap.has(pid)) continue;
            pMap.set(pid, {
              id:            pid,
              name:          p.name||p.player?.name||'—',
              position:      p.position||p.player?.position||'—',
              jersey_number: String(p.jersey_number||''),
              photo:         `https://sports.bzzoiro.com/img/player/${pid}/`
            });
          }

          // Guarda como próximo jogo para lineup se ainda não temos
          if (!nextMatch && list.length > 0) {
            nextMatch  = ev;
            isHomeTeam = isH;
            lu         = { lineup_status: luObj?.lineup_status || null, lineups: luObj };
          }
        } catch(e) { console.log(`[squad] erro ev ${ev.id}:`, e.message); }
      }

      players = [...pMap.values()];
      console.log(`[squad] elenco: ${players.length} jogadores`);

      // Processa lineup para os círculos de status
      if (nextMatch && lu) {
        const evStatus   = (nextMatch.status||'').toLowerCase();
        const LIVE_S     = new Set(['inprogress','live','1h','2h','ht','ongoing','extra_time','et','penalties']);
        const matchIsLive     = LIVE_S.has(evStatus)||nextMatch.is_live===true||(nextMatch.current_minute>0&&evStatus!=='finished'&&evStatus!=='ft');
        const matchIsFinished = evStatus==='finished'||evStatus==='ft'||evStatus==='complete';

        lineupStatus = lu.lineup_status || lu.lineups?.lineup_status || null;
        if (matchIsLive||matchIsFinished) lineupStatus = 'confirmed';

        nextMatchInfo = `${nextMatch.home_team} × ${nextMatch.away_team} (${nextMatch.event_date?.slice(0,10)}) [isHome=${isHomeTeam}]`;
        console.log(`[squad] próximo jogo: ${nextMatchInfo} status=${lineupStatus}`);

        const luSide   = lu.lineups ? (isHomeTeam ? lu.lineups.home : lu.lineups.away) : null;
        const starters = luSide?.players     || [];
        const subs     = luSide?.substitutes || [];

        const extractPid = p => String(p.player_id||p.api_id||p.player?.id||p.id||'');
        const norm2      = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();

        const starterPids = new Set(starters.map(extractPid).filter(p=>p&&p!=='undefined'&&p!=='null'));
        const allLuPids   = new Set([...starters,...subs].map(extractPid).filter(p=>p&&p!=='undefined'&&p!=='null'));
        const allLuNames  = new Set([...starters,...subs].map(p=>norm2(p.name||p.player?.name||'')).filter(Boolean));
        const starterNames= new Set(starters.map(p=>norm2(p.name||p.player?.name||'')).filter(Boolean));

        lineupPlayerIds = allLuPids;
        if (lineupStatus==='confirmed') starterPids.forEach(p=>confirmedIds.add(p));

        // Fallback por nome se IDs não bateram
        const idsInSquad = new Set(players.map(p=>p.id));
        if ([...allLuPids].filter(p=>idsInSquad.has(p)).length === 0 && allLuNames.size > 0) {
          console.log('[squad] fallback nome...');
          players.forEach(p => {
            const pn = norm2(p.name);
            const pt = pn.split(/\s+/).filter(t=>t.length>=3);
            const inAll = [...allLuNames].some(ln => {
              const lt = ln.split(/\s+/).filter(t=>t.length>=3);
              return lt.some(l=>pt.some(pp=>l===pp||l.startsWith(pp)||pp.startsWith(l)));
            });
            if (inAll) {
              lineupPlayerIds.add(p.id);
              const inStarter = [...starterNames].some(ln => {
                const lt = ln.split(/\s+/).filter(t=>t.length>=3);
                return lt.some(l=>pt.some(pp=>l===pp||l.startsWith(pp)||pp.startsWith(l)));
              });
              if (lineupStatus==='confirmed'&&inStarter) confirmedIds.add(p.id);
            }
          });
          console.log(`[squad] fallback nome: ${lineupPlayerIds.size} IDs`);
        }
      }
    } catch(e) {
      console.log('[squad] erro geral:', e.message);
    }

    // ── FASE 3: CRUZAMENTO FINAL ─────────────────────────────────
    players = players.map(p => {
      const pid = String(p.id);
      let status = null;
      if (confirmedIds.has(pid)) {
        status = 'confirmed';    // 🟢 confirmado titular
      } else if (lineupPlayerIds.has(pid)) {
        status = 'predicted';    // 🟡 na escalação predita / banco confirmado
      }
      return { ...p, lineup_status: status };
    });

    const withStatus = players.filter(p => p.lineup_status).length;
    console.log(`[squad] retornando ${players.length} jogadores, ${withStatus} com status de escalação`);

    res.json({ players, lineup_status: lineupStatus, next_match: nextMatchInfo });
  } catch (e) {
    console.log('[squad] erro geral:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Stats do jogador → /api/player/:id/stats?teamId=X
// Usa BSD: /api/player-stats/?player=ID (endpoint que retorna evento aninhado)
// Cada item: { event: {id, home_team, away_team, event_date, home_score, away_score, home_team_id, away_team_id},
//              total_shots, shots_on_target, total_tackle, yellow_card, red_card, saves,
//              fouls_committed, fouls_drawn, goals, goal_assist, accurate_pass, minutes_played, rating }
app.get('/api/player/:id/stats', async (req, res) => {
  try {
    const { teamId } = req.query;
    const playerId = req.params.id;

    // Endpoint correto: /api/player-stats/?player=ID retorna lista com evento aninhado
    const data = await fetch(
      `https://sports.bzzoiro.com/api/player-stats/?player=${playerId}&limit=20&tz=America/Sao_Paulo`,
      { headers: { Authorization: `Token ${BSD_TOKEN}` } }
    ).then(r => r.json());

    let raw = data.results || [];

    if (!raw.length) {
      return res.json({ jogos: [], fromCache: false });
    }

    // Debug: ver o que a BSD retorna no primeiro item
    if (raw.length > 0) {
      const s = raw[0];
      console.log('[player-stats] CAMPOS RAIZ:', Object.keys(s).join(', '));
      console.log('[player-stats] team_id:', s.team_id, '| event.home_team_id:', s.event?.home_team_id, '| event.away_team_id:', s.event?.away_team_id);
      console.log('[player-stats] teamId query:', teamId);
    }

    // Ordena por data mais recente
    raw.sort((a, b) => new Date(b.event?.event_date || 0) - new Date(a.event?.event_date || 0));

    const jogos = raw.slice(0, 7).map(g => {
      const ev = g.event || {};

      // Determina o lado do jogador — usa g.team_id (campo do item) como fonte primária
      // depois teamId da query, depois nome do time como fallback
      const playerTeamId = String(g.team_id || teamId || '');
      const homeId       = String(ev.home_team_id || '');
      const awayId       = String(ev.away_team_id || '');

      let opponent, myScore, oppScore;
      if (playerTeamId && homeId && playerTeamId === homeId) {
        opponent = ev.away_team;  myScore = ev.home_score; oppScore = ev.away_score;
      } else if (playerTeamId && awayId && playerTeamId === awayId) {
        opponent = ev.home_team;  myScore = ev.away_score; oppScore = ev.home_score;
      } else if (homeId && homeId === String(teamId)) {
        opponent = ev.away_team;  myScore = ev.home_score; oppScore = ev.away_score;
      } else if (awayId && awayId === String(teamId)) {
        opponent = ev.home_team;  myScore = ev.away_score; oppScore = ev.home_score;
      } else {
        // Último fallback: tenta pelo nome do time no item do player-stats
        const ht  = (ev.home_team || '').toLowerCase();
        const at  = (ev.away_team || '').toLowerCase();
        const tn  = (g.team?.name || g.team_name || g.player?.team || '').toLowerCase();
        const tok = tn ? tn.split(' ')[0] : '';
        if (tok && ht.includes(tok)) {
          opponent = ev.away_team;  myScore = ev.home_score; oppScore = ev.away_score;
        } else if (tok && at.includes(tok)) {
          opponent = ev.home_team;  myScore = ev.away_score; oppScore = ev.home_score;
        } else {
          // Sem informação de lado — mantém jogo completo para o frontend resolver
          opponent = `${ev.home_team} × ${ev.away_team}`;
          myScore = null; oppScore = null;
        }
      }

      let result = '—';
      if (myScore != null && oppScore != null) {
        result = myScore > oppScore ? 'W' : myScore < oppScore ? 'L' : 'D';
      }

      const score = (ev.home_score != null && ev.away_score != null)
        ? `${ev.home_score}-${ev.away_score}` : '—';

      const data_jogo = ev.event_date
        ? new Date(ev.event_date).toLocaleDateString('pt-BR',
            { day:'2-digit', month:'2-digit', timeZone:'America/Sao_Paulo' })
        : '—';

      // Campos BSD confirmados na documentação (raiz do item)
      const n = (v) => (v !== null && v !== undefined && v !== '' && !isNaN(Number(v))) ? Number(v) : null;

      return {
        opponent:     opponent || '—',
        score,
        result,
        data:         data_jogo,
        chutes:       n(g.total_shots)   ?? n(g.shots),
        chutes_gol:   n(g.shots_on_target) ?? n(g.shots_on_goal),
        desarmes:     n(g.total_tackle),
        ftc:          n(g.fouls_committed) ?? n(g.fouls),
        fts:          n(g.fouls_drawn)   ?? n(g.was_fouled),
        amarelos:     n(g.yellow_card)   ?? n(g.yellow_cards),
        vermelhos:    n(g.red_card)      ?? n(g.red_cards),
        defesas:      n(g.saves),
        gols:         n(g.goals),
        assistencias: n(g.goal_assist),
        minutos:      n(g.minutes_played),
        passes:       n(g.accurate_pass) ?? n(g.total_pass),
        rating:       n(g.rating),
      };
    });

    res.json({ jogos, fromCache: false });
  } catch (e) {
    console.error('[player-stats] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─────────────────────────────────────────────
// ÁRBITRO — stats por jogo (cartões, pênaltis)
// Útil para apostadores: árbitros com histórico
// de muitos cartões elevam Over de cartões
// ─────────────────────────────────────────────
app.get('/api/arbitros/:id/stats', async (req, res) => {
  try {
    const id = req.params.id;
    const [detailRes, matchesRes] = await Promise.allSettled([
      bsd(`/referees/${id}/`),
      bsd(`/referees/${id}/matches/`, {
        date_from: dayOffset(-365),
        date_to:   dayOffset(0),
        limit: 15,
        ordering: '-event_date'
      })
    ]);

    const detail    = detailRes.status  === 'fulfilled' ? detailRes.value  : null;
    const matchData = matchesRes.status === 'fulfilled' ? matchesRes.value : null;
    const items     = matchData?.results || [];

    const avgY = detail?.avg_yellow_per_match ?? null;
    const avgR = detail?.avg_red_per_match    ?? null;
    const avgF = detail?.avg_fouls_per_match  ?? null;
    const avgP = detail?.avg_goals_per_match  ?? null;
    const totM = detail?.matches              ?? items.length;
    const totY = detail?.total_yellow_cards   ?? null;
    const totR = detail?.total_red_cards      ?? null;

    // Para cada jogo, busca os incidentes para contar cartões reais por partida
    // /events/{id}/incidents/ retorna gols, cartões, substituições etc.
    const jogos = await Promise.all(items.map(async m => {
      const ev  = m.event || m;
      const evId = ev.id || m.id || null;
      let yellow = m.yellow_cards ?? m.referee_yellow_cards ?? null;
      let red    = m.red_cards    ?? m.referee_red_cards    ?? null;

      // Se a BSD não retornou cartões no item, busca nos incidentes do evento
      if (evId && (yellow === null || red === null)) {
        try {
          const inc = await bsd(`/events/${evId}/incidents/`);
          const list = inc.results || inc.incidents || [];
          if (list.length > 0) {
            yellow = list.filter(i =>
              i.card_type === 'yellow' || i.card_type === 'yellowCard' ||
              (i.type === 'card' && (i.card_type === 'yellow' || String(i.card_type||'').toLowerCase().includes('yellow')))
            ).length;
            red = list.filter(i =>
              i.card_type === 'red' || i.card_type === 'redCard' ||
              i.card_type === 'yellow_red' || i.card_type === 'yellowRed' ||
              (i.type === 'card' && (i.card_type === 'red' || String(i.card_type||'').toLowerCase().includes('red')))
            ).length;
          } else {
            // Fallback: tenta stats do evento (tem yellow_cards somados por time)
            try {
              const st = await bsd(`/events/${evId}/stats/`);
              const sh = st?.stats?.home || st?.home || {};
              const sa = st?.stats?.away || st?.away || {};
              yellow = (Number(sh.yellow_cards||0) + Number(sa.yellow_cards||0)) || null;
              red    = (Number(sh.red_cards||0)    + Number(sa.red_cards||0))    || null;
            } catch (_) {}
          }
        } catch (e) {
          console.warn(`[arb-incidents] erro evento ${evId}:`, e.message);
        }
      }

      return {
        id:           evId,
        home_team:    ev.home_team  || m.home_team  || '—',
        away_team:    ev.away_team  || m.away_team  || '—',
        event_date:   ev.event_date || m.event_date || null,
        yellow_cards: yellow,
        red_cards:    red,
        penalties:    m.penalties  ?? null,
        league_name:  ev.league?.name || m.league_name || '—',
      };
    }));

    // Busca próximos jogos do árbitro (próximos 14 dias)
    let proximosJogos = [];
    try {
      const futEvs = await bsd('/events/', {
        date_from: today(),
        date_to:   dayOffset(14),
        limit:     500,
        referee_id: id
      });
      // Se BSD não suporta referee_id como filtro, filtra manualmente
      const all = futEvs.results || [];
      proximosJogos = all
        .filter(ev => String(ev.referee_id||ev.referee?.id||'') === String(id))
        .map(ev => ({
          id:          ev.id,
          home_team:   ev.home_team,
          away_team:   ev.away_team,
          event_date:  ev.event_date,
          league_name: ev.league?.name || ev.league_name || '—',
        }))
        .sort((a,b) => new Date(a.event_date) - new Date(b.event_date))
        .slice(0, 5);
    } catch(_) {}

    res.json({
      detail, jogos, proximos_jogos: proximosJogos,
      averages: {
        yellow_per_game:    avgY ?? 0,
        red_per_game:       avgR ?? 0,
        fouls_per_game:     avgF ?? 0,
        penalties_per_game: avgP ?? 0,
        games_analyzed:     totM,
        total_yellow:       totY,
        total_red:          totR,
      }
    });
  } catch (e) {
    console.error('[arbitros/stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Árbitro por nome
app.get('/api/arbitros/buscar', async (req, res) => {
  try {
    const { name, league_id } = req.query;
    const data = await bsd('/referees/', { name, league_id, limit: 20 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// ÁRBITROS DOS PRÓXIMOS JOGOS
// Extrai árbitros escalados dos eventos futuros
// ─────────────────────────────────────────────
app.get('/api/arbitros/proximos', async (req, res) => {
  try {
    const { league_id, name } = req.query;

    // ESTRATÉGIA DUPLA:
    // 1. Busca /referees/ diretamente (lista completa com stats)
    // 2. Busca eventos próximos para cruzar jogos confirmados
    const refParams = { limit: 200, min_matches: 1 };
    if (league_id) refParams.id_da_liga = league_id;
    if (name)      refParams.name       = name;

    const [refData, evData] = await Promise.allSettled([
      bsd('/referees/', refParams),
      bsd('/events/', {
        date_from: today(),
        date_to: dayOffset(7),
        limit: 500,
        tz: 'America/Sao_Paulo',
        ...(league_id ? { league: league_id } : {})
      })
    ]);

    const lista   = refData.status   === 'fulfilled' ? (refData.value.results   || []) : [];
    const eventos = evData.status === 'fulfilled' ? (evData.value.results || []) : [];

    // Mapa de jogos por referee_id
    const jogosMap = new Map();
    for (const ev of eventos) {
      const rId = ev.referee_id || null;
      if (!rId) continue;
      if (!jogosMap.has(rId)) jogosMap.set(rId, []);
      jogosMap.get(rId).push({
        id: ev.id,
        home_team:  ev.home_team,
        away_team:  ev.away_team,
        event_date: ev.event_date,
        league_name: ev.league?.name || ev.league_name || '—'
      });
    }

    const arbitros = lista.map(r => ({
      id:         r.id,
      name:       r.name || '—',
      country:    r.country || r.nationality_a3 || '—',
      matches:    r.matches || 0,
      avg_yellow: r.avg_yellow_per_match || null,
      avg_red:    r.avg_red_per_match    || null,
      avg_fouls:  r.avg_fouls_per_match  || null,
      jogos:      jogosMap.get(r.id) || []
    })).filter(r => r.name !== '—');

    // Ordena: 1º os que têm jogos confirmados (por data do próximo jogo), depois por nº de partidas
    arbitros.sort((a, b) => {
      const aNext = a.jogos[0]?.event_date || null;
      const bNext = b.jogos[0]?.event_date || null;
      if (aNext && !bNext) return -1;
      if (!aNext && bNext) return 1;
      if (aNext && bNext) return new Date(aNext) - new Date(bNext);
      return (b.matches || 0) - (a.matches || 0);
    });
    res.json({ arbitros, total: arbitros.length });
  } catch (e) {
    console.error('[arbitros/proximos]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// SOCIAL — sentimento por time (Twitter/X)
// Positivo/negativo/neutro — indica moral do time
// ─────────────────────────────────────────────
app.get('/api/social/time/:id', async (req, res) => {
  try {
    const data = await bsd(`/social/`, { team_id: req.params.id, limit: 5 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/social/jogo/:id', async (req, res) => {
  try {
    const data = await bsd(`/social/`, { event_id: req.params.id, limit: 10 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// HEAD2HEAD — histórico de confrontos diretos
// Busca eventos entre dois times nos últimos 2 anos
// ─────────────────────────────────────────────
app.get('/api/h2h', async (req, res) => {
  try {
    const { home_id, away_id } = req.query;
    if (!home_id || !away_id) return res.status(400).json({ error: 'home_id e away_id obrigatórios' });
    const dateFrom = new Date(Date.now() - 730 * 86400000).toISOString().slice(0,10);
    const data = await fetch(
      `https://sports.bzzoiro.com/api/events/?home_team_id=${home_id}&away_team_id=${away_id}&date_from=${dateFrom}&limit=10`,
      { headers: { Authorization: `Token ${BSD_TOKEN}` } }
    ).then(r => r.json());
    // Tenta também confronto invertido
    const data2 = await fetch(
      `https://sports.bzzoiro.com/api/events/?home_team_id=${away_id}&away_team_id=${home_id}&date_from=${dateFrom}&limit=10`,
      { headers: { Authorization: `Token ${BSD_TOKEN}` } }
    ).then(r => r.json());
    const all = [...(data.results||[]), ...(data2.results||[])]
      .sort((a,b) => new Date(b.event_date) - new Date(a.event_date));
    res.json({ results: all, count: all.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// TIMES
// ─────────────────────────────────────────────
app.get('/api/times', async (req, res) => {
  try {
    const { league_id, season_id, name } = req.query;
    const data = await bsd('/teams/', { league_id, season_id, name, limit: 100 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/times/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [time, squad, fixtures] = await Promise.allSettled([
      bsd(`/teams/${id}/`),
      bsd(`/teams/${id}/squad/`),
      bsd(`/teams/${id}/fixtures/`, { date_from: dayOffset(-7), date_to: dayOffset(7), limit: 20 })
    ]);
    res.json({
      time: time.status === 'fulfilled' ? time.value : null,
      squad: squad.status === 'fulfilled' ? squad.value : null,
      fixtures: fixtures.status === 'fulfilled' ? fixtures.value : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Elenco do time
app.get('/api/times/:id/elenco', async (req, res) => {
  try {
    const data = await bsd(`/teams/${req.params.id}/squad/`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Jogos do time
app.get('/api/times/:id/jogos', async (req, res) => {
  try {
    const { status, league_id, limit = 20 } = req.query;
    const data = await bsd(`/teams/${req.params.id}/fixtures/`, {
      status,
      league_id,
      date_from: dayOffset(-30),
      date_to: dayOffset(30),
      limit
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// JOGADORES
// ─────────────────────────────────────────────
app.get('/api/jogadores', async (req, res) => {
  try {
    const { team_id, position, name, nationality_code, limit = 200, team_name } = req.query;
    const results = [];
    const seen    = new Set();

    const addPlayers = (list, teamOverride = null) => {
      for (const p of (list || [])) {
        if (!p?.id || seen.has(p.id)) continue;
        seen.add(p.id);
        const enriched = { ...p };
        // Garante current_team sempre preenchido
        if (teamOverride)            enriched.current_team = teamOverride;
        else if (!enriched.current_team) {
          enriched.current_team =
            p.team?.name ? p.team :
            typeof p.team === 'string' ? { name: p.team } :
            p.club?.name ? p.club :
            typeof p.club === 'string' ? { name: p.club } : null;
        }
        results.push(enriched);
      }
    };

    const teamQuery = (team_name || '').trim();

    // ── CAMINHO A: tem nome de time → prioriza busca pelo time
    if (teamQuery) {
      // Passo 1: encontrar o time pelo nome (via standings — mais confiável para times BR)
      const teamCandidates = new Map(); // id → name
      try {
        // Busca por standings que incluem times brasileiros
        const stData = await bsd('/standings/', { search: teamQuery, limit: 20 });
        for (const s of (stData.results||[])) {
          const tid  = s.team_id || s.team?.id;
          const tname = s.team_name || s.team?.name || s.team;
          if (tid && tname && String(tname).toLowerCase().includes(teamQuery.toLowerCase()))
            teamCandidates.set(String(tid), tname);
        }
      } catch(_) {}

      // Busca também via /teams/?search=
      try {
        const tData = await bsd('/teams/', { search: teamQuery, limit: 10 });
        for (const t of (tData.results||[])) {
          if (t.id) teamCandidates.set(String(t.id), t.name);
        }
      } catch(_) {}

      // Passo 2: para cada time encontrado, busca os jogadores e filtra por nome
      const nameFilter = (name || '').toLowerCase();
      await Promise.all([...teamCandidates.entries()].slice(0, 5).map(async ([tid, tname]) => {
        const teamObj = { id: Number(tid), name: tname };
        // Busca via eventos recentes + player-stats (fonte correta para times BR)
        // /players/?team=ID é IGNORADO — BSD retorna times errados para BR
        try {
          const df = new Date(Date.now()-60*86400000).toISOString().slice(0,10);
          const dt = new Date().toISOString().slice(0,10);
          // Busca eventos sem filtro e filtra manualmente (BSD ignora home_team_id)
          const evData = await bsd('/events/', { date_from: df, date_to: dt, limit: 200 });
          const tidStr = String(tid);
          const teamEvs = (evData.results||[]).filter(ev => {
            const hid = String(ev.home_team_id||ev.home_team_obj?.id||'');
            const aid = String(ev.away_team_id||ev.away_team_obj?.id||'');
            return hid === tidStr || aid === tidStr;
          }).slice(0, 5);

          console.log(`[jogadores] time ${tid} (${tname}): ${teamEvs.length} eventos encontrados`);

          const seen2 = new Set();
          for (const ev of teamEvs) {
            try {
              const evHomeId = String(ev.home_team_id||ev.home_team_obj?.id||'');
              const isHomeTeam = evHomeId === tidStr;
              const psData = await bsd('/player-stats/', { event: ev.id, limit: 50 });
              for (const ps of (psData.results||[])) {
                const pid = String(ps.player?.id||ps.player_id||'');
                if (!pid || seen2.has(pid)) continue;
                // Filtra pelo lado correto
                const hasIsHome = ps.is_home !== undefined && ps.is_home !== null;
                const isOurSide = hasIsHome ? ps.is_home === isHomeTeam : true;
                if (!isOurSide) continue;
                const pname = (ps.player?.name||'').toLowerCase();
                if (nameFilter && !pname.includes(nameFilter)) continue;
                seen2.add(pid);
                addPlayers([ps.player].filter(Boolean), teamObj);
              }
            } catch(_) {}
          }
        } catch(_) {}
      }));
    }

    // ── CAMINHO B: só nome, sem time → busca direta por nome
    if (!teamQuery || results.length < 3) {
      try {
        const d = await bsd('/players/', { name, team_id, position, nationality_code, limit });
        addPlayers(d.results);
      } catch (_) {}
    }

    // ── ENRIQUECIMENTO: para jogadores sem current_team, busca via player-stats recentes
    // BSD não retorna current_team na busca por nome — buscamos de player-stats
    const withoutTeam = results.filter(p => !p.current_team);
    if (withoutTeam.length > 0) {
      const df = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
      const dt = new Date().toISOString().slice(0,10);
      await Promise.all(withoutTeam.slice(0, 20).map(async p => {
        try {
          const ps = await bsd('/player-stats/', { player: p.id, date_from: df, date_to: dt, limit: 1, ordering: '-event_date' });
          const item = (ps.results || [])[0];
          if (!item) return;
          // Extrai time do evento
          const ev = item.event || {};
          const isHome = item.is_home;
          const teamName = isHome !== undefined
            ? (isHome ? ev.home_team : ev.away_team)
            : (ev.home_team || ev.away_team);
          const teamId2 = isHome !== undefined
            ? (isHome ? (ev.home_team_id||ev.home_team_obj?.id) : (ev.away_team_id||ev.away_team_obj?.id))
            : null;
          if (teamName) p.current_team = { id: teamId2, name: teamName };
        } catch(_) {}
      }));
    }

    res.json({ results, count: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/jogadores/:id', async (req, res) => {
  try {
    const id = req.params.id;
    // Busca a temporada atual da liga principal para filtrar stats corretamente
    const [jogador, carreira, selecao] = await Promise.allSettled([
      bsd(`/players/${id}/`),
      bsd(`/players/${id}/career/`),
      bsd(`/players/${id}/national-team/`)
    ]);

    // Stats da temporada atual (pegamos o season_id do primeiro item da carreira)
    let stats = null;
    if (carreira.status === 'fulfilled' && carreira.value.seasons?.length > 0) {
      const currentSeason = carreira.value.seasons[0];
      try {
        stats = await bsd(`/players/${id}/stats/`, {
          season_id: currentSeason.season_id,
          limit: 50
        });
      } catch (_) {
        // se falhar, tenta sem filtro de temporada mas com date_from
        try {
          stats = await bsd(`/players/${id}/stats/`, {
            date_from: `${new Date().getFullYear() - 1}-07-01`,
            limit: 50
          });
        } catch (__) {}
      }
    }

    res.json({
      jogador: jogador.status === 'fulfilled' ? jogador.value : null,
      carreira: carreira.status === 'fulfilled' ? carreira.value : null,
      selecao: selecao.status === 'fulfilled' ? selecao.value : null,
      stats
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stats do jogador com season_id dinâmico
app.get('/api/jogadores/:id/stats', async (req, res) => {
  try {
    const { season_id, league_id, limit = 30 } = req.query;
    let sId = season_id;

    // Se não veio season_id, busca a temporada atual do jogador
    if (!sId) {
      try {
        const carreira = await bsd(`/players/${req.params.id}/career/`);
        if (carreira.seasons?.length > 0) {
          sId = carreira.seasons[0].season_id;
        }
      } catch (_) {}
    }

    const data = await bsd(`/players/${req.params.id}/stats/`, {
      season_id: sId,
      league_id,
      limit,
      date_from: sId ? undefined : `${new Date().getFullYear() - 1}-07-01`
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Transferências do jogador
app.get('/api/jogadores/:id/transferencias', async (req, res) => {
  try {
    const data = await bsd(`/players/${req.params.id}/transfers/`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// TREINADORES
// ─────────────────────────────────────────────
app.get('/api/treinadores', async (req, res) => {
  try {
    const { team_id, league_id, tactical_profile, name, limit = 50 } = req.query;
    const data = await bsd('/managers/', { team_id, league_id, tactical_profile, name, limit });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/treinadores/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [manager, carreira] = await Promise.allSettled([
      bsd(`/managers/${id}/`),
      bsd(`/managers/${id}/career/`)
    ]);
    res.json({
      manager: manager.status === 'fulfilled' ? manager.value : null,
      carreira: carreira.status === 'fulfilled' ? carreira.value : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// ÁRBITROS
// ─────────────────────────────────────────────
app.get('/api/arbitros', async (req, res) => {
  try {
    const { league_id, name, limit = 50 } = req.query;
    const data = await bsd('/referees/', { league_id, name, limit });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/arbitros/:id/jogos', async (req, res) => {
  try {
    const data = await bsd(`/referees/${req.params.id}/matches/`, {
      date_from: dayOffset(-30),
      date_to: dayOffset(14),
      limit: 20
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// IMAGENS (proxy das imagens BSD sem revelar origem)
// ─────────────────────────────────────────────


// Cache de imagens em disco — evita rebaixar a mesma imagem
const IMG_CACHE_DIR = path.join(__dirname, '.img_cache');
if (!fs.existsSync(IMG_CACHE_DIR)) fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });

async function serveImg(tipo, id, res) {
  if (!id || id === 'null' || id === 'undefined') return res.status(404).end();
  const cacheFile = path.join(IMG_CACHE_DIR, `${tipo}_${id}`);
  // Serve do cache em disco se existir
  if (fs.existsSync(cacheFile)) {
    const buf = fs.readFileSync(cacheFile);
    const ext = buf[0]===0x89 ? 'image/png' : buf[0]===0xFF ? 'image/jpeg' : 'image/webp';
    res.set('Content-Type', ext);
    res.set('Cache-Control', 'public, max-age=2592000');
    return res.send(buf);
  }
  // Baixa da BSD e salva
  try {
    const r = await fetch(`https://sports.bzzoiro.com/img/${tipo}/${id}/`);
    if (!r.ok) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(cacheFile, buf);
    res.set('Content-Type', r.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=2592000');
    res.send(buf);
  } catch {
    res.status(404).end();
  }
}

app.get('/img/team/:id',    (req, res) => serveImg('team',    req.params.id, res));
app.get('/img/league/:id',  (req, res) => serveImg('league',  req.params.id, res));
app.get('/img/player/:id',  (req, res) => serveImg('player',  req.params.id, res));
app.get('/img/manager/:id', (req, res) => serveImg('manager', req.params.id, res));
app.get('/img/venue/:id',   (req, res) => serveImg('venue',   req.params.id, res));

// ─────────────────────────────────────────────
// ODDS — lista e comparativo
// ─────────────────────────────────────────────
app.get('/api/odds', async (req, res) => {
  try {
    const { event_id, league_id, market, bookmaker_slug, limit = 50 } = req.query;
    const data = await bsd('/odds/', { event_id, league_id, market, bookmaker_slug, limit });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bookmakers', async (req, res) => {
  try {
    const data = await bsd('/bookmakers/');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Scout Pro Backend v2 rodando na porta ${PORT}`);
});
