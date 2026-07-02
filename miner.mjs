// Free-compute lead miner — runs on GitHub Actions (no 26s limit, free minutes).
// Mines active contributors of top repos: GitHub's commits API gives each
// contributor's real name + email (from the commit) + login in one call; their
// profile gives LinkedIn. Result = COMPLETE dev leads, email already in the data.
// Posts them to the engine's /api/ingest, which gates + dedups + persists.
//
// $0: all GitHub endpoints are free (read-only token). No paid API touched.
//
// This file also EXPORTS its helpers so the continuous loop (loop.mjs) reuses the
// exact same mining + gate-row logic — one source of truth. The one-shot run at the
// bottom only executes when this file is run directly (guarded by isMain).

import { pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

export const BASE = process.env.NETLIFY_BASE;
const AUTH = "Basic " + Buffer.from(process.env.NETLIFY_AUTH || "").toString("base64"); // "user:pass"
const GH = process.env.GH_TOKEN;
const ghHeaders = { Accept: "application/vnd.github+json", Authorization: `Bearer ${GH}`, "User-Agent": "cte-lead-miner" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Adaptive: learn which slices produce leads and double down automatically -
// The backend (/api/miner-stats) keeps cumulative per-slice yield. Each run we
// load it, bias effort toward high-yield slices (exploit) while still trying
// others (explore + optimistic init), then report this run's yield back.
let STATS = {};                     // { sliceKey: { leads, runs } }
const YIELD = {};                   // this run's per-slice yield to report back
const RUN = Number(process.env.GITHUB_RUN_NUMBER || 0);
function bumpYield(key, n) { if (key) YIELD[key] = (YIELD[key] || 0) + (n || 0); }
async function loadStats() {
  try {
    const r = await fetch(`${BASE}/api/miner-stats`, { headers: { Authorization: AUTH } });
    STATS = (await r.json()).slices || {};
  } catch { STATS = {}; }
}
async function reportStats() {
  // DELTA semantics: capture the yield accrued since the last report, then CLEAR it.
  // (reportStats is called after every flush in the continuous loop — without the
  // clear, each call would re-post the running total and the server would double-count.)
  const updates = Object.entries(YIELD).map(([key, leads]) => ({ key, leads }));
  for (const k of Object.keys(YIELD)) delete YIELD[k];
  if (!updates.length) return;
  try {
    await fetch(`${BASE}/api/miner-stats`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTH },
      body: JSON.stringify({ updates }),
    });
  } catch {}
}
// Smoothed yield-per-run. Unseen slices get an optimistic score (explore new);
// low-yield slices decay but never hit zero (Laplace smoothing = second chances).
function score(key) {
  const s = STATS[key];
  if (!s || !s.runs) return 8;
  return (s.leads + 2) / (s.runs + 1);
}
// Pick one slice: exploit the best 4 of every 5 runs, rotate-explore the 5th.
function pickAdaptive(items, prefix) {
  if (RUN % 5 === 4) return items[RUN % items.length];
  return [...items].sort((a, b) => score(prefix + b) - score(prefix + a))[0];
}

// TOP ENGINEERING TALENT — the most impactful GitHub searches (all sorted by
// followers desc in mineProminent). Global icons + per-language leaders + the top
// devs in each major tech hub + prolific builders. Auto-double-down concentrates
// on whichever elite slices yield the most REACHABLE talent (public LinkedIn+email).
const PROM_TIERS = [
  // global icons / most-followed engineers on the planet
  "followers:>10000", "followers:5000..10000", "followers:3000..5000",
  "followers:2000..3000", "followers:1200..2000", "followers:800..1200",
  // language leaders (top engineers per stack)
  "followers:1500..5000 language:python", "followers:1500..5000 language:javascript",
  "followers:1200..4000 language:typescript", "followers:1200..4000 language:go",
  "followers:1200..4000 language:rust", "followers:1000..4000 language:java",
  "followers:800..3000 language:c++", "followers:800..3000 language:swift",
  "followers:800..3000 language:kotlin", "followers:800..3000 language:scala",
  // top talent in the major tech hubs (worldwide reach)
  'followers:600..4000 location:"San Francisco"', 'followers:600..4000 location:"New York"',
  "followers:600..4000 location:London", "followers:600..4000 location:Berlin",
  "followers:600..4000 location:Bangalore", "followers:600..4000 location:Singapore",
  "followers:600..4000 location:Toronto", "followers:600..4000 location:Amsterdam",
  "followers:600..4000 location:Paris", "followers:600..4000 location:Tokyo",
  // prolific elite builders (depth of work, not just fame)
  "repos:>80 followers:>1500", "repos:>50 followers:800..2500",
];
const NPM_TOPICS = ["react", "typescript", "cli", "api", "server", "graphql",
  "testing", "vite", "nextjs", "node", "database", "ai"];

// Broad set of top repos across languages/domains. Extend freely — more repos =
// more coverage. A batch is mined each run (rotated by run number).
const REPOS = [
  "facebook/react", "vercel/next.js", "microsoft/vscode", "kubernetes/kubernetes",
  "tensorflow/tensorflow", "pytorch/pytorch", "rust-lang/rust", "golang/go",
  "nodejs/node", "django/django", "rails/rails", "laravel/laravel", "angular/angular",
  "vuejs/core", "sveltejs/svelte", "denoland/deno", "supabase/supabase", "pola-rs/polars",
  "huggingface/transformers", "langchain-ai/langchain", "openai/openai-python",
  "pandas-dev/pandas", "scikit-learn/scikit-learn", "apache/spark", "elastic/elasticsearch",
  "hashicorp/terraform", "grafana/grafana", "prometheus/prometheus", "ansible/ansible",
  "flutter/flutter", "expo/expo", "tauri-apps/tauri", "electron/electron",
  "fastapi/fastapi", "spring-projects/spring-boot", "dotnet/runtime",
  "apache/airflow", "dbt-labs/dbt-core", "ray-project/ray", "ggerganov/llama.cpp",
  "ollama/ollama", "vllm-project/vllm", "n8n-io/n8n", "appwrite/appwrite",
  "strapi/strapi", "nestjs/nest", "remix-run/react-router", "withastro/astro",
  "prisma/prisma", "trpc/trpc", "tRPC/trpc", "redis/redis", "postgres/postgres",
  "python/cpython", "microsoft/TypeScript", "facebook/react-native", "storybookjs/storybook",
  "vitejs/vite", "webpack/webpack", "babel/babel", "eslint/eslint", "prettier/prettier",
  "kubernetes-sigs/kustomize", "cilium/cilium", "envoyproxy/envoy", "moby/moby",
  "containerd/containerd", "etcd-io/etcd", "gin-gonic/gin", "fiber/fiber", "gofiber/fiber",
  "spencermountain/compromise", "d3/d3", "chartjs/Chart.js", "mrdoob/three.js",
  "pixijs/pixijs", "godotengine/godot", "bevyengine/bevy", "tokio-rs/tokio",
  "serde-rs/serde", "clap-rs/clap", "rustls/rustls", "astral-sh/ruff", "astral-sh/uv",
  "pydantic/pydantic", "encode/httpx", "tiangolo/sqlmodel", "streamlit/streamlit",
  "gradio-app/gradio", "chroma-core/chroma", "milvus-io/milvus", "qdrant/qdrant",
  "weaviate/weaviate", "run-llama/llama_index", "microsoft/autogen", "crewAIInc/crewAI",
];

function findLinkedin(t) {
  const m = String(t || "").match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/([A-Za-z0-9\-_%]+)/i);
  return m ? `https://www.linkedin.com/in/${m[1].replace(/\/+$/, "")}` : null;
}
function validEmail(e) {
  e = String(e || "").toLowerCase().trim();
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e)) return null;
  if (/noreply|no-reply|users\.noreply\.github\.com|githubusercontent|@github\.com$|example\.com|\.local$/.test(e)) return null;
  return e;
}

async function j(url) {
  const r = await fetch(url, { headers: ghHeaders });
  if (r.status === 403) { // rate limited — wait for reset
    const reset = Number(r.headers.get("x-ratelimit-reset")) * 1000;
    const wait = Math.max(1000, reset - Date.now() + 2000);
    if (wait < 15 * 60000) { await sleep(wait); return j(url); }
  }
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function socials(login) {
  try {
    const a = await j(`https://api.github.com/users/${login}/social_accounts`);
    return Array.isArray(a) ? a.map((s) => s.url).join(" ") : "";
  } catch { return ""; }
}

// --- GraphQL batch profile resolver (the discovery speedup) ------------------
// Resolves up to ~40 logins' profile + social accounts in ONE request, on GitHub's
// SEPARATE 5000-points/hr GraphQL budget — replacing 2 REST calls per contributor.
// Same fields the REST path used (websiteUrl=blog, bio, socialAccounts), so the
// LinkedIn/email/name gate is byte-for-byte identical; only the fetch is cheaper.
async function gql(query) {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...ghHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (r.status === 403 || r.status === 429) { // rate/secondary limit — back off ONCE, then let REST take over
    const ra = Number(r.headers.get("retry-after")); // secondary limits use retry-after
    const reset = Number(r.headers.get("x-ratelimit-reset")) * 1000;
    const wait = ra ? ra * 1000 : Math.max(2000, (reset || Date.now() + 30000) - Date.now() + 2000);
    if (wait < 60000) { await sleep(wait); return gql(query); } // short waits only; long ones -> throw -> REST fallback
  }
  if (!r.ok) throw new Error(`gql ${r.status}`);
  return r.json();
}
// Resolve a single login via REST (fallback when GraphQL is saturated). Shapes the
// result exactly like the GraphQL node so socialText()/the gate work unchanged.
async function restProfile(login) {
  try {
    const p = await j(`https://api.github.com/users/${login}`);
    if (!p || p.type !== "User") return null;
    const urls = (await socials(login)).split(/\s+/).filter(Boolean).map((u) => ({ url: u }));
    return { login, name: p.name, email: p.email, location: p.location, websiteUrl: p.blog, bio: p.bio, socialAccounts: { nodes: urls } };
  } catch { return null; }
}
async function profilesBatch(logins) {
  const out = {};
  if (!logins.length) return out;
  const f = `login name email location websiteUrl bio socialAccounts(first:6){nodes{url}}`;
  const q = `query{` + logins.map((lg, i) => `u${i}:user(login:${JSON.stringify(lg)}){${f}}`).join(" ") + `}`;
  try {
    const d = await gql(q);
    logins.forEach((lg, i) => { const u = d?.data?.[`u${i}`]; if (u) out[lg.toLowerCase()] = u; });
  } catch { /* GraphQL saturated — fall through to REST */ }
  // REST fallback for whatever GraphQL didn't return (uses the SEPARATE REST budget,
  // so a GraphQL stall no longer zeroes everything). Bounded to protect REST quota.
  const missing = logins.filter((lg) => !out[lg.toLowerCase()]);
  for (const lg of missing.slice(0, 40)) {
    const p = await restProfile(lg);
    if (p) out[lg.toLowerCase()] = p;
  }
  return out;
}
function socialText(p) {
  return [p?.websiteUrl || "", p?.bio || "", ...((p?.socialAccounts?.nodes) || []).map((n) => n.url)].join(" ");
}
// Logins resolved this shift — skip re-fetching (server-side dedup handles re-emits,
// so skipping a repeat costs zero leads and saves the API calls). Compounds over a run.
const SEEN = new Set();

// Batch-resolve a list of GitHub logins into COMPLETE leads: GraphQL profile
// resolution (~40/call) → LinkedIn + email (public / commit-email) → same gate.
// Skips already-seen logins. Shared by every login-based vector below.
async function resolveLogins(logins) {
  const fresh = [...new Set(logins.filter((lg) => lg && !SEEN.has(lg.toLowerCase())))];
  const rows = [];
  for (let i = 0; i < fresh.length; i += 40) {
    const chunk = fresh.slice(i, i + 40);
    const profs = await profilesBatch(chunk);
    for (const login of chunk) {
      SEEN.add(login.toLowerCase());
      const p = profs[login.toLowerCase()];
      if (!p) continue;
      const li = findLinkedin(socialText(p));
      if (!li) continue;
      let email = validEmail(p.email);
      if (!email) email = await commitEmail(login);
      if (!email) continue;
      const name = String(p.name || "").trim();
      const parts = name.split(/\s+/).filter(Boolean);
      if (parts.length < 2) continue;
      rows.push({
        "First name": parts[0], "Last name": parts.slice(1).join(" "),
        Email: email, LinkedIn: li, Location: p.location || "",
        Role: "software_engineer", Source: "contributors",
      });
    }
  }
  return rows;
}

// STARGAZERS — the vast untapped pool: developers who starred a popular repo.
// One list call yields 100 logins; resolve them in ~3 GraphQL calls. Bottomless.
async function mineStargazers(repo, page = 1) {
  try {
    const gz = await j(`https://api.github.com/repos/${repo}/stargazers?per_page=100&page=${page}`);
    return resolveLogins((Array.isArray(gz) ? gz : []).map((u) => u.login));
  } catch { return []; }
}

// SOCIAL GRAPH — traverse a seed dev's followers + following. Open-ended: every
// resolved dev is a new seed, so coverage expands across the whole network over time.
async function mineGraph(seed) {
  try {
    const [f1, f2] = await Promise.all([
      j(`https://api.github.com/users/${seed}/followers?per_page=100`).catch(() => []),
      j(`https://api.github.com/users/${seed}/following?per_page=100`).catch(() => []),
    ]);
    const logins = [...(Array.isArray(f1) ? f1 : []), ...(Array.isArray(f2) ? f2 : [])].map((u) => u.login);
    return resolveLogins(logins);
  } catch { return []; }
}
// Pick a well-connected seed login for graph traversal (top-followed dev for a query).
async function graphSeed(q) {
  try {
    const res = await j(`https://api.github.com/search/users?q=${encodeURIComponent(q)}&sort=followers&order=desc&per_page=10`);
    const items = (res.items || []).map((u) => u.login).filter((lg) => lg && !SEEN.has(lg.toLowerCase()));
    return items[0] || null;
  } catch { return null; }
}

async function mineRepo(repo, page = 1) {
  const rows = [];
  let commits;
  try { commits = await j(`https://api.github.com/repos/${repo}/commits?per_page=100&page=${page}`); }
  catch { return rows; }
  if (!Array.isArray(commits)) return rows;
  const byLogin = {};
  for (const c of commits) {
    const login = c.author?.login;
    const email = validEmail(c.commit?.author?.email); // email already in the commit — no call
    const name = c.commit?.author?.name || "";
    if (!login || !email) continue;
    const key = login.toLowerCase();
    if (SEEN.has(key) || byLogin[key]) continue; // skip already-resolved this shift
    byLogin[key] = { login, name, email };
  }
  const entries = Object.values(byLogin);
  for (let i = 0; i < entries.length; i += 40) {
    const chunk = entries.slice(i, i + 40);
    const profs = await profilesBatch(chunk.map((a) => a.login)); // 1 call resolves ~40 people
    for (const a of chunk) {
      SEEN.add(a.login.toLowerCase());
      const p = profs[a.login.toLowerCase()];
      if (!p) continue;
      const li = findLinkedin(socialText(p));
      if (!li) continue; // LinkedIn required — same gate as before
      const email = validEmail(p.email) || a.email;
      const name = String(p.name || a.name || "").trim();
      const parts = name.split(/\s+/).filter(Boolean);
      if (parts.length < 2) continue; // need a real full name (avoids handles)
      rows.push({
        "First name": parts[0],
        "Last name": parts.slice(1).join(" "),
        Email: email,
        LinkedIn: li,
        Location: p.location || "",
        Role: "software_engineer",
        Source: "contributors",
      });
    }
  }
  return rows;
}

// Commit-email for a single login (for prominent devs without a public email).
async function commitEmail(login) {
  try {
    const events = await j(`https://api.github.com/users/${login}/events/public?per_page=100`);
    const counts = {};
    for (const ev of (Array.isArray(events) ? events : [])) {
      if (ev.type !== "PushEvent") continue;
      for (const c of (ev.payload?.commits || [])) {
        const e = validEmail(c.author?.email);
        if (e) counts[e] = (counts[e] || 0) + 1;
      }
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  } catch { return null; }
}

// Build a COMPLETE lead from a GitHub login: profile -> LinkedIn (socials/blog/bio)
// + email (public / provided fallback / commit-email). Returns null if incomplete.
async function leadFromLogin(login, fallbackEmail) {
  const key = login.toLowerCase();
  if (SEEN.has(key)) return null;
  SEEN.add(key);
  const p = (await profilesBatch([login]))[key]; // 1 GraphQL call
  if (!p) return null;
  const li = findLinkedin(socialText(p));
  if (!li) return null;
  const email = validEmail(p.email) || validEmail(fallbackEmail) || await commitEmail(login);
  if (!email) return null;
  const name = String(p.name || "").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return {
    "First name": parts[0], "Last name": parts.slice(1).join(" "),
    Email: email, LinkedIn: li, Location: p.location || "",
    Role: "software_engineer", Source: "contributors",
  };
}

// PROMINENT DEVS: highly-followed developers (proxy for high GitHub stars) — the
// accomplished, in-demand talent. One follower tier per run, rotating.
async function mineProminent(q, limit = 100) {
  let logins = [];
  try {
    const res = await j(`https://api.github.com/search/users?q=${encodeURIComponent(q)}&sort=followers&order=desc&per_page=100`);
    logins = (res.items || []).map((u) => u.login).filter(Boolean).slice(0, limit);
  } catch { return []; }
  return resolveLogins(logins);
}

// NPM AUTHORS: a Parachute-style email-in-data directory — the npm registry exposes
// maintainer/author emails; LinkedIn resolves via the package's GitHub owner.
// Package authors are professional JS/TS devs; one topic slice per run, rotating.
async function mineNpm(q, limit = 100) {
  let objs = [];
  try {
    const r = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=100`);
    objs = ((await r.json()).objects || []).slice(0, limit);
  } catch { return []; }
  const rows = [];
  const seenOwner = new Set();
  for (const o of objs) {
    const pkg = o.package || {};
    const repoUrl = pkg.links?.repository || "";
    const m = repoUrl.match(/github\.com[/:]([A-Za-z0-9\-_.]+)\/[A-Za-z0-9\-_.]+/i);
    const owner = m && m[1];
    if (!owner || seenOwner.has(owner.toLowerCase())) continue;
    seenOwner.add(owner.toLowerCase());
    const row = await leadFromLogin(owner, pkg.publisher?.email || pkg.author?.email);
    if (row) { row.Source = "contributors"; rows.push(row); await sleep(45); }
  }
  return rows;
}

async function post(rows) {
  if (!rows.length) return 0;
  try {
    const r = await fetch(`${BASE}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTH },
      body: JSON.stringify({ rows }),
    });
    const d = await r.json().catch(() => ({}));
    return d?.stats?.newlyStored ?? d?.stats?.shipped ?? 0;
  } catch { return 0; }
}

// Ambitious "whole open-source ecosystem" pool: many search slices (star tiers ×
// languages × recency) -> up to ~1600 active repos, biased to professional projects.
const REPO_QUERIES = [
  "stars:>3000", "stars:1500..3000",
  "stars:800..1500 language:python", "stars:800..1500 language:javascript",
  "stars:800..1500 language:typescript", "stars:600..1500 language:go",
  "stars:600..1500 language:rust", "stars:600..1500 language:java",
  "stars:500..1200 language:c++", "stars:500..1200 language:c#",
  "stars:400..1000 language:php", "stars:400..1000 language:ruby",
  "stars:400..1000 language:swift", "stars:400..1000 language:kotlin",
  "stars:300..800 language:python pushed:>2026-03-01",
  "stars:300..800 language:typescript pushed:>2026-03-01",
  // long tail — the deep pool for 100k (still active, professional projects)
  "stars:120..400 language:python pushed:>2026-01-01",
  "stars:120..400 language:javascript pushed:>2026-01-01",
  "stars:120..400 language:typescript pushed:>2026-01-01",
  "stars:120..400 language:go pushed:>2026-01-01",
  "stars:120..400 language:rust pushed:>2026-01-01",
  "stars:120..400 language:java pushed:>2026-01-01",
  "stars:80..250 language:c++ pushed:>2026-01-01",
  "stars:80..250 language:c# pushed:>2026-01-01",
  "stars:80..250 language:ruby pushed:>2026-01-01",
  "stars:80..250 language:php pushed:>2026-01-01",
  "stars:80..250 language:kotlin pushed:>2026-01-01",
  "stars:80..250 language:swift pushed:>2026-01-01",
];
// Skip student/course/tutorial repos -> bias to working-age professional devs.
const REPO_SKIP = /(tutorial|homework|assignment|bootcamp|cs50|100-?days|freecodecamp|awesome[-_]|[-_]awesome|coding-?interview|leet-?code|hacktoberfest|^examples?$|[-_]examples?$|learn[-_]|[-_]learning|roadmap|cheat-?sheet|interview|[-_]course|[-_]book|[-_]notes|study|beginner|for-?beginners|hello-?world|my-?portfolio|test-?repo|playground|sandbox)/i;

async function fetchTopRepos() {
  const out = [];
  const seen = new Set();
  for (const q of REPO_QUERIES) {
    try {
      const res = await j(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100`);
      for (const r of (res.items || [])) {
        if (r.full_name && !REPO_SKIP.test(r.full_name) && !seen.has(r.full_name)) {
          seen.add(r.full_name);
          out.push({ name: r.full_name, lang: String(r.language || "other").toLowerCase() });
        }
      }
      await sleep(2200); // GitHub search: 30 req/min
    } catch {}
  }
  for (const r of REPOS) if (!seen.has(r)) out.push({ name: r, lang: "seed" });
  return out;
}

// Build this run's repo batch: allocate more slots to high-yield LANGUAGES
// (double down on winners), and rotate WITHIN each language so we still hit fresh
// repos every run (keeps expanding coverage automatically).
function buildBatch(pool, size) {
  const byLang = {};
  for (const r of pool) (byLang[r.lang] ||= []).push(r);
  const langs = Object.keys(byLang);
  const weights = langs.map((l) => Math.max(0.25, score(`repolang:${l}`)));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const batch = [];
  langs.forEach((l, i) => {
    const n = Math.max(1, Math.round(size * (weights[i] / total)));
    const arr = byLang[l];
    const start = (RUN * n) % arr.length;
    for (let k = 0; k < n; k++) batch.push(arr[(start + k) % arr.length]);
  });
  return batch.slice(0, size);
}

export {
  AUTH, sleep, j, socials, mineRepo, commitEmail, leadFromLogin, resolveLogins,
  mineProminent, mineNpm, mineStargazers, mineGraph, graphSeed, post,
  fetchTopRepos, buildBatch, loadStats, reportStats, bumpYield, pickAdaptive, score,
  PROM_TIERS, NPM_TOPICS,
};

async function runOnce() {
  if (!BASE || !GH || !process.env.NETLIFY_AUTH) {
    console.error("Missing env: NETLIFY_BASE / NETLIFY_AUTH / GH_TOKEN");
    process.exit(1);
  }
  await loadStats(); // learn from prior runs
  const pool = await fetchTopRepos();
  const BATCH = 55;
  const batch = buildBatch(pool, BATCH);
  console.log(`repo pool: ${pool.length}, batch: ${batch.length} (yield-weighted by language)`);

  let mined = 0, stored = 0;

  const postAll = async (rows) => { let s = 0; for (let i = 0; i < rows.length; i += 100) s += await post(rows.slice(i, i + 100)); return s; };

  // Prominent devs (high-followed = high-star talent) — adaptively pick a tier.
  const promTier = pickAdaptive(PROM_TIERS, "prom:");
  const prom = await mineProminent(promTier);
  const promNew = await postAll(prom);
  stored += promNew; mined += prom.length; bumpYield(`prom:${promTier}`, promNew); // net-new attribution
  console.log(`prominent devs [${promTier}]: ${prom.length} mined, ${promNew} fresh`);

  // npm authors (Parachute-style email-in-data directory) — adaptively pick a topic.
  const npmTopic = pickAdaptive(NPM_TOPICS, "npm:");
  const npm = await mineNpm(npmTopic);
  const npmNew = await postAll(npm);
  stored += npmNew; mined += npm.length; bumpYield(`npm:${npmTopic}`, npmNew);
  console.log(`npm authors [${npmTopic}]: ${npm.length} mined, ${npmNew} fresh`);

  // STARGAZERS — vast untapped pool. Rotate repo + page across runs (open-ended).
  for (let k = 0; k < 3; k++) {
    const repo = pool[(RUN * 3 + k) % pool.length];
    const page = ((RUN + k) % 20) + 1;
    const gz = await mineStargazers(repo.name, page);
    const gzNew = await postAll(gz);
    stored += gzNew; mined += gz.length; bumpYield("stargazers", gzNew);
    console.log(`stargazers ${repo.name} p${page}: ${gz.length} mined, ${gzNew} fresh`);
  }

  // SOCIAL GRAPH — traverse a well-connected seed's network (open-ended expansion).
  const seed = await graphSeed(pickAdaptive(PROM_TIERS, "prom:"));
  if (seed) {
    const g = await mineGraph(seed);
    const gNew = await postAll(g);
    stored += gNew; mined += g.length; bumpYield("graph", gNew);
    console.log(`graph @${seed}: ${g.length} mined, ${gNew} fresh`);
  }

  for (const repo of batch) {
    const rows = await mineRepo(repo.name);
    let sNew = await postAll(rows);
    mined += rows.length;
    // Winner-following: keep digging deeper WHILE the repo stays hot (fresh-yield).
    let page = 1, last = rows.length;
    while (last >= 3 && page < 4) {
      page++;
      const more = await mineRepo(repo.name, page);
      sNew += await postAll(more);
      mined += more.length; last = more.length;
    }
    stored += sNew; bumpYield(`repolang:${repo.lang}`, sNew);
    console.log(`${repo.name}: ${sNew} fresh${page > 1 ? ` (deep x${page})` : ""}`);
  }

  await reportStats(); // teach the next run what worked
  console.log(`DONE — mined ${mined} complete leads, ${stored} newly stored in backend.`);
}

if (isMain) runOnce();
