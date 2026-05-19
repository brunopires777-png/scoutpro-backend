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
  console.log('[BSD]', url);
  const r = await fetch(url, {headers: HEADERS});
  const text = await r.text();
  console.log(`[${r.status}]`, text.substring(0,500));
  try{ return {ok:r.ok, status:r.status, data:JSON.parse(text)}; }
  catch(e){ return {ok:false, status:r.status, data:{error:text.substring(0,200)}}; }
}

app.get('/', (req,res) => res.json({status:'Scout Pro v13.0 ok', time:new Date().toISOString()}));
app.get('/api/clear-cache', (req,res) => { cache.clear(); res.json({ok:true}); });

// ── BUSCAR TIME ──────────────────────────────────
app.get('/api/teams', async(req,res) => {
  const {q, nocache} = req.query;
  if(!q) return res.status(400).json({error:'Nome obrigatorio'});
  const ck = `teams_${q.toLowerCase().trim()}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const {ok, data} = await bsd(`/teams/?name=${encodeURIComponent(q)}&limit=8`);
    if(!ok) return res.status(500).json({error: data.detail||data.error||'Erro na busca'});
    const teams = (data.results||[]).map(t=>({
      id:      t.id,
      name:    t.name,
      short:   t.short_name||t.name,
      country: t.country||'',
      logo:    `https://sports.bzzoiro.com/img/team/${t.id}/`
    }));
    console.log(`Times para "${q}":`, teams.map(t=>`${t.name}(${t.id})`).join(', '));
    if(teams.length) cacheSet(ck,{teams},3600000);
    res.json({teams});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── ELENCO DO TIME ───────────────────────────────
app.get('/api/squad/:teamId', async(req,res) => {
  const {teamId} = req.params;
  const {nocache} = req.query;
  const ck = `squad_${teamId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const {ok, data} = await bsd(`/teams/${teamId}/squad/`);
    if(!ok) return res.status(500).json({error: data.detail||'Elenco não encontrado'});
    const players = (data.players||[]).map(p=>({
      id:       p.id,
      name:     p.name||p.short_name||'—',
      position: mapPos(p.position),
      photo:    `https://sports.bzzoiro.com/img/player/${p.id}/`
    }));
    console.log(`Elenco ${teamId}: ${players.length} jogadores`);
    if(players.length) cacheSet(ck,{players},86400000);
    res.json({players});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── STATS DO JOGADOR ─────────────────────────────
app.get('/api/player/:playerId/stats', async(req,res) => {
  const {playerId} = req.params;
  const {teamId, nocache} = req.query;
  const ck = `stats_${playerId}_${teamId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }

  try{
    // 1. Buscar últimos jogos finalizados do time no ano atual
    const anoAtual = new Date().getFullYear();
    const dataInicio = `${anoAtual-1}-06-01T00:00:00Z`;
    const dataFim    = `${anoAtual}-12-31T23:59:59Z`;

    const {ok:fe, data:fixData} = await bsd(
      `/teams/${teamId}/fixtures/?status=finished&date_from=${dataInicio}&date_to=${dataFim}&limit=50`
    );
    if(!fe) return res.status(500).json({error: fixData.detail||'Jogos não encontrados'});

    // Ordenar decrescente e pegar 5 mais recentes
    const allFix = fixData.results||[];
    const fixtures = allFix
      .sort((a,b) => new Date(b.event_date) - new Date(a.event_date))
      .slice(0,5);

    console.log(`Fixtures ${teamId}: ${allFix.length} total, usando ${fixtures.length}`);

    if(!fixtures.length) return res.status(404).json({
      error:'Nenhum jogo encontrado para este time',
      debug:{total:allFix.length, dateRange:`${dataInicio} - ${dataFim}`}
    });

    // 2. Para cada jogo, buscar stats do jogador
    const jogos = [];
    for(const fix of fixtures){
      const eventId = fix.id;
      const isHome  = fix.home_team_id === parseInt(teamId);
      const opp     = isHome ? fix.away_team : fix.home_team;
      const hg      = fix.home_score ?? 0;
      const ag      = fix.away_score ?? 0;
      const mg      = isHome ? hg : ag;
      const og      = isHome ? ag : hg;
      const score   = `${mg}-${og}`;
      const result  = mg>og?'W':mg<og?'L':'D';
      const d       = new Date(fix.event_date||0);
      const date    = `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
      const comp    = fix.league_name||'—';

      let stats = {chutes:null,chutes_gol:null,desarmes:null,ftc:null,fts:null,amarelos:null,vermelhos:null,defesas:null};

      try{
        const {ok:ps, data:psData} = await bsd(`/events/${eventId}/player-stats/`);
        if(ps && psData.player_stats){
          const found = psData.player_stats.find(p => p.player_id === parseInt(playerId));
          if(found){
            console.log(`Stats player ${playerId} event ${eventId}:`, JSON.stringify(found).substring(0,300));
            stats = {
              chutes:     found.total_shots     ?? null,
              chutes_gol: found.shots_on_target ?? null,
              desarmes:   found.total_tackle    ?? found.interception ?? null,
              ftc:        found.fouls_committed ?? null,
              fts:        found.fouls_drawn     ?? null,
              amarelos:   found.yellow_card     ?? null,
              vermelhos:  found.red_card        ?? null,
              defesas:    found.saves           ?? null,
            };
          } else {
            console.log(`Player ${playerId} NOT in event ${eventId}. Sample:`, 
              psData.player_stats?.slice(0,3).map(p=>({id:p.player_id,name:p.player_name})));
          }
        }
      }catch(e){ console.log(`Stats error event ${eventId}:`, e.message); }

      jogos.push({date, opponent:opp||'—', score, result, comp, ...stats});
    }

    const result = {jogos};
    cacheSet(ck, result, 43200000);
    res.json(result);
  }catch(e){
    console.error('Stats error:', e.message);
    res.status(500).json({error:e.message});
  }
});

// ── DEBUG: ver campos reais das stats ────────────
app.get('/api/debug/event/:eventId', async(req,res) => {
  const {eventId} = req.params;
  const {playerId} = req.query;
  try{
    const {ok, data} = await bsd(`/events/${eventId}/player-stats/`);
    if(!ok) return res.status(500).json({error:data});
    const sample = playerId
      ? data.player_stats?.find(p=>p.player_id===parseInt(playerId))
      : data.player_stats?.[0];
    res.json({
      total_players: data.player_stats?.length,
      sample_ids: data.player_stats?.slice(0,5).map(p=>({id:p.player_id,name:p.player_name})),
      sample_stats: sample,
      all_keys: sample ? Object.keys(sample) : []
    });
  }catch(e){ res.status(500).json({error:e.message}); }
});

function mapPos(pos){
  if(!pos) return 'Unknown';
  switch(pos.toUpperCase()){
    case 'G': return 'Goalkeeper';
    case 'D': return 'Defender';
    case 'M': return 'Midfielder';
    case 'F': return 'Forward';
    default:  return pos;
  }
}

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`Scout Pro v13.0 porta ${PORT}`));
