const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const KEY  = 'bfc6e69a18mshb2f15a331d47fc7p1c68a8jsnd86c1b637755';
const HOST = 'sofascore.p.rapidapi.com';
const BASE = `https://${HOST}`;
const HEADERS = { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST };

// API-Football para busca de times e elenco
const FOOTBALL_KEY  = 'bb3b1b2ce74687c0a7092754514dfebd';
const FOOTBALL_BASE = 'https://v3.football.api-sports.io';

const cache = new Map();
function cacheGet(k){ const i=cache.get(k); if(!i||Date.now()>i.exp){cache.delete(k);return null;} return i.data; }
function cacheSet(k,d,ttl){ cache.set(k,{data:d,exp:Date.now()+ttl}); }

async function sofa(path){
  const r = await fetch(`${BASE}/${path}`, {headers: HEADERS});
  const text = await r.text();
  console.log(`[SOFA] ${path} -> ${r.status} | ${text.substring(0,300)}`);
  try{ return {ok: r.ok, status: r.status, data: JSON.parse(text)}; }
  catch(e){ return {ok: false, status: r.status, data: {error: text}}; }
}

async function football(path){
  const r = await fetch(`${FOOTBALL_BASE}/${path}`, {headers:{'x-apisports-key': FOOTBALL_KEY}});
  const data = await r.json();
  console.log(`[FOOTBALL] ${path} -> ${r.status}`);
  return data;
}

app.get('/', (req,res) => res.json({status:'Scout Pro v8.0 ok - SofaScore Stats'}));
app.get('/api/clear-cache', (req,res) => { cache.clear(); res.json({ok:true}); });

// â”€â”€ BUSCAR TIME (API-Football) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/teams', async(req,res) => {
  const {q, nocache} = req.query;
  if(!q) return res.status(400).json({error:'Nome obrigatorio'});
  const ck = `teams_${q.toLowerCase()}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const data = await football(`teams?search=${encodeURIComponent(q)}`);
    const teams = (data.response||[]).slice(0,8).map(t=>({
      id: t.team.id, name: t.team.name,
      logo: t.team.logo||'', country: t.team.country||''
    }));
    if(teams.length) cacheSet(ck,{teams},3600000);
    res.json({teams});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// â”€â”€ ELENCO (API-Football) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/squad/:teamId', async(req,res) => {
  const {teamId} = req.params;
  const {nocache} = req.query;
  const ck = `squad_${teamId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const data = await football(`players/squads?team=${teamId}`);
    const squad = data.response?.[0]?.players||[];
    const players = squad.map(p=>({
      id: p.id, name: p.name,
      position: p.position||'Unknown', photo: p.photo||''
    }));
    if(players.length) cacheSet(ck,{players},86400000);
    res.json({players});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// â”€â”€ STATS DO JOGADOR (SofaScore) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/player/:playerId/stats', async(req,res) => {
  const {playerId} = req.params;
  const {teamId, nocache} = req.query;
  const ck = `stats_${playerId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }

  try{
    // 1. Buscar Ãºltimos jogos do jogador via SofaScore
    const {ok, data: evData} = await sofa(`players/get-last-matches?playerId=${playerId}&pageIndex=0`);
    
    if(!ok || !evData.events){
      return res.status(404).json({error:'Nenhum jogo encontrado para este jogador', debug: evData});
    }

    const events = (evData.events||[])
      .filter(e => e.status?.type === 'finished' || e.status?.description === 'Ended')
      .slice(0,5);

    if(!events.length) return res.status(404).json({error:'Nenhum jogo finalizado encontrado'});

    const jogos = [];
    for(const ev of events){
      const matchId = ev.id;
      const isHome = ev.homeTeam?.id === parseInt(teamId);
      const opponent = isHome ? ev.awayTeam?.name : ev.homeTeam?.name;
      const hg = ev.homeScore?.current ?? 0;
      const ag = ev.awayScore?.current ?? 0;
      const mg = isHome ? hg : ag;
      const og = isHome ? ag : hg;
      const score = `${mg}-${og}`;
      const result = mg > og ? 'W' : mg < og ? 'L' : 'D';
      const d = new Date((ev.startTimestamp||0)*1000);
      const date = `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
      const comp = ev.tournament?.name || 'â€”';

      // 2. Buscar stats do jogador nesse jogo
      let stats = {chutes:null,desarmes:null,ftc:null,fts:null,amarelos:null,vermelhos:null,defesas:null};
      try{
        const {data: sd} = await sofa(`matches/get-player-statistics?matchId=${matchId}`);
        // Procurar o jogador nas estatÃ­sticas
        const home = sd.home?.players || [];
        const away = sd.away?.players || [];
        const all = [...home, ...away];
        const found = all.find(p => (p.player?.id || p.id) === parseInt(playerId));
        
        if(found){
          const s = found.statistics || {};
          stats = {
            chutes:    s.totalShots ?? s.shots ?? null,
            desarmes:  s.tackles ?? s.interceptions ?? null,
            ftc:       s.fouls ?? s.foulsCommitted ?? null,
            fts:       s.wasFouled ?? s.foulsSuffered ?? null,
            amarelos:  s.yellowCards ?? null,
            vermelhos: s.redCards ?? null,
            defesas:   s.saves ?? null,
          };
        }
      }catch(e){ console.log('Stats per match error:', e.message); }

      jogos.push({date, opponent: opponent||'â€”', score, result, comp, ...stats});
    }

    const result = {jogos};
    cacheSet(ck, result, 43200000);
    res.json(result);
  }catch(e){
    console.error('Stats error:', e.message);
    res.status(500).json({error: e.message});
  }
});

function mapPos(pos){
  if(!pos) return 'Unknown';
  const p = pos.toLowerCase();
  if(p==='g'||p.includes('goalkeeper')) return 'Goalkeeper';
  if(p==='d'||p.includes('defender')) return 'Defender';
  if(p==='m'||p.includes('midfielder')) return 'Midfielder';
  if(p==='f'||p.includes('forward')||p.includes('attacker')) return 'Forward';
  return pos;
}

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`Scout Pro v8.0 porta ${PORT}`));
