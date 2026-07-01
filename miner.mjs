// Free-compute lead miner — runs on GitHub Actions (no 26s limit, free minutes).
// Mines active contributors of top repos: GitHub's commits API gives each
// contributor's real name + email (from the commit) + login in one call; their
// profile gives LinkedIn. Result = COMPLETE dev leads, email already in the data.
// Posts them to the engine's /api/ingest, which gates + dedups + persists.
//
// $0: all GitHub endpoints are free (read-only token). No paid API touched.

const BASE = process.env.NETLIFY_BASE;
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
  const updates = Object.entries(YIELD).map(([key, leads]) => ({ key, leads }));
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

const PROM_TIERS = [
  "followers:>3000", "followers:1500..3000", "followers:800..1500",
  "followers:500..800", "followers:300..500 language:python",
  "followers:300..500 language:javascript", "followers:300..500 language:go",
  "followers:300..500 language:rust",
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

async function mineRepo(repo, page = 1) {
  const rows = [];
  let commits;
  try { commits = await j(`https://api.github.com/repos/${repo}/commits?per_page=100&page=${page}`); }
  catch { return rows; }
  if (!Array.isArray(commits)) return rows;
  const byLogin = {};
  for (const c of commits) {
    const login = c.author?.login;
    const email = validEmail(c.commit?.author?.email);
    const name = c.commit?.author?.name || "";
    if (!login || !email) continue;
    if (!byLogin[login]) byLogin[login] = { login, name, email };
  }
  for (const a of Object.values(byLogin)) {
    let p;
    try { p = await j(`https://api.github.com/users/${a.login}`); } catch { continue; }
    const li = findLinkedin(`${await socials(a.login)} ${p.blog || ""} ${p.bio || ""}`);
    if (!li) continue; // LinkedIn required
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
    await sleep(40);
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
  try {
    const p = await j(`https://api.github.com/users/${login}`);
    if (p.type !== "User") return null; // skip orgs
    const li = findLinkedin(`${await socials(login)} ${p.blog || ""} ${p.bio || ""}`);
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
  } catch { return null; }
}

// PROMINENT DEVS: highly-followed developers (proxy for high GitHub stars) — the
// accomplished, in-demand talent. One follower tier per run, rotating.
async function mineProminent(q) {
  let logins = [];
  try {
    const res = await j(`https://api.github.com/search/users?q=${encodeURIComponent(q)}&sort=followers&order=desc&per_page=100`);
    logins = (res.items || []).map((u) => u.login).filter(Boolean);
  } catch { return []; }
  const rows = [];
  for (const login of logins) {
    const row = await leadFromLogin(login);
    if (row) { rows.push(row); await sleep(45); }
  }
  return rows;
}

// NPM AUTHORS: a Parachute-style email-in-data directory — the npm registry exposes
// maintainer/author emails; LinkedIn resolves via the package's GitHub owner.
// Package authors are professional JS/TS devs; one topic slice per run, rotating.
async function mineNpm(q) {
  let objs = [];
  try {
    const r = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=100`);
    objs = (await r.json()).objects || [];
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

(async () => {
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

  // Prominent devs (high-followed = high-star talent) — adaptively pick a tier.
  const promTier = pickAdaptive(PROM_TIERS, "prom:");
  const prom = await mineProminent(promTier);
  for (let i = 0; i < prom.length; i += 100) stored += await post(prom.slice(i, i + 100));
  mined += prom.length; bumpYield(`prom:${promTier}`, prom.length);
  console.log(`prominent devs [${promTier}]: ${prom.length} complete leads`);

  // npm authors (Parachute-style email-in-data directory) — adaptively pick a topic.
  const npmTopic = pickAdaptive(NPM_TOPICS, "npm:");
  const npm = await mineNpm(npmTopic);
  for (let i = 0; i < npm.length; i += 100) stored += await post(npm.slice(i, i + 100));
  mined += npm.length; bumpYield(`npm:${npmTopic}`, npm.length);
  console.log(`npm authors [${npmTopic}]: ${npm.length} complete leads`);

  for (const repo of batch) {
    const rows = await mineRepo(repo.name);
    for (let i = 0; i < rows.length; i += 100) stored += await post(rows.slice(i, i + 100));
    mined += rows.length; bumpYield(`repolang:${repo.lang}`, rows.length);
    // Winner-following: a repo that produced well gets a second page mined now.
    if (rows.length >= 3) {
      const more = await mineRepo(repo.name, 2);
      for (let i = 0; i < more.length; i += 100) stored += await post(more.slice(i, i + 100));
      mined += more.length; bumpYield(`repolang:${repo.lang}`, more.length);
      console.log(`${repo.name}: ${rows.length}+${more.length} (hot -> deep) complete leads`);
    } else {
      console.log(`${repo.name}: ${rows.length} complete leads`);
    }
  }

  await reportStats(); // teach the next run what worked
  console.log(`DONE — mined ${mined} complete leads, ${stored} newly stored in backend.`);
})();
