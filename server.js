const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const BSD_TOKEN = process.env.BSD_TOKEN || 'dddbf69d96a0efa0ffeb9f8d0c791528b61d1c1d';
const BASE_URL = 'https://sports.bzzoiro.com/api/v2';

app.use(cors());
app.use(express.json());

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
// JOGOS — hoje, amanhã, semana, ao vivo
// ─────────────────────────────────────────────
app.get('/api/jogos/hoje', async (req, res) => {
  try {
    const { league_id } = req.query;
    const t = today();
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${t}&date_to=${t}&tz=America/Sao_Paulo&limit=200${league_id ? `&league=${league_id}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/amanha', async (req, res) => {
  try {
    const { league_id } = req.query;
    const t = dayOffset(1);
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${t}&date_to=${t}&tz=America/Sao_Paulo&limit=200${league_id ? `&league=${league_id}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/semana', async (req, res) => {
  try {
    const { league_id } = req.query;
    const url = `https://sports.bzzoiro.com/api/events/?date_from=${today()}&date_to=${dayOffset(7)}&tz=America/Sao_Paulo&limit=200${league_id ? `&league=${league_id}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jogos/ao-vivo', async (req, res) => {
  try {
    const { league_id } = req.query;
    const url = `https://sports.bzzoiro.com/api/live/?tz=America/Sao_Paulo${league_id ? `&league=${league_id}` : ''}`;
    const data = await fetch(url, { headers: { Authorization: `Token ${BSD_TOKEN}` } }).then(r => r.json());
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Detalhes completos de um jogo
app.get('/api/jogos/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [evento, stats, incidents, odds, lineups, playerStats, predicao] = await Promise.allSettled([
      bsd(`/events/${id}/`),
      bsd(`/events/${id}/stats/`),
      bsd(`/events/${id}/incidents/`),
      bsd(`/events/${id}/odds/`),
      bsd(`/events/${id}/lineups/`),
      bsd(`/events/${id}/player-stats/`),
      bsd(`/events/${id}/prediction/`)
    ]);

    res.json({
      evento: evento.status === 'fulfilled' ? evento.value : null,
      stats: stats.status === 'fulfilled' ? stats.value : null,
      incidents: incidents.status === 'fulfilled' ? incidents.value : null,
      odds: odds.status === 'fulfilled' ? odds.value : null,
      lineups: lineups.status === 'fulfilled' ? lineups.value : null,
      playerStats: playerStats.status === 'fulfilled' ? playerStats.value : null,
      predicao: predicao.status === 'fulfilled' ? predicao.value : null
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
// VALUE BETS — melhores odds do mercado
// ─────────────────────────────────────────────
app.get('/api/value-bets', async (req, res) => {
  try {
    const { market = '1x2', league_id } = req.query;
    // BSD: value bets vêm do endpoint /api/predictions/ — filtra por confidence alta
    // e monta cards com odds embutidos nos eventos
    const qs = new URLSearchParams({
      date_from: today(), date_to: dayOffset(7),
      limit: 100, tz: 'America/Sao_Paulo'
    });
    if (league_id) qs.set('league', league_id);
    const data = await fetch(`https://sports.bzzoiro.com/api/predictions/?${qs}`, {
      headers: { Authorization: `Token ${BSD_TOKEN}` }
    }).then(r => r.json());

    // Transforma predições em value bets (confiança >= 60%)
    const results = (data.results || [])
      .filter(p => {
        const m = p.markets || p.predictions || {};
        const res = m.match_result || {};
        return Math.max(res.prob_home||0, res.prob_draw||0, res.prob_away||0) >= 60;
      })
      .map(p => {
        const ev = p.event || {};
        const m  = p.markets || p.predictions || {};
        const mr = m.match_result || {};
        const maxProb = Math.max(mr.prob_home||0, mr.prob_draw||0, mr.prob_away||0);
        const favOutcome = mr.prob_home >= mr.prob_away && mr.prob_home >= mr.prob_draw ? 'Casa'
          : mr.prob_away >= mr.prob_home && mr.prob_away >= mr.prob_draw ? 'Fora' : 'Empate';
        const oddsMap = { 'Casa': ev.odds_home, 'Fora': ev.odds_away, 'Empate': ev.odds_draw };
        return {
          home_team:  ev.home_team || '—',
          away_team:  ev.away_team || '—',
          league_id:  ev.league?.id,
          event_date: ev.event_date,
          confidence: Math.round(maxProb),
          market,
          best_odds: [{
            outcome_name:  favOutcome,
            decimal_odds:  oddsMap[favOutcome] || null,
            bookmaker_name:'Consenso',
            edge_pct: null
          }]
        };
      });
    res.json({ results });
  } catch (e) {
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

// Busca times — BSD tem GET /api/teams/ com paginação
// Filtra por nome localmente já que não há parâmetro de busca por nome
app.get('/api/teams', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Parâmetro q obrigatório' });

    const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
    const term = norm(q);
    const seen = new Map();

    // Busca todas as páginas de /api/teams/ até achar ou acabar
    // BSD tem ~500 times, 100 por página = ~5 páginas
    let totalPages = 0;
    for (let page = 1; page <= 10; page++) {
      const data = await fetch(`https://sports.bzzoiro.com/api/teams/?page=${page}&limit=100`, {
        headers: { Authorization: `Token ${BSD_TOKEN}` }
      }).then(r => r.json());
      const items = data.results || [];
      totalPages++;
      items.forEach(t => {
        if (norm(t.name).includes(term) && !seen.has(t.id)) {
          seen.set(t.id, { id: t.id, name: t.name, country: t.country || '' });
        }
      });
      if (!data.next) break; // acabou as páginas
      if (seen.size >= 15) break; // já achou suficiente
    }
    console.log(`TEAMS search "${q}": varreu ${totalPages} páginas, achou ${seen.size}`);

    // Fallback: busca nos eventos recentes se não achou nada
    if (seen.size === 0) {
      const evData = await fetch(
        `https://sports.bzzoiro.com/api/events/?date_from=${
          new Date(Date.now()-60*86400000).toISOString().slice(0,10)
        }&date_to=${
          new Date(Date.now()+7*86400000).toISOString().slice(0,10)
        }&limit=200`,
        { headers: { Authorization: `Token ${BSD_TOKEN}` } }
      ).then(r => r.json());
      (evData.results || []).forEach(ev => {
        if (norm(ev.home_team).includes(term) && ev.home_team_id && !seen.has(ev.home_team_id))
          seen.set(ev.home_team_id, { id: ev.home_team_id, name: ev.home_team, country: '' });
        if (norm(ev.away_team).includes(term) && ev.away_team_id && !seen.has(ev.away_team_id))
          seen.set(ev.away_team_id, { id: ev.away_team_id, name: ev.away_team, country: '' });
      });
    }

    console.log(`Teams search "${q}": ${seen.size} encontrados`);
    res.json({ teams: Array.from(seen.values()).slice(0, 15) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/teams-all', async (req, res) => res.json({ results: [], next: null }));

// Elenco do time → /api/squad/:id
app.get('/api/squad/:id', async (req, res) => {
  try {
    const id = req.params.id;
    let raw = [];

    // Tentativa 1: /api/teams/{id}/squad/
    try {
      const resp = await fetch(`https://sports.bzzoiro.com/api/teams/${id}/squad/`, {
        headers: { Authorization: `Token ${BSD_TOKEN}` }
      });
      const data = await resp.json();
      console.log(`SQUAD /teams/${id}/squad/ status=${resp.status} keys=${Object.keys(data)}`);
      raw = data.results || data.players || data.squad || [];
    } catch(e) { console.log('SQUAD t1 error:', e.message); }

    // Tentativa 2: /api/players/?team={id}
    if (!raw.length) {
      try {
        const resp2 = await fetch(`https://sports.bzzoiro.com/api/players/?team=${id}&limit=100`, {
          headers: { Authorization: `Token ${BSD_TOKEN}` }
        });
        const data2 = await resp2.json();
        console.log(`SQUAD /players/?team=${id} status=${resp2.status} count=${data2.count}`);
        console.log('SQUAD player sample:', JSON.stringify((data2.results||[])[0]).slice(0,300));
        raw = data2.results || [];
      } catch(e) { console.log('SQUAD t2 error:', e.message); }
    }

    // Tentativa 3: /api/players/?current_team={id}
    if (!raw.length) {
      try {
        const resp3 = await fetch(`https://sports.bzzoiro.com/api/players/?current_team=${id}&limit=100`, {
          headers: { Authorization: `Token ${BSD_TOKEN}` }
        });
        const data3 = await resp3.json();
        console.log(`SQUAD /players/?current_team=${id} status=${resp3.status} count=${data3.count}`);
        raw = data3.results || [];
      } catch(e) { console.log('SQUAD t3 error:', e.message); }
    }

    console.log(`SQUAD final: ${raw.length} jogadores para time ${id}`);

    const players = raw.map(p => ({
      id: p.id,
      name: p.name || p.display_name || p.full_name || '—',
      position: p.position || p.role || '—',
      photo: `https://scoutpro-backend-9q23.onrender.com/img/player/${p.id}`,
      jersey_number: p.jersey_number || ''
    }));

    res.json({ players });
  } catch (e) {
    console.log('SQUAD fatal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Stats do jogador → /api/player/:id/stats?teamId=X  (formato que o scout original usa)
app.get('/api/player/:id/stats', async (req, res) => {
  try {
    const { teamId } = req.query;
    const playerId = req.params.id;

    // Busca o season_id atual via /api/player-stats/ filtrado por jogador
    // A BSD v1 usa /api/player-stats/?player=ID&season=ID
    // Primeiro buscamos as ligas para pegar os current_season ids
    let seasonIds = [];
    try {
      const ligas = await fetch(`https://sports.bzzoiro.com/api/leagues/`, {
        headers: { Authorization: `Token ${BSD_TOKEN}` }
      }).then(r => r.json());
      seasonIds = (ligas.results || [])
        .map(l => l.current_season?.id)
        .filter(Boolean);
    } catch (_) {}

    // Tenta buscar stats com o season mais recente (tenta os primeiros 3)
    let raw = [];
    const seasonsToTry = seasonIds.slice(0, 5);

    for (const sid of seasonsToTry) {
      try {
        const url = `https://sports.bzzoiro.com/api/player-stats/?player=${playerId}&season=${sid}&limit=20`;
        const data = await fetch(url, {
          headers: { Authorization: `Token ${BSD_TOKEN}` }
        }).then(r => r.json());
        const items = data.results || [];
        if (items.length > 0) { raw = items; break; }
      } catch (_) {}
    }

    // Se não achou em nenhuma season, tenta sem filtro de season mas com date_from
    if (!raw.length) {
      try {
        const anoAtual = new Date().getFullYear();
        const url = `https://sports.bzzoiro.com/api/player-stats/?player=${playerId}&date_from=${anoAtual - 1}-07-01&limit=15&tz=America/Sao_Paulo`;
        const data = await fetch(url, {
          headers: { Authorization: `Token ${BSD_TOKEN}` }
        }).then(r => r.json());
        raw = data.results || [];
      } catch (_) {}
    }

    // Ordena por data mais recente
    raw.sort((a, b) => new Date(b.event?.event_date || 0) - new Date(a.event?.event_date || 0));

    // DEBUG: loga o primeiro item para ver a estrutura real da BSD
    if (raw.length > 0) {
      console.log('BSD player-stats sample keys:', Object.keys(raw[0]));
      console.log('BSD player-stats sample:', JSON.stringify(raw[0]).slice(0, 800));
    }

    // Mapeia para o formato que o frontend scout espera
    const jogos = raw.slice(0, 7).map(g => {
      const ev = g.event || {};

      // Descobre se o jogador jogou em casa ou fora
      // BSD pode retornar: g.team_id, g.player?.team_id, g.is_home, g.side
      const playerTeamId = g.team_id || g.player?.team_id || g.player?.current_team_id;
      const isHome = g.is_home !== undefined
        ? g.is_home
        : (playerTeamId && ev.home_team_id)
          ? String(playerTeamId) === String(ev.home_team_id)
          : null;

      // Se isHome for null (não conseguimos determinar), usa o time que NÃO é o do jogador
      let opponent, myScore, oppScore;
      if (isHome === true) {
        opponent = ev.away_team;
        myScore  = ev.home_score;
        oppScore = ev.away_score;
      } else if (isHome === false) {
        opponent = ev.home_team;
        myScore  = ev.away_score;
        oppScore = ev.home_score;
      } else {
        // fallback: pega o time que aparece diferente do time buscado
        const teamId = String(playerTeamId || '');
        if (teamId && String(ev.home_team_id) === teamId) {
          opponent = ev.away_team;
          myScore  = ev.home_score;
          oppScore = ev.away_score;
        } else {
          opponent = ev.home_team;
          myScore  = ev.away_score;
          oppScore = ev.home_score;
        }
      }

      let result = '—';
      if (myScore != null && oppScore != null) {
        result = myScore > oppScore ? 'W' : myScore < oppScore ? 'L' : 'D';
      }

      const score = (ev.home_score != null && ev.away_score != null)
        ? `${ev.home_score}-${ev.away_score}` : '—';

      const data_jogo = ev.event_date
        ? new Date(ev.event_date).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', timeZone:'America/Sao_Paulo' })
        : '—';

      // Campos BSD v1 — tenta todos os nomes possíveis
      return {
        opponent:   opponent || '—',
        score,
        result,
        comp:       ev.league?.name || ev.league_name || g.competition || '—',
        data:       data_jogo,
        chutes:     g.total_shots     ?? g.shots         ?? null,
        chutes_gol: g.shots_on_target ?? g.shots_on_goal  ?? null,
        desarmes:   g.tackles         ?? g.tackles_won    ?? g.duels_won ?? null,
        ftc:        g.fouls_committed ?? g.fouls          ?? null,
        fts:        g.fouls_drawn     ?? g.was_fouled     ?? null,
        amarelos:   g.yellow_cards    ?? g.yellow         ?? null,
        vermelhos:  g.red_cards       ?? g.red            ?? null,
        defesas:    g.saves           ?? g.goalkeeper_saves ?? null,
      };
    });

    res.json({ jogos, fromCache: false });
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
app.get('/img/player/:id', async (req, res) => {
  try {
    const r = await fetch(`https://sports.bzzoiro.com/img/player/${req.params.id}/`);
    res.set('Content-Type', r.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    r.body.pipe(res);
  } catch {
    res.status(404).end();
  }
});

app.get('/img/team/:id', async (req, res) => {
  try {
    const r = await fetch(`https://sports.bzzoiro.com/img/team/${req.params.id}/`);
    res.set('Content-Type', r.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    r.body.pipe(res);
  } catch {
    res.status(404).end();
  }
});

app.get('/img/league/:id', async (req, res) => {
  try {
    const r = await fetch(`https://sports.bzzoiro.com/img/league/${req.params.id}/`);
    res.set('Content-Type', r.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    r.body.pipe(res);
  } catch {
    res.status(404).end();
  }
});

app.get('/img/manager/:id', async (req, res) => {
  try {
    const r = await fetch(`https://sports.bzzoiro.com/img/manager/${req.params.id}/`);
    res.set('Content-Type', r.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    r.body.pipe(res);
  } catch {
    res.status(404).end();
  }
});

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
