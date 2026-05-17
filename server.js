const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = 'bfc6e69a18mshb2f15a331d47fc7p1c68a8jsnd86c1b637755';
const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const BASE = `https://${SOFASCORE_HOST}`;
const HEADERS = { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': SOFASCORE_HOST };

const cache = new Map();
function cacheGet(k){ const i=cache.get(k); if(!i||Date.now()>i.exp){cache.delete(k);return null;} return i.data; }
function cacheSet(k,d,ttl){ cache.set(k,{data:d,exp:Date.now()+ttl}); }

async function sofaFetch(path){
  const url = `${BASE}/${path}`;
  console.log('Fetching:', url);
  const r = await fetch(url, {headers: HEADERS});
  const text = await r.text();
  console.log(`Status: ${r.status}, Body: ${text.substring(0,300)}`);
  try{ return {status: r.status, data: JSON.parse(text)}; }
  catch(e){ return {status: r.status, data: {error: text}}; }
}

app.get('/', (req,res) => res.json({status:'Scout Pro v5.0 ok'}));

// â”€â”€ BUSCAR TIME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/teams', async(req,res) => {
  const {q} = req.query;
  if(!q) return res.status(400).json({error:'Nome obrigatorio'});
  const ck = `teams_${q.toLowerCase()}`;
  const cached = cacheGet(ck);
  if(cached) return res.json({...cached, fromCache:true});
  try{
    // Usar endpoint search geral
    const {status, data} = await sofaFetch(`search?query=${encodeURIComponent(q)}&page=0`);
    console.log('Search keys:', Object.keys(data));
    
    let teams = [];
    
    // Tentar diferentes estruturas de resposta
    if(data.results){
      teams = data.results
        .filter(r => r.type === 'team')
        .slice(0,8)
        .map(r => ({
          id: r.entity?.id || r.id,
          name: r.entity?.name || r.name,
          logo: `https://api.sofascore.app/api/v1/team/${r.entity?.id || r.id}/image`,
          country: r.entity?.country?.name || r.country?.name || ''
        }));
    } else if(data.teams){
      teams = data.teams.slice(0,8).map(t => ({
        id: t.id, name: t.name,
        logo: `https://api.sofascore.app/api/v1/team/${t.id}/image`,
        country: t.country?.name || ''
      }));
    }

    if(!teams.length){
      // Fallback: tentar endpoint de busca alternativo
      const {data: d2} = await sofaFetch(`categories/list?sport=football`);
      console.log('Fallback keys:', Object.keys(d2));
    }

    const result = {teams, debug: Object.keys(data)};
    cacheSet(ck, {teams}, 3600000);
    res.json(result);
  }catch(e){
    console.error('Teams error:', e.message);
    res.status(500).json({error: e.message});
  }
});

// â”€â”€ ELENCO DO TIME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/squad/:teamId', async(req,res) => {
  const {teamId} = req.params;
  const ck = `squad_${teamId}`;
  const cached = cacheGet(ck);
  if(cached) return res.json({...cached, fromCache:true});
  try{
    const {status, data} = await sofaFetch(`teams/get-squad?teamId=${teamId}`);
    console.log('Squad keys:', Object.keys(data));
    
    const members = data.players || data.squad || data.members || data.data || [];
    const players = members.map(m => {
      const p = m.player || m;
      return {
        id: p.id, name: p.name || p.shortName || 'â€”',
        position: mapPos(p.position || m.position),
        photo: `https://api.sofascore.app/api/v1/player/${p.id}/image`
      };
    }).filter(p => p.id);
    
    const result = {players};
    cacheSet(ck, result, 86400000);
    res.json(result);
  }catch(e){
    console.error('Squad error:', e.message);
    res.status(500).json({error: e.message});
  }
});

// â”€â”€ STATS DO JOGADOR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/player/:playerId/stats', async(req,res) => {
  const {playerId} = req.params;
  const {teamId} = req.query;
  const ck = `stats_${playerId}_${teamId}`;
  const cached = cacheGet(ck);
  if(cached) return res.json({...cached, fromCache:true});
  try{
    const {status, data} = await sofaFetch(`teams/get-last-matches?teamId=${teamId}&pageIndex=0`);
    console.log('Last matches keys:', Object.keys(data));
    
    const events = (data.events || data.matches || data.data || [])
      .filter(e => e.status?.type === 'finished' || e.status?.description === 'Ended')
      .slice(0,5);
    
    if(!events.length) return res.status(404).json({error:'Nenhum jogo encontrado'});
    
    const jogos = [];
    for(const ev of events){
      const isHome = ev.homeTeam?.id === parseInt(teamId);
      const opponent = isHome ? ev.awayTeam?.name : ev.homeTeam?.name;
      const hg = ev.homeScore?.current ?? ev.homeScore?.normaltime ?? 0;
      const ag = ev.awayScore?.current ?? ev.awayScore?.normaltime ?? 0;
      const mg = isHome ? hg : ag, og = isHome ? ag : hg;
      const score = `${mg}-${og}`;
      const result = mg > og ? 'W' : mg < og ? 'L' : 'D';
      const d = new Date((ev.startTimestamp || 0) * 1000);
      const date = `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
      const comp = ev.tournament?.name || 'â€”';

      let stats = {chutes:null,desarmes:null,ftc:null,fts:null,amarelos:null,vermelhos:null,defesas:null};
      try{
        const {data: sd} = await sofaFetch(`teams/get-player-statistics?teamId=${teamId}&matchId=${ev.id}`);
        const allPlayers = [
          ...(sd.home?.players || sd.homeTeam?.players || []),
          ...(sd.away?.players || sd.awayTeam?.players || [])
        ];
        const found = allPlayers.find(p => (p.player?.id || p.id) === parseInt(playerId));
        if(found){
          const s = found.statistics || found.stats || {};
          stats = {
            chutes:   s.totalShots ?? s.shots?.total ?? null,
            desarmes: s.tackles ?? null,
            ftc:      s.fouls ?? s.foulsCommitted ?? null,
            fts:      s.wasFouled ?? null,
            amarelos: s.yellowCards ?? null,
            vermelhos:s.redCards ?? null,
            defesas:  s.saves ?? null,
          };
        }
      }catch(e){}
      jogos.push({date, opponent: opponent||'â€”', score, result, comp, ...stats});
    }

    const result2 = {jogos};
    cacheSet(ck, result2, 43200000);
    res.json(result2);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scout Pro v5.0 porta ${PORT}`));
