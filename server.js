const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

// ── CHAVE BSD ────────────────────────────────────
// Substitua pela sua chave em: sports.bzzoiro.com
const BSD_KEY = process.env.BSD_KEY || 'dddbf69d96a0efa0ffeb9f8d0c791528b61d1c1d';
const BSD_BASE = 'https://sports.bzzoiro.com/api/v2';
const BSD_HEADERS = { 'Authorization': `Token ${BSD_KEY}` };

// ── CACHE ────────────────────────────────────────
const cache = new Map();
function cacheGet(k){ const i=cache.get(k); if(!i||Date.now()>i.exp){cache.delete(k);return null;} return i.data; }
function cacheSet(k,d,ttl){ cache.set(k,{data:d,exp:Date.now()+ttl}); }

async function bsd(path){
  const url = `${BSD_BASE}${path}`;
  console.log('[BSD]', url);
  const r = await fetch(url, {headers: BSD_HEADERS});
  const text = await r.text();
  console.log(`[BSD] ${r.status} | ${text.substring(0,300)}`);
  try{ return {ok:r.ok, status:r.status, data:JSON.parse(text)}; }
  catch(e){ return {ok:false, status:r.status, data:{error:text}}; }
}

app.get('/', (req,res) => res.json({status:'Scout Pro v11.0 - BSD API ok'}));
app.get('/api/clear-cache', (req,res) => { cache.clear(); res.json({ok:true}); });

// ── BUSCAR TIME ──────────────────────────────────
app.get('/api/teams', async(req,res) => {
  const {q, nocache} = req.query;
  if(!q) return res.status(400).json({error:'Nome obrigatorio'});
  const ck = `bsd_teams_${q.toLowerCase()}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const {ok, data} = await bsd(`/teams/?name=${encodeURIComponent(q)}&limit=8`);
    if(!ok) return res.status(500).json({error: data.error||'Erro na busca'});
    const teams = (data.results||[]).map(t=>({
      id: t.id,
      name: t.name,
      logo: `https://sports.bzzoiro.com/img/team/${t.id}/`,
      country: t.country||''
    }));
    if(teams.length) cacheSet(ck,{teams},3600000);
    res.json({teams});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── ELENCO ───────────────────────────────────────
app.get('/api/squad/:teamId', async(req,res) => {
  const {teamId} = req.params;
  const {nocache} = req.query;
  const ck = `bsd_squad_${teamId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const {ok, data} = await bsd(`/teams/${teamId}/squad/`);
    if(!ok) return res.status(500).json({error: data.error||'Elenco não encontrado'});
    const players = (data.players||[]).map(p=>({
      id: p.id,
      name: p.name || p.short_name || '—',
      position: p.position || 'Unknown',
      photo: `https://sports.bzzoiro.com/img/player/${p.id}/`
    }));
    if(players.length) cacheSet(ck,{players},86400000);
    res.json({players});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── STATS DO JOGADOR ─────────────────────────────
app.get('/api/player/:playerId/stats', async(req,res) => {
  const {playerId} = req.params;
  const {teamId, nocache} = req.query;
  const ck = `bsd_stats_${playerId}_${teamId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    // 1. Buscar últimos jogos do time (finalizados)
    const hoje = new Date().toISOString().split('T')[0];
    const tresAnosAtras = `${parseInt(hoje)-1}-01-01`.replace(/\d{4}/,(y)=>parseInt(hoje.split('-')[0])-1);
    const dataInicio = `${parseInt(hoje.split('-')[0])-1}-01-01`;

    const {ok:fe, data:fixData} = await bsd(
      `/teams/${teamId}/fixtures/?status=finished&limit=20&date_from=${dataInicio}T00:00:00Z`
    );
    if(!fe) return res.status(500).json({error: fixData.error||'Jogos não encontrados'});

    const fixtures = (fixData.results||[]).slice(0,5);
    if(!fixtures.length) return res.status(404).json({error:'Nenhum jogo encontrado'});

    const jogos = [];
    for(const fix of fixtures){
      const eventId = fix.id;
      const isHome = fix.home_team_id === parseInt(teamId);
      const opponent = isHome ? fix.away_team : fix.home_team;
      const hg = fix.home_score ?? 0;
      const ag = fix.away_score ?? 0;
      const mg = isHome ? hg : ag;
      const og = isHome ? ag : hg;
      const score = `${mg}-${og}`;
      const result = mg>og?'W':mg<og?'L':'D';
      const d = new Date(fix.event_date||fix.date||0);
      const date = `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
      const comp = fix.league_name||'—';

      let stats = {chutes:null,chutes_gol:null,desarmes:null,ftc:null,fts:null,amarelos:null,vermelhos:null,defesas:null};

      try{
        // 2. Buscar stats do jogador nesse jogo
        const {ok:ps, data:psData} = await bsd(`/events/${eventId}/player-stats/`);
        if(ps && psData.player_stats){
          const found = psData.player_stats.find(p => p.player_id === parseInt(playerId));
          if(found){
            stats = {
              chutes:     found.total_shots ?? null,
              chutes_gol: found.shots_on_target ?? null,
              desarmes:   found.total_tackle ?? null,
              ftc:        found.fouls_committed ?? null,
              fts:        found.fouls_drawn ?? null,
              amarelos:   found.yellow_card ?? null,
              vermelhos:  found.red_card ?? null,
              defesas:    found.saves ?? null,
            };
          }
        }
      }catch(e){ console.log('Per-match stats error:', e.message); }

      jogos.push({date, opponent: opponent||'—', score, result, comp, ...stats});
    }

    const result = {jogos};
    cacheSet(ck, result, 43200000);
    res.json(result);
  }catch(e){
    console.error('Stats error:', e.message);
    res.status(500).json({error:e.message});
  }
});

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`Scout Pro v11.0 - BSD API - porta ${PORT}`));
