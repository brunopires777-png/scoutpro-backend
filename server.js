const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

// â”€â”€ CHAVES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const FOOTBALL_KEY = 'bb3b1b2ce74687c0a7092754514dfebd';
const FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const GROQ_KEY = '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';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const cache = new Map();
function cacheGet(k){ const i=cache.get(k); if(!i||Date.now()>i.exp){cache.delete(k);return null;} return i.data; }
function cacheSet(k,d,ttl){ cache.set(k,{data:d,exp:Date.now()+ttl}); }

async function football(path){
  const r = await fetch(`${FOOTBALL_BASE}/${path}`, {headers:{'x-apisports-key': FOOTBALL_KEY}});
  const data = await r.json();
  console.log(`Football API ${path} -> ${r.status}`, JSON.stringify(data).substring(0,200));
  return data;
}

// â”€â”€ HEALTH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/', (req,res) => res.json({status:'Scout Pro v7.0 ok'}));
app.get('/api/clear-cache', (req,res) => { cache.clear(); res.json({ok:true}); });

// â”€â”€ BUSCAR TIME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

// â”€â”€ ELENCO DO TIME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/squad/:teamId', async(req,res) => {
  const {teamId} = req.params;
  const {nocache} = req.query;
  const ck = `squad_${teamId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const data = await football(`players/squads?team=${teamId}`);
    const squad = data.response?.[0]?.players||[];
    const players = squad.map(p=>({
      id: p.id,
      name: p.name,
      position: p.position||'Unknown',
      photo: p.photo||''
    }));
    if(players.length) cacheSet(ck,{players},86400000);
    res.json({players});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

// â”€â”€ STATS VIA GROQ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/player/:playerId/stats', async(req,res) => {
  const {playerId} = req.params;
  const {teamId, playerName, teamName, nocache} = req.query;
  const ck = `stats_${playerId}_${teamId}`;
  if(!nocache){ const c=cacheGet(ck); if(c) return res.json({...c,fromCache:true}); }
  try{
    const hoje = new Date();
    const dataHoje = `${hoje.getDate().toString().padStart(2,'0')}/${(hoje.getMonth()+1).toString().padStart(2,'0')}/${hoje.getFullYear()}`;

    const prompt = `Hoje Ã© ${dataHoje}. VocÃª Ã© analista de futebol especializado em scout.

Liste os 5 jogos mais recentes de 2025 do jogador "${playerName}" pelo "${teamName}". Inclua QUALQUER competiÃ§Ã£o (campeonato, copa, libertadores, champions etc).

Para cada jogo retorne as estatÃ­sticas INDIVIDUAIS do jogador. Use null se nÃ£o souber â€” NUNCA invente nÃºmeros.

Responda SOMENTE JSON puro sem markdown:
{"jogos":[{"date":"DD/MM/YYYY","opponent":"AdversÃ¡rio","score":"X-X","comp":"CompetiÃ§Ã£o","chutes":2,"desarmes":1,"ftc":1,"fts":2,"amarelos":0,"vermelhos":0,"defesas":null}]}`;

    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {role:'system', content:'Analista de futebol. Responda SEMPRE com JSON puro, sem markdown, sem texto extra.'},
          {role:'user', content: prompt}
        ],
        temperature: 0.1,
        max_tokens: 2048
      })
    });

    const gdata = await r.json();
    const raw = gdata.choices?.[0]?.message?.content||'';
    const clean = raw.replace(/```json/g,'').replace(/```/g,'').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if(!match) throw new Error('Resposta invÃ¡lida da IA');

    const parsed = JSON.parse(match[0]);
    const jogos = (parsed.jogos||[]).slice(0,5).map(g=>{
      const parts = (g.score||'0-0').split('-');
      const mg = parseInt(parts[0])||0;
      const og = parseInt(parts[1])||0;
      return {
        date: g.date||'â€”',
        opponent: g.opponent||'â€”',
        score: g.score||'â€”',
        result: mg>og?'W':mg<og?'L':'D',
        comp: g.comp||'â€”',
        chutes: g.chutes??null,
        desarmes: g.desarmes??null,
        ftc: g.ftc??null,
        fts: g.fts??null,
        amarelos: g.amarelos??null,
        vermelhos: g.vermelhos??null,
        defesas: g.defesas??null
      };
    });

    if(jogos.length) cacheSet(ck,{jogos},43200000);
    res.json({jogos});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`Scout Pro v7.0 porta ${PORT}`));
