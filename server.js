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

const cache = new Map();
function cacheGet(k){ const i=cache.get(k); if(!i||Date.now()>i.exp){cache.delete(k);return null;} return i.data; }
function cacheSet(k,d,ttl){ cache.set(k,{data:d,exp:Date.now()+ttl}); }

async function sofa(path){
  const r = await fetch(`${BASE}/${path}`, {headers: HEADERS});
  const text = await r.text();
  console.log(`[SOFA] ${path} -> ${r.status} | ${text.substring(0,400)}`);
  try{ return {ok:r.ok, status:r.status, data:JSON.parse(text)}; }
  catch(e){ return {ok:false, status:r.status, data:{error:text}}; }
}

app.get('/', (req,res) => res.json({status:'Scout Pro v9.0 ok'}));
app.get('/api/clear-cache', (req,res) => { cache.clear(); res.json({ok:true}); });

// ── BUSCAR TIME via SofaScore search ─────────────
app.get('/api/teams', async(req,res) => {
  const {q, nocache} = req.query;
  if(!q) return res.status(400).json({error:'Nome obrigatorio'});
  const ck = `teams_${q.toLowerCase()}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const {data} = await sofa(`search?query=${encodeURIComponent(q)}&page=0`);
    console.log('Search keys:', Object.keys(data));

    let teams = [];
    // Estrutura: {results:[{type:'team', entity:{id,name,...}}]}
    if(data.results){
      teams = data.results
        .filter(r => r.type === 'team')
        .map(r => {
          const t = r.entity || r;
          return {
            id: t.id, name: t.name||t.shortName||'—',
            logo: `https://api.sofascore.app/api/v1/team/${t.id}/image`,
            country: t.country?.name||''
          };
        })
        .filter(t => t.id)
        .slice(0,8);
    }

    console.log('Teams found:', teams.length);
    if(teams.length) cacheSet(ck,{teams},3600000);
    res.json({teams, debug:{keys:Object.keys(data), count:teams.length}});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── ELENCO via SofaScore teams/get-squad ─────────
app.get('/api/squad/:teamId', async(req,res) => {
  const {teamId} = req.params;
  const {nocache} = req.query;
  const ck = `squad_${teamId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const {data} = await sofa(`teams/get-squad?teamId=${teamId}`);
    console.log('Squad keys:', Object.keys(data));

    const members = data.players || data.squad || data.members || [];
    const players = members.map(m => {
      const p = m.player || m;
      return {
        id: p.id, name: p.name||p.shortName||'—',
        position: mapPos(p.position||m.position),
        photo: `https://api.sofascore.app/api/v1/player/${p.id}/image`
      };
    }).filter(p=>p.id);

    console.log('Players found:', players.length);
    if(players.length) cacheSet(ck,{players},86400000);
    res.json({players, debug:{keys:Object.keys(data), count:players.length}});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── STATS via SofaScore players/get-last-matches ──
app.get('/api/player/:playerId/stats', async(req,res) => {
  const {playerId} = req.params;
  const {teamId, nocache} = req.query;
  const ck = `stats_${playerId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    // Buscar últimos jogos do jogador
    const {ok, data:evData} = await sofa(`players/get-last-matches?playerId=${playerId}&pageIndex=0`);
    console.log('Events keys:', Object.keys(evData));

    if(!ok) return res.status(404).json({error:'Jogador não encontrado no SofaScore', debug:evData});

    const allEvents = evData.events || evData.data || [];
    const events = allEvents
      .filter(e => e.status?.type==='finished' || e.status?.description==='Ended' || e.status?.code===100)
      .slice(0,5);

    if(!events.length) return res.status(404).json({
      error:'Nenhum jogo encontrado',
      debug:{total:allEvents.length, keys:Object.keys(evData)}
    });

    const jogos = [];
    for(const ev of events){
      const matchId = ev.id;
      const isHome = ev.homeTeam?.id === parseInt(teamId);
      const opponent = isHome ? ev.awayTeam?.name : ev.homeTeam?.name;
      const hg = ev.homeScore?.current??0;
      const ag = ev.awayScore?.current??0;
      const mg = isHome?hg:ag, og = isHome?ag:hg;
      const score = `${mg}-${og}`;
      const result = mg>og?'W':mg<og?'L':'D';
      const d = new Date((ev.startTimestamp||0)*1000);
      const date = `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
      const comp = ev.tournament?.name||'—';

      let stats = {chutes:null,desarmes:null,ftc:null,fts:null,amarelos:null,vermelhos:null,defesas:null};
      try{
        const {data:sd} = await sofa(`matches/get-player-statistics?matchId=${matchId}`);
        const all = [...(sd.home?.players||[]),...(sd.away?.players||[])];
        const found = all.find(p=>(p.player?.id||p.id)===parseInt(playerId));
        if(found){
          const s = found.statistics||{};
          stats = {
            chutes:    s.totalShots??s.shots??null,
            desarmes:  s.tackles??s.interceptions??null,
            ftc:       s.fouls??s.foulsCommitted??null,
            fts:       s.wasFouled??null,
            amarelos:  s.yellowCards??null,
            vermelhos: s.redCards??null,
            defesas:   s.saves??null,
          };
        }
      }catch(e){ console.log('Per-match stats error:', e.message); }

      jogos.push({date, opponent:opponent||'—', score, result, comp, ...stats});
    }

    const result = {jogos};
    cacheSet(ck, result, 43200000);
    res.json(result);
  }catch(e){
    res.status(500).json({error:e.message});
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
app.listen(PORT, ()=>console.log(`Scout Pro v9.0 porta ${PORT}`));
