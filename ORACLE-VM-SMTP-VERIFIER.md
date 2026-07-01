# Oracle Free VM — SMTP email verifier (baby steps)

**Why:** Netlify (and GitHub Actions, and most free clouds) block outbound **port 25**,
so they can't verify emails via SMTP. **Oracle Cloud's Always-Free VM is the one free
box that can get port 25 unblocked.** With it, we can take a *guessed* company-pattern
email (e.g. `jane.doe@company.com`) and confirm it's real — unlocking the company-email
pool (team/startups/universities) at **$0**.

We'll run **Reacher** (`check-if-email-exists`, open-source) as a tiny HTTP API on the VM.
The engine calls it to verify pattern emails before shipping them.

---

## Step 1 — Create a free Oracle Cloud account (~10 min)
1. Go to **oracle.com/cloud/free** → **Start for free**.
2. Sign up (needs a card for identity check — **Always-Free tier is never charged**).
3. Pick a home region close to you.

## Step 2 — Launch an Always-Free VM (~5 min)
1. Console → **Menu → Compute → Instances → Create Instance**.
2. Name: `smtp-verifier`.
3. Image & shape: **Ubuntu 22.04**, shape **VM.Standard.A1.Flex** (ARM, always-free:
   up to 4 OCPU / 24 GB) or **VM.Standard.E2.1.Micro** (x86, always-free).
4. Add your **SSH public key** (or let it generate one — download it).
5. **Create**. Note the instance's **public IP**.

## Step 3 — Unblock outbound port 25 (the key step)
Oracle blocks port 25 by default. Remove the block:
1. Open a **support request**: Console → **Help → Support → Create support request →**
   category "**Remove Email Sending Limits / Port 25**".
2. Say you'll use it for **outbound email verification (SMTP RCPT checks), not bulk mail.**
   Free-tier requests are usually granted in 1–2 days.
3. Also open the port in networking: **VCN → Security List → add Ingress rule** for TCP
   **8080** (the verifier's HTTP port) from your engine's IP (or 0.0.0.0/0 + a secret).

## Step 4 — Install the verifier (~5 min, on the VM)
SSH in (`ssh -i your_key ubuntu@PUBLIC_IP`), then:
```bash
# install Docker
sudo apt-get update && sudo apt-get install -y docker.io
sudo systemctl enable --now docker

# run Reacher (open-source email verifier) on port 8080
sudo docker run -d --restart unless-stopped -p 8080:8080 \
  -e RCH__HTTP_HOST=0.0.0.0 \
  --name reacher reacherhq/backend:latest
```
Test it:
```bash
curl -X POST http://localhost:8080/v0/check_email \
  -H 'content-type: application/json' \
  -d '{"to_email":"someone@gmail.com"}'
# -> JSON with "is_reachable": "safe" | "risky" | "invalid" | "unknown"
```
If `is_reachable` comes back as real values (not all "unknown"), **port 25 is working.**

## Step 5 — Secure it (5 min)
Put a secret in front so only the engine can call it. Easiest: run a tiny reverse proxy
that checks a header, or set Reacher behind Caddy with basic auth. Minimal version — allow
only the engine's IP in the Oracle Security List ingress rule for 8080.

## Step 6 — Tell me the URL + secret
Once it's up, give me `http://PUBLIC_IP:8080` (and any auth secret). I'll wire the engine:
1. For leads with a known company domain but no email, generate ranked patterns
   (`first.last@`, `flast@`, `first@`, …).
2. Call your Reacher VM to verify each; ship only the one marked **safe** (and skip
   catch-all domains, which can't be confirmed per-mailbox).
3. Cache the confirmed pattern per-domain so future same-company leads are instant + free.

**Result:** verified company emails for the team/startup/university pool — the last locked
segment — at **$0**, forever.

---
*Note: if Oracle denies the port-25 unblock (rare on free tier), the fallback is a cheap
pay-per-hit verify API — but try Oracle first; it's the free path.*
