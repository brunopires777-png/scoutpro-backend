const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const SOFA_KEY  = 'bfc6e69a18mshb2f15a331d47fc7p1c68a8jsnd86c1b637755';
const SOFA_HOST = 'sofascore.p.rapidapi.com';
const SOFA_BASE = `https://${SOFA_HOST}`;
const SOFA_HEADERS = { 'x-rapidapi-key': SOFA_KEY, 'x-rapidapi-host': SOFA_HOST };

const FOOTBALL_KEY  = 'bb3b1b2ce74687c0a7092754514dfebd';
const FOOTBALL_BASE = 'https://v3.football.api-sports.io';

const cache = new Map();
function cacheGet(k){ const i=cache.get(k); if(!i||Date.now()>i.exp){cache.delete(k);return null;} return i.data; }
function cacheSet(k,d,ttl){ cache.set(k,{data:d,exp:Date.now()+ttl}); }

async function sofa(path){
  const r = await fetch(`${SOFA_BASE}/${path}`, {headers: SOFA_HEADERS});
  const text = await r.text();
  console.log(`[SOFA] ${path} -> ${r.status} | ${text.substring(0,300)}`);
  try{ return {ok:r.ok, status:r.status, data:JSON.parse(text)}; }
  catch(e){ return {ok:false, status:r.status, data:{error:text}}; }
}

async function football(path){
  const r = await fetch(`${FOOTBALL_BASE}/${path}`, {headers:{'x-apisports-key':FOOTBALL_KEY}});
  const data = await r.json();
  console.log(`[FOOTBALL] ${path} -> ${r.status}`);
  return data;
}

app.get('/', (req,res) => res.json({status:'Scout Pro v10.0 ok'}));
app.get('/api/clear-cache', (req,res) => { cache.clear(); res.json({ok:true}); });

// ── BUSCAR TIME — API-Football ───────────────────
app.get('/api/teams', async(req,res) => {
  const {q, nocache} = req.query;
  if(!q) return res.status(400).json({error:'Nome obrigatorio'});
  const ck = `teams_${q.toLowerCase()}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const data = await football(`teams?search=${encodeURIComponent(q)}`);
    const teams = (data.response||[]).slice(0,8).map(t=>({
      id: t.team.id,
      name: t.team.name,
      logo: t.team.logo||'',
      country: t.team.country||''
    }));
    if(teams.length) cacheSet(ck,{teams},3600000);
    res.json({teams});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── ELENCO — SofaScore teams/get-squad ──────────
// Recebe teamId do SofaScore (mapeado pelo nome)
app.get('/api/squad/:teamId', async(req,res) => {
  const {teamId} = req.params;
  const {nocache} = req.query;
  const ck = `squad_sofa_${teamId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const {ok, data} = await sofa(`teams/get-squad?teamId=${teamId}`);
    console.log('Squad keys:', Object.keys(data), 'ok:', ok);

    const members = data.players || data.squad || data.members || [];
    const players = members.map(m => {
      const p = m.player || m;
      return {
        id: p.id,
        name: p.name || p.shortName || '—',
        position: mapPos(p.position || m.position),
        photo: `https://api.sofascore.app/api/v1/player/${p.id}/image`
      };
    }).filter(p => p.id);

    console.log('Players found:', players.length);
    if(players.length) cacheSet(ck,{players},86400000);
    res.json({players, debug:{ok, keys:Object.keys(data), count:players.length}});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── MAPEAR TIME: API-Football ID -> SofaScore ID ─
app.get('/api/team-sofa-id', async(req,res) => {
  const {name} = req.query;
  if(!name) return res.status(400).json({error:'Nome obrigatorio'});
  const ck = `sofaid_${name.toLowerCase()}`;
  const c = cacheGet(ck);
  if(c) return res.json({...c, fromCache:true});
  try{
    // Buscar ID do time no SofaScore via teams/get-squad com IDs conhecidos
    // Usar tabela de mapeamento para times populares
    const knownTeams = {
      'flamengo': 5981, 'fluminense': 1963, 'vasco': 1966,
      'botafogo': 1958, 'palmeiras': 1967, 'corinthians': 1957,
      'são paulo': 1953, 'santos': 1968, 'atletico mineiro': 1977,
      'cruzeiro': 1954, 'internacional': 1969, 'gremio': 1981,
      'real madrid': 2829, 'barcelona': 2817, 'manchester city': 17,
      'manchester united': 35, 'liverpool': 44, 'chelsea': 38,
      'arsenal': 42, 'tottenham': 33, 'juventus': 2686,
      'ac milan': 2692, 'inter milan': 2697, 'napoli': 2714,
      'bayern munich': 2672, 'borussia dortmund': 2673,
      'psg': 1644, 'atletico madrid': 2836, 'sevilla': 2833,
    };
    const key = name.toLowerCase();
    const sofaId = knownTeams[key];
    if(sofaId){
      cacheSet(ck, {sofaId}, 86400000);
      return res.json({sofaId});
    }
    res.json({sofaId: null, msg:'Time não encontrado na tabela. Use busca manual.'});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── STATS — SofaScore players/get-last-matches ───
app.get('/api/player/:playerId/stats', async(req,res) => {
  const {playerId} = req.params;
  const {teamId, nocache} = req.query;
  const ck = `stats_sofa_${playerId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const {ok, data:evData} = await sofa(`players/get-last-matches?playerId=${playerId}&pageIndex=0`);
    console.log('Events ok:', ok, 'keys:', Object.keys(evData));

    if(!ok) return res.status(404).json({error:'Jogador não encontrado', debug:evData});

    const allEvents = evData.events || [];
    console.log('Total events:', allEvents.length);

    const events = allEvents
      .filter(e => {
        const st = e.status;
        return st?.type==='finished' || st?.description==='Ended' || st?.code===100;
      })
      .slice(0,5);

    console.log('Filtered events:', events.length);

    if(!events.length) return res.status(404).json({
      error:'Nenhum jogo finalizado encontrado',
      debug:{total:allEvents.length, statuses:allEvents.slice(0,3).map(e=>e.status)}
    });

    const jogos = [];
    for(const ev of events){
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
        const {data:sd} = await sofa(`matches/get-player-statistics?matchId=${ev.id}`);
        const all = [...(sd.home?.players||[]),...(sd.away?.players||[])];
        const found = all.find(p=>(p.player?.id||p.id)===parseInt(playerId));
        if(found){
          const s = found.statistics||{};
          stats = {
            chutes:    s.totalShots??s.shots??null,
            desarmes:  s.tackles??null,
            ftc:       s.fouls??s.foulsCommitted??null,
            fts:       s.wasFouled??null,
            amarelos:  s.yellowCards??null,
            vermelhos: s.redCards??null,
            defesas:   s.saves??null,
          };
        }
      }catch(e){}

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
app.listen(PORT, ()=>console.log(`Scout Pro v10.0 porta ${PORT}`));
