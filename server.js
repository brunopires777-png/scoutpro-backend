const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = 'bfc6e69a18mshb2f15a331d47fc7p1c68a8jsnd86c1b637755';
const HOST = 'sofascore.p.rapidapi.com';
const BASE = `https://${HOST}`;
const HEADERS = { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': HOST };

const cache = new Map();
function cacheGet(k){ const i=cache.get(k); if(!i||Date.now()>i.exp){cache.delete(k);return null;} return i.data; }
function cacheSet(k,d,ttl){ cache.set(k,{data:d,exp:Date.now()+ttl}); }

async function sofa(path){
  const url = `${BASE}/${path}`;
  console.log('GET', url);
  const r = await fetch(url, {headers: HEADERS});
  const text = await r.text();
  console.log('STATUS', r.status, text.substring(0,400));
  return {status: r.status, data: JSON.parse(text), raw: text};
}

app.get('/', (req,res) => res.json({status:'Scout Pro v6.0 ok'}));

// Limpar cache
app.get('/api/clear-cache', (req,res) => { cache.clear(); res.json({ok:true, msg:'Cache limpo'}); });

// â”€â”€ BUSCAR TIME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/teams', async(req,res) => {
  const {q, nocache} = req.query;
  if(!q) return res.status(400).json({error:'Nome obrigatorio'});
  const ck = `teams_${q.toLowerCase()}`;
  if(!nocache){ const cached=cacheGet(ck); if(cached) return res.json({...cached,fromCache:true}); }

  try{
    // Endpoint correto: search com tipo team
    const {status, data, raw} = await sofa(`search?query=${encodeURIComponent(q)}&page=0`);
    
    console.log('Search response keys:', Object.keys(data));
    
    let teams = [];

    // Estrutura 1: {results: [{type:'team', entity:{...}}]}
    if(data.results && Array.isArray(data.results)){
      teams = data.results
        .filter(r => r.type === 'team')
        .map(r => {
          const t = r.entity || r;
          return { id:t.id, name:t.name||t.shortName, logo:`https://api.sofascore.app/api/v1/team/${t.id}/image`, country:t.country?.name||'' };
        });
    }
    // Estrutura 2: {teams: [...]}
    else if(data.teams && Array.isArray(data.teams)){
      teams = data.teams.map(t => ({ id:t.id, name:t.name, logo:`https://api.sofascore.app/api/v1/team/${t.id}/image`, country:t.country?.name||'' }));
    }
    // Estrutura 3: array direto
    else if(Array.isArray(data)){
      teams = data.filter(t=>t.id&&t.name).map(t => ({ id:t.id, name:t.name, logo:`https://api.sofascore.app/api/v1/team/${t.id}/image`, country:t.country?.name||'' }));
    }

    teams = teams.slice(0,8);
    console.log('Teams found:', teams.length);

    if(teams.length > 0) cacheSet(ck, {teams}, 3600000);
    res.json({teams, debug:{status, keys:Object.keys(data), raw:raw.substring(0,200)}});
  }catch(e){
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

// â”€â”€ ELENCO DO TIME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/squad/:teamId', async(req,res) => {
  const {teamId} = req.params;
  const {nocache} = req.query;
  const ck = `squad_${teamId}`;
  if(!nocache){ const cached=cacheGet(ck); if(cached) return res.json({...cached,fromCache:true}); }
  try{
    const {status, data} = await sofa(`teams/get-squad?teamId=${teamId}`);
    console.log('Squad keys:', Object.keys(data));
    
    const members = data.players || data.squad || data.members || data.data || [];
    const players = members.map(m => {
      const p = m.player || m;
      return { id:p.id, name:p.name||p.shortName||'â€”', position:mapPos(p.position||m.position), photo:`https://api.sofascore.app/api/v1/player/${p.id}/image` };
    }).filter(p=>p.id);

    const result = {players};
    if(players.length > 0) cacheSet(ck, result, 86400000);
    res.json({...result, debug:{status, keys:Object.keys(data), count:players.length}});
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// â”€â”€ STATS DO JOGADOR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/player/:playerId/stats', async(req,res) => {
  const {playerId} = req.params;
  const {teamId, nocache} = req.query;
  const ck = `stats_${playerId}_${teamId}`;
  if(!nocache){ const cached=cacheGet(ck); if(cached) return res.json({...cached,fromCache:true}); }
  try{
    const {data} = await sofa(`teams/get-last-matches?teamId=${teamId}&pageIndex=0`);
    console.log('Matches keys:', Object.keys(data));
    
    const events = (data.events||data.matches||data.data||[])
      .filter(e=>e.status?.type==='finished'||e.status?.description==='Ended')
      .slice(0,5);
    
    if(!events.length) return res.status(404).json({error:'Nenhum jogo encontrado', debug:Object.keys(data)});
    
    const jogos = [];
    for(const ev of events){
      const isHome = ev.homeTeam?.id===parseInt(teamId);
      const opponent = isHome ? ev.awayTeam?.name : ev.homeTeam?.name;
      const hg=ev.homeScore?.current??0, ag=ev.awayScore?.current??0;
      const mg=isHome?hg:ag, og=isHome?ag:hg;
      const score=`${mg}-${og}`;
      const result=mg>og?'W':mg<og?'L':'D';
      const d=new Date((ev.startTimestamp||0)*1000);
      const date=`${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
      const comp=ev.tournament?.name||'â€”';
      let stats={chutes:null,desarmes:null,ftc:null,fts:null,amarelos:null,vermelhos:null,defesas:null};
      try{
        const {data:sd}=await sofa(`teams/get-player-statistics?teamId=${teamId}&matchId=${ev.id}`);
        const all=[...(sd.home?.players||sd.homeTeam?.players||[]),...(sd.away?.players||sd.awayTeam?.players||[])];
        const found=all.find(p=>(p.player?.id||p.id)===parseInt(playerId));
        if(found){ const s=found.statistics||found.stats||{}; stats={chutes:s.totalShots??null,desarmes:s.tackles??null,ftc:s.fouls??null,fts:s.wasFouled??null,amarelos:s.yellowCards??null,vermelhos:s.redCards??null,defesas:s.saves??null}; }
      }catch(e){}
      jogos.push({date,opponent:opponent||'â€”',score,result,comp,...stats});
    }
    const result2={jogos};
    cacheSet(ck,result2,43200000);
    res.json(result2);
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

function mapPos(pos){
  if(!pos) return 'Unknown';
  const p=pos.toLowerCase();
  if(p==='g'||p.includes('goalkeeper')) return 'Goalkeeper';
  if(p==='d'||p.includes('defender')) return 'Defender';
  if(p==='m'||p.includes('midfielder')) return 'Midfielder';
  if(p==='f'||p.includes('forward')||p.includes('attacker')) return 'Forward';
  return pos;
}

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Scout Pro v6.0 porta ${PORT}`));
