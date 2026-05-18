const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const BSD_KEY  = 'dddbf69d96a0efa0ffeb9f8d0c791528b61d1c1d';
const BSD_BASE = 'https://sports.bzzoiro.com/api/v2';
const HEADERS  = { 'Authorization': `Token ${BSD_KEY}` };

// ── CACHE ────────────────────────────────────────
const cache = new Map();
function cacheGet(k){ const i=cache.get(k); if(!i||Date.now()>i.exp){cache.delete(k);return null;} return i.data; }
function cacheSet(k,d,ttl){ cache.set(k,{data:d,exp:Date.now()+ttl}); }

async function bsd(path){
  const url = `${BSD_BASE}${path}`;
  console.log('[BSD GET]', url);
  const r = await fetch(url, {headers: HEADERS});
  const text = await r.text();
  console.log(`[BSD ${r.status}]`, text.substring(0, 400));
  try{ return {ok: r.ok, status: r.status, data: JSON.parse(text)}; }
  catch(e){ return {ok: false, status: r.status, data: {error: text.substring(0,200)}}; }
}

app.get('/', (req,res) => res.json({status:'Scout Pro v12.0 - BSD API ok', time: new Date().toISOString()}));
app.get('/api/clear-cache', (req,res) => { cache.clear(); res.json({ok:true, msg:'Cache limpo'}); });

// ── BUSCAR TIME ──────────────────────────────────
// Usa busca dinâmica da BSD pelo nome
app.get('/api/teams', async(req,res) => {
  const {q, nocache} = req.query;
  if(!q) return res.status(400).json({error:'Nome obrigatorio'});
  const ck = `teams_${q.toLowerCase().trim()}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }

  try{
    const {ok, data} = await bsd(`/teams/?name=${encodeURIComponent(q)}&limit=10`);
    if(!ok) return res.status(500).json({error: data?.detail || data?.error || `Erro ${ok}`});

    const teams = (data.results||[]).map(t=>({
      id:      t.id,
      name:    t.name,
      short:   t.short_name || t.name,
      country: t.country || '',
      logo:    `https://sports.bzzoiro.com/img/team/${t.id}/`
    }));

    console.log(`Times encontrados para "${q}":`, teams.map(t=>`${t.name}(${t.id})`));
    if(teams.length) cacheSet(ck,{teams},3600000);
    res.json({teams});
  }catch(e){
    console.error('Teams error:', e.message);
    res.status(500).json({error: e.message});
  }
});

// ── ELENCO DO TIME ───────────────────────────────
app.get('/api/squad/:teamId', async(req,res) => {
  const {teamId} = req.params;
  const {nocache} = req.query;
  const ck = `squad_${teamId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }

  try{
    const {ok, data} = await bsd(`/teams/${teamId}/squad/`);
    if(!ok) return res.status(500).json({error: data?.detail || 'Elenco não encontrado'});

    const players = (data.players||[]).map(p=>({
      id:       p.id,
      name:     p.name || p.short_name || '—',
      position: p.position || 'Unknown',
      photo:    `https://sports.bzzoiro.com/img/player/${p.id}/`
    }));

    console.log(`Elenco time ${teamId}: ${players.length} jogadores`);
    if(players.length) cacheSet(ck,{players},86400000);
    res.json({players});
  }catch(e){
    console.error('Squad error:', e.message);
    res.status(500).json({error: e.message});
  }
});

// ── STATS DO JOGADOR ─────────────────────────────
app.get('/api/player/:playerId/stats', async(req,res) => {
  const {playerId} = req.params;
  const {teamId, nocache} = req.query;
  const ck = `stats_${playerId}_${teamId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }

  try{
    // Buscar últimos jogos do time finalizados no ano atual e anterior
    const anoAtual = new Date().getFullYear();
    const dataInicio = `${anoAtual-1}-01-01T00:00:00Z`;
    const dataFim    = `${anoAtual}-12-31T23:59:59Z`;

    const {ok:fe, data:fixData} = await bsd(
      `/teams/${teamId}/fixtures/?status=finished&date_from=${dataInicio}&date_to=${dataFim}&limit=20`
    );

    if(!fe) return res.status(500).json({error: fixData?.detail||'Jogos não encontrados'});

    // Ordenar por data decrescente e pegar os 5 mais recentes
    const allFix = fixData.results || [];
    const fixtures = allFix
      .sort((a,b) => new Date(b.event_date||b.date) - new Date(a.event_date||a.date))
      .slice(0,5);

    console.log(`Jogos do time ${teamId}: ${allFix.length} totais, ${fixtures.length} selecionados`);

    if(!fixtures.length) return res.status(404).json({
      error:'Nenhum jogo encontrado para este time',
      debug:{total: allFix.length}
    });

    const jogos = [];
    for(const fix of fixtures){
      const eventId  = fix.id;
      const isHome   = fix.home_team_id === parseInt(teamId);
      const opponent = isHome ? fix.away_team : fix.home_team;
      const hg       = fix.home_score ?? 0;
      const ag       = fix.away_score ?? 0;
      const mg       = isHome ? hg : ag;
      const og       = isHome ? ag : hg;
      const score    = `${mg}-${og}`;
      const result   = mg>og?'W':mg<og?'L':'D';
      const d        = new Date(fix.event_date || fix.date || 0);
      const date     = `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
      const comp     = fix.league_name || '—';

      let stats = {chutes:null, chutes_gol:null, desarmes:null, ftc:null, fts:null, amarelos:null, vermelhos:null, defesas:null};

      try{
        const {ok:ps, data:psData} = await bsd(`/events/${eventId}/player-stats/`);
        if(ps && psData.player_stats){
          const found = psData.player_stats.find(p => p.player_id === parseInt(playerId));
          if(found){
            console.log(`Stats found for player ${playerId} in event ${eventId}:`, JSON.stringify(found).substring(0,300));
            stats = {
              chutes:     found.total_shots     ?? null,
              chutes_gol: found.shots_on_target ?? null,
              desarmes:   found.total_tackle    ?? null,
              ftc:        found.fouls_committed ?? null,
              fts:        found.fouls_drawn     ?? null,
              amarelos:   found.yellow_card     ?? null,
              vermelhos:  found.red_card        ?? null,
              defesas:    found.saves           ?? null,
            };
          } else {
            console.log(`Player ${playerId} NOT found in event ${eventId}. Available IDs:`, psData.player_stats.slice(0,5).map(p=>p.player_id));
          }
        }
      }catch(e){
        console.log(`Per-match stats error event ${eventId}:`, e.message);
      }

      jogos.push({date, opponent: opponent||'—', score, result, comp, ...stats});
    }

    const result = {jogos};
    cacheSet(ck, result, 43200000);
    res.json(result);
  }catch(e){
    console.error('Stats error:', e.message);
    res.status(500).json({error: e.message});
  }
});

// ── DEBUG: ver campos do jogador ─────────────────
app.get('/api/debug/player-stats/:eventId', async(req,res) => {
  const {eventId} = req.params;
  const {playerId} = req.query;
  try{
    const {ok, data} = await bsd(`/events/${eventId}/player-stats/`);
    if(!ok) return res.status(500).json({error: data});
    const found = playerId
      ? data.player_stats?.find(p=>p.player_id===parseInt(playerId))
      : data.player_stats?.[0];
    res.json({found, sample_ids: data.player_stats?.slice(0,5).map(p=>({id:p.player_id,name:p.player_name}))});
  }catch(e){ res.status(500).json({error:e.message}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scout Pro v12.0 porta ${PORT}`));
