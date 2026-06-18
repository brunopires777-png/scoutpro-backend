const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');
const fs   = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BSD_TOKEN = process.env.BSD_TOKEN || 'SEU_TOKEN_AQUI';
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

// Helper: resolve league_id real da Copa do Mundo (id=1 é nosso alias interno)
let _wcLeagueIdCache = null;
async function resolveLeagueId(id) {
  if (String(id) !== '1') return id; // só Copa tem alias
  if (_wcLeagueIdCache) return _wcLeagueIdCache;
  try {
    const lgs = await bsd('/leagues/', { search: 'World Cup', limit: 10 });
    const wc = (lgs.results||[]).find(l =>
      l.name?.toLowerCase().includes('world cup') || l.name?.toLowerCase().includes('mundial')
    );
    if (wc?.id) { _wcLeagueIdCache = wc.id; return wc.id; }
  } catch(_) {}
  return id; // fallback: usa o 1 mesmo
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
      `https://sports.bzzoiro.com/api/v2/teams/?name=${encodeURIComponent(q)}&limit=10`,
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
// Copa do Mundo 2026 → /api/worldcup/squads
app.get('/api/worldcup/squads', async (req, res) => {
  try {
    const { team_id } = req.query;
    if (team_id) {
      const data = await bsd(`/worldcup/squads/${team_id}/`);
      res.json(data);
    } else {
      const data = await bsd('/worldcup/squads/', { limit: 200 });
      res.json(data);
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Jogos Copa do Mundo → /api/worldcup/matches
app.get('/api/worldcup/matches', async (req, res) => {
  try {
    const { league_id } = req.query;
    // Busca a liga Copa do Mundo 2026 pelo nome se não tem ID
    let lgId = league_id;
    if (!lgId) {
      try {
        const lgs = await bsd('/leagues/', { search: 'World Cup', limit: 10 });
        const wc = (lgs.results||[]).find(l =>
          l.name?.toLowerCase().includes('world cup') ||
          l.name?.toLowerCase().includes('mundial')
        );
        lgId = wc?.id || '';
        if (lgId) console.log(`[worldcup] liga encontrada: ${wc.name} id=${lgId}`);
      } catch(_) {}
    }
    const data = await bsd('/events/', {
      ...(lgId ? { league_id: lgId } : {}),
      date_from: '2026-06-01',
      date_to:   '2026-07-20',
      limit: 200
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// COPA 2026 — Grupos com IDs reais via BSD worldcup/squads
// Retorna os 12 grupos com times, IDs e escudos
// ─────────────────────────────────────────────
app.get('/api/copa2026/grupos', async (req, res) => {
  // IDs reais da BSD para cada seleção — mapeados via /api/v2/teams/?name=
  // Fonte da verdade: IDs fixos pois seleções não mudam de ID
  const TEAM_IDS = {
    // Grupo A
    'Mexico': 3, 'Czechia': 42, 'South Africa': 100, 'South Korea': 63,
    // Grupo B
    'Bosnia & Herzegovina': 45, 'Canada': 105, 'Qatar': 160, 'Switzerland': 36,
    // Grupo C
    'Brazil': 5, 'Haiti': 190, 'Morocco': 92, 'Scotland': 27,
    // Grupo D
    'Australia': 97, 'Paraguay': 118, 'Türkiye': 50, 'USA': 82,
    // Grupo E
    'Curaçao': 229, 'Ecuador': 112, 'Germany': 4, "Côte d'Ivoire": 89,
    // Grupo F
    'Japan': 64, 'Netherlands': 33, 'Sweden': 34, 'Tunisia': 93,
    // Grupo G
    'Belgium': 30, 'Egypt': 91, 'Iran': 80, 'New Zealand': 134,
    // Grupo H
    'Cabo Verde': 220, 'Saudi Arabia': 131, 'Spain': 9, 'Uruguay': 77,
    // Grupo I
    'France': 2, 'Iraq': 164, 'Norway': 48, 'Senegal': 90,
    // Grupo J
    'Algeria': 95, 'Argentina': 7, 'Austria': 44, 'Jordan': 196,
    // Grupo K
    'Colombia': 109, 'DR Congo': 187, 'Portugal': 31, 'Uzbekistan': 193,
    // Grupo L
    'Croatia': 46, 'England': 11, 'Ghana': 85, 'Panama': 192,
  };
  const GRUPOS_FIXOS = {
    A:['Mexico','Czechia','South Africa','South Korea'],
    B:['Bosnia & Herzegovina','Canada','Qatar','Switzerland'],
    C:['Brazil','Haiti','Morocco','Scotland'],
    D:['Australia','Paraguay','Türkiye','USA'],
    E:['Curaçao','Ecuador','Germany',"Côte d'Ivoire"],
    F:['Japan','Netherlands','Sweden','Tunisia'],
    G:['Belgium','Egypt','Iran','New Zealand'],
    H:['Cabo Verde','Saudi Arabia','Spain','Uruguay'],
    I:['France','Iraq','Norway','Senegal'],
    J:['Algeria','Argentina','Austria','Jordan'],
    K:['Colombia','DR Congo','Portugal','Uzbekistan'],
    L:['Croatia','England','Ghana','Panama'],
  };
  const grupos = {};
  for (const [letra, times] of Object.entries(GRUPOS_FIXOS)) {
    grupos[letra] = times.map(name => ({ name, id: TEAM_IDS[name] || null }));
  }
  res.json({ grupos });
});

// ─────────────────────────────────────────────
// COPA 2026 — Chaveamento completo
// Retorna jogos organizados por fase com placares reais
// ─────────────────────────────────────────────
app.get('/api/copa2026/chaveamento', async (req, res) => {
  try {
    // Descobrir league_id da Copa 2026
    let lgId = null;
    try {
      const lgs = await bsd('/leagues/', { search: 'World Cup', limit: 10 });
      const wc = (lgs.results||[]).find(l =>
        l.name?.toLowerCase().includes('world cup') || l.name?.toLowerCase().includes('mundial')
      );
      lgId = wc?.id || null;
    } catch(_) {}

    // Busca todos os jogos da Copa 2026
    const params = {
      date_from: '2026-06-01',
      date_to:   '2026-07-20',
      limit: 200
    };
    if (lgId) params.league_id = lgId;
    const data = await bsd('/events/', params);
    const jogos = (data.results || []).map(ev => ({
      id:           ev.id,
      home_team:    ev.home_team || ev.home_team_obj?.name || '—',
      away_team:    ev.away_team || ev.away_team_obj?.name || '—',
      home_team_id: ev.home_team_id || ev.home_team_obj?.id || null,
      away_team_id: ev.away_team_id || ev.away_team_obj?.id || null,
      home_score:   ev.home_score ?? null,
      away_score:   ev.away_score ?? null,
      event_date:   ev.event_date,
      status:       ev.status || 'notstarted',
      round:        ev.round_name || ev.round || ev.group_name || '',
      venue:        ev.venue_name || ev.venue?.name || '',
      venue_city:   ev.venue_city || ev.venue?.city || '',
    }));

    // Classifica por fase baseado no round/group_name
    const fases = { grupos: [], r32: [], r16: [], qf: [], sf: [], terceiro: [], final: [] };
    for (const j of jogos) {
      const r = (j.round || '').toLowerCase();
      if      (r.includes('final') && r.includes('third'))    fases.terceiro.push(j);
      else if (r.includes('final') && !r.includes('semi') && !r.includes('quarter') && !r.includes('round')) fases.final.push(j);
      else if (r.includes('semi'))                             fases.sf.push(j);
      else if (r.includes('quarter'))                         fases.qf.push(j);
      else if (r.includes('round of 16') || r.includes('r16') || r.includes('oitava')) fases.r16.push(j);
      else if (r.includes('round of 32') || r.includes('r32') || r.includes('dezesseis')) fases.r32.push(j);
      else                                                     fases.grupos.push(j);
    }

    res.json({ fases, total: jogos.length, league_id: lgId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DIAGNÓSTICO: buscar IDs reais das seleções da Copa 2026
app.get('/api/debug/selecoes', async (req, res) => {
  const selecoes = [
    'Mexico','Czechia','South Africa','South Korea',
    'Bosnia','Canada','Qatar','Switzerland',
    'Brazil','Haiti','Morocco','Scotland',
    'Australia','Paraguay','Turkey','USA',
    'Curacao','Ecuador','Germany','Ivory Coast',
    'Japan','Netherlands','Sweden','Tunisia',
    'Belgium','Egypt','Iran','New Zealand',
    'Cape Verde','Saudi Arabia','Spain','Uruguay',
    'France','Iraq','Norway','Senegal',
    'Algeria','Argentina','Austria','Jordan',
    'Colombia','Congo','Portugal','Uzbekistan',
    'Croatia','England','Ghana','Panama',
  ];
  const results = {};
  await Promise.allSettled(selecoes.map(async name => {
    try {
      const d = await bsd('/v2/teams/', { name, limit: 3 });
      results[name] = (d.results||[]).map(t => ({ id: t.id, name: t.name, country: t.country }));
    } catch(e) { results[name] = [{ error: e.message }]; }
  }));
  res.json(results);
});


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
      if ((n=>n.includes(term)||n.split(/\s+/).some(w=>w.startsWith(term)))(norm(ev.home_team||'')))
        result.events_found.push({ side:'home', team: ev.home_team, id: hid, home_team_id: ev.home_team_id, home_team_obj_id: ev.home_team_obj?.id, home_team_obj_full: ev.home_team_obj, event_id: ev.id, event_date: ev.event_date?.slice(0,10) });
      if ((n=>n.includes(term)||n.split(/\s+/).some(w=>w.startsWith(term)))(norm(ev.away_team||'')))
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

// ─────────────────────────────────────────────
// DIAGNÓSTICO DE ÁRBITROS — GET /api/debug/arbitros
// Retorna: total na BSD, escalados esta semana, lista dos escalados
// ─────────────────────────────────────────────
app.get('/api/debug/arbitros', async (req, res) => {
  const result = { total_bsd: null, escalados_semana: 0, arbitros_escalados: [], sem_arbitro: 0, total_jogos_semana: 0 };
  try {
    // 1. Total de árbitros cadastrados na BSD
    const totRef = await bsd('/referees/', { limit: 1 });
    result.total_bsd = totRef.count || null;

    // 2. Jogos desta semana (hoje + 7 dias)
    const df = new Date().toISOString().slice(0,10);
    const dt = new Date(Date.now()+7*86400000).toISOString().slice(0,10);
    const evData = await bsd('/events/', { date_from: df, date_to: dt, limit: 200 });
    const jogos = evData.results || [];
    result.total_jogos_semana = jogos.length;

    // 3. Extrai árbitros escalados
    const arbMap = new Map();
    for (const ev of jogos) {
      const rid  = ev.referee_id  || ev.referee?.id   || null;
      const nome = ev.referee_name|| ev.referee?.name || ev.referee?.full_name || (typeof ev.referee==='string'?ev.referee:null) || null;
      if (nome || rid) {
        const key = rid || nome;
        if (!arbMap.has(key)) arbMap.set(key, { id: rid, name: nome, jogos: 0 });
        arbMap.get(key).jogos++;
      } else {
        result.sem_arbitro++;
      }
    }
    result.escalados_semana = arbMap.size;
    result.arbitros_escalados = Array.from(arbMap.values()).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  } catch(e) { result.error = e.message; }
  res.json(result);
});

// ─────────────────────────────────────────────
// CACHE DE NOMES DE ÁRBITROS
// A BSD retorna referee_id nos eventos mas não o nome.
// Este cache busca /referees/{id}/ uma vez por ID e guarda por 24h.
// ─────────────────────────────────────────────
const _refCache = new Map(); // id -> { name, ts }
const _REF_TTL  = 24 * 60 * 60 * 1000; // 24h

async function resolverNomeArbitro(id) {
  if (!id) return null;
  const cached = _refCache.get(id);
  if (cached && Date.now() - cached.ts < _REF_TTL) return cached.name;
  try {
    const d = await bsd(`/referees/${id}/`);
    const name = d.name || d.full_name || d.display_name || null;
    _refCache.set(id, { name, ts: Date.now() });
    return name;
  } catch(_) { return null; }
}

// Enriquece lista de eventos: resolve nomes de árbitros sem nome em paralelo
async function enriquecerArbitros(eventos) {
  // Coleta IDs que precisam de nome
  const ids = [...new Set(
    eventos
      .map(ev => ev.referee_id)
      .filter(id => id && !ev_temNome(eventos, id))
  )];
  if (!ids.length) return eventos;
  // Busca em paralelo (máx 20 por vez para não sobrecarregar)
  const chunks = [];
  for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i+20));
  for (const chunk of chunks) {
    await Promise.allSettled(chunk.map(id => resolverNomeArbitro(id)));
  }
  // Aplica nomes resolvidos
  return eventos.map(ev => {
    if (ev.referee_id && !ev.referee_name) {
      const cached = _refCache.get(ev.referee_id);
      if (cached?.name) return { ...ev, referee_name: cached.name };
    }
    return ev;
  });
}

function ev_temNome(eventos, id) {
  const ev = eventos.find(e => e.referee_id === id);
  return !!(ev?.referee_name);
}

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
    // xG disponível diretamente no evento — usa ?? para não perder valores 0
    home_xg:      ev.home_xg_live  ?? ev.actual_home_xg ?? ev.home_xg  ?? null,
    away_xg:      ev.away_xg_live  ?? ev.actual_away_xg ?? ev.away_xg  ?? null,
    // Odds já disponíveis na raiz
    odds_home:    ev.odds_home,
    odds_draw:    ev.odds_draw,
    odds_away:    ev.odds_away,
    // Árbitro
    referee_id:   ev.referee_id   || ev.referee?.id   || null,
    referee_name: ev.referee_name || ev.referee?.name || ev.referee?.full_name || (typeof ev.referee === 'string' ? ev.referee : null) || null,
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
    const lgId = league_id ? await resolveLeagueId(league_id) : '';
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${t}&date_to=${t}&tz=America/Sao_Paulo&limit=200${lgId ? `&league=${lgId}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    data.results = await enriquecerArbitros((data.results || []).map(normEvento));
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/amanha', async (req, res) => {
  try {
    const { league_id } = req.query;
    const t = dayOffset(1);
    const lgId = league_id ? await resolveLeagueId(league_id) : '';
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${t}&date_to=${t}&tz=America/Sao_Paulo&limit=200${lgId ? `&league=${lgId}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    data.results = await enriquecerArbitros((data.results || []).map(normEvento));
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/semana', async (req, res) => {
  try {
    const { league_id } = req.query;
    const lgId = league_id ? await resolveLeagueId(league_id) : '';
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${today()}&date_to=${dayOffset(7)}&tz=America/Sao_Paulo&limit=200${lgId ? `&league=${lgId}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    data.results = await enriquecerArbitros((data.results || []).map(normEvento));
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/ao-vivo', async (req, res) => {
  try {
    const { league_id } = req.query;
    const url = `https://sports.bzzoiro.com/api/live/?tz=America/Sao_Paulo${league_id ? `&league=${league_id}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    const lista = data.events || data.results || [];
    const normalized = await enriquecerArbitros(lista.map(normEvento));
    res.json({ results: normalized, count: normalized.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Detalhes completos de um jogo
app.get('/api/jogos/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [evento, stats, incidents, odds, lineups, playerStats, predicao, metadata, eventoBase] = await Promise.allSettled([
      bsd(`/events/${id}/`, { full: 'true' }),
      bsd(`/api/v2/events/${id}/stats/`).catch(() => bsd(`/events/${id}/stats/`)),
      bsd(`/events/${id}/incidents/`),
      bsd(`/events/${id}/odds/`),
      bsd(`/events/${id}/lineups/`),
      bsd(`/events/${id}/player-stats/`),
      bsd(`/events/${id}/prediction/`),
      bsd(`/api/v2/events/${id}/metadata/`).catch(() => bsd(`/events/${id}/metadata/`)),
      bsd(`/events/${id}/`) // base sem full=true, tem odds_home/draw/away
    ]);

    const evData = evento.status === 'fulfilled' ? evento.value : null;
    const evBase = eventoBase?.status === 'fulfilled' ? eventoBase.value : null;
    // Mescla odds do base no evData (full=true às vezes não tem odds)
    if (evData && evBase) {
      evData.odds_home = evData.odds_home ?? evBase.odds_home ?? evBase['1'] ?? null;
      evData.odds_draw = evData.odds_draw ?? evBase.odds_draw ?? evBase['X'] ?? null;
      evData.odds_away = evData.odds_away ?? evBase.odds_away ?? evBase['2'] ?? null;
      evData.over_25 = evData.over_25 ?? evBase.over_25 ?? evBase.over_25_goals ?? null;
      evData.under_25 = evData.under_25 ?? evBase.under_25 ?? evBase.under_25_goals ?? null;
      evData.btts = evData.btts ?? evBase.btts ?? evBase.btts_yes ?? null;
    }
    const statsData = stats.status === 'fulfilled' ? stats.value : null;
    if (statsData) console.log('[xG debug]', JSON.stringify(statsData).slice(0,300));
    const predData = predicao.status === 'fulfilled' ? predicao.value : null;

    // Extrai xG de todas as fontes
    if (evData) {
      const sh = statsData?.home || statsData?.stats?.home || {};
      const sa = statsData?.away || statsData?.stats?.away || {};
      const xgH = sh?.xg ?? sh?.expected_goals ?? sh?.xg_total
        ?? statsData?.home_xg ?? statsData?.xg?.home
        ?? evBase?.home_xg_live ?? evBase?.actual_home_xg ?? evBase?.home_xg
        ?? evData.home_xg_live ?? evData.actual_home_xg ?? evData.home_xg
        ?? predData?.markets?.expected_goals?.home ?? null;
      const xgA = sa?.xg ?? sa?.expected_goals ?? sa?.xg_total
        ?? statsData?.away_xg ?? statsData?.xg?.away
        ?? evBase?.away_xg_live ?? evBase?.actual_away_xg ?? evBase?.away_xg
        ?? evData.away_xg_live ?? evData.actual_away_xg ?? evData.away_xg
        ?? predData?.markets?.expected_goals?.away ?? null;
      evData.home_xg = xgH != null ? parseFloat(xgH).toFixed(2) : null;
      evData.away_xg = xgA != null ? parseFloat(xgA).toFixed(2) : null;
    }

    const metaData = metadata?.status === 'fulfilled' ? metadata.value : null;
    // ai_preview: v2 pode retornar {ai_preview:'...'} ou {preview:'...'} ou {text:'...'}
    const rawAi = metaData?.ai_preview || metaData?.preview || metaData?.analysis
      || metaData?.ai_text || metaData?.description || null;
    const aiText = typeof rawAi === 'string' && rawAi.length > 5 ? rawAi
      : (rawAi?.text || rawAi?.content || rawAi?.preview || rawAi?.analysis
      || (typeof rawAi === 'object' && rawAi ? JSON.stringify(rawAi) : null));
    res.json({
      evento: evData,
      stats: statsData,
      incidents: incidents.status === 'fulfilled' ? incidents.value : null,
      odds: odds.status === 'fulfilled' ? odds.value : null,
      lineups: lineups.status === 'fulfilled' ? lineups.value : null,
      playerStats: (function(){
        if (playerStats.status !== 'fulfilled') return null;
        const ps = playerStats.value;
        // Normaliza nomes — BSD pode retornar em múltiplos campos
        const arr = ps?.player_stats || ps?.results || ps || [];
        if (Array.isArray(arr)) {
          arr.forEach(p => {
            p._name = p.player?.short_name || p.player?.name || p.player?.display_name
              || p.player_name || p.player_short_name || p.name || p.short_name || null;
          });
        }
        return ps;
      })(),
      predicao: predData,
      ai_preview: aiText,
      metadata: metaData
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

// Shotmap do jogo
app.get('/api/jogos/:id/shotmap', async (req, res) => {
  try {
    const data = await bsd(`/api/v2/events/${req.params.id}/shotmap/`)
      .catch(() => bsd(`/events/${req.params.id}/shotmap/`));
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
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
// ─────────────────────────────────────────────
// VALUE BETS — endpoint nativo BSD v2
// ─────────────────────────────────────────────
app.get('/api/value-bets', async (req, res) => {
  try {
    const { league_id, market, min_edge = 5, limit = 50 } = req.query;
    const params = { limit };
    if (league_id) params.league_id = league_id;
    if (market && market !== 'all') params.market = market;
    if (min_edge) params.min_edge = min_edge;

    const data = await bsd('/v2/value-bets/', params);
    const raw = data.results || data.value_bets || data.bets || [];

    console.log(`[value-bets] BSD retornou ${raw.length} picks`);
    if (raw.length > 0) console.log('[value-bets] primeiro item:', JSON.stringify(raw[0]).slice(0,200));

    res.json({ results: raw, total: raw.length, count: data.count || raw.length });
  } catch(e) {
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

// Função reutilizável de busca de time — usada por /api/teams e /api/jogadores
// Fontes: 1) API v2 /api/v2/teams/?name= (busca parcial nativa), 2) eventos recentes, 3) standings
async function buscarTimePorNome(q) {
  const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const term = norm(q);
  const seen = new Map();

  // 1ª fonte: API de times da BSD com busca nativa (mais abrangente)
  try {
    const apiTeams = await fetch(
      `https://sports.bzzoiro.com/api/v2/teams/?name=${encodeURIComponent(q)}&limit=20`,
      { headers: { Authorization: `Token ${BSD_TOKEN}` } }
    ).then(r => r.json());
    (apiTeams.results || []).forEach(t => {
      if (t.id && !seen.has(t.id))
        seen.set(t.id, { id: t.id, name: t.name, country: t.country || '' });
    });
  } catch(_) {}

  // 2ª fonte: eventos recentes (complementa com times que tenham jogos)
  if (seen.size < 3) {
    try {
      const dateFrom = new Date(Date.now()-60*86400000).toISOString().slice(0,10);
      const dateTo   = new Date(Date.now()+14*86400000).toISOString().slice(0,10);
      const evData = await fetch(
        `https://sports.bzzoiro.com/api/events/?date_from=${dateFrom}&date_to=${dateTo}&limit=300`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }
      ).then(r => r.json());
      (evData.results || []).forEach(ev => {
        const hid = ev.home_team_id || ev.home_team_obj?.id;
        const aid = ev.away_team_id || ev.away_team_obj?.id;
        if ((n=>n.includes(term)||n.split(/\s+/).some(w=>w.startsWith(term)))(norm(ev.home_team||'')) && hid && !seen.has(hid))
          seen.set(hid, { id: hid, name: ev.home_team, country: ev.league?.country||'' });
        if ((n=>n.includes(term)||n.split(/\s+/).some(w=>w.startsWith(term)))(norm(ev.away_team||'')) && aid && !seen.has(aid))
          seen.set(aid, { id: aid, name: ev.away_team, country: ev.league?.country||'' });
      });
    } catch(_) {}
  }

  return Array.from(seen.values()).slice(0,15);
}

app.get('/api/teams', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Parâmetro q obrigatório' });
    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const term = norm(q);
    const seen = new Map();

    // 1ª fonte: API de times da BSD com busca nativa (mais abrangente)
    try {
      const apiTeams = await fetch(
        `https://sports.bzzoiro.com/api/v2/teams/?name=${encodeURIComponent(q)}&limit=20`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }
      ).then(r => r.json());
      (apiTeams.results || []).forEach(t => {
        if (t.id && !seen.has(t.id))
          seen.set(t.id, { id: t.id, name: t.name, country: t.country || '' });
      });
    } catch(_) {}

    // 2ª fonte: eventos recentes (complementa com times que tenham jogos)
    if (seen.size < 3) {
      const dateFrom = new Date(Date.now()-60*86400000).toISOString().slice(0,10);
      const dateTo   = new Date(Date.now()+14*86400000).toISOString().slice(0,10);
      const evData = await fetch(
        `https://sports.bzzoiro.com/api/events/?date_from=${dateFrom}&date_to=${dateTo}&limit=300`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }
      ).then(r => r.json());
      (evData.results || []).forEach(ev => {
        const hid = ev.home_team_id || ev.home_team_obj?.id;
        const aid = ev.away_team_id || ev.away_team_obj?.id;
        if ((n=>n.includes(term)||n.split(/\s+/).some(w=>w.startsWith(term)))(norm(ev.home_team||'')) && hid && !seen.has(hid))
          seen.set(hid, { id: hid, name: ev.home_team, country: ev.league?.country || ev.home_team_obj?.country || '' });
        if ((n=>n.includes(term)||n.split(/\s+/).some(w=>w.startsWith(term)))(norm(ev.away_team||'')) && aid && !seen.has(aid))
          seen.set(aid, { id: aid, name: ev.away_team, country: ev.league?.country || ev.away_team_obj?.country || '' });
      });
    }

    // 3ª fonte: standings (fallback se ainda sem resultado)
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
// Usa exclusivamente BSD v2 via helper bsd()
app.get('/api/squad/:id', async (req, res) => {
  try {
    const teamId = String(req.params.id);
    let players  = [];
    let lineupStatus    = null;
    let lineupPlayerIds = new Set();
    let confirmedIds    = new Set();

    // ── FASE 1: ELENCO via /teams/{id}/squad/ (v2) ─────────────────────
    // Valida com lineup: se nenhum jogador do squad aparece na próxima lineup, BSD tem bug de ID
    let squadFromEndpoint = [];
    try {
      const sq = await bsd(`/teams/${teamId}/squad/`);
      const list = sq.players || sq.squad || sq.results || [];
      if (list.length > 0) {
        squadFromEndpoint = list.map(p => ({
          id:            String(p.id),
          name:          p.name || p.display_name || '—',
          position:      p.position || '—',
          jersey_number: String(p.jersey_number || ''),
          photo:         `https://sports.bzzoiro.com/img/player/${p.id}/`
        }));
        console.log(`[squad] via /teams/squad: ${squadFromEndpoint.length}`);
      }
    } catch(_) {}

    // Squad v2 é confiável — usa direto se retornou dados
    if (squadFromEndpoint.length > 0) {
      players = squadFromEndpoint;
      console.log(`[squad] squad OK: ${players.length} jogadores`);
    }

    // ── FASE 1B: fallback via /events/?team_id= (v2 suporta team_id) ───
    if (!players.length) {
      try {
        const df2 = new Date(Date.now()-90*86400000).toISOString().slice(0,10);
        const dt2 = new Date().toISOString().slice(0,10);
        // v2 tem team_id como filtro real
        const evData = await bsd('/events/', { team_id: teamId, date_from: df2, date_to: dt2, limit: 5, ordering: '-event_date' });
        const teamEvs = (evData.results||[]).slice(0,5);
        console.log(`[squad] eventos v2 team_id=${teamId}: ${teamEvs.length}`);

        const pMap = new Map();
        for (const ev of teamEvs) {
          try {
            // lineups v2 — retorna 200 sempre, lineup_status indica o estado
            const lu = await bsd(`/events/${ev.id}/lineups/`);
            if (lu.lineup_status === 'unavailable' || !lu.lineups) continue;

            const isH   = String(ev.home_team_id) === teamId;
            const side  = isH ? lu.lineups.home : lu.lineups.away;
            const list2 = [...(side?.players||[]), ...(side?.substitutes||[])];

            for (const p of list2) {
              const pid = String(p.id || '');
              if (!pid || pMap.has(pid)) continue;
              pMap.set(pid, {
                id:            pid,
                name:          p.name || p.short_name || '—',
                position:      p.position || '—',
                jersey_number: String(p.jersey_number || ''),
                photo:         `https://sports.bzzoiro.com/img/player/${pid}/`
              });
            }
            if (pMap.size >= 18) break;
          } catch(_) {}
        }
        players = [...pMap.values()];
        console.log(`[squad] via lineups fallback: ${players.length}`);
      } catch(e) { console.log('[squad] fallback err:', e.message); }
    }

    // ── FASE 2: LINEUP para círculos ────────────────────────────────────
    // Busca próximo jogo com lineup disponível
    try {
      const df  = today();
      const dt  = dayOffset(10);
      // v2: /teams/{id}/fixtures/ é o endpoint correto para jogos do time
      const fixturesFut  = await bsd(`/teams/${teamId}/fixtures/`, { date_from: df, date_to: dt, limit: 5 });
      const fixturesPast = await bsd(`/teams/${teamId}/fixtures/`, { date_from: new Date(Date.now()-14*86400000).toISOString().slice(0,10), date_to: df, status: 'finished', limit: 5 });
      const candidates   = [...(fixturesFut.results||[]), ...(fixturesPast.results||[])];

      for (const ev of candidates) {
        try {
          const lu = await bsd(`/events/${ev.id}/lineups/`);
          if (lu.lineup_status === 'unavailable' || !lu.lineups) continue;

          const isH  = String(ev.home_team_id) === teamId;
          const side = isH ? lu.lineups.home : lu.lineups.away;
          const list = [...(side?.players||[]), ...(side?.substitutes||[])];
          if (!list.length) continue;

          const es    = (ev.status||'').toLowerCase();
          const LIVES = new Set(['inprogress','1st_half','2nd_half','halftime','extra_time','penalties']);
          const isLive = LIVES.has(es) || LIVES.has(ev.period||'');
          const isFin  = es==='finished' || ev.period==='FT';
          lineupStatus = (lu.lineup_status==='confirmed' || isLive || isFin) ? 'confirmed' : 'predicted';

          list.forEach((p,i) => {
            const pid = String(p.id||'');
            if (!pid) return;
            lineupPlayerIds.add(pid);
            if (lineupStatus==='confirmed' && i<11) confirmedIds.add(pid);
          });

          // Fallback por nome se IDs não cruzam com elenco
          const idsInSquad = new Set(players.map(p=>p.id));
          if ([...lineupPlayerIds].filter(p=>idsInSquad.has(p)).length === 0) {
            const norm = s=>(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
            players.forEach(p => {
              const pn = norm(p.name), pt = pn.split(/\s+/).filter(t=>t.length>=3);
              const idx2 = list.findIndex(lp=>{
                const lt = norm(lp.name||lp.short_name||'').split(/\s+/).filter(t=>t.length>=3);
                return lt.some(l=>pt.some(pp=>l===pp||l.startsWith(pp)||pp.startsWith(l)));
              });
              if (idx2>=0) { lineupPlayerIds.add(p.id); if(lineupStatus==='confirmed'&&idx2<11) confirmedIds.add(p.id); }
            });
          }

          console.log(`[squad] lineup: ${ev.home_team}x${ev.away_team} status=${lineupStatus} n=${lineupPlayerIds.size}`);
          break;
        } catch(_) {}
      }
    } catch(e) { console.log('[squad] lineup err:', e.message); }

    players = players.map(p => ({
      ...p,
      lineup_status: confirmedIds.has(String(p.id))    ? 'confirmed'
                   : lineupPlayerIds.has(String(p.id)) ? 'predicted'
                   : null
    }));

    console.log(`[squad] retornando ${players.length} jogadores`);
    res.json({ players, lineup_status: lineupStatus });
  } catch(e) {
    console.log('[squad] erro:', e.message);
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

    // NOVA ESTRATÉGIA: partir dos eventos da semana (fonte da verdade dos escalados)
    // e enriquecer com dados do árbitro via /referees/{id}/
    const evData = await bsd('/events/', {
      date_from: today(),
      date_to:   dayOffset(7),
      limit:     500,
      tz:        'America/Sao_Paulo',
      ...(league_id ? { league: league_id } : {})
    });
    const eventos = evData.results || [];

    // Coleta todos os referee_id únicos dos eventos
    const arbMap = new Map(); // id -> { id, jogos:[] }
    for (const ev of eventos) {
      const rId = ev.referee_id || ev.referee?.id || null;
      if (!rId) continue;
      if (!arbMap.has(rId)) arbMap.set(rId, { id: rId, jogos: [] });
      arbMap.get(rId).jogos.push({
        id:          ev.id,
        home_team:   ev.home_team  || ev.home_team_obj?.name  || '—',
        away_team:   ev.away_team  || ev.away_team_obj?.name  || '—',
        event_date:  ev.event_date || null,
        league_name: ev.league?.name || ev.league_name || '—'
      });
    }

    // Busca detalhes de cada árbitro em paralelo (usa cache _refCache quando possível)
    const ids = Array.from(arbMap.keys());
    const detalhes = await Promise.allSettled(
      ids.map(id => bsd(`/referees/${id}/`))
    );

    const arbitros = [];
    for (let i = 0; i < ids.length; i++) {
      const id  = ids[i];
      const det = detalhes[i].status === 'fulfilled' ? detalhes[i].value : null;
      const nome = det?.name || det?.full_name || det?.display_name || null;

      // Guarda no cache de nomes
      if (nome) _refCache.set(id, { name: nome, ts: Date.now() });

      // Filtro por nome se passado
      if (name && nome && !nome.toLowerCase().includes(name.toLowerCase())) continue;

      arbitros.push({
        id,
        name:       nome || `Árbitro #${id}`,
        country:    det?.country || det?.nationality_a3 || '—',
        matches:    det?.matches || 0,
        avg_yellow: det?.avg_yellow_per_match || null,
        avg_red:    det?.avg_red_per_match    || null,
        avg_fouls:  det?.avg_fouls_per_match  || null,
        jogos:      arbMap.get(id)?.jogos || []
      });
    }

    // Ordena por data do próximo jogo
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
    const { home_id, away_id, event_id } = req.query;
    if (!home_id || !away_id) return res.status(400).json({ error: 'home_id e away_id obrigatórios' });

    // Tenta primeiro o endpoint v2 dedicado de H2H (mais preciso)
    if (event_id) {
      try {
        const v2h2h = await bsd(`/api/v2/events/${event_id}/h2h/`);
        if (v2h2h) {
          // v2 retorna campos: total_matches, home_wins, draws, away_wins, home_goals, away_goals, recent_matches
          const rm = v2h2h.recent_matches || [];
          const jogos = rm.map(j => ({
            event_date: j.event_date,
            home_team: j.home_team, away_team: j.away_team,
            home_team_id: j.home_team_id, away_team_id: j.away_team_id,
            home_score: j.home_score, away_score: j.away_score,
            league: j.league_name || ''
          }));
          const stats = {
            team1_wins: v2h2h.home_wins || 0,
            team2_wins: v2h2h.away_wins || 0,
            draws: v2h2h.draws || 0,
            avg_goals: v2h2h.total_matches ? ((v2h2h.home_goals + v2h2h.away_goals) / v2h2h.total_matches).toFixed(1) : 0
          };
          return res.json({ jogos, stats, count: jogos.length });
        }
      } catch(_) {}
    }

    // Fallback: busca por team_id (funciona independente de home/away)
    const dateFrom = new Date(Date.now() - 730 * 86400000).toISOString().slice(0,10);
    const [data, data2] = await Promise.all([
      fetch(`https://sports.bzzoiro.com/api/v2/events/?team_id=${home_id}&date_from=${dateFrom}&limit=50`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json()),
      fetch(`https://sports.bzzoiro.com/api/v2/events/?team_id=${away_id}&date_from=${dateFrom}&limit=50`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json())
    ]);
    // Encontra jogos onde ambos os times estiveram presentes
    const t1games = new Set((Array.isArray(data) ? data : data.results || []).map(e => e.id));
    const all = (Array.isArray(data2) ? data2 : data2.results || [])
      .filter(e => t1games.has(e.id) || 
        (String(e.home_team_id)===String(home_id) && String(e.away_team_id)===String(away_id)) ||
        (String(e.home_team_id)===String(away_id) && String(e.away_team_id)===String(home_id)))
      .sort((a,b) => new Date(b.event_date) - new Date(a.event_date)).slice(0,10);

    // Calcular stats para o frontend
    let t1w=0, t2w=0, draws=0, totalGoals=0;
    all.forEach(j => {
      const hs = j.home_score ?? j.home_goals, as = j.away_score ?? j.away_goals;
      if (hs == null || as == null) return;
      totalGoals += Number(hs) + Number(as);
      const homeIsT1 = String(j.home_team_id) === String(home_id);
      const t1s = homeIsT1 ? hs : as, t2s = homeIsT1 ? as : hs;
      if (t1s > t2s) t1w++;
      else if (t2s > t1s) t2w++;
      else draws++;
    });
    const stats = { team1_wins: t1w, team2_wins: t2w, draws, avg_goals: all.length ? (totalGoals/all.length).toFixed(1) : 0 };
    const jogos = all.map(j => ({
      event_date: j.event_date,
      home_team: j.home_team, away_team: j.away_team,
      home_team_id: j.home_team_id, away_team_id: j.away_team_id,
      home_score: j.home_score ?? j.home_goals,
      away_score: j.away_score ?? j.away_goals,
      league: j.league?.name || j.tournament?.name || ''
    }));
    res.json({ jogos, stats, count: jogos.length });
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
// GRÁFICO DE DESEMPENHO DO TIME
// Últimos 10 jogos finalizados com stats
// ─────────────────────────────────────────────
app.get('/api/times/:id/grafico', async (req, res) => {
  try {
    const teamId = req.params.id;

    // A BSD ignora ordering e retorna mais antigos primeiro com limit alto.
    // Solução: buscar em janelas curtas do mais recente ao mais antigo até ter 10 jogos válidos.
    const seenIds = new Set();
    const jogosValidos = [];
    const janelas = [
      { from: dayOffset(-30),  to: dayOffset(0)   },
      { from: dayOffset(-60),  to: dayOffset(-30)  },
      { from: dayOffset(-90),  to: dayOffset(-60)  },
      { from: dayOffset(-150), to: dayOffset(-90)  },
      { from: dayOffset(-270), to: dayOffset(-150) },
      { from: dayOffset(-365), to: dayOffset(-270) },
    ];

    for (const janela of janelas) {
      if (jogosValidos.length >= 10) break;
      const fixtures = await bsd(`/teams/${teamId}/fixtures/`, {
        status: 'finished',
        date_from: janela.from,
        date_to: janela.to,
        limit: 20,
        ordering: '-event_date'
      });
      const results = fixtures.results || [];
      for (const ev of results) {
        if (jogosValidos.length >= 10) break;
        if (seenIds.has(ev.id)) continue;
        seenIds.add(ev.id);
        const base = normEvento(ev);
        if (base.home_score !== null && base.away_score !== null
         && base.home_score !== undefined && base.away_score !== undefined) {
          jogosValidos.push(ev);
        }
      }
    }

    // Ordena do mais recente para o mais antigo (para o gráfico mostrar cronológico ao reverter)
    jogosValidos.sort((a, b) => new Date(b.event_date || 0) - new Date(a.event_date || 0));
    const jogos = jogosValidos.slice(0, 10);
    console.log('[grafico] jogos selecionados:', jogos.map(ev => ev.event_date?.slice(0,10)).join(', '));

    // Para cada jogo, busca stats em paralelo
    const comStats = await Promise.allSettled(
      jogos.map(async ev => {
        const base = normEvento(ev);
        try {
          const stats = await bsd(`/events/${ev.id}/stats/`);
          const isHome = String(base.home_team_id) === String(teamId);
          const side = isHome ? (stats.stats?.home || stats.home || {}) : (stats.stats?.away || stats.away || {});
          const opp  = isHome ? base.away_team : base.home_team;
          const oppId = isHome ? base.away_team_id : base.home_team_id;
          const hs = base.home_score, as_ = base.away_score;
          let result = '—';
          if (hs !== null && as_ !== null) {
            const ts = isHome ? hs : as_, os = isHome ? as_ : hs;
            result = ts > os ? 'W' : ts < os ? 'L' : 'D';
          }
          return {
            id: ev.id,
            date: base.event_date,
            opponent: opp,
            opponent_id: oppId,
            score: hs !== null ? `${hs}-${as_}` : '—',
            result,
            corners:    side.corner_kicks    ?? side.corners        ?? null,
            shots:      side.total_shots     ?? side.shots           ?? null,
            shots_on:   side.shots_on_target ?? side.shots_on        ?? null,
            fouls:      side.fouls           ?? null,
            passes:     side.passes          ?? side.total_passes    ?? null,
            possession: side.ball_possession ?? side.possession      ?? null,
            goals_for:  isHome ? hs : as_,
            goals_against: isHome ? as_ : hs,
            yellow:     side.yellow_cards    ?? null,
          };
        } catch(_) {
          const isHome = String(base.home_team_id) === String(teamId);
          const hs = base.home_score, as_ = base.away_score;
          let result = '—';
          if (hs !== null && as_ !== null) {
            const ts = isHome ? hs : as_, os = isHome ? as_ : hs;
            result = ts > os ? 'W' : ts < os ? 'L' : 'D';
          }
          return {
            id: ev.id,
            date: base.event_date,
            opponent: isHome ? base.away_team : base.home_team,
            opponent_id: isHome ? base.away_team_id : base.home_team_id,
            score: hs !== null ? `${hs}-${as_}` : '—',
            result,
            corners: null, shots: null, shots_on: null,
            fouls: null, passes: null, possession: null,
            goals_for: isHome ? hs : as_,
            goals_against: isHome ? as_ : hs,
            yellow: null,
          };
        }
      })
    );

    const data = comStats
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      // Remove jogos sem placar definido (evita barras vazias/duplicadas no gráfico)
      .filter(j => j.score && j.score !== '—' && j.opponent && j.opponent !== '—')
      .reverse(); // cronológico

    res.json({ jogos: data, total: data.length, team_id: teamId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


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

    // ── CAMINHO A: busca por nome + time
    if (teamQuery) {
      let teamId2 = null, teamName2 = null;
      try {
        // Usa a mesma função que /api/teams já usa — sem HTTP interno
        const times = await buscarTimePorNome(teamQuery);
        if (times.length > 0) { teamId2 = times[0].id; teamName2 = times[0].name; }
      } catch(e) { console.log(`[jogadores] ERRO buscarTimePorNome: ${e.message}`); }

      if (teamId2) {
        const teamObj = { id: teamId2, name: teamName2 };
        try {
          const sqRes = await fetch(
            `https://sports.bzzoiro.com/api/v2/teams/${teamId2}/squad/`,
            { headers: { Authorization: `Token ${BSD_TOKEN}` } }
          );
          const sq   = await sqRes.json();
          const list = sq.players || sq.squad || sq.results || [];
          const normLocal = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
          const nameF = normLocal(name || '');
          const filtered = nameF
            ? list.filter(p => normLocal(p.name||p.display_name||'').includes(nameF))
            : list;
          console.log(`[jogadores] squad "${teamName2}": ${list.length} total → ${filtered.length} match "${nameF}"`);
          if (filtered.length === 0 && nameF) {
            const sample = list.slice(0,15).map(p=>p.name||'?').join(' | ');
          }
          addPlayers(filtered, teamObj);
        } catch(e) { console.log(`[jogadores] ERRO squad: ${e.message}`); }
      }
    }

    // ── CAMINHO B: só nome, sem time → busca direta por nome
    if (!teamQuery || results.length < 3) {
      try {
        const d = await bsd('/players/', { name, team_id, position, nationality_code, limit });
        addPlayers(d.results);
      } catch (_) {}
    }

    // ── ENRIQUECIMENTO: usa current_team_id (v2 retorna isso) para buscar nome do time em batch
    const teamIds = [...new Set(results.filter(p => p.current_team_id && !p.current_team).map(p => p.current_team_id))];
    if (teamIds.length > 0) {
      // Busca nomes dos times em paralelo (máximo 10 times únicos)
      const teamNames = {};
      await Promise.all(teamIds.slice(0,10).map(async tid => {
        try {
          const t = await bsd(`/teams/${tid}/`);
          teamNames[String(tid)] = t.name || t.short_name || '—';
        } catch(_) {}
      }));
      // Aplica nos jogadores
      results.forEach(p => {
        if (p.current_team_id && !p.current_team) {
          const tname = teamNames[String(p.current_team_id)];
          if (tname) p.current_team = { id: p.current_team_id, name: tname };
        }
      });
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

// Perfil completo do jogador → /api/player/:id/profile
app.get('/api/player/:id/profile', async (req, res) => {
  try {
    const id = req.params.id;
    const [detail, career, national, transfers] = await Promise.allSettled([
      bsd(`/players/${id}/`),
      bsd(`/players/${id}/career/`),
      bsd(`/players/${id}/national-team/`),
      bsd(`/players/${id}/transfers/`),
    ]);
    res.json({
      detail:    detail.status==='fulfilled'    ? detail.value    : null,
      career:    career.status==='fulfilled'    ? career.value    : null,
      national:  national.status==='fulfilled'  ? national.value  : null,
      transfers: transfers.status==='fulfilled' ? transfers.value : null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Stats do jogador → /api/player/:id/stats?teamId=X
// Usa BSD: /api/player-stats/?player=ID (endpoint que retorna evento aninhado)
app.get('/api/player/:id/stats', async (req, res) => {
  try {
    const { teamId } = req.query;
    const playerId = req.params.id;

    const data = await fetch(
      `https://sports.bzzoiro.com/api/player-stats/?player=${playerId}&limit=20&tz=America/Sao_Paulo`,
      { headers: { Authorization: `Token ${BSD_TOKEN}` } }
    ).then(r => r.json());

    let raw = data.results || [];

    // Se não encontrou por ID, tenta buscar por nome (lineup usa ID diferente do player-stats)
    if (!raw.length && req.query.playerName) {
      try {
        const nameQ = encodeURIComponent(req.query.playerName);
        const search = await fetch(
          `https://sports.bzzoiro.com/api/players/?search=${nameQ}&limit=5`,
          { headers: { Authorization: `Token ${BSD_TOKEN}` } }
        ).then(r => r.json());
        const found = (search.results||[]).find(p =>
          String(p.id) !== String(playerId) // ID diferente do que já tentamos
        );
        if (found) {
          const retry = await fetch(
            `https://sports.bzzoiro.com/api/player-stats/?player=${found.id}&limit=20&tz=America/Sao_Paulo`,
            { headers: { Authorization: `Token ${BSD_TOKEN}` } }
          ).then(r => r.json());
          if ((retry.results||[]).length) raw = retry.results;
        }
      } catch(_) {}
    }

    if (!raw.length) return res.json({ jogos: [], fromCache: false });

    raw.sort((a, b) => new Date(b.event?.event_date || 0) - new Date(a.event?.event_date || 0));

    // Se teamId foi passado, tenta filtrar por esse time
    // g.team_id pode não bater com teamId (BSD usa IDs internos diferentes)
    // Por isso ignoramos teamId no filtro e deixamos o mapeamento de opponent cuidar disso
    // O teamId ainda é usado abaixo para identificar qual lado do placar é do jogador

    const jogos = raw.slice(0, 7).map(g => {
      const ev = g.event || {};
      const playerTeamId = String(g.team_id || teamId || '');
      const homeId = String(ev.home_team_id || '');
      const awayId = String(ev.away_team_id || '');

      let opponent, myScore, oppScore;
      if (playerTeamId && homeId && playerTeamId === homeId) {
        opponent = ev.away_team; myScore = ev.home_score; oppScore = ev.away_score;
      } else if (playerTeamId && awayId && playerTeamId === awayId) {
        opponent = ev.home_team; myScore = ev.away_score; oppScore = ev.home_score;
      } else if (homeId && homeId === String(teamId)) {
        opponent = ev.away_team; myScore = ev.home_score; oppScore = ev.away_score;
      } else if (awayId && awayId === String(teamId)) {
        opponent = ev.home_team; myScore = ev.away_score; oppScore = ev.home_score;
      } else {
        const ht = (ev.home_team||'').toLowerCase(), at = (ev.away_team||'').toLowerCase();
        const tn = (g.team?.name||g.team_name||'').toLowerCase();
        const tok = tn ? tn.split(' ')[0] : '';
        if (tok && ht.includes(tok)) { opponent = ev.away_team; myScore = ev.home_score; oppScore = ev.away_score; }
        else if (tok && at.includes(tok)) { opponent = ev.home_team; myScore = ev.away_score; oppScore = ev.home_score; }
        else { opponent = `${ev.home_team} × ${ev.away_team}`; myScore = null; oppScore = null; }
      }

      let result = '—';
      if (myScore != null && oppScore != null)
        result = myScore > oppScore ? 'W' : myScore < oppScore ? 'L' : 'D';

      const score = (ev.home_score != null && ev.away_score != null)
        ? `${ev.home_score}-${ev.away_score}` : '—';
      const data_jogo = ev.event_date
        ? new Date(ev.event_date).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', timeZone:'America/Sao_Paulo' })
        : '—';
      const n = v => (v !== null && v !== undefined && v !== '' && !isNaN(Number(v))) ? Number(v) : null;

      return {
        opponent: opponent||'—', score, result, data: data_jogo,
        chutes: n(g.total_shots)??n(g.shots),
        chutes_gol: n(g.shots_on_target)??n(g.shots_on_goal),
        desarmes: n(g.tackle_won ?? g.tackles_won ?? g.won_tackle ?? g.total_tackle),
        ftc: n(g.fouls_committed)??n(g.fouls),
        fts: n(g.fouls_drawn)??n(g.was_fouled),
        amarelos: n(g.yellow_card)??n(g.yellow_cards),
        vermelhos: n(g.red_card)??n(g.red_cards),
        defesas: n(g.saves),
        gols: n(g.goals),
        assistencias: n(g.goal_assist),
        minutos: n(g.minutes_played),
        passes: n(g.accurate_pass)??n(g.total_pass),
        rating: n(g.rating),
      };
    });

    // Calcular snapshot (médias) para o frontend
    const keys = ['chutes','chutes_gol','desarmes','ftc','fts','amarelos','vermelhos','defesas','gols','assistencias'];
    const labels = ['CHU','CHG','DES','FTC','FTS','🟨','🟥','DEF','⚽','ASS'];
    const snapshot = {};
    keys.forEach((k, i) => {
      const vals = jogos.map(j => j[k]).filter(v => v !== null && v !== undefined);
      if (vals.length) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        snapshot[labels[i]] = Math.round(avg * 10) / 10;
        snapshot[k] = Math.round(avg * 10) / 10;
      }
    });

    res.json({ jogos, snapshot, fromCache: false });
  } catch(e) {
    console.error('[player-stats] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Resolve teamId pelo nome do time
app.get('/api/team/id-by-name', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.json({ id: null });
    const times = await buscarTimePorNome(name);
    const t = times[0];
    res.json({ id: t ? t.id : null, name: t ? t.name : null });
  } catch(e) {
    res.json({ id: null });
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
    const { league_id, name, limit = 200 } = req.query;
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

  // Mantém o servidor acordado no Render (plano gratuito dorme após 15min)
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/api/ping`);
      console.log('[keep-alive] ping OK');
    } catch(_) {}
  }, 14 * 60 * 1000); // a cada 14 minutos
});

app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Endpoint de tradução via Google Translate (sem chave, sem limite prático)
app.post('/api/traduzir', async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ error: 'texto obrigatório' });
    // Divide em blocos de 4800 chars para garantir estabilidade
    const blocos = [];
    for (let i = 0; i < texto.length; i += 4800) blocos.push(texto.slice(i, i + 4800));
    const partes = await Promise.all(blocos.map(async bloco => {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=' + encodeURIComponent(bloco);
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await r.json();
      return (data[0] || []).map(s => s[0] || '').join('');
    }));
    const traduzido = partes.join(' ');
    if (!traduzido.trim()) throw new Error('resposta vazia');
    res.json({ traduzido });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
