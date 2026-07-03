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
// Name = compulsion is email+LinkedIn; the name is DERIVED. Prefer the source's
// name; if it isn't a full name, recover it from the LinkedIn slug (john-smith-3b ->
// John Smith). Returns {first,last}; first is only empty if truly nothing is parseable.
function nameParts(rawName, linkedinUrl) {
  let parts = String(rawName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    const slug = (String(linkedinUrl || "").match(/\/in\/([^/?#]+)/i)?.[1] || "")
      .replace(/\d+$/, "").split(/[-_]/).filter((t) => t && !/^\d+$/.test(t) && t.length > 1);
    if (slug.length >= 2) parts = slug.map((t) => t[0].toUpperCase() + t.slice(1));
  }
  return { first: parts[0] || "", last: parts.slice(1).join(" ") };
}

// Proactively pause when a budget is nearly gone, so the workers self-pace to ONE
// token's sustainable rate and keep producing steadily instead of bursting into
// 403s and returning nothing. reset = seconds since epoch (header).
async function paceOn(res) {
  const rem = Number(res.headers.get("x-ratelimit-remaining"));
  if (Number.isFinite(rem) && rem < 120) {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    const wait = Math.min(3600000, Math.max(0, (reset || Date.now()) - Date.now() + 3000));
    if (wait > 1000) await sleep(wait);
  }
}
async function j(url) {
  const r = await fetch(url, { headers: ghHeaders });
  if (r.status === 403 || r.status === 429) { // rate limited — wait for reset
    const ra = Number(r.headers.get("retry-after"));
    const reset = Number(r.headers.get("x-ratelimit-reset")) * 1000;
    const wait = ra ? ra * 1000 : Math.max(1000, reset - Date.now() + 2000);
    if (wait < 15 * 60000) { await sleep(wait); return j(url); }
  }
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  await paceOn(r);
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
  await paceOn(r); // self-pace on the GraphQL points budget too
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
  for (const lg of missing.slice(0, 20)) { // bounded — REST fallback amplifies REST load
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
      const { first, last } = nameParts(p.name, li); // name derived from LinkedIn if needed
      if (!first) continue;
      rows.push({
        "First name": first, "Last name": last,
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

// COMPANY ORGS — public members of tech-company GitHub orgs are working professionals
// with the HIGHEST public-LinkedIn density of any GitHub population. Seed list plus
// self-expansion: every repo we mine is "owner/repo", and the owner is usually an org,
// so orgPool() keeps discovering fresh orgs open-endedly.
const ORGS = [
  "vercel", "stripe", "shopify", "gitlab", "hashicorp", "airbnb", "netflix", "uber",
  "spotify", "atlassian", "twilio", "cloudflare", "digitalocean", "elastic", "mongodb",
  "confluentinc", "databricks", "grafana", "huggingface", "openai", "cockroachdb",
  "supabase", "prisma", "vercel-labs", "withastro", "remix-run", "nextauthjs", "nrwl",
  "expo", "reactjs", "vuejs", "angular", "sveltejs", "denoland", "nodejs", "rust-lang",
  "golang", "python", "pytorch", "tensorflow", "kubernetes", "docker", "hashicorp",
  "apache", "grpc", "envoyproxy", "cilium", "temporalio", "dagster-io", "dbt-labs",
  "getsentry", "posthog", "calcom", "medusajs", "novuhq", "appwrite", "strapi",
  "nestjs", "fastify", "trpc", "tanstack", "pmndrs", "chakra-ui", "mui", "ant-design",
  "storybookjs", "vitejs", "rollup", "esbuild", "biomejs", "astral-sh", "pydantic",
  "encode", "tiangolo", "streamlit", "gradio-app", "langchain-ai", "run-llama",
];
function orgPool(repos) {
  const owners = (repos || []).map((r) => String(r.name || r).split("/")[0]).filter(Boolean);
  return [...new Set([...ORGS, ...owners])];
}
async function mineOrg(org, page = 1) {
  try {
    const m = await j(`https://api.github.com/orgs/${org}/public_members?per_page=100&page=${page}`);
    return resolveLogins((Array.isArray(m) ? m : []).map((u) => u.login));
  } catch { return []; }
}

// --- GitLab: a PARALLEL dev ecosystem — separate 500/min rate limit (~30k/hr, does
// NOT touch the GitHub token) AND email+LinkedIn in the profile data (public_email +
// linkedin fields). Parachute-class supply, net-new devs, relieves the bottleneck.
const GL = process.env.GITLAB_TOKEN;
const glHeaders = GL ? { "PRIVATE-TOKEN": GL } : {};
async function glJson(url) {
  try { const r = await fetch(url, { headers: glHeaders }); return r.ok ? await r.json() : null; }
  catch { return null; }
}
function gitlabLinkedin(full) {
  const raw = String(full.linkedin || "").trim();
  if (raw) {
    const direct = findLinkedin(raw);
    if (direct) return direct;
    const slug = raw.replace(/\/+$/, "").split("/").pop();
    if (/^[A-Za-z0-9\-_%]{3,}$/.test(slug)) return `https://www.linkedin.com/in/${slug}`;
  }
  return findLinkedin(`${full.website_url || ""} ${full.bio || ""}`);
}
// --- Package registries: PyPI (Python) + crates.io (Rust) reach NET-NEW author
// populations on their OWN discovery budgets; PyPI's author_email is a real email
// fallback. LinkedIn resolves via each package's GitHub owner (shared, GraphQL). ---
function ghOwnerFromUrls(urls) {
  for (const u of urls) {
    const m = String(u || "").match(/github\.com[/:]([A-Za-z0-9\-_.]+)\/[A-Za-z0-9\-_.]+/i);
    if (m && m[1] && !/^(sponsors|orgs|features|about)$/i.test(m[1])) return m[1];
  }
  return null;
}
function unwrapEmail(s) {
  const raw = String(s || "");
  return validEmail(raw.match(/<([^>]+)>/)?.[1] || raw.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i)?.[0] || raw);
}
const PYPI_SEED = ["httpx", "rich", "pydantic", "fastapi", "flask", "requests", "click",
  "poetry", "black", "ruff", "mypy", "pytest", "sqlalchemy", "typer", "uvicorn",
  "starlette", "aiohttp", "loguru", "tqdm", "pandas", "numpy", "polars", "duckdb",
  "pyright", "hatch", "pdm", "pillow", "beautifulsoup4", "scrapy", "celery"];
let PYPI_TOP = null;
async function pypiTop() {
  if (PYPI_TOP) return PYPI_TOP;
  try {
    const r = await fetch("https://hugovk.github.io/top-pypi-packages/top-pypi-packages-30-days.min.json");
    const rows = ((await r.json()).rows || []).map((x) => x.project).filter(Boolean);
    PYPI_TOP = rows.length ? rows : PYPI_SEED;
  } catch { PYPI_TOP = PYPI_SEED; }
  return PYPI_TOP;
}
async function minePyPI(page = 1) {
  const top = await pypiTop();
  if (!top.length) return [];
  const size = 40, start = ((page - 1) * size) % top.length;
  const slice = top.slice(start, start + size);
  const rows = [];
  const seenOwner = new Set();
  for (const pkg of slice) {
    try {
      const r = await fetch(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`);
      if (!r.ok) continue;
      const info = (await r.json()).info || {};
      const owner = ghOwnerFromUrls([info.home_page, ...Object.values(info.project_urls || {})]);
      if (!owner || seenOwner.has(owner.toLowerCase())) continue;
      seenOwner.add(owner.toLowerCase());
      const row = await leadFromLogin(owner, unwrapEmail(info.author_email) || unwrapEmail(info.maintainer_email));
      if (row) { row.Source = "contributors"; rows.push(row); }
    } catch {}
  }
  return rows;
}
async function mineCrates(page = 1) {
  const ua = { "User-Agent": "cte-lead-miner (talent sourcing)" };
  let crates = [];
  try {
    const r = await fetch(`https://crates.io/api/v1/crates?sort=downloads&per_page=50&page=${page}`, { headers: ua });
    crates = ((await r.json()).crates || []);
  } catch { return []; }
  const logins = [], seenOwner = new Set();
  for (const c of crates) {
    try {
      const r = await fetch(`https://crates.io/api/v1/crates/${c.id}/owners`, { headers: ua });
      for (const o of (((await r.json()).users) || [])) {
        const lg = o.login;
        if (lg && !lg.includes(":") && !seenOwner.has(lg.toLowerCase())) { seenOwner.add(lg.toLowerCase()); logins.push(lg); }
      }
      await sleep(120); // crates.io asks for gentle pacing
    } catch {}
  }
  return resolveLogins(logins);
}

// --- HuggingFace: AI/ML talent. The API has no contact fields, but the profile
// HTML carries github/linkedin links. Discover model authors -> read their profile
// HTML -> GitHub username -> resolve (LinkedIn+email). Targets a high-value niche. ---
const HF_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
async function mineHF(page = 1) {
  let models = [];
  try {
    const r = await fetch(`https://huggingface.co/api/models?sort=likes&limit=100&skip=${(page - 1) * 100}`);
    models = await r.json();
  } catch { return []; }
  const authors = [...new Set((Array.isArray(models) ? models : [])
    .map((m) => String(m.id || "").split("/")[0]).filter(Boolean))];
  const logins = [];
  for (const a of authors) {
    if (SEEN.has("hf:" + a.toLowerCase())) continue;
    SEEN.add("hf:" + a.toLowerCase());
    try {
      const html = await (await fetch(`https://huggingface.co/${encodeURIComponent(a)}`, { headers: { "User-Agent": HF_UA } })).text();
      const gh = html.match(/github\.com\/([A-Za-z0-9\-]{2,39})(?=["'\/\s])/i)?.[1];
      if (gh && !/^(huggingface|orgs|features|about|sponsors|topics|marketplace)$/i.test(gh)) logins.push(gh);
    } catch {}
    await sleep(80);
  }
  return resolveLogins(logins); // GitHub gives LinkedIn + email
}

// --- FOCUS: most-forked AI projects. Contributors AND forkers of these repos are
// AI/ML engineers. Mine both for maximum yield (Neil's directive). ---------------
const AI_TOPICS = ["machine-learning", "deep-learning", "llm", "large-language-models",
  "nlp", "computer-vision", "artificial-intelligence", "neural-network", "transformers",
  "generative-ai", "diffusion-models", "reinforcement-learning", "pytorch", "tensorflow",
  "rag", "ai-agents", "mlops", "data-science", "gpt", "stable-diffusion", "langchain",
  "chatbot", "image-generation", "speech-recognition", "recommender-system"];
async function aiForkedRepos(topic, page = 1) {
  try {
    const res = await j(`https://api.github.com/search/repositories?q=topic:${encodeURIComponent(topic)}&sort=forks&order=desc&per_page=100&page=${page}`);
    return (res.items || []).map((r) => r.full_name).filter((n) => n && !REPO_SKIP.test(n));
  } catch { return []; }
}
// Forkers = engaged devs who cloned the project into their own account.
async function mineForks(repo, page = 1) {
  try {
    const forks = await j(`https://api.github.com/repos/${repo}/forks?sort=newest&per_page=100&page=${page}`);
    return resolveLogins((Array.isArray(forks) ? forks : []).map((f) => f.owner?.login).filter(Boolean));
  } catch { return []; }
}

// --- JSON Resume Registry: Parachute-class structured source (email + LinkedIn IN
// the data, $0, no auth, INDEPENDENT of the GitHub token). Found + tool-verified by
// the agent team. registry.jsonresume.org/api/resumes -> {username}.json. ----------
let JR_LIST = null;
async function jrList() {
  if (JR_LIST) return JR_LIST;
  try {
    const r = await fetch("https://registry.jsonresume.org/api/resumes");
    JR_LIST = ((await r.json()) || []).map((u) => u.username).filter(Boolean);
  } catch { JR_LIST = []; }
  return JR_LIST;
}
function jrLinkedin(profiles) {
  for (const p of (profiles || [])) {
    if (/linkedin/i.test(String(p.network || ""))) {
      const u = findLinkedin(p.url || "");
      if (u) return u;
      const un = String(p.username || "").replace(/^.*\/in\//, "").replace(/\/+$/, "");
      if (/^[A-Za-z0-9\-_%.]{3,}$/.test(un)) return `https://www.linkedin.com/in/${un}`;
    }
  }
  return findLinkedin(JSON.stringify(profiles || []));
}
async function mineJsonResume(page = 1) {
  const list = await jrList();
  if (!list.length) return [];
  const size = 80, start = ((page - 1) * size) % list.length;
  const slice = list.slice(start, start + size);
  const rows = [];
  for (const username of slice) {
    if (SEEN.has("jr:" + username.toLowerCase())) continue;
    SEEN.add("jr:" + username.toLowerCase());
    try {
      const res = await fetch(`https://registry.jsonresume.org/${encodeURIComponent(username)}.json`);
      if (!res.ok) continue;
      const b = ((await res.json()) || {}).basics || {};
      const email = validEmail(b.email);
      if (!email || /example\.|@test\.|edison|john@gmail/i.test(email)) continue; // placeholders
      const li = jrLinkedin(b.profiles); // email + linkedin both in the data -> no GitHub needed
      if (!li) continue;
      const { first, last } = nameParts(b.name, li);
      if (!first) continue;
      const loc = b.location ? [b.location.city, b.location.region, b.location.countryCode].filter(Boolean).join(", ") : "";
      rows.push({
        "First name": first, "Last name": last, Email: email, LinkedIn: li,
        Location: loc, Role: b.label || "software_engineer", Source: "resumes",
      });
    } catch {}
  }
  return rows;
}

// --- ORCID: public researcher registry (16M+). Full-text search "linkedin.com"
// finds profiles carrying a linkedin; /person yields public email + linkedin + name.
// $0, no auth, INDEPENDENT of GitHub. Agent-team find. ------------------------------
async function orcidJson(url) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "cte-lead-miner (talent sourcing)" } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
// Field-filtered to tech/finance/legal (ORCID is mostly non-tech academics otherwise).
const ORCID_Q = encodeURIComponent('"linkedin.com" AND ("machine learning" OR "computer science" OR "software" OR "data science" OR "artificial intelligence" OR engineer OR developer OR "deep learning" OR fintech OR quant OR "financial" OR lawyer OR attorney OR "legal")');
async function mineOrcid(start = 0) {
  const s = await orcidJson(`https://pub.orcid.org/v3.0/search/?q=${ORCID_Q}&rows=100&start=${start}`);
  const results = (s && s.result) || [];
  const rows = [];
  for (const r of results) {
    const oid = r["orcid-identifier"] && r["orcid-identifier"].path;
    if (!oid || SEEN.has("orcid:" + oid)) continue;
    SEEN.add("orcid:" + oid);
    const p = await orcidJson(`https://pub.orcid.org/v3.0/${oid}/person`);
    if (!p) continue;
    const emailObj = ((p.emails && p.emails.email) || [])[0];
    const email = validEmail(emailObj && emailObj.email);
    if (!email) continue; // public email required
    let li = null;
    for (const u of ((p["researcher-urls"] && p["researcher-urls"]["researcher-url"]) || [])) {
      const found = findLinkedin((u.url && u.url.value) || "");
      if (found) { li = found; break; }
    }
    if (!li) continue;
    const nm = p.name || {};
    const full = `${(nm["given-names"] || {}).value || ""} ${(nm["family-names"] || {}).value || ""}`.trim();
    const { first, last } = nameParts(full, li); // derive last from LinkedIn if missing (avoids ingest LLM path)
    if (!first) continue;
    const kw = ((p.keywords && p.keywords.keyword) || [])[0];
    const addr = await orcidJson(`https://pub.orcid.org/v3.0/${oid}/address`); // fill location
    const country = (((addr && addr.addresses && addr.addresses.address) || [])[0] || {}).country;
    rows.push({
      "First name": first, "Last name": last, Email: email, LinkedIn: li,
      Location: (country && country.value) || "", Role: (kw && kw.content) || "software_engineer", Source: "orcid",
    });
    await sleep(40);
  }
  return rows;
}

// --- HN "Who wants to be hired?" monthly archives: job SEEKERS self-post email +
// linkedin. Free Algolia HN API, no auth, INDEPENDENT of GitHub. Agent-team spec. ---
function decodeHtmlText(s) {
  return String(s || "")
    .replace(/&#x2F;/g, "/").replace(/&#x27;/g, "'").replace(/&#x3D;/g, "=")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, " ");
}
async function hnWantsThreads() {
  try {
    const r = await fetch("https://hn.algolia.com/api/v1/search?tags=story,author_whoishiring&query=wants%20to%20be%20hired&hitsPerPage=300");
    const d = await r.json();
    return (d.hits || []).filter((h) => /wants to be hired/i.test(h.title || "")).map((h) => h.objectID);
  } catch { return []; }
}
async function mineHNThread(id) {
  let d;
  try { d = await (await fetch(`https://hn.algolia.com/api/v1/items/${id}`)).json(); } catch { return []; }
  const rows = [];
  const walk = (node) => {
    if (!node) return;
    const txt = decodeHtmlText(node.text || "");
    const email = validEmail((txt.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i) || [])[0]);
    const li = findLinkedin(txt);
    if (email && li) {
      const { first, last } = nameParts(node.author || "", li); // real name from linkedin slug
      if (first) rows.push({ "First name": first, "Last name": last, Email: email, LinkedIn: li, Location: "", Role: "software_engineer", Source: "hn" });
    }
    (node.children || []).forEach(walk);
  };
  walk(d);
  return rows;
}

// --- CNCF gitdm: 406k entries (~118k unique devs) with email+name+location IN the
// data (email obfuscated as '!' for '@'). Only LinkedIn needs GitHub resolution.
// Agent-team find — the biggest verified vein. --------------------------------------
let CNCF = null;
async function cncfUsers() {
  if (CNCF) return CNCF;
  try {
    const d = await (await fetch("https://media.githubusercontent.com/media/cncf/gitdm/master/src/github_users.json")).json();
    const byLogin = {};
    for (const u of (Array.isArray(d) ? d : [])) {
      const lg = u.login;
      if (!lg) continue;
      const email = validEmail(String(u.email || "").replace("!", "@")); // deobfuscate + filter noreply
      if (!email) continue;
      const k = lg.toLowerCase();
      const cur = byLogin[k];
      if (!cur) byLogin[k] = { login: lg, email, name: u.name || "", location: u.location || "" };
      else { if (!cur.name && u.name) cur.name = u.name; if (!cur.location && u.location) cur.location = u.location; }
    }
    CNCF = Object.values(byLogin);
  } catch { CNCF = []; }
  return CNCF;
}
async function mineCNCF(page = 1) {
  const users = await cncfUsers();
  if (!users.length) return [];
  const size = 200, start = ((page - 1) * size) % users.length;
  const slice = users.slice(start, start + size).filter((u) => !SEEN.has("cncf:" + u.login.toLowerCase()));
  slice.forEach((u) => SEEN.add("cncf:" + u.login.toLowerCase()));
  const byLogin = {};
  slice.forEach((u) => { byLogin[u.login.toLowerCase()] = u; });
  const rows = [];
  for (let i = 0; i < slice.length; i += 40) {
    const chunk = slice.slice(i, i + 40).map((u) => u.login);
    const profs = await profilesBatch(chunk); // GraphQL — just need LinkedIn from socials
    for (const login of chunk) {
      const g = byLogin[login.toLowerCase()];
      const p = profs[login.toLowerCase()];
      if (!p) continue;
      const li = findLinkedin(socialText(p));
      if (!li) continue; // LinkedIn required (the one field not in gitdm)
      const email = validEmail(p.email) || g.email; // email from GitHub or gitdm
      const { first, last } = nameParts(p.name || g.name, li);
      if (!first) continue;
      rows.push({
        "First name": first, "Last name": last, Email: email, LinkedIn: li,
        Location: p.location || g.location || "", Role: "software_engineer", Source: "contributors",
      });
    }
  }
  return rows;
}

async function mineGitlab(page = 1) {
  const users = await glJson(`https://gitlab.com/api/v4/users?per_page=100&page=${page}&active=true&without_project_bots=true`);
  if (!Array.isArray(users)) return [];
  const rows = [];
  for (const u of users) {
    const email = validEmail(u.public_email);
    if (!email || SEEN.has("gl:" + u.id)) continue; // public_email is in the list -> cheap filter
    SEEN.add("gl:" + u.id);
    const full = await glJson(`https://gitlab.com/api/v4/users/${u.id}`); // full profile has linkedin
    if (!full) continue;
    const li = gitlabLinkedin(full);
    if (!li) continue;
    const { first, last } = nameParts(full.name || u.name, li);
    if (!first) continue;
    rows.push({
      "First name": first, "Last name": last, Email: email, LinkedIn: li,
      Location: full.location || "", Role: "software_engineer", Source: "gitlab",
    });
  }
  return rows;
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
      const { first, last } = nameParts(p.name || a.name, li); // derive from LinkedIn if needed
      if (!first) continue;
      rows.push({
        "First name": first,
        "Last name": last,
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
  const { first, last } = nameParts(p.name, li); // name derived from LinkedIn if needed
  if (!first) return null;
  return {
    "First name": first, "Last name": last,
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
  mineProminent, mineNpm, mineStargazers, mineGraph, graphSeed,
  mineOrg, orgPool, ORGS, minePyPI, mineCrates, mineHF, mineJsonResume, mineOrcid,
  hnWantsThreads, mineHNThread, mineCNCF, AI_TOPICS, aiForkedRepos, mineForks, post,
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

  // COMPANY ORGS — highest public-LinkedIn density (working professionals at top firms).
  const orgs = orgPool(pool);
  for (let k = 0; k < 4; k++) {
    const org = orgs[(RUN * 4 + k) % orgs.length];
    const page = ((RUN + k) % 5) + 1;
    const om = await mineOrg(org, page);
    const omNew = await postAll(om);
    stored += omNew; mined += om.length; bumpYield("orgs", omNew);
    console.log(`org ${org} p${page}: ${om.length} mined, ${omNew} fresh`);
  }

  // PACKAGE REGISTRIES — net-new author populations (Python/Rust) on own budgets.
  const py = await minePyPI((RUN % 300) + 1);
  const pyNew = await postAll(py);
  stored += pyNew; mined += py.length; bumpYield("pypi", pyNew);
  console.log(`pypi: ${py.length} mined, ${pyNew} fresh`);
  const cr = await mineCrates((RUN % 40) + 1);
  const crNew = await postAll(cr);
  stored += crNew; mined += cr.length; bumpYield("crates", crNew);
  console.log(`crates: ${cr.length} mined, ${crNew} fresh`);

  // HUGGINGFACE — AI/ML talent (profile HTML -> GitHub -> resolve).
  const hf = await mineHF((RUN % 20) + 1);
  const hfNew = await postAll(hf);
  stored += hfNew; mined += hf.length; bumpYield("hf", hfNew);
  console.log(`huggingface: ${hf.length} mined, ${hfNew} fresh`);

  // JSON RESUME REGISTRY — email+linkedin in the data, no GitHub cost (agent-team find).
  const jr = await mineJsonResume((RUN % 30) + 1);
  const jrNew = await postAll(jr);
  stored += jrNew; mined += jr.length; bumpYield("jsonresume", jrNew);
  console.log(`jsonresume: ${jr.length} mined, ${jrNew} fresh`);

  // ORCID — researcher registry, email+linkedin in the data, no GitHub cost (agent-team find).
  const orc = await mineOrcid((RUN % 200) * 100);
  const orcNew = await postAll(orc);
  stored += orcNew; mined += orc.length; bumpYield("orcid", orcNew);
  console.log(`orcid: ${orc.length} mined, ${orcNew} fresh`);

  // CNCF gitdm — 118k devs with email+name in data; LinkedIn via GitHub (agent-team find).
  const cncf = await mineCNCF((RUN % 500) + 1);
  const cncfNew = await postAll(cncf);
  stored += cncfNew; mined += cncf.length; bumpYield("cncf", cncfNew);
  console.log(`cncf: ${cncf.length} mined, ${cncfNew} fresh`);

  // AI FOCUS — most-forked AI projects: mine BOTH contributors and forkers (Neil's directive).
  const aiTopic = AI_TOPICS[RUN % AI_TOPICS.length];
  const aiRepos = await aiForkedRepos(aiTopic, (RUN % 3) + 1);
  console.log(`ai focus [${aiTopic}]: ${aiRepos.length} most-forked repos`);
  for (const repo of aiRepos.slice(0, 10)) {
    let cNew = 0, cMined = 0, page = 1, last = 3;
    while (last >= 3 && page <= 5) { // contributors, deep while productive
      const c = await mineRepo(repo, page);
      cNew += await postAll(c); cMined += c.length; last = c.length; page++;
    }
    const f = await mineForks(repo, (RUN % 6) + 1); // forkers
    const fNew = await postAll(f);
    stored += cNew + fNew; mined += cMined + f.length; bumpYield("ai", cNew + fNew);
    console.log(`  ai ${repo}: ${cNew} contrib + ${fNew} forkers fresh`);
  }

  for (const repo of batch) {
    const rows = await mineRepo(repo.name);
    let sNew = await postAll(rows);
    mined += rows.length;
    // Winner-following: keep digging deeper WHILE the repo stays hot (fresh-yield).
    let page = 1, last = rows.length;
    while (last >= 3 && page < 6) {
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
