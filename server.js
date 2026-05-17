const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = 'bfc6e69a18mshb2f15a331d47fc7p1c68a8jsnd86c1b637755';
const SOFASCORE_HOST = 'sofascore.p.rapidapi.com';
const BASE = `https://${SOFASCORE_HOST}`;
const headers = { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': SOFASCORE_HOST };

const cache = new Map();
function cacheGet(k){ const i=cache.get(k); if(!i||Date.now()>i.exp){cache.delete(k);return null;} return i.data; }
function cacheSet(k,d,ttl){ cache.set(k,{data:d,exp:Date.now()+ttl}); }

app.get('/', (req,res)=>res.json({status:'Scout Pro API ok',version:'2.0'}));

app.get('/api/teams', async(req,res)=>{
  const {q}=req.query;
  if(!q) return res.status(400).json({error:'Nome obrigatorio'});
  const ck=`teams_${q.toLowerCase()}`;
  const cached=cacheGet(ck);
  if(cached) return res.json({...cached,fromCache:true});
  try{
    const r=await fetch(`${BASE}/teams/search?name=${encodeURIComponent(q)}`,{headers});
    const data=await r.json();
    console.log('teams raw keys:', Object.keys(data));
    const list=data.teams||data.data||[];
    const teams=list.slice(0,8).map(t=>({
      id:t.id, name:t.name,
      logo:`https://api.sofascore.app/api/v1/team/${t.id}/image`,
      country:t.country?.name||''
    }));
    const result={teams};
    cacheSet(ck,result,3600000);
    res.json(result);
  }catch(e){console.error(e); res.status(500).json({error:e.message});}
});

app.get('/api/squad/:teamId', async(req,res)=>{
  const {teamId}=req.params;
  const ck=`squad_${teamId}`;
  const cached=cacheGet(ck);
  if(cached) return res.json({...cached,fromCache:true});
  try{
    const r=await fetch(`${BASE}/teams/${teamId}/players`,{headers});
    const data=await r.json();
    console.log('squad raw keys:', Object.keys(data), 'status:', r.status);
    const list=data.players||data.data||[];
    const players=list.map(p=>{
      const pl=p.player||p;
      return {id:pl.id,name:pl.name||pl.shortName||'â€”',position:mapPos(pl.position),photo:`https://api.sofascore.app/api/v1/player/${pl.id}/image`};
    }).filter(p=>p.id);
    const result={players};
    cacheSet(ck,result,86400000);
    res.json(result);
  }catch(e){console.error(e); res.status(500).json({error:e.message});}
});

app.get('/api/player/:playerId/stats', async(req,res)=>{
  const {playerId}=req.params;
  const {teamId}=req.query;
  const ck=`stats_${playerId}_${teamId}`;
  const cached=cacheGet(ck);
  if(cached) return res.json({...cached,fromCache:true});
  try{
    const r=await fetch(`${BASE}/players/${playerId}/events/last/0`,{headers});
    const data=await r.json();
    console.log('events raw keys:', Object.keys(data));
    const events=(data.events||[]).filter(e=>e.status?.type==='finished').slice(0,5);
    if(!events.length) return res.status(404).json({error:'Nenhum jogo encontrado'});
    const jogos=[];
    for(const ev of events){
      const isHome=ev.homeTeam?.id===parseInt(teamId);
      const opp=isHome?ev.awayTeam?.name:ev.homeTeam?.name;
      const hg=ev.homeScore?.current??0, ag=ev.awayScore?.current??0;
      const mg=isHome?hg:ag, og=isHome?ag:hg;
      const score=`${mg}-${og}`;
      const result=mg>og?'W':mg<og?'L':'D';
      const d=new Date((ev.startTimestamp||0)*1000);
      const date=`${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
      const comp=ev.tournament?.name||'â€”';
      let stats={chutes:null,desarmes:null,ftc:null,fts:null,amarelos:null,vermelhos:null,defesas:null};
      try{
        const sr=await fetch(`${BASE}/events/${ev.id}/player-statistics`,{headers});
        const sd=await sr.json();
        const all=[...(sd.home?.players||[]),...(sd.away?.players||[])];
        const found=all.find(p=>p.player?.id===parseInt(playerId));
        if(found?.statistics){
          const s=found.statistics;
          stats={chutes:s.totalShots??s.shots??null,desarmes:s.tackles??null,ftc:s.fouls??null,fts:s.wasFouled??null,amarelos:s.yellowCards??null,vermelhos:s.redCards??null,defesas:s.saves??null};
        }
      }catch(e){}
      jogos.push({date,opponent:opp||'â€”',score,result,comp,...stats});
    }
    const result2={jogos};
    cacheSet(ck,result2,43200000);
    res.json(result2);
  }catch(e){console.error(e); res.status(500).json({error:e.message});}
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
app.listen(PORT,()=>console.log(`Scout Pro v2.0 porta ${PORT}`));
