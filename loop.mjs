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
  mineStargazers, mineGraph, graphSeed,
  fetchTopRepos, buildBatch, loadStats, reportStats, bumpYield,
  pickAdaptive, score, PROM_TIERS, NPM_TOPICS,
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

// --- Netlify ingest, batched PER SOURCE, attributed by NET-NEW ---------------
// Buffers are kept per source so each flush learns that source's fresh-yield
// (newlyStored / mined). Attributing NET-NEW (not gross mined) is what lets
// auto-double-down abandon an exhausted source (e.g. Parachute after a full pass,
// where every row is a dedup) and pour effort into sources still producing FRESH
// leads — essential when the goal is 100k *new* records.
const SOURCES = ["parachute", "repo", "prom", "npm", "stars", "graph"];
const buffers = { parachute: [], repo: [], prom: [], npm: [], stars: [], graph: [] };
const pending = { parachute: {}, repo: {}, prom: {}, npm: {}, stars: {}, graph: {} }; // sliceKey -> gross since last flush
const FLUSH_AT = 40;
let totalBuffered = () => SOURCES.reduce((a, s) => a + buffers[s].length, 0);
function stash(source, sliceKey, rows) {
  buffers[source].push(...rows);
  pending[source][sliceKey] = (pending[source][sliceKey] || 0) + rows.length;
}
async function flushSource(source, force) {
  const buf = buffers[source];
  if (!buf.length || (!force && buf.length < FLUSH_AT)) return 0;
  buffers[source] = [];
  const pend = pending[source]; pending[source] = {};
  const gross = buf.length;
  let stored = 0;
  for (let i = 0; i < buf.length; i += 100) stored += await post(buf.slice(i, i + 100));
  const freshRatio = gross ? stored / gross : 0; // 1.0 = all fresh, 0 = fully exhausted
  for (const [k, g] of Object.entries(pend)) bumpYield(k, g * freshRatio); // net-new attribution
  return stored;
}
async function flush(force) {
  let stored = 0;
  for (const s of SOURCES) stored += await flushSource(s, force);
  if (stored > 0 || force) await reportStats(); // teach the loop what's producing FRESH leads
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

// --- AUTO-DOUBLE-DOWN ---------------------------------------------------------
// Score each SOURCE by its best slice's live yield-per-run, then pick each tick's
// source by weighted chance (with an exploration floor so nothing is fully starved).
// The winner automatically earns a bigger share of the 20s heartbeats; when yields
// shift, the mix shifts with them. Re-scored every ~5 min from fresh backend stats.
const EXPLORE_FLOOR = 2;
function sourceScores() {
  const langs = pool.length ? [...new Set(pool.map((r) => r.lang))] : ["seed"];
  return {
    parachute: score("parachute"),
    repo: Math.max(...langs.map((l) => score(`repolang:${l}`))),
    prom: Math.max(...PROM_TIERS.map((tt) => score(`prom:${tt}`))),
    npm: Math.max(...NPM_TOPICS.map((tt) => score(`npm:${tt}`))),
    stars: score("stargazers"),
    graph: score("graph"),
  };
}
let starPage = 1; // advances so stargazer coverage keeps expanding open-endedly
function pickSource() {
  const s = sourceScores();
  const entries = Object.entries(s).map(([k, v]) => [k, Math.max(EXPLORE_FLOOR, v)]);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  let r = Math.random() * total;
  for (const [k, v] of entries) { r -= v; if (r <= 0) return k; }
  return entries[0][0];
}
function topSource() {
  return Object.entries(sourceScores()).sort((a, b) => b[1] - a[1])[0][0];
}

async function tick() {
  if (!pool.length || Date.now() - poolAt > POOL_TTL || bi >= batch.length) await refreshPool();
  const type = pickSource(); // auto-double-down: more ticks go to the winner

  if (type === "parachute") {
    // Bigger pages when Parachute is the runaway winner (double-down on depth too).
    const size = topSource() === "parachute" ? 90 : 60;
    const rows = await paraPage(size);
    stash("parachute", "parachute", rows);
    return `parachute +${rows.length}`;
  }
  if (type === "prom") {
    const q = pickAdaptive(PROM_TIERS, "prom:");
    const rows = await mineProminent(q, 8);
    stash("prom", `prom:${q}`, rows);
    return `prominent[${q}] +${rows.length}`;
  }
  if (type === "npm") {
    const q = pickAdaptive(NPM_TOPICS, "npm:");
    const rows = await mineNpm(q, 10);
    stash("npm", `npm:${q}`, rows);
    return `npm[${q}] +${rows.length}`;
  }
  if (type === "stars") {
    // Stargazers of a rotating repo/page — a bottomless pool of fresh devs.
    const repo = batch[bi++] || pool[0];
    if (!repo) return "idle";
    const page = (starPage++ % 25) + 1;
    const rows = await mineStargazers(repo.name, page);
    stash("stars", "stargazers", rows);
    return `stars ${repo.name} p${page} +${rows.length}`;
  }
  if (type === "graph") {
    // Traverse a well-connected dev's network — open-ended coverage expansion.
    const seed = await graphSeed(pickAdaptive(PROM_TIERS, "prom:"));
    if (!seed) return "idle";
    const rows = await mineGraph(seed);
    stash("graph", "graph", rows);
    return `graph @${seed} +${rows.length}`;
  }
  // repo: mine one, then keep digging deeper WHILE it stays hot (auto-double-down).
  const repo = batch[bi++];
  if (!repo) return "idle";
  let page = 1, got = await mineRepo(repo.name, page);
  stash("repo", `repolang:${repo.lang}`, got);
  let extra = 0;
  while (got.length >= 3 && page < 4) { // very hot repos get pages 2, 3, 4
    page++;
    got = await mineRepo(repo.name, page);
    stash("repo", `repolang:${repo.lang}`, got);
    extra += got.length;
  }
  return extra ? `${repo.name} +${got.length + extra} (deep x${page})` : `${repo.name} +${got.length}`;
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
      // Re-pull fresh yields every ~5 min so auto-double-down tracks what's working NOW.
      if (t > 0 && t % 15 === 0) {
        await loadStats();
        const s = sourceScores();
        console.log(`re-weight: ${Object.entries(s).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" ")}`);
      }
      const what = await tick();
      // Time-flush every ~2 min even if the buffer is small, so nothing lingers.
      const stored = await flush(t % 6 === 0);
      totalStored += stored;
      if (what !== "idle") console.log(`t${t}: ${what}  (buffer ${totalBuffered()}, stored ${totalStored})`);
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
