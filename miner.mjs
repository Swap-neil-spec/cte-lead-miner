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

async function mineRepo(repo) {
  const rows = [];
  let commits;
  try { commits = await j(`https://api.github.com/repos/${repo}/commits?per_page=100`); }
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

(async () => {
  if (!BASE || !GH || !process.env.NETLIFY_AUTH) {
    console.error("Missing env: NETLIFY_BASE / NETLIFY_AUTH / GH_TOKEN");
    process.exit(1);
  }
  // Rotate a batch each run so we cover all repos over time.
  const run = Number(process.env.GITHUB_RUN_NUMBER || 0);
  const BATCH = 24;
  const start = (run * BATCH) % REPOS.length;
  const batch = Array.from({ length: BATCH }, (_, i) => REPOS[(start + i) % REPOS.length]);

  let mined = 0, stored = 0;
  for (const repo of batch) {
    const rows = await mineRepo(repo);
    for (let i = 0; i < rows.length; i += 100) stored += await post(rows.slice(i, i + 100));
    mined += rows.length;
    console.log(`${repo}: ${rows.length} complete leads`);
  }
  console.log(`DONE — mined ${mined} complete leads, ${stored} newly stored in backend.`);
})();
