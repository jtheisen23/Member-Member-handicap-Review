#!/usr/bin/env node
/* =============================================================================
 * ghin-proxy.js — tiny zero-dependency helper to pull a golfer's score history
 * from GHIN and print it as JSON you can paste into the web app
 * (Import… → "Rounds for one existing player").
 *
 * WHY THIS EXISTS
 *   Browsers block direct calls to GHIN's servers (CORS), so the single-file
 *   web app can't fetch live data on its own. This little Node script logs in
 *   with YOUR GHIN account and fetches scores, then prints them to stdout.
 *
 * IMPORTANT / ETHICS
 *   - Use your own GHIN credentials.
 *   - Only pull score data your club/committee is entitled to review for the
 *     purpose of running a fair event.
 *   - GHIN's endpoints are unofficial and change over time. If a request fails,
 *     update the URLs in the CONFIG block below (or open an issue). The web app
 *     also accepts hand-captured GHIN JSON, so this script is optional.
 *
 * REQUIREMENTS
 *   Node 18+ (uses the built-in global fetch). Check with:  node --version
 *
 * USAGE
 *   Single golfer:
 *     node ghin-proxy.js --email you@example.com --password 'secret' --ghin 1234567 > player.json
 *
 *   Batch (one GHIN per line in ghins.txt), writes <ghin>.json into ./ghin-out:
 *     node ghin-proxy.js --email you@example.com --password 'secret' --batch ghins.txt --out ghin-out
 *
 *   Reuse a token instead of email/password:
 *     node ghin-proxy.js --token "<jwt>" --ghin 1234567 > player.json
 *
 *   Options:
 *     --limit N     how many recent scores to fetch (default 40)
 *     --base URL    override the API base (default https://api2.ghin.com/api/v1)
 * ============================================================================= */

const fs = require("fs");
const path = require("path");

/* ---------------------------------------------------------------------------
 * CONFIG — adjust here if GHIN changes its endpoints.
 * These reflect the commonly-used GHIN mobile API (api2.ghin.com, v1).
 * ------------------------------------------------------------------------- */
const CONFIG = {
  base: "https://api2.ghin.com/api/v1",
  loginPath: "/golfer_login.json",          // POST { user: { email_or_ghin, password, remember_me } }
  // Scores endpoint. {ghin} and {limit} are substituted. Some deployments use
  // "/scores.json?golfer_id={ghin}&offset=0&limit={limit}" instead — swap if needed.
  scoresPath: "/golfers/{ghin}/scores.json?offset=0&limit={limit}&statuses=Validated",
  golferPath: "/golfers/{ghin}.json"         // optional: golfer details incl. handicap_index
};

function parseArgs(argv){
  const o = { limit: 40, base: CONFIG.base };
  for (let i = 2; i < argv.length; i++){
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--email") o.email = next();
    else if (a === "--password") o.password = next();
    else if (a === "--token") o.token = next();
    else if (a === "--ghin") o.ghin = next();
    else if (a === "--batch") o.batch = next();
    else if (a === "--out") o.out = next();
    else if (a === "--limit") o.limit = parseInt(next(), 10) || 40;
    else if (a === "--base") o.base = next();
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

function usage(){
  console.error(`ghin-proxy.js — fetch GHIN scores as JSON

  node ghin-proxy.js --email YOU --password PASS --ghin 1234567 > player.json
  node ghin-proxy.js --email YOU --password PASS --batch ghins.txt --out ghin-out
  node ghin-proxy.js --token JWT --ghin 1234567 > player.json

Options: --limit N (default 40)  --base URL  --help
`);
}

async function login(base, emailOrGhin, password){
  const url = base + CONFIG.loginPath;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ user: { email_or_ghin: emailOrGhin, password, remember_me: true } })
  });
  if (!res.ok) throw new Error(`Login failed (${res.status} ${res.statusText}). ${await safeText(res)}`);
  const data = await res.json();
  // Token shows up under a few possible keys depending on API version.
  const token =
    data?.golfer_user?.golfer_user_token ||
    data?.golfer_user?.token ||
    data?.token ||
    data?.user?.token;
  if (!token) throw new Error("Logged in but no token found in response. Inspect the JSON / update CONFIG.");
  return token;
}

async function fetchScores(base, token, ghin, limit){
  const url = base + CONFIG.scoresPath.replace("{ghin}", encodeURIComponent(ghin)).replace("{limit}", String(limit));
  const res = await fetch(url, {
    headers: { "Authorization": "Bearer " + token, "Accept": "application/json" }
  });
  if (!res.ok) throw new Error(`Scores request failed (${res.status} ${res.statusText}). ${await safeText(res)}`);
  return res.json();
}

async function fetchGolfer(base, token, ghin){
  try{
    const url = base + CONFIG.golferPath.replace("{ghin}", encodeURIComponent(ghin));
    const res = await fetch(url, { headers: { "Authorization": "Bearer " + token, "Accept": "application/json" } });
    if (res.ok) return res.json();
  }catch(_){ /* optional, ignore */ }
  return null;
}

async function safeText(res){ try { return (await res.text()).slice(0, 300); } catch { return ""; } }

async function pullOne(base, token, ghin, limit){
  const [scores, golfer] = await Promise.all([
    fetchScores(base, token, ghin, limit),
    fetchGolfer(base, token, ghin)
  ]);
  // Normalize into a single object the web app's importer understands.
  const scoreArray =
    Array.isArray(scores) ? scores :
    Array.isArray(scores?.scores) ? scores.scores :
    Array.isArray(scores?.revision_scores) ? scores.revision_scores :
    Array.isArray(scores?.data) ? scores.data : [];
  return {
    ghin: String(ghin),
    handicap_index: golfer?.handicap_index ?? golfer?.golfer?.handicap_index ?? null,
    first_name: golfer?.first_name ?? golfer?.golfer?.first_name ?? null,
    last_name: golfer?.last_name ?? golfer?.golfer?.last_name ?? null,
    scores: scoreArray
  };
}

(async function main(){
  const o = parseArgs(process.argv);
  if (o.help || (!o.ghin && !o.batch)){ usage(); process.exit(o.help ? 0 : 1); }

  let token = o.token;
  try{
    if (!token){
      if (!o.email || !o.password){ throw new Error("Provide --email and --password (or --token)."); }
      token = await login(o.base, o.email, o.password);
      process.stderr.write("Logged in to GHIN.\n");
    }

    const targets = [];
    if (o.batch){
      const lines = fs.readFileSync(o.batch, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      targets.push(...lines);
    } else {
      targets.push(o.ghin);
    }

    if (o.out){
      fs.mkdirSync(o.out, { recursive: true });
      for (const g of targets){
        try{
          const data = await pullOne(o.base, token, g, o.limit);
          const file = path.join(o.out, `${g}.json`);
          fs.writeFileSync(file, JSON.stringify(data, null, 2));
          process.stderr.write(`✓ ${g} -> ${file} (${data.scores.length} scores)\n`);
        }catch(e){ process.stderr.write(`✗ ${g}: ${e.message}\n`); }
      }
      process.stderr.write(`Done. Paste each JSON file into the web app (Import… → box 2).\n`);
    } else {
      const data = await pullOne(o.base, token, targets[0], o.limit);
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
      process.stderr.write(`Fetched ${data.scores.length} scores for ${targets[0]}.\n`);
    }
  }catch(e){
    process.stderr.write("ERROR: " + e.message + "\n");
    process.stderr.write("If this is an endpoint problem, update the CONFIG block at the top of ghin-proxy.js.\n");
    process.exit(1);
  }
})();
