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
  const r = await fetch(`${BASE}/${path}`, {headers: HEADERS});
  const data = await r.json();
  console.log(`GET ${path} -> ${r.status}`, JSON.stringify(data).substring(0,200));
  return {status: r.status, data};
}

// â”€â”€ HEALTH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/', (req,res) => res.json({status:'Scout Pro v4.0 ok'}));

// â”€â”€ BUSCAR TIME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/teams', async(req,res) => {
  const {q} = req.query;
  if(!q) return res.status(400).json({error:'Nome obrigatorio'});
  const ck = `teams_${q.toLowerCase()}`;
  const cached = cacheGet(ck);
  if(cached) return res.json({...cached, fromCache:true});
  try{
    const {status, data} = await sofaFetch(`search?query=${encodeURIComponent(q)}`);
    if(status !== 200) return res.status(status).json({error: data.message||'Erro na busca'});
    
    const results = data.results || [];
    const teams = results
      .filter(r => r.type === 'team' || r.entity?.type === 'team')
      .slice(0,8)
      .map(r => {
        const t = r.entity || r;
        return {
          id: t.id,
          name: t.name || t.shortName,
          logo: `https://api.sofascore.app/api/v1/team/${t.id}/image`,
          country: t.country?.name || ''
        };
      });
    const result = {teams};
    cacheSet(ck, result, 3600000);
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
    if(status !== 200) return res.status(status).json({error: data.message||'Erro no elenco'});
    
    const members = data.players || data.squad || data.members || [];
    const players = members.map(m => {
      const p = m.player || m;
      return {
        id: p.id,
        name: p.name || p.shortName || 'â€”',
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
    // Buscar Ãºltimos jogos do TIME e cruzar com stats do jogador
    const {status: es, data: ed} = await sofaFetch(`teams/get-last-matches?teamId=${teamId}&pageIndex=0`);
    if(es !== 200) return res.status(es).json({error: ed.message||'Erro nos jogos'});
    
    const events = (ed.events || [])
      .filter(e => e.status?.type === 'finished')
      .slice(0,5);
    
    if(!events.length) return res.status(404).json({error:'Nenhum jogo encontrado'});
    
    const jogos = [];
    for(const ev of events){
      const isHome = ev.homeTeam?.id === parseInt(teamId);
      const opponent = isHome ? ev.awayTeam?.name : ev.homeTeam?.name;
      const hg = ev.homeScore?.current ?? 0;
      const ag = ev.awayScore?.current ?? 0;
      const mg = isHome ? hg : ag;
      const og = isHome ? ag : hg;
      const score = `${mg}-${og}`;
      const result = mg > og ? 'W' : mg < og ? 'L' : 'D';
      const d = new Date((ev.startTimestamp || 0) * 1000);
      const date = `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
      const comp = ev.tournament?.name || ev.season?.name || 'â€”';

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
            fts:      s.wasFouled ?? s.foulsSuffered ?? null,
            amarelos: s.yellowCards ?? null,
            vermelhos:s.redCards ?? null,
            defesas:  s.saves ?? null,
          };
        }
      }catch(e){ console.log('player stats err:', e.message); }

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
  if(p === 'g' || p.includes('goalkeeper') || p.includes('goleiro')) return 'Goalkeeper';
  if(p === 'd' || p.includes('defender') || p.includes('back')) return 'Defender';
  if(p === 'm' || p.includes('midfielder') || p.includes('medio')) return 'Midfielder';
  if(p === 'f' || p.includes('forward') || p.includes('attacker') || p.includes('striker')) return 'Forward';
  return pos;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scout Pro v4.0 porta ${PORT}`));
