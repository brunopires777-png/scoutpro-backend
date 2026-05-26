const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');
const fs   = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BSD_TOKEN = process.env.BSD_TOKEN || 'dddbf69d96a0efa0ffeb9f8d0c791528b61d1c1d';
const BASE_URL = 'https://sports.bzzoiro.com/api/v2';

app.use(cors());
app.use(express.json());

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
function today() {
  return new Date().toISOString().slice(0, 10);
}
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
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

// ─────────────────────────────────────────────
// HELPER: normaliza um evento BSD para o formato
// que o frontend espera (garante home_team_id etc.)
// ─────────────────────────────────────────────
function normEvento(ev) {
  if (!ev) return ev;
  return {
    ...ev,
    // BSD v1 usa home_team_id; live usa home_id — normaliza tudo
    home_team_id: ev.home_team_id || ev.home_id    || ev.home_team?.id    || null,
    away_team_id: ev.away_team_id || ev.away_id    || ev.away_team?.id    || null,
    home_team:    ev.home_team    || ev.home_name  || ev.home_team?.name  || '—',
    away_team:    ev.away_team    || ev.away_name  || ev.away_team?.name  || '—',
    league_name:  ev.league_name  || ev.league?.name || '—',
    league_id:    ev.league_id    || ev.league?.id   || null,
    status:       ev.status       || (ev.is_live ? 'inprogress' : 'ns'),
  };
}

// ─────────────────────────────────────────────
// JOGOS — hoje, amanhã, semana, ao vivo
// ─────────────────────────────────────────────
app.get('/api/jogos/hoje', async (req, res) => {
  try {
    const { league_id } = req.query;
    const t = today();
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
    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
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
      if (norm(ev.home_team).includes(term) && ev.home_team_id && !seen.has(ev.home_team_id))
        seen.set(ev.home_team_id, { id: ev.home_team_id, name: ev.home_team, country: ev.league?.country||'' });
      if (norm(ev.away_team).includes(term) && ev.away_team_id && !seen.has(ev.away_team_id))
        seen.set(ev.away_team_id, { id: ev.away_team_id, name: ev.away_team, country: ev.league?.country||'' });
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

// Elenco do time → /api/squad/:id
// BSD não tem squad para times brasileiros — monta elenco via player-stats dos jogos recentes
app.get('/api/squad/:id', async (req, res) => {
  try {
    const teamId = String(req.params.id);
    let players = [];

    // Tenta /api/players/?team=ID (funciona para times europeus)
    try {
      const r = await fetch(`https://sports.bzzoiro.com/api/players/?team=${teamId}&limit=100`, {
        headers: { Authorization: `Token ${BSD_TOKEN}` }
      }).then(r => r.json());
      if ((r.results||[]).length > 0) {
        players = r.results.map(p => ({
          id: p.id,
          name: p.name||'—',
          position: p.position||'—',
          jersey_number: p.jersey_number||'',
          photo: `https://sports.bzzoiro.com/img/player/${p.id}/`
        }));
        console.log(`SQUAD via players: ${players.length} jogadores`);
      }
    } catch(_) {}

    // Fallback: monta elenco via player-stats dos últimos jogos do time
    if (!players.length) {
      const dateFrom = new Date(Date.now()-90*86400000).toISOString().slice(0,10);
      const dateTo   = new Date().toISOString().slice(0,10);

      // Busca eventos do time
      const evData = await fetch(
        `https://sports.bzzoiro.com/api/events/?date_from=${dateFrom}&date_to=${dateTo}&limit=50`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }
      ).then(r => r.json());

      // Filtra eventos do time
      const teamEvents = (evData.results||[]).filter(ev =>
        String(ev.home_team_id) === teamId || String(ev.away_team_id) === teamId
      ).slice(0, 5); // últimos 5 jogos

      console.log(`SQUAD via events: ${teamEvents.length} jogos encontrados para time ${teamId}`);

      const playersSeen = new Map();
      for (const ev of teamEvents) {
        try {
          const psData = await fetch(`https://sports.bzzoiro.com/api/player-stats/?event=${ev.id}&limit=50`, {
            headers: { Authorization: `Token ${BSD_TOKEN}` }
          }).then(r => r.json());
          console.log(`SQUAD event ${ev.id} player-stats:`, JSON.stringify(psData).slice(0,300));
          for (const ps of (psData.results||[])) {
            const pid = ps.player?.id || ps.player_id;
            const ptid = ps.team_id || ps.player?.team_id || ps.player?.current_team_id;
            if (pid && !playersSeen.has(pid) && String(ptid) === teamId) {
              playersSeen.set(pid, {
                id: pid,
                name: ps.player?.name || ps.player?.display_name || '—',
                position: ps.player?.position || '—',
                jersey_number: ps.player?.jersey_number || '',
                photo: `https://sports.bzzoiro.com/img/player/${pid}/`
              });
            }
          }
        } catch(_) {}
      }
      players = Array.from(playersSeen.values());
      console.log(`SQUAD final via player-stats: ${players.length} jogadores`);
    }

    res.json({ players });
  } catch (e) {
    console.log('SQUAD error:', e.message);
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

    res.json({
      detail, jogos,
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

    // ESTRATÉGIA: buscar próximos eventos → extrair referee_id únicos
    // → buscar dados de cada árbitro em /referees/{id}/
    // Isso garante que o filtro por liga funciona corretamente
    const evParams = {
      date_from: today(),
      date_to: dayOffset(7),
      limit: 200,
      tz: 'America/Sao_Paulo'
    };
    if (league_id) evParams.league = league_id;

    const evData = await bsd('/events/', evParams);
    const eventos = evData.results || [];

    // Mapa: referee_id → jogos do próximos 7 dias
    const refMap = new Map();
    for (const ev of eventos) {
      const rId   = ev.referee_id   || null;
      const rNome = ev.referee      || ev.referee_name || null;
      if (!rId && !rNome) continue;
      const key = rId ?? rNome;
      if (!refMap.has(key)) refMap.set(key, { id: rId, name: rNome, jogos: [] });
      refMap.get(key).jogos.push({
        id:          ev.id,
        home_team:   ev.home_team,
        away_team:   ev.away_team,
        event_date:  ev.event_date,
        league_name: ev.league?.name || ev.league_name || '—',
        league_id:   ev.league?.id   || ev.league_id   || null
      });
    }

    // Busca dados agregados de cada árbitro identificado
    // (usa /referees/{id}/ se tiver id, senão usa /referees/?name=)
    const arbitros = [];
    for (const entry of refMap.values()) {
      let detail = null;
      try {
        if (entry.id) {
          detail = await bsd(`/referees/${entry.id}/`);
        } else if (entry.name) {
          const r = await bsd('/referees/', { name: entry.name, limit: 1 });
          detail = (r.results || [])[0] || null;
        }
      } catch (_) {}

      // Filtro por nome (busca local)
      const nomeFiltro = (name || '').toLowerCase();
      const nomeArb = (detail?.name || entry.name || '').toLowerCase();
      if (nomeFiltro && !nomeArb.includes(nomeFiltro)) continue;

      arbitros.push({
        id:          detail?.id   || entry.id   || null,
        name:        detail?.name || entry.name || '—',
        country:     detail?.country || detail?.nationality_a3 || '—',
        matches:     detail?.matches || 0,
        avg_yellow:  detail?.avg_yellow_per_match || null,
        avg_red:     detail?.avg_red_per_match    || null,
        avg_fouls:   detail?.avg_fouls_per_match  || null,
        jogos:       entry.jogos
      });
    }

    // Ordena por nome
    arbitros.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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
    const { team_id, position, name, nationality_code, limit = 50 } = req.query;
    const data = await bsd('/players/', { team_id, position, name, nationality_code, limit });
    res.json(data);
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
