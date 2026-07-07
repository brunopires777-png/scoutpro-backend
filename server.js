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

// Cache em memória do ai_preview por event_id.
// A BSD às vezes volta a mandar NULL num jogo que já tinha texto gerado
// (instabilidade do lado deles). Uma vez que recebemos um texto válido,
// guardamos aqui e passamos a servir esse texto mesmo se uma chamada
// futura vier NULL — só substituímos quando chega um texto novo de verdade.
const aiPreviewCache = new Map(); // id -> { text, ts }
function resolveAiPreview(id, aiText) {
  if (aiText) {
    aiPreviewCache.set(id, { text: aiText, ts: Date.now() });
    return aiText;
  }
  const cached = aiPreviewCache.get(id);
  return cached ? cached.text : null;
}

// Helper: extrai número de formatos variados que a BSD pode retornar
// (número puro, {actual:N}, {value:N}, {total:N}, string numérica).
// Evita o bug de "??" pegar um objeto truthy (ex: {actual:1.23}) e travar
// a cadeia de fallback inteira gerando NaN.
function numFrom(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(parseFloat(v))) return parseFloat(v);
    if (typeof v === 'object') {
      const inner = v.actual ?? v.value ?? v.total ?? v.cum ?? null;
      if (inner != null) {
        if (typeof inner === 'number' && isFinite(inner)) return inner;
        if (typeof inner === 'string' && isFinite(parseFloat(inner))) return parseFloat(inner);
      }
    }
  }
  return null;
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
    // Tenta múltiplos termos de busca
    const termos = ['World Cup 2026', 'FIFA World Cup', 'World Cup', 'Mundial 2026'];
    for(const termo of termos){
      const lgs = await bsd('/leagues/', { search: termo, limit: 20 }).catch(()=>({results:[]}));
      const arr = lgs.results || (Array.isArray(lgs) ? lgs : []);
      const wc = arr.find(l => {
        const nm = (l.name||'').toLowerCase();
        return nm.includes('world cup') || nm.includes('mundial') || nm.includes('fifa cup');
      });
      if (wc?.id) {
        _wcLeagueIdCache = wc.id;
        console.log(`[copa] liga encontrada: "${wc.name}" id=${wc.id}`);
        return wc.id;
      }
    }
    console.log('[copa] liga não encontrada, usando fallback amplo');
  } catch(e) { console.error('[copa resolveLeagueId]', e.message); }
  return id; // fallback: usa o 1 mesmo
}



// Diagnóstico detalhado do value-bets — ajuda a entender por que está vazio
app.get('/api/debug/value-bets', async (req, res) => {
  try {
    const t    = today();
    const t5   = dayOffset(5);
    const data = await bsd('/events/', { date_from: t, date_to: t5, limit: 200, tz: 'America/Sao_Paulo' });
    const all  = data.results || [];

    const por_status = {};
    all.forEach(ev => {
      const s = ev.status || ev.event_status || 'sem_status';
      por_status[s] = (por_status[s]||0) + 1;
    });

    const futuros = all.filter(ev => {
      const s = (ev.status || ev.event_status || '').toLowerCase();
      return !['finished','ft','full-time','ended','canceled','postponed','live','inprogress','1h','ht','2h'].some(x=>s.includes(x));
    });

    const comOdds   = futuros.filter(ev => ev.odds_home || ev.odds_draw || ev.odds_away);
    const semOdds   = futuros.filter(ev => !ev.odds_home && !ev.odds_draw && !ev.odds_away);

    // Testa predição para o primeiro jogo futuro
    let predTeste = null;
    if(futuros.length){
      try{
        predTeste = await bsd(`/events/${futuros[0].id}/prediction/`);
      }catch(e){ predTeste = {erro: e.message}; }
    }

    res.json({
      janela: `${t} a ${t5}`,
      total_eventos: all.length,
      por_status,
      futuros: futuros.length,
      futuros_com_odds: comOdds.length,
      futuros_sem_odds: semOdds.length,
      primeiros_futuros: futuros.slice(0,5).map(ev=>({
        id: ev.id,
        partida: `${ev.home_team_name||ev.home_team?.name||'?'} x ${ev.away_team_name||ev.away_team?.name||'?'}`,
        data: ev.event_date?.slice(0,16),
        status: ev.status||ev.event_status,
        tem_odds: !!(ev.odds_home||ev.odds_draw||ev.odds_away)
      })),
      pred_primeiro_futuro: predTeste ? {
        mercados: Object.keys(predTeste?.markets||{}),
        match_result: predTeste?.markets?.match_result,
      } : null
    });
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
// Busca odds via /api/v2/events/{id}/odds/ apenas para jogos sem odds na raiz.
// Limita a 30 chamadas paralelas pra não sobrecarregar a API.
const _oddsCache = new Map(); // cache em memória por id, TTL 10min

async function _fetchOddsV2(id) {
  const now = Date.now();
  const cached = _oddsCache.get(id);
  if (cached && now - cached.ts < 10 * 60 * 1000) return cached.data;
  try {
    const d = await bsd(`/api/v2/events/${id}/odds/`);
    // Estrutura esperada: { markets: { '1X2': { HOME, DRAW, AWAY } } }
    const m1x2 = d?.markets?.['1X2'] || d?.markets?.['1x2'] || d?.['1X2'] || d?.['1x2'] || {};
    const data = {
      odds_home: parseFloat(m1x2.HOME || m1x2.home || 0) || null,
      odds_draw: parseFloat(m1x2.DRAW || m1x2.draw || m1x2.X || 0) || null,
      odds_away: parseFloat(m1x2.AWAY || m1x2.away || 0) || null,
    };
    _oddsCache.set(id, { ts: now, data });
    return data;
  } catch (_) { return null; }
}

async function enriquecerOdds(eventos) {
  // Só busca para jogos que chegaram sem odds — evita chamadas desnecessárias
  const semOdds = eventos.filter(ev => !ev.odds_home && !ev.odds_draw && !ev.odds_away && ev.id);
  if (!semOdds.length) return eventos;
  // Máximo 30 chamadas em paralelo por rodada
  const chunks = [];
  for (let i = 0; i < semOdds.length; i += 30) chunks.push(semOdds.slice(i, i + 30));
  const resultMap = new Map();
  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(async ev => ({ id: ev.id, odds: await _fetchOddsV2(ev.id) }))
    );
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value.odds) resultMap.set(r.value.id, r.value.odds);
    });
  }
  return eventos.map(ev => {
    if (!ev.odds_home && resultMap.has(ev.id)) {
      return { ...ev, ...resultMap.get(ev.id) };
    }
    return ev;
  });
}

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
    // xG disponível diretamente no evento — numFrom() evita pegar objeto {actual:N} cru
    home_xg:      numFrom(ev.home_xg_live, ev.actual_home_xg, ev.home_xg),
    away_xg:      numFrom(ev.away_xg_live, ev.actual_away_xg, ev.away_xg),
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
    const t = date || today();
    // Busca também dia anterior e seguinte para pegar jogos que a BSD classifica em UTC
    const tPrev = (() => { const d = new Date(t); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); })();
    const tNext = (() => { const d = new Date(t); d.setDate(d.getDate()+1); return d.toISOString().slice(0,10); })();
    const lgId = league_id ? await resolveLeagueId(league_id) : '';
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${tPrev}&date_to=${tNext}&tz=America/Sao_Paulo&limit=200${lgId ? `&league=${lgId}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    // Filtrar pelo dia correto em Brasília (UTC-3) — a BSD classifica jogos noturnos em UTC do dia seguinte
    const brDateOf = ev => ev.event_date ? new Date(new Date(ev.event_date).getTime() - 3*60*60*1000).toISOString().slice(0,10) : t;
    const filtered = (data.results || []).filter(ev => brDateOf(ev) === t);
    data.results = await enriquecerOdds(await enriquecerArbitros(filtered.map(normEvento)));
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/amanha', async (req, res) => {
  try {
    const { league_id } = req.query;
    const t = dayOffset(1);
    // Busca range hoje+amanhã+depois pois a BSD pode classificar em UTC
    const tFrom = today();
    const tTo = dayOffset(2);
    const lgId = league_id ? await resolveLeagueId(league_id) : '';
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${tFrom}&date_to=${tTo}&tz=America/Sao_Paulo&limit=200${lgId ? `&league=${lgId}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    const brDateOf = ev => ev.event_date ? new Date(new Date(ev.event_date).getTime() - 3*60*60*1000).toISOString().slice(0,10) : t;
    const filtered = (data.results || []).filter(ev => brDateOf(ev) === t);
    data.results = await enriquecerOdds(await enriquecerArbitros(filtered.map(normEvento)));
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/semana', async (req, res) => {
  try {
    const { league_id } = req.query;
    const lgId = league_id ? await resolveLeagueId(league_id) : '';
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${today()}&date_to=${dayOffset(7)}&tz=America/Sao_Paulo&limit=200${lgId ? `&league=${lgId}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    data.results = await enriquecerOdds(await enriquecerArbitros((data.results || []).map(normEvento)));
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/ao-vivo', async (req, res) => {
  try {
    const { league_id } = req.query;
    const url = `https://sports.bzzoiro.com/api/live/?tz=America/Sao_Paulo${league_id ? `&league=${league_id}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    const lista = data.events || data.results || [];

    // O endpoint /api/live/ é "lightweight" (feito para polling de alta frequência) e
    // NÃO retorna árbitro nem odds — só id, times, placar e status. Por isso esses
    // campos sumiam só na aba Ao Vivo. Busca os jogos completos de hoje via /api/events/
    // (mesma chamada que a rota /hoje já faz) e mescla árbitro/odds pelo ID do evento.
    if (lista.length) {
      try {
        const t = today();
        const tPrev = (() => { const d = new Date(t); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); })();
        const tNext = (() => { const d = new Date(t); d.setDate(d.getDate()+1); return d.toISOString().slice(0,10); })();
        const fullUrl = `https://sports.bzzoiro.com/api/events/?date_from=${tPrev}&date_to=${tNext}&tz=America/Sao_Paulo&limit=200`;
        const fullData = await fetch(fullUrl, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
        const fullMap = new Map((fullData.results || []).map(ev => [ev.id, ev]));
        for (const ev of lista) {
          const full = fullMap.get(ev.id);
          if (!full) continue;
          ev.referee_id   = ev.referee_id   ?? full.referee_id   ?? full.referee?.id   ?? null;
          ev.referee_name = ev.referee_name ?? full.referee_name ?? full.referee?.name ?? full.referee?.full_name ?? (typeof full.referee === 'string' ? full.referee : null) ?? null;
          ev.referee      = ev.referee      ?? full.referee      ?? null;
          ev.odds_home    = ev.odds_home    ?? full.odds_home    ?? full.home_win ?? null;
          ev.odds_draw    = ev.odds_draw    ?? full.odds_draw    ?? full.draw     ?? null;
          ev.odds_away    = ev.odds_away    ?? full.odds_away    ?? full.away_win ?? null;
        }
      } catch (_) { /* merge falhou — segue só com os dados lightweight, não quebra a lista */ }
    }

    const normalized = await enriquecerOdds(await enriquecerArbitros(lista.map(normEvento)));
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
      bsd(`/events/${id}/metadata/`).catch(() => null), // path correto sem /api/v2 duplicado
      bsd(`/events/${id}/`) // base sem full=true
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
    const predData = predicao.status === 'fulfilled' ? predicao.value : null;

    // Extrai xG de todas as fontes — numFrom() desembrulha formatos como {actual:N}
    // que antes travavam a cadeia de "??" e geravam NaN durante o jogo ao vivo.
    if (evData) {
      const sh = statsData?.home || statsData?.stats?.home || {};
      const sa = statsData?.away || statsData?.stats?.away || {};
      // xg_per_minute: array cronológico com cumulativo por minuto — é a
      // fonte mais granular e mais confiável durante o jogo ao vivo.
      const xgPerMin = statsData?.xg_per_minute || statsData?.stats?.xg_per_minute;
      const lastMin = Array.isArray(xgPerMin) && xgPerMin.length ? xgPerMin[xgPerMin.length - 1] : null;

      const xgH = numFrom(
        lastMin?.cum_xg_home, lastMin?.cum_home, lastMin?.xg_home,
        sh?.xg, sh?.expected_goals, sh?.xg_total,
        statsData?.home_xg, statsData?.xg?.home,
        evBase?.home_xg_live, evBase?.actual_home_xg, evBase?.home_xg,
        evData.home_xg_live, evData.actual_home_xg, evData.home_xg,
        predData?.markets?.expected_goals?.home
      );
      const xgA = numFrom(
        lastMin?.cum_xg_away, lastMin?.cum_away, lastMin?.xg_away,
        sa?.xg, sa?.expected_goals, sa?.xg_total,
        statsData?.away_xg, statsData?.xg?.away,
        evBase?.away_xg_live, evBase?.actual_away_xg, evBase?.away_xg,
        evData.away_xg_live, evData.actual_away_xg, evData.away_xg,
        predData?.markets?.expected_goals?.away
      );
      evData.home_xg = xgH != null ? xgH.toFixed(2) : null;
      evData.away_xg = xgA != null ? xgA.toFixed(2) : null;
    }

    const metaData = metadata?.status === 'fulfilled' ? metadata.value : null;
    // ai_preview: BSD retorna {ai_preview: {text:'...', generated_at:'...'}} ou null
    const aiObj  = metaData?.ai_preview;
    const aiTextRaw = (typeof aiObj === 'string' && aiObj.length > 5) ? aiObj
      : (aiObj?.text && aiObj.text.length > 5) ? aiObj.text : null;
    const aiText = resolveAiPreview(id, aiTextRaw);
    console.log(`[jogo ${id}] ai_preview: ${aiTextRaw ? 'OK '+aiTextRaw.slice(0,40) : (aiText ? 'NULL (usando cache)' : 'NULL')} | meta keys: ${metaData ? Object.keys(metaData).join(',') : 'null'}`);
    res.json({
      evento: evData,
      stats: statsData,
      incidents: incidents.status === 'fulfilled' ? incidents.value : null,
      odds: odds.status === 'fulfilled' ? odds.value : null,
      lineups: lineups.status === 'fulfilled' ? lineups.value : null,
      playerStats: playerStats.status === 'fulfilled' ? playerStats.value : null,
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
    const { league_id, limit = 60 } = req.query;

    // Busca TODAS as predições de jogos futuros (sem filtro recommended)
    // e filtra em código pelos que têm predição clara do modelo
    const predQs = new URLSearchParams({ status: 'upcoming', limit: '200' });
    if(league_id) predQs.set('league_id', league_id);

    // Busca predições + melhores odds em paralelo
    const [predRaw, oddsRaw] = await Promise.all([
      fetch(`https://sports.bzzoiro.com/api/v2/predictions/?${predQs}`, {
        headers: { Authorization: `Token ${BSD_TOKEN}` }
      }).then(r => r.json()),
      fetch(`https://sports.bzzoiro.com/api/v2/odds/best/?limit=300`, {
        headers: { Authorization: `Token ${BSD_TOKEN}` }
      }).then(r => r.json()).catch(() => ({}))
    ]);

    const allPreds = Array.isArray(predRaw) ? predRaw : (predRaw?.results || []);
    console.log(`[value-bets] total predições: ${allPreds.length}`);

    // Filtra: modelo tem predição definida (not null) e confiança >= 45%
    const preds = allPreds.filter(p =>
      p.markets?.match_result?.predicted !== null &&
      p.markets?.match_result?.predicted !== undefined &&
      (p.model?.confidence == null || p.model.confidence >= 0.45)
    );
    console.log(`[value-bets] com predição clara: ${preds.length}`);

    const oddsMap = new Map();
    const oddsArr = Array.isArray(oddsRaw) ? oddsRaw : (oddsRaw?.results || []);
    oddsArr.forEach(o => {
      const eid = o.event?.id || o.event_id;
      if(eid) oddsMap.set(String(eid), o);
    });

    const valueBets = [];

    for(const pred of preds){
      const ev     = pred.event || {};
      const mkts   = pred.markets || {};
      const rec    = pred.recommendations || {};
      const model  = pred.model || {};
      const mr     = mkts.match_result || {};
      const ou     = mkts.over_under || {};
      const btts   = mkts.btts || {};
      const score  = mkts.score || {};

      // BSD retorna prob_home/draw/away já em % (0-100) ou em 0-1 — normaliza:
      const toP = v => v == null ? 0 : v > 1 ? parseFloat(v) : parseFloat(v) * 100;
      const probH  = toP(mr.prob_home);
      const probD  = toP(mr.prob_draw);
      const probA  = toP(mr.prob_away);

      // Melhores odds disponíveis
      const bestOdds = oddsMap.get(String(ev.id)) || {};
      const bo = bestOdds.best_odds || bestOdds.outcomes || {};

      // Monta bet baseado na predição do modelo (predicted: H/D/A)
      const bets = [];
      const pred_result = mr.predicted; // 'H', 'D', 'A' ou null

      // Bet principal: o que o modelo prevê
      if(pred_result){
        const oh = parseFloat(bo.home_win?.odds || bo['1']?.odds || 0);
        const ox = parseFloat(bo.draw?.odds    || bo['X']?.odds || 0);
        const oa = parseFloat(bo.away_win?.odds || bo['2']?.odds || 0);

        if(pred_result === 'H' && probH >= 35){
          const odd = oh > 1 ? oh : null;
          const edge = odd ? +((probH/100*odd - 1)*100).toFixed(1) : null;
          bets.push({ tipo:'1x2', selection:'home', label:`${ev.home_team||'Casa'} Vence`,
            odd: odd ? +odd.toFixed(2) : null, prob:+probH.toFixed(1), edge, icon:'🏠' });
        }
        if(pred_result === 'D' && probD >= 25){
          const odd = ox > 1 ? ox : null;
          const edge = odd ? +((probD/100*odd - 1)*100).toFixed(1) : null;
          bets.push({ tipo:'1x2', selection:'draw', label:'Empate',
            odd: odd ? +odd.toFixed(2) : null, prob:+probD.toFixed(1), edge, icon:'🤝' });
        }
        if(pred_result === 'A' && probA >= 35){
          const odd = oa > 1 ? oa : null;
          const edge = odd ? +((probA/100*odd - 1)*100).toFixed(1) : null;
          bets.push({ tipo:'1x2', selection:'away', label:`${ev.away_team||'Fora'} Vence`,
            odd: odd ? +odd.toFixed(2) : null, prob:+probA.toFixed(1), edge, icon:'✈️' });
        }
      }

      // Over 2.5 se modelo indica (prob >= 55%)
      const probO25 = toP(ou.prob_over_25);
      if(probO25 >= 55){
        const oddO25 = parseFloat(bo.over_25?.odds || bo['over_2.5']?.odds || 0);
        const edge   = oddO25 > 1 ? +((probO25/100*oddO25 - 1)*100).toFixed(1) : null;
        bets.push({ tipo:'over_under', selection:'over_25', label:'Over 2.5 Gols',
          odd: oddO25 > 1 ? +oddO25.toFixed(2) : null, prob:+probO25.toFixed(1), edge, icon:'⚽' });
      }

      // BTTS se modelo indica (prob >= 60%)
      const probBtts = toP(btts.prob_yes || btts.probability);
      if(probBtts >= 60){
        const oddBtts = parseFloat(bo.btts_yes?.odds || bo['btts']?.odds || 0);
        const edge    = oddBtts > 1 ? +((probBtts/100*oddBtts - 1)*100).toFixed(1) : null;
        bets.push({ tipo:'btts', selection:'btts', label:'Ambas Marcam (Sim)',
          odd: oddBtts > 1 ? +oddBtts.toFixed(2) : null, prob:+probBtts.toFixed(1), edge, icon:'🎯' });
      }

      if(!bets.length) continue;


      valueBets.push({
        evento: {
          id: ev.id,
          home_team: ev.home_team || '?',
          away_team: ev.away_team || '?',
          home_team_id: ev.home_team_id || null,
          away_team_id: ev.away_team_id || null,
          event_date: ev.event_date,
          league_name: ev.league_name || '',
          league_id: ev.league_id
        },
        probs: { home:+probH.toFixed(1), draw:+probD.toFixed(1), away:+probA.toFixed(1) },
        score_likely: score.most_likely || null,
        confidence: model.confidence ? Math.round(model.confidence * 100) : null,
        predicted: mr.predicted,
        over_25: (ou.prob_over_25||0)*100,
        btts_prob: (btts.prob_yes||btts.probability||0)*100,
        bets
      });
    }

    // Filtra: somente jogos de hoje ou amanhã (fuso Brasília)
    const _diasValidos = new Set([today(), dayOffset(1)]);
    const valueBetsHojeAmanha = valueBets.filter(vb => {
      if(!vb.evento.event_date) return false;
      const d = toBrasiliaDateStr(new Date(vb.evento.event_date));
      return _diasValidos.has(d);
    });
    console.log(`[value-bets] hoje+amanhã: ${valueBetsHojeAmanha.length} de ${valueBets.length} com predição`);

    // Busca ai_preview de cada jogo em paralelo (mesmo mecanismo do RESUMO)
    function extrairPlacarDoTexto(text, homeTeam, awayTeam){
      if(!text || !homeTeam || !awayTeam) return null;
      const t = text.replace(/\*\*/g,'').replace(/\*/g,'')
                    .replace(/–/g,'-').replace(/—/g,'-')
                    .replace(/\bO\b/g,'0');
      const hN = homeTeam.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/\s+/)[0];
      const aN = awayTeam.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/\s+/)[0];
      function norm(teamStr, sL, sR){
        const left = teamStr.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
        if(left.includes(hN) && !left.includes(aN)) return `${sL}-${sR}`;
        if(left.includes(aN) && !left.includes(hN)) return `${sR}-${sL}`;
        if(left.includes(hN)) return `${sL}-${sR}`;
        if(left.includes(aN)) return `${sR}-${sL}`;
        return null;
      }
      const tN = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      const kwds = ['prediction:','predicted:','predicts:','final score','result:','wins here','will win','should win','leans'];
      for(const kw of kwds){
        const idx = tN.lastIndexOf(kw);
        if(idx===-1) continue;
        const win = t.slice(Math.max(0,idx-20), idx+200);
        const re = /([A-ZÀ-Ÿa-zà-ÿ][A-ZÀ-Ÿa-zà-ÿ'\-\s]{0,30}?)\s+(\d)\s*-\s*(\d)\s*([A-ZÀ-Ÿa-zà-ÿ][A-ZÀ-Ÿa-zà-ÿ'\-\s]{0,30})/g;
        let m;
        while((m=re.exec(win))!==null){
          const r = norm(m[1],m[2],m[3]) || norm(m[4],m[3],m[2]);
          if(r) return r;
        }
        const rs = /(\d)\s*-\s*(\d)/.exec(win);
        if(rs) return `${rs[1]}-${rs[2]}`;
      }
      const tail = t.slice(-400);
      const re2 = /([A-ZÀ-Ÿa-zà-ÿ][A-ZÀ-Ÿa-zà-ÿ'\-\s]{0,25}?)\s+(\d)\s*-\s*(\d)\s*([A-ZÀ-Ÿa-zà-ÿ][A-ZÀ-Ÿa-zà-ÿ'\-\s]{0,25})/g;
      let m2;
      while((m2=re2.exec(tail))!==null){
        const r = norm(m2[1],m2[2],m2[3]) || norm(m2[4],m2[3],m2[2]);
        if(r) return r;
      }
      return null;
    }

    await Promise.all(valueBetsHojeAmanha.map(async vb => {
      try {
        const meta = await bsd(`/events/${vb.evento.id}/metadata/`);
        const aiObj = meta?.ai_preview;
        const aiTextRaw = typeof aiObj === 'string' ? aiObj : (aiObj?.text || null);
        vb.ai_preview = resolveAiPreview(vb.evento.id, aiTextRaw);
        vb.score_ia = extrairPlacarDoTexto(vb.ai_preview, vb.evento.home_team, vb.evento.away_team);
      } catch(_){ vb.ai_preview = resolveAiPreview(vb.evento.id, null); vb.score_ia = extrairPlacarDoTexto(vb.ai_preview, vb.evento.home_team, vb.evento.away_team); }
    }));

    // Só mantém jogos que realmente têm placar extraído do Preview (mais preciso
    // que a predição estruturada) — evita perder jogos que já tiveram o Preview
    // gerado, mesmo se a BSD variar e mandar NULL de novo (o cache cobre isso).
    const comPreview = valueBetsHojeAmanha.filter(vb => vb.score_ia);

    // Ordena por maior edge disponível
    comPreview.sort((a,b) => {
      const maxEdgeA = Math.max(...a.bets.map(x => x.edge || 0));
      const maxEdgeB = Math.max(...b.bets.map(x => x.edge || 0));
      return maxEdgeB - maxEdgeA;
    });

    const sliced = comPreview.slice(0, parseInt(limit));

    console.log(`[value-bets v2] ${preds.length} preds → ${valueBets.length} bets | hoje+amanhã: ${valueBetsHojeAmanha.length} | com placar IA: ${comPreview.length} | enviados: ${sliced.length}`);
    res.json({ results: sliced, total: sliced.length, source: 'bsd_v2_predictions' });

  } catch(e) {
    console.error('[value-bets v2] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});
;


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

// ── Dicionário PT→EN para busca de seleções/times em português ──
const TEAM_NAME_PT_EN = {
  'brasil':'brazil','argentina':'argentina','alemanha':'germany','espanha':'spain',
  'franca':'france','frança':'france','italia':'italy','itália':'italy','inglaterra':'england',
  'portugal':'portugal','holanda':'netherlands','paises baixos':'netherlands',
  'belgica':'belgium','bélgica':'belgium','croacia':'croatia','croácia':'croatia',
  'uruguai':'uruguay','colombia':'colombia','colômbia':'colombia','chile':'chile',
  'mexico':'mexico','méxico':'mexico','estados unidos':'united states','eua':'united states',
  'japao':'japan','japão':'japan','coreia do sul':'south korea','coreia':'south korea',
  'marrocos':'morocco','senegal':'senegal','gana':'ghana','camaroes':'cameroon','camarões':'cameroon',
  'nigeria':'nigeria','nigéria':'nigeria','egito':'egypt','tunisia':'tunisia','tunísia':'tunisia',
  'argelia':'algeria','argélia':'algeria','africa do sul':'south africa','áfrica do sul':'south africa',
  'arabia saudita':'saudi arabia','arábia saudita':'saudi arabia','catar':'qatar','qatar':'qatar',
  'ira':'iran','irã':'iran','iraque':'iraq','australia':'australia','austrália':'australia',
  'canada':'canada','canadá':'canada','equador':'ecuador','peru':'peru','paraguai':'paraguay',
  'bolivia':'bolivia','bolívia':'bolivia','venezuela':'venezuela','costa rica':'costa rica',
  'panama':'panama','panamá':'panama','jamaica':'jamaica','suica':'switzerland','suíça':'switzerland',
  'austria':'austria','áustria':'austria','polonia':'poland','polônia':'poland','suecia':'sweden','suécia':'sweden',
  'noruega':'norway','dinamarca':'denmark','escocia':'scotland','escócia':'scotland',
  'pais de gales':'wales','país de gales':'wales','irlanda':'ireland','irlanda do norte':'northern ireland',
  'russia':'russia','rússia':'russia','ucrania':'ukraine','ucrânia':'ukraine','turquia':'turkey',
  'grecia':'greece','grécia':'greece','servia':'serbia','sérvia':'serbia','romenia':'romania','romênia':'romania',
  'hungria':'hungary','republica tcheca':'czech republic','república tcheca':'czech republic','tchequia':'czechia',
  'eslovaquia':'slovakia','eslováquia':'slovakia','eslovenia':'slovenia','eslovênia':'slovenia',
  'bulgaria':'bulgaria','bulgária':'bulgaria','islandia':'iceland','islândia':'iceland',
  'finlandia':'finland','finlândia':'finland','bosnia':'bosnia','bósnia':'bosnia',
  'china':'china','india':'india','índia':'india','tailandia':'thailand','tailândia':'thailand',
  'vietna':'vietnam','vietnã':'vietnam','indonesia':'indonesia','indonésia':'indonesia',
  'jordania':'jordan','jordânia':'jordan','iraque':'iraq','israel':'israel',
  'nova zelandia':'new zealand','nova zelândia':'new zealand','costa do marfim':'ivory coast',
  'rep democratica do congo':'dr congo','república democrática do congo':'dr congo','dr congo':'dr congo',
  'cabo verde':'cape verde','uzbequistao':'uzbekistan','uzbequistão':'uzbekistan',
  'emirados arabes':'united arab emirates','emirados árabes':'united arab emirates',
};
function traduzirNomeTime(q) {
  const norm = (q||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
  return TEAM_NAME_PT_EN[norm] || null;
}

async function buscarTimePorNome(q) {
  const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const term = norm(q);
  const seen = new Map();

  // Se o termo em português tem tradução conhecida, busca também pelo nome em inglês
  const qTraduzido = traduzirNomeTime(q);
  const termosBusca = qTraduzido ? [q, qTraduzido] : [q];

  // 1ª fonte: API de times da BSD com busca nativa (mais abrangente)
  for (const termo of termosBusca) {
    try {
      const apiTeams = await fetch(
        `https://sports.bzzoiro.com/api/v2/teams/?name=${encodeURIComponent(termo)}&limit=20`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }
      ).then(r => r.json());
      (apiTeams.results || []).forEach(t => {
        if (t.id && !seen.has(t.id))
          seen.set(t.id, { id: t.id, name: t.name, country: t.country || '' });
      });
    } catch(_) {}
    if (seen.size >= 5) break; // já achou o suficiente, não precisa tentar a segunda forma
  }

  // 2ª fonte: eventos recentes (complementa com times que tenham jogos)
  if (seen.size < 3) {
    try {
      const dateFrom = new Date(Date.now()-60*86400000).toISOString().slice(0,10);
      const dateTo   = new Date(Date.now()+14*86400000).toISOString().slice(0,10);
      const evData = await fetch(
        `https://sports.bzzoiro.com/api/events/?date_from=${dateFrom}&date_to=${dateTo}&limit=300`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }
      ).then(r => r.json());
      // Termo de busca: usa tradução se houver, senão o termo original
      const termBusca = qTraduzido ? norm(qTraduzido) : term;
      const matchFn = n => n.includes(termBusca) || n.split(/\s+/).some(w=>w.startsWith(termBusca)) || n.includes(term) || n.split(/\s+/).some(w=>w.startsWith(term));
      (evData.results || []).forEach(ev => {
        const hid = ev.home_team_id || ev.home_team_obj?.id;
        const aid = ev.away_team_id || ev.away_team_obj?.id;
        if (matchFn(norm(ev.home_team||'')) && hid && !seen.has(hid))
          seen.set(hid, { id: hid, name: ev.home_team, country: ev.league?.country||'' });
        if (matchFn(norm(ev.away_team||'')) && aid && !seen.has(aid))
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
    // Tradução PT→EN para seleções (ex: "Brasil" também busca "Brazil")
    const qTrad = traduzirNomeTime(q);
    const termosQ = qTrad ? [q, qTrad] : [q];

    // 1ª fonte: API de times da BSD com busca nativa (mais abrangente)
    for (const termoQ of termosQ) {
      try {
        const apiTeams = await fetch(
          `https://sports.bzzoiro.com/api/v2/teams/?name=${encodeURIComponent(termoQ)}&limit=20`,
          { headers: { Authorization: `Token ${BSD_TOKEN}` } }
        ).then(r => r.json());
        (apiTeams.results || []).forEach(t => {
          if (t.id && !seen.has(t.id))
            seen.set(t.id, { id: t.id, name: t.name, country: t.country || '' });
        });
      } catch(_) {}
      if (seen.size >= 5) break;
    }

    // 2ª fonte: eventos recentes (complementa com times que tenham jogos)
    if (seen.size < 3) {
      const dateFrom = new Date(Date.now()-60*86400000).toISOString().slice(0,10);
      const dateTo   = new Date(Date.now()+14*86400000).toISOString().slice(0,10);
      const evData = await fetch(
        `https://sports.bzzoiro.com/api/events/?date_from=${dateFrom}&date_to=${dateTo}&limit=300`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }
      ).then(r => r.json());
      const termB = qTrad ? norm(qTrad) : term;
      const matchF = n => n.includes(termB)||n.split(/\s+/).some(w=>w.startsWith(termB))||n.includes(term)||n.split(/\s+/).some(w=>w.startsWith(term));
      (evData.results || []).forEach(ev => {
        const hid = ev.home_team_id || ev.home_team_obj?.id;
        const aid = ev.away_team_id || ev.away_team_obj?.id;
        if (matchF(norm(ev.home_team||'')) && hid && !seen.has(hid))
          seen.set(hid, { id: hid, name: ev.home_team, country: ev.league?.country || ev.home_team_obj?.country || '' });
        if (matchF(norm(ev.away_team||'')) && aid && !seen.has(aid))
          seen.set(aid, { id: aid, name: ev.away_team, country: ev.league?.country || ev.away_team_obj?.country || '' });
      });
    }

    // 3ª fonte: standings (fallback se ainda sem resultado)
    if (seen.size === 0) {
      const ligasData = await fetch('https://sports.bzzoiro.com/api/leagues/', {
        headers: { Authorization: `Token ${BSD_TOKEN}` }
      }).then(r => r.json());
      const termB = qTrad ? norm(qTrad) : term;
      for (const liga of (ligasData.results||[])) {
        try {
          const std = await fetch(`https://sports.bzzoiro.com/api/leagues/${liga.id}/standings/`, {
            headers: { Authorization: `Token ${BSD_TOKEN}` }
          }).then(r => r.json());
          for (const s of (std.standings||[])) {
            const nome = s.team||s.team_name||'';
            const tid  = s.team_id||s.id;
            if ((norm(nome).includes(term)||norm(nome).includes(termB)) && tid && !seen.has(tid))
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
// HISTÓRICO DO TIME — últimos 10 jogos (qualquer adversário)
// ─────────────────────────────────────────────
app.get('/api/teams/:id/historico', async (req, res) => {
  try {
    const teamId = req.params.id;
    const dateFrom = new Date(Date.now() - 365 * 86400000).toISOString().slice(0,10);
    const today2 = new Date().toISOString().slice(0,10);
    const data = await fetch(
      `https://sports.bzzoiro.com/api/v2/events/?team_id=${teamId}&date_from=${dateFrom}&date_to=${today2}&limit=30`,
      { headers: { Authorization: `Token ${BSD_TOKEN}` } }
    ).then(r => r.json());
    const raw = Array.isArray(data) ? data : (data.results || []);
    // Apenas jogos com placar (já encerrados), mais recentes primeiro
    const jogos = raw
      .filter(e => e.home_score != null && e.away_score != null)
      .sort((a,b) => new Date(b.event_date) - new Date(a.event_date))
      .slice(0, 10)
      .map(e => ({
        id: e.id,
        event_date: e.event_date,
        home_team: e.home_team, away_team: e.away_team,
        home_team_id: e.home_team_id, away_team_id: e.away_team_id,
        home_score: e.home_score, away_score: e.away_score,
        league: e.league?.name || e.league_name || '',
        is_team_home: String(e.home_team_id) === String(teamId)
      }));
    res.json({ jogos, count: jogos.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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

    // Usa exatamente a mesma fonte e lógica do histórico "últimos 10 jogos" (endpoint
    // /v2/events/?team_id=) — antes o gráfico buscava por /teams/{id}/fixtures/ em janelas
    // de data separadas, o que podia trazer um conjunto de jogos diferente do da lista
    // exibida logo abaixo. Agora os dois sempre mostram os mesmos 10 confrontos,
    // de qualquer liga, campeonato ou copa.
    const dateFrom = new Date(Date.now() - 365 * 86400000).toISOString().slice(0,10);
    const today2 = new Date().toISOString().slice(0,10);
    const rawData = await fetch(
      `https://sports.bzzoiro.com/api/v2/events/?team_id=${teamId}&date_from=${dateFrom}&date_to=${today2}&limit=30`,
      { headers: { Authorization: `Token ${BSD_TOKEN}` } }
    ).then(r => r.json());
    const raw = Array.isArray(rawData) ? rawData : (rawData.results || []);
    const jogos = raw
      .filter(e => e.home_score != null && e.away_score != null)
      .sort((a, b) => new Date(b.event_date) - new Date(a.event_date))
      .slice(0, 10);

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
            offsides:   side.offsides        ?? side.offside         ?? null,
            throws:     side.throws          ?? side.throw_ins       ?? side.throwins ?? null,
            goal_kicks: side.goal_kicks       ?? null,
            free_kicks: side.free_kicks       ?? null,
            // tackles_won na BSD é % de aproveitamento, não contagem — desarmes certos
            // = total de desarmes (tackles) × essa taxa de sucesso
            tackles_certos: (numFrom(side.tackles, side.total_tackles) != null && numFrom(side.tackles_won) != null)
              ? Math.round(numFrom(side.tackles, side.total_tackles) * numFrom(side.tackles_won) / 100)
              : null,
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
            offsides: null, throws: null,
            goal_kicks: null, free_kicks: null, tackles_certos: null,
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
    const keys = ['chutes','chutes_gol','desarmes','ftc','fts','amarelos','vermelhos','defesas','gols','assistencias','passes'];
    const labels = ['CHU','CHG','DES','FTC','FTS','🟨','🟥','DEF','⚽','ASS','PAS'];
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


// ── Compare odds, Best odds, Polymarket, Venue ──────────────
app.get('/api/jogos/:id/compare-odds', async (req, res) => {
  try {
    const data = await bsd(`/events/${req.params.id}/odds/comparison/`).catch(()=>null);
    const raw = data?.results || data?.bookmakers || [];
    const arr = Array.isArray(raw) ? raw
      : Object.entries(raw).map(([slug,mkts])=>({bookmaker:slug,...(mkts?.['1x2']||mkts||{})}));
    const bkms = arr.map(b=>({
      bookmaker: b.bookmaker_name||b.bookmaker||b.name||b.slug||'—',
      home_win: parseFloat(b.HOME||b.home_win||b.home||0)||null,
      draw:     parseFloat(b.DRAW||b.draw||0)||null,
      away_win: parseFloat(b.AWAY||b.away_win||b.away||0)||null,
    })).filter(b=>b.home_win||b.draw||b.away_win);
    res.json({ bookmakers: bkms });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/:id/best-odds', async (req, res) => {
  try {
    const [simple, comp] = await Promise.allSettled([
      bsd(`/events/${req.params.id}/odds/`),
      bsd(`/events/${req.params.id}/odds/comparison/`)
    ]);
    const o = simple.status==='fulfilled' ? simple.value?.odds||{} : {};
    let bestH={val:parseFloat(o.home_win)||0,book:''};
    let bestD={val:parseFloat(o.draw)||0,book:''};
    let bestA={val:parseFloat(o.away_win)||0,book:''};
    const arr = comp.status==='fulfilled' ? (comp.value?.results||comp.value?.bookmakers||[]) : [];
    (Array.isArray(arr)?arr:[]).forEach(b=>{
      const name=b.bookmaker_name||b.bookmaker||b.name||'—';
      const h=parseFloat(b.HOME||b.home_win||b.home||0);
      const d=parseFloat(b.DRAW||b.draw||0);
      const a=parseFloat(b.AWAY||b.away_win||b.away||0);
      if(h>bestH.val){bestH={val:h,book:name};}
      if(d>bestD.val){bestD={val:d,book:name};}
      if(a>bestA.val){bestA={val:a,book:name};}
    });
    res.json({ home_win:bestH, draw:bestD, away_win:bestA,
      over_25: o.over_25_goals||null, under_25: o.under_25_goals||null, btts_yes: o.btts_yes||null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/:id/polymarket', async (req, res) => {
  try {
    const data = await bsd(`/events/${req.params.id}/odds/polymarket/`)
      .catch(()=>bsd('/odds/polymarket/',{event_id:req.params.id}));
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/:id/venue', async (req, res) => {
  try {
    const ev = await bsd(`/events/${req.params.id}/`);
    const venueId = ev?.venue_id||ev?.venue?.id;
    if(!venueId) return res.json({ venue: null });
    const venue = await bsd(`/venues/${venueId}/`);
    res.json({ venue });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
let _bsdWs=null, _wsClients=new Set();
function _conectarBSDWs(){
  try{
    const {WebSocket}=require('ws');
    _bsdWs=new WebSocket(`wss://sports.bzzoiro.com/ws/live/?token=${BSD_TOKEN}`);
    _bsdWs.on('open',()=>console.log('[WS] BSD conectado'));
    _bsdWs.on('message',(data)=>{ _wsClients.forEach(c=>{if(c.readyState===1)c.send(data.toString());}); });
    _bsdWs.on('close',()=>setTimeout(_conectarBSDWs,10000));
    _bsdWs.on('error',(e)=>console.error('[WS]',e.message));
  }catch(e){ console.log('[WS] ws não disponível'); }
}

const server = app.listen(PORT, () => {
  console.log(`Scout Pro Backend v2 rodando na porta ${PORT}`);

  try{
    const {WebSocketServer}=require('ws');
    const wss=new WebSocketServer({server});
    wss.on('connection',(ws)=>{ _wsClients.add(ws); ws.on('close',()=>_wsClients.delete(ws)); });
    _conectarBSDWs();
    console.log('[WS] Servidor WebSocket ativo');
  }catch(e){ console.log('[WS] ws não instalado, usando polling'); }

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

// ─────────────────────────────────────────────
// MERCADO PAGO — Checkout Pro
// Token fica na variável de ambiente MP_ACCESS_TOKEN do Render
// ─────────────────────────────────────────────
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_API   = 'https://api.mercadopago.com';

const PLANOS_MP = {
  semanal: { titulo: 'ESA Semanal',  valor: 9,   dias: 7   },
  mensal:  { titulo: 'ESA Mensal',   valor: 20,  dias: 30  },
  anual:   { titulo: 'ESA Anual',    valor: 180, dias: 365 }
};

// Gera o link de checkout do Mercado Pago
app.post('/api/criar-pagamento', async (req, res) => {
  try {
    const { plano, uid, email } = req.body;
    if (!plano || !uid) return res.status(400).json({ error: 'plano e uid obrigatórios' });
    const p = PLANOS_MP[plano];
    if (!p) return res.status(400).json({ error: 'plano inválido' });

    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

    const preference = {
      items: [{
        title: p.titulo,
        quantity: 1,
        unit_price: p.valor,
        currency_id: 'BRL'
      }],
      payer: { email: email || '' },
      back_urls: {
        success: `${baseUrl}/?pagamento=sucesso&plano=${plano}&uid=${uid}`,
        failure: `${baseUrl}/?pagamento=falha`,
        pending: `${baseUrl}/?pagamento=pendente`
      },
      auto_return: 'approved',
      external_reference: `${uid}__${plano}`,
      notification_url: `${baseUrl}/api/webhook-mp`,
      statement_descriptor: 'ESA APP'
    };

    const r = await fetch(`${MP_API}/checkout/preferences`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MP_TOKEN}`
      },
      body: JSON.stringify(preference)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || JSON.stringify(data));

    // sandbox_init_point = ambiente de teste | init_point = produção real
    const url = data.sandbox_init_point || data.init_point;
    res.json({ url, preference_id: data.id });
  } catch(e) {
    console.error('[MP criar-pagamento]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Verifica pagamento após redirect do MP (frontend chama com payment_id da URL)
app.get('/api/verificar-pagamento', async (req, res) => {
  try {
    const { payment_id } = req.query;
    if (!payment_id) return res.status(400).json({ error: 'payment_id obrigatório' });

    const r = await fetch(`${MP_API}/v1/payments/${payment_id}`, {
      headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'Erro MP');

    const [uid, plano] = (data.external_reference || '').split('__');
    res.json({
      status:   data.status,
      aprovado: data.status === 'approved',
      plano:    plano || '',
      uid:      uid   || ''
    });
  } catch(e) {
    console.error('[MP verificar-pagamento]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Webhook do MP — recebe notificações de pagamento (server-side)
app.post('/api/webhook-mp', async (req, res) => {
  res.sendStatus(200); // Responde imediatamente ao MP (obrigatório)
  try {
    const { type, data } = req.body;
    if (type !== 'payment' || !data?.id) return;

    const r = await fetch(`${MP_API}/v1/payments/${data.id}`, {
      headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
    });
    const pag = await r.json();

    if (pag.status === 'approved') {
      console.log(`[MP webhook] Pagamento aprovado: ref=${pag.external_reference} valor=R$${pag.transaction_amount}`);
    } else {
      console.log(`[MP webhook] Status: ${pag.status} ref=${pag.external_reference}`);
    }
  } catch(e) {
    console.error('[MP webhook erro]', e.message);
  }
});

// ─────────────────────────────────────────────
// PÁGINAS LEGAIS — Termos de Uso e Privacidade
// ─────────────────────────────────────────────
const paginaLegalHTML = (titulo, corpo) => `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo} — ESA</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0f0a;color:#d0e8d0;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.7;padding:0}
  .topo{background:#0d1a0e;border-bottom:1px solid rgba(57,255,20,0.2);padding:18px 24px;display:flex;align-items:center;gap:14px}
  .topo-logo{font-size:22px;font-weight:900;color:#39ff14;letter-spacing:0.08em}
  .topo-sub{font-size:12px;color:#7eb090}
  .back{margin-left:auto;color:#39ff14;text-decoration:none;font-size:13px;border:1px solid rgba(57,255,20,0.3);padding:6px 14px;border-radius:8px}
  .container{max-width:720px;margin:0 auto;padding:36px 24px 64px}
  h1{font-size:22px;color:#39ff14;margin-bottom:6px;font-weight:700}
  .atualizado{font-size:12px;color:#7eb090;margin-bottom:32px}
  h2{font-size:15px;font-weight:700;color:#b0e0b0;margin:28px 0 8px;text-transform:uppercase;letter-spacing:0.06em}
  p{margin-bottom:10px;color:#c0dcc0}
  ul{margin:8px 0 12px 20px;color:#c0dcc0}
  li{margin-bottom:6px}
  a{color:#39ff14}
  .destaque{background:rgba(57,255,20,0.07);border:1px solid rgba(57,255,20,0.2);border-radius:10px;padding:14px 18px;margin:16px 0}
</style>
</head>
<body>
<div class="topo">
  <div>
    <div class="topo-logo">ESA</div>
    <div class="topo-sub">Esporte Scout Analytics</div>
  </div>
  <a class="back" href="/">← Voltar ao ESA</a>
</div>
<div class="container">
${corpo}
</div>
</body>
</html>`;

app.get('/termos', (req, res) => {
  const corpo = `
<h1>Termos de Uso</h1>
<div class="atualizado">Última atualização: julho de 2026</div>

<h2>1. Sobre o ESA</h2>
<p>O ESA (Esporte Scout Analytics) é uma plataforma digital de análise estatística de futebol voltada para apostadores esportivos, desenvolvida e operada por Bruno Ferreira Pires. O app oferece dados, predições e análises com fins informativos — não constitui aconselhamento financeiro.</p>

<h2>2. Aceitação dos Termos</h2>
<p>Ao criar uma conta ou utilizar o ESA, você concorda integralmente com estes Termos de Uso. Se não concordar, não utilize o serviço.</p>

<h2>3. Planos e Cobrança</h2>
<p>O ESA oferece os seguintes planos pagos, cobrados por período:</p>
<ul>
  <li><strong>Semanal:</strong> R$ 9,00 por semana (7 dias)</li>
  <li><strong>Mensal:</strong> R$ 20,00 por mês (30 dias)</li>
  <li><strong>Anual:</strong> R$ 180,00 por ano (365 dias)</li>
</ul>
<p>Todos os novos cadastros têm direito a <strong>7 dias gratuitos</strong> sem necessidade de cartão. Após o período trial, é necessário contratar um plano para continuar usando.</p>
<p>Os pagamentos são processados pelo Mercado Pago. Ao assinar, você autoriza a cobrança do valor correspondente ao plano escolhido.</p>

<h2>4. Cancelamento</h2>
<div class="destaque">
  <p>Você pode cancelar sua assinatura a qualquer momento, de duas formas:</p>
  <ul>
    <li><strong>Pelo app:</strong> acesse Configurações → Minha Assinatura → Cancelar plano</li>
    <li><strong>Por e-mail:</strong> envie sua solicitação para <a href="mailto:brunopires777@gmail.com">brunopires777@gmail.com</a></li>
  </ul>
  <p><strong>Importante:</strong> o cancelamento deve ser solicitado com pelo menos <strong>2 dias de antecedência</strong> antes da data de renovação para evitar a cobrança do próximo período. Após o cancelamento, o acesso permanece ativo até o fim do período já pago.</p>
</div>

<h2>5. Reembolsos</h2>
<p>Não oferecemos reembolso proporcional por períodos não utilizados. Em caso de cobrança indevida, entre em contato pelo e-mail <a href="mailto:brunopires777@gmail.com">brunopires777@gmail.com</a> em até 7 dias após a cobrança.</p>

<h2>6. Uso Permitido</h2>
<p>O acesso ao ESA é pessoal e intransferível. É proibido compartilhar sua conta, revender o acesso ou utilizar meios automatizados para extrair dados da plataforma.</p>

<h2>7. Isenção de Responsabilidade</h2>
<p>As análises e predições do ESA são baseadas em dados estatísticos e não garantem resultados em apostas. O uso das informações para fins de apostas é de total responsabilidade do usuário. Aposte com responsabilidade.</p>

<h2>8. Alterações</h2>
<p>Estes termos podem ser atualizados a qualquer momento. Usuários serão notificados por e-mail em caso de mudanças relevantes.</p>

<h2>9. Contato</h2>
<p>Dúvidas ou solicitações: <a href="mailto:brunopires777@gmail.com">brunopires777@gmail.com</a></p>
`;
  res.send(paginaLegalHTML('Termos de Uso', corpo));
});

app.get('/privacidade', (req, res) => {
  const corpo = `
<h1>Política de Privacidade</h1>
<div class="atualizado">Última atualização: julho de 2026</div>

<h2>1. Responsável pelos Dados</h2>
<p>Bruno Ferreira Pires é o responsável pelo tratamento dos dados pessoais coletados pelo ESA (Esporte Scout Analytics), em conformidade com a Lei Geral de Proteção de Dados (LGPD — Lei nº 13.709/2018).</p>

<h2>2. Dados Coletados</h2>
<p>Coletamos apenas os dados necessários para o funcionamento do serviço:</p>
<ul>
  <li><strong>Nome e e-mail:</strong> fornecidos no cadastro ou via login com Google</li>
  <li><strong>Foto de perfil:</strong> quando o acesso é feito via Google (opcional)</li>
  <li><strong>Dados de assinatura:</strong> plano ativo, data de início e vencimento</li>
  <li><strong>Dados de pagamento:</strong> processados diretamente pelo Mercado Pago — o ESA não armazena dados de cartão</li>
</ul>

<h2>3. Uso dos Dados</h2>
<p>Seus dados são utilizados exclusivamente para:</p>
<ul>
  <li>Autenticação e controle de acesso à plataforma</li>
  <li>Gerenciamento da sua assinatura e período de acesso</li>
  <li>Comunicações relacionadas ao serviço (confirmações, avisos de vencimento)</li>
</ul>
<p>Não vendemos, alugamos ou compartilhamos seus dados com terceiros para fins comerciais.</p>

<h2>4. Armazenamento</h2>
<p>Os dados são armazenados com segurança no Firebase (Google Cloud), com acesso restrito exclusivamente ao seu próprio usuário por meio de regras de segurança.</p>

<h2>5. Seus Direitos (LGPD)</h2>
<div class="destaque">
<p>Você tem direito a:</p>
<ul>
  <li>Confirmar a existência de tratamento dos seus dados</li>
  <li>Acessar seus dados a qualquer momento</li>
  <li>Solicitar correção de dados incorretos</li>
  <li>Solicitar exclusão dos seus dados da plataforma</li>
  <li>Revogar o consentimento a qualquer momento</li>
</ul>
<p>Para exercer qualquer um desses direitos, entre em contato: <a href="mailto:brunopires777@gmail.com">brunopires777@gmail.com</a></p>
</div>

<h2>6. Cookies e Armazenamento Local</h2>
<p>O ESA utiliza o <em>localStorage</em> do navegador apenas para salvar preferências locais (como tema de cor escolhido). Nenhum dado pessoal é armazenado localmente.</p>

<h2>7. Segurança</h2>
<p>Adotamos medidas técnicas para proteger seus dados, incluindo autenticação segura via Firebase Auth e regras de acesso no Firestore. Em caso de incidente de segurança, notificaremos os usuários afetados.</p>

<h2>8. Contato</h2>
<p>Dúvidas sobre privacidade ou solicitações relacionadas aos seus dados:<br>
<a href="mailto:brunopires777@gmail.com">brunopires777@gmail.com</a></p>
`;
  res.send(paginaLegalHTML('Política de Privacidade', corpo));
});

// ─────────────────────────────────────────────
// PERFIL COMPLETO DO JOGADOR v2
// ─────────────────────────────────────────────
app.get('/api/v2/players/:id/perfil', async (req, res) => {
  try {
    const { id } = req.params;
    const [detalhe, carreira, selecao, social] = await Promise.allSettled([
      bsd(`/players/${id}/`),
      bsd(`/players/${id}/career/`),
      bsd(`/players/${id}/national-team/`),
      bsd(`/players/${id}/social/`, { limit: 10 })
    ]);
    const d = detalhe.status === 'fulfilled' ? detalhe.value : {};
    res.json({
      id: d.id,
      nome: d.name || d.display_name,
      nome_curto: d.short_name,
      posicao: d.position,
      posicao_especifica: d.specific_position,
      numero: d.jersey_number,
      nascimento: d.date_of_birth,
      altura: d.height_cm,
      peso: d.weight_kg,
      pe: d.preferred_foot,
      nacionalidade: d.nationality,
      foto: d.photo || d.image || `https://sports.bzzoiro.com/img/player/${id}/`,
      time_id: d.current_team_id,
      selecao_id: d.national_team_id,
      valor_mercado: d.market_value_eur,
      contrato_ate: d.contract_until,
      disponibilidade: d.availability,
      atributos: d.attributes || null,
      forcas: d.strengths || [],
      fraquezas: d.weaknesses || [],
      rating: d.rating,
      potencial: d.potential,
      risco_lesao: d.injury_risk,
      salario_anual: d.wage_eur_annual,
      carreira: carreira.status === 'fulfilled' ? carreira.value : null,
      selecao: selecao.status === 'fulfilled' ? selecao.value : null,
      social: social.status === 'fulfilled' ? (social.value?.results || social.value || []) : []
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// SOCIAL + VÍDEOS DO TIME v2
// ─────────────────────────────────────────────
app.get('/api/v2/social/time/:id', async (req, res) => {
  try {
    const data = await bsd(`/teams/${req.params.id}/social/`, { limit: 20 });
    const items = Array.isArray(data) ? data : (data?.results || []);
    res.json({ results: items });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
