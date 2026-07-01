# cte-lead-miner

Free-compute lead miner for the Connector Talent Engine. Runs on **GitHub Actions**
(free minutes, no serverless time limit) every 4 hours, mining active contributors
of top open-source repos:

- GitHub's commits API gives each contributor's **real name + email (from the commit)
  + login** in one call.
- Their profile gives **LinkedIn**.
- Result = **complete dev leads** (name + email + LinkedIn), email already in the data —
  no enrichment, **$0**.
- Posts them to the engine's `/api/ingest`, which gates + dedups + persists to the backend.

## Setup (one time)
```bash
cd cte-lead-miner
gh repo create cte-lead-miner --private --source=. --push

gh secret set NETLIFY_BASE   --body "https://connector-talent-engine-neil.netlify.app"
gh secret set NETLIFY_AUTH   --body "SITE_USER:SITE_PASSWORD"   # your engine's basic-auth creds
gh secret set MINER_GH_TOKEN --body "$(gh auth token)"          # 5000 req/hr

gh workflow run mine.yml     # kick off the first run now
```
Then it runs automatically every 4 hours. Watch runs: `gh run watch` or the repo's
**Actions** tab. Extend coverage by adding repos to `REPOS` in `miner.mjs`.
