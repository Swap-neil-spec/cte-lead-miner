// Continuous 20s auto-loop — runs on GitHub Actions (free compute), device-off.
//
// GitHub cron can't fire every 20s and hammering Netlify's heavy /api/run-engine
// would blow its free-tier limits. So this is a LONG-LIVED job that loops every
// ~20s doing the mining locally on free CI, and only touches Netlify via the
// lightweight, idempotent /api/ingest — BATCHED. Server-side dedup (by email/
// LinkedIn key) guarantees zero duplicates no matter how often we push.
//
// Continuity: the job runs ~5.4h (under the 6h hard limit), then re-dispatches
// itself; a 6h schedule backstop restarts it if that ever fails. concurrency
// keeps exactly one loop alive. Net effect: a true 24/7 ~20s discovery heartbeat.

import {
  BASE, AUTH, sleep, post, mineRepo, mineProminent, mineNpm,
  fetchTopRepos, buildBatch, loadStats, reportStats, bumpYield,
  pickAdaptive, PROM_TIERS, NPM_TOPICS,
} from "./miner.mjs";

const GH = process.env.GH_TOKEN;
const RUN = Number(process.env.GITHUB_RUN_NUMBER || 0);
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

// --- Parachute directory (email + LinkedIn already in the data) --------------
// Queried directly (no Netlify) so the heavy work stays on free CI. We keep our
// OWN advancing offset (distinct from the hourly Netlify cron) to cover the ~14k
// consented profiles densely without re-treading the cron's pages.
let paraOffset = (RUN * 360) % 13800;
async function paraPage(size = 60) {
  const q = `query { profiles(limit: ${size}, offset: ${paraOffset}) { name linkedIn email location title targetRoles } }`;
  try {
    const r = await fetch("https://graph.parachutelist.com/v1/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
      body: JSON.stringify({ query: q }),
    });
    const d = await r.json().catch(() => ({}));
    const profiles = d?.data?.profiles || [];
    paraOffset = (paraOffset + size) % 13800;
    return profiles
      .filter((p) => p && p.email && p.linkedIn && p.name)
      .map((p) => {
        const parts = String(p.name).trim().split(/\s+/).filter(Boolean);
        return {
          "First name": parts[0] || "",
          "Last name": parts.slice(1).join(" "),
          Email: p.email,
          LinkedIn: p.linkedIn,
          Location: p.location || "",
          Role: p.title || p.targetRoles || "",
          Source: "parachute",
        };
      });
  } catch {
    return [];
  }
}

// --- Netlify ingest, batched -------------------------------------------------
let buffer = [];
const FLUSH_AT = 40; // push when the buffer reaches this many rows…
async function flush(force) {
  if (!buffer.length || (!force && buffer.length < FLUSH_AT)) return 0;
  const chunk = buffer;
  buffer = [];
  let stored = 0;
  for (let i = 0; i < chunk.length; i += 100) stored += await post(chunk.slice(i, i + 100));
  await reportStats(); // teach the adaptive loop what's working
  return stored;
}

// --- Self-continuity ---------------------------------------------------------
async function redispatch() {
  const tok = process.env.ACTIONS_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!tok || !repo) return;
  try {
    await fetch(`https://api.github.com/repos/${repo}/actions/workflows/continuous.yml/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "cte-loop" },
      body: JSON.stringify({ ref: process.env.GITHUB_REF_NAME || "master" }),
    });
    console.log("re-dispatched continuous loop for 24/7 continuity");
  } catch {}
}

// --- Main loop ---------------------------------------------------------------
const START = Date.now();
const BUDGET_MS = 5.4 * 3600 * 1000; // re-dispatch before the 6h hard limit
const TICK_MS = 20000;               // 20-second discovery heartbeat
const POOL_TTL = 25 * 60 * 1000;     // refresh repo pool every 25 min

let pool = [], batch = [], bi = 0, poolAt = 0;
async function refreshPool() {
  await loadStats();
  pool = await fetchTopRepos();
  batch = buildBatch(pool, 240); // a long rolling batch to iterate one-per-tick
  bi = 0; poolAt = Date.now();
  console.log(`pool refreshed: ${pool.length} repos, rolling batch ${batch.length}`);
}

async function tick(t) {
  if (!pool.length || Date.now() - poolAt > POOL_TTL || bi >= batch.length) await refreshPool();
  if (t % 4 === 0) {
    // Parachute — highest-yield, email+LinkedIn already in the data.
    const rows = await paraPage();
    buffer.push(...rows); bumpYield("parachute", rows.length);
    return `parachute +${rows.length}`;
  } else if (t % 12 === 5) {
    const q = pickAdaptive(PROM_TIERS, "prom:");
    const rows = await mineProminent(q, 8);
    buffer.push(...rows); bumpYield(`prom:${q}`, rows.length);
    return `prominent[${q}] +${rows.length}`;
  } else if (t % 12 === 9) {
    const q = pickAdaptive(NPM_TOPICS, "npm:");
    const rows = await mineNpm(q, 10);
    buffer.push(...rows); bumpYield(`npm:${q}`, rows.length);
    return `npm[${q}] +${rows.length}`;
  }
  // Default: mine one repo (adaptive language-weighted), dig deeper if it's hot.
  const repo = batch[bi++];
  if (!repo) return "idle";
  const rows = await mineRepo(repo.name);
  buffer.push(...rows); bumpYield(`repolang:${repo.lang}`, rows.length);
  if (rows.length >= 3) {
    const more = await mineRepo(repo.name, 2);
    buffer.push(...more); bumpYield(`repolang:${repo.lang}`, more.length);
    return `${repo.name} +${rows.length}+${more.length}`;
  }
  return `${repo.name} +${rows.length}`;
}

(async () => {
  if (!BASE || !GH || !process.env.NETLIFY_AUTH) {
    console.error("Missing env: NETLIFY_BASE / NETLIFY_AUTH / GH_TOKEN");
    process.exit(1);
  }
  console.log(`continuous loop start — ~20s heartbeat, budget ${(BUDGET_MS / 3600000).toFixed(1)}h`);
  let t = 0, totalStored = 0;
  while (Date.now() - START < BUDGET_MS) {
    const t0 = Date.now();
    try {
      const what = await tick(t);
      // Time-flush every ~2 min even if the buffer is small, so nothing lingers.
      const stored = await flush(t % 6 === 0);
      totalStored += stored;
      if (what !== "idle") console.log(`t${t}: ${what}  (buffer ${buffer.length}, stored ${totalStored})`);
    } catch (e) {
      console.log(`t${t} error: ${e?.message || e}`);
      await sleep(3000);
    }
    t++;
    const spent = Date.now() - t0;
    await sleep(Math.max(2000, TICK_MS - spent)); // steady ~20s cadence
  }
  await flush(true);
  console.log(`loop budget reached — ${totalStored} stored this shift.`);
  await redispatch();
})();
