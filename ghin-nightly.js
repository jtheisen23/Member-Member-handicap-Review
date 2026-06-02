#!/usr/bin/env node
/* =============================================================================
 * ghin-nightly.js — scheduled GHIN refresh for the Posting Watch.
 *
 * Run by .github/workflows/ghin-nightly.yml on a cron schedule. It:
 *   1. logs into GHIN,
 *   2. reads the current shared room from Firebase (so it doesn't clobber the
 *      organizer's teams / settings / watch baseline),
 *   3. refreshes every member's handicap index from the club roster, and pulls
 *      fresh score history for the tournament field (players on a team), then
 *   4. writes the merged state back to the room — which the web app picks up
 *      live for everyone.
 *
 * Secrets (set in GitHub → repo Settings → Secrets and variables → Actions):
 *   GHIN_EMAIL, GHIN_PASSWORD            — your GHIN login (to pull scores)
 *   FIREBASE_SERVICE_ACCOUNT             — Firebase service-account JSON (full text)
 * Optional env overrides: ROOM_ID, GHIN_CLUB_ID, GHIN_ASSOC_ID,
 *   FIREBASE_DATABASE_URL, GHIN_APP_TOKEN, SCORE_PAGES.
 * ============================================================================= */

const admin = require("firebase-admin");

const CONFIG = {
  base: "https://api2.ghin.com/api/v1",
  // Same public GHINcom client token the web app ships.
  appToken: process.env.GHIN_APP_TOKEN ||
    "4XxmdKDLAnV5vdfV97PNGNsp7z2Z1z3Pax84WMf26NUCitoArI8aWd24m/IUApBpmXR/zCHAwofHDao1EOUBp7tvGnJAUiv9AcFmVnNuaDWUS6I1Sha7nQqcnM0Pz7qEc9ZwHUvimGj/jvI02vNOFAK3lw8qDjsrW2jmbH2f8uE43qGqkH5WDxL68CzCDpvKGNvfOKny+4hhLDpg7xMBRqjAu0FgyEIzppiik12c+kYOO8ig5c44FC95x5JHXz+QjhEuayh6QhhxXwAEvmitOirsPpyCJiT2hYx2VEgpoxNrn3gEVDoEy8fy2MjC+XcZy9DdAorWo7MjT8M+rSKG2d78Hbsv4W3ic2fgIuGzRFZVKNAkB85/0tUjjqdZJT1/5wtkjx2ail/S0KeGgrZeHWaZvQNWgWwKL75Vw2o055HjoqWIap4T9wacwW4mtIhaAA3M2kVTMzmgqTXbjMAdfZuBwJWByeCnAt6/Ij4WpUT4cooyLWhV3sflDd4xvsvfeE8/6cTm6E0gxwXg/aUDhOPTbF5x6hslNMleSmDsdvUlmo3yAk4x/I7BeqwWwYN3bTei0ZsMhRHVTx4I1SJR9GV2Ud1B3fwkvJ+19Ds5oA+8GBDgXdTV7ldTV7i/9wHMTfsLmMSp8HBq+NxCenFKuxIJ+3LDSifdzqkL7YFYGz4=",
  email: process.env.GHIN_EMAIL,
  password: process.env.GHIN_PASSWORD,
  clubId: process.env.GHIN_CLUB_ID || "52147",
  assocId: process.env.GHIN_ASSOC_ID || "106",
  room: process.env.ROOM_ID || "geneva-mm-2026",
  databaseURL: process.env.FIREBASE_DATABASE_URL || "https://member-member-handicap-review-default-rtdb.firebaseio.com",
  pages: parseInt(process.env.SCORE_PAGES || "3", 10)
};

const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
function parseIndex(v){
  if(v==null||v==="") return null;
  if(typeof v==="number") return Math.abs(v)>60?null:v;
  const s=String(v).trim().toUpperCase();
  if(s==="NH"||s==="WD"||s==="N/A") return null;
  if(s[0]==="+"){ const n=parseFloat(s.slice(1)); return isNaN(n)?null:-n; }
  const n=parseFloat(s); if(isNaN(n)) return null; return Math.abs(n)>60?null:n;
}
function roundsFromScores(arr){
  return (arr||[]).map(s=>{
    const holes = num(s.number_of_holes ?? s.holes) || 18;
    const diff = num(s.adjusted_scaled_up_differential ?? s.scaled_up_differential ?? s.differential ?? s.score_differential);
    return {
      date:(s.played_at||s.posted_at||s.adjusted_played_at||s.date||"").slice(0,10),
      score:num(s.adjusted_gross_score ?? s.gross_score ?? s.score),
      rating:num(s.course_rating ?? s.rating),
      slope:num(s.slope_rating ?? s.slope),
      tees:(s.tee_name||s.tee_set_side||s.tees||"").toString(),
      holes,
      type:(s.score_type_display_full||s.score_type||s.type||"").toString().charAt(0).toUpperCase(),
      differential:diff,
      course:(s.course_name||s.facility_name||"").toString()
    };
  }).filter(r=>r.date||r.score);
}

async function login(){
  const res = await fetch(CONFIG.base+"/golfer_login.json", {
    method:"POST",
    headers:{ "Content-Type":"application/json; charset=utf-8", "Accept":"application/json" },
    body: JSON.stringify({ user:{ email_or_ghin:CONFIG.email, password:CONFIG.password, remember_me:"true", source:"GHINcom" }, token: CONFIG.appToken })
  });
  if(!res.ok) throw new Error(`GHIN login failed (${res.status}). ${(await res.text()).slice(0,200)}`);
  const d = await res.json(); const gu = d.golfer_user||d.user||d;
  const t = gu.golfer_user_token||gu.token||d.token; if(!t) throw new Error("No token in login response."); return t;
}
async function ghinGet(token, path, params={}){
  const url = new URL(CONFIG.base+path);
  if(params.source===undefined) params.source="GHINcom";
  Object.entries(params).forEach(([k,v])=>{ if(v!=null&&v!=="") url.searchParams.set(k,String(v)); });
  const res = await fetch(url.toString(), { headers:{ "Authorization":"Bearer "+token, "Accept":"application/json" } });
  if(!res.ok) throw new Error(`GET ${path} ${res.status} ${(await res.text()).slice(0,150)}`);
  return res.json();
}
async function fetchRoster(token){
  let page=1, all=[];
  while(page<=80){
    const j = await ghinGet(token, `/clubs/${encodeURIComponent(CONFIG.clubId)}/golfers.json`, { per_page:100, page });
    const list = j.golfers||j.golfers_complete||j.data||(Array.isArray(j)?j:[]);
    all = all.concat(list);
    if(list.length<100) break; page++;
  }
  return all;
}
async function fetchScores(token, id){
  let all=[], seen=new Set();
  for(let p=1;p<=CONFIG.pages;p++){
    let j; try{ j = await ghinGet(token, `/golfers/${encodeURIComponent(id)}/scores.json`, { per_page:20, page:p }); }catch(e){ break; }
    const rev=(j.revision_scores&&j.revision_scores.scores)||[];
    const rec=(j.recent_scores&&j.recent_scores.scores)||[];
    let batch=[...rev,...rec]; if(!batch.length) batch=j.scores||j.data||[];
    if(!batch.length) break;
    for(const s of batch){ const k=s.id!=null?"id:"+s.id:`${s.played_at||""}|${s.adjusted_gross_score}`; if(!seen.has(k)){ seen.add(k); all.push(s); } }
    if(rec.length<20) break;
  }
  return all;
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

(async()=>{
  if(!CONFIG.email||!CONFIG.password) throw new Error("Set GHIN_EMAIL and GHIN_PASSWORD secrets.");
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!svc) throw new Error("Set FIREBASE_SERVICE_ACCOUNT secret (the full service-account JSON).");

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(svc)), databaseURL: CONFIG.databaseURL });
  const ref = admin.database().ref("rooms/"+CONFIG.room);

  const snap = await ref.get();
  const room = snap.val() || {};
  const st = room.state || { players:[], teams:[] };
  st.players = st.players || []; st.teams = st.teams || [];

  const token = await login();
  process.stderr.write("Logged into GHIN.\n");

  const golfers = await fetchRoster(token);
  process.stderr.write(`Roster: ${golfers.length} golfers.\n`);

  // Merge index/name from roster into existing players (preserve id, tournament flag, etc.)
  const byGhin = new Map(st.players.map(p=>[String(p.ghin), p]));
  let added=0;
  for(const g of golfers){
    if(String(g.status||"").toLowerCase()==="inactive") continue;
    const ghin = String(g.ghin||g.ghin_number||g.golfer_id||g.id||""); if(!ghin) continue;
    const idx = parseIndex(g.handicap_index ?? g.hi_display ?? g.display ?? g.handicap ?? g.hi_value);
    let p = byGhin.get(ghin);
    if(p){ p.index=idx; if(g.first_name)p.firstName=g.first_name.trim(); if(g.last_name)p.lastName=g.last_name.trim(); if(!p.ghinId&&(g.id||g.golfer_id))p.ghinId=g.id||g.golfer_id; }
    else { p={ id:Math.random().toString(36).slice(2,10), firstName:(g.first_name||"").trim(), lastName:(g.last_name||"").trim(), ghin, ghinId:g.id||g.golfer_id||ghin, index:idx, gender:g.gender||"M", rounds:[] }; st.players.push(p); byGhin.set(ghin,p); added++; }
  }

  // Decide whose SCORES to refresh: the tournament field (players on a team),
  // else tournament-flagged, else everyone.
  const teamIds = new Set(); st.teams.forEach(t=>Array.isArray(t)&&t.forEach(id=>id&&teamIds.add(id)));
  let targets = st.players.filter(p=>teamIds.has(p.id));
  if(!targets.length) targets = st.players.filter(p=>p.tournament);
  if(!targets.length) targets = st.players;
  process.stderr.write(`Pulling scores for ${targets.length} player(s).\n`);

  let ok=0, fail=0;
  for(const p of targets){
    const id = p.ghin || p.ghinId; if(!id){ continue; }
    let done=false;
    for(let a=0;a<2&&!done;a++){
      try{ p.rounds = roundsFromScores(await fetchScores(token, id)); ok++; done=true; }
      catch(e){ if(a===0) await sleep(400); else { fail++; process.stderr.write(`  scores failed for ${p.lastName}: ${e.message}\n`); } }
    }
    await sleep(120); // be gentle on the API
  }

  await ref.set({ state: st, _by:"nightly-job", updatedAt: Date.now() });
  process.stderr.write(`Done. New members: ${added}. Scores refreshed: ${ok}${fail?`, ${fail} failed`:""}. Wrote room "${CONFIG.room}".\n`);
  process.exit(0);
})().catch(e=>{ console.error("ERROR:", e.message); process.exit(1); });
