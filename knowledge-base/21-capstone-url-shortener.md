# Capstone: URL Shortener

*Phase 6 · Capstones·Module 21-22·Weeks 11-12 · ~13 hrs*

You designed Bitly on paper in Module 1 — now you **build it for real**, deploy it, and productionize it, because a running URL shortener with an architecture doc is the single highest-leverage rep in this entire track.

## 01 What you're building & why it's the ultimate rep

You're building a real, deployed URL shortener: an API that turns a long URL into a short code, a redirect endpoint that sends `sho.rt/aB3xK9` to the original, backed by a database, a cache, containers, and a cloud host — then hardened until it can take real traffic.

Every other capstone is a variation on this one, which is why it goes first. It's **small enough to finish in two weeks** yet it forces you to touch *every layer you've studied*: an HTTP API and contract (Module 9), unique-ID generation and a data model (Modules 1, 3), a SQL schema and indexes (Module 3), a cache-aside read path (Module 5), a CDN edge (Module 6), containers and an orchestrator (Module 18), a load balancer and auto-scaling (Module 2), observability (Module 14), a CI/CD pipeline (Module 19), and rate limiting (Module 15). You will assemble the whole course into one artifact.

The gap this closes is the gap interviewers probe hardest: the difference between *"I would add a cache"* and *"I added Redis, watched my p99 drop from 40 ms to 3 ms, then had to fix the thundering-herd on a cold key."* One of those sentences comes from a slide; the other comes from scars. This module manufactures scars.

> **Key idea:** A deployed URL shortener plus a one-page architecture doc outperforms ten whiteboard sessions in an interview — because you can defend every box from experience, name the trade-off you actually hit, and show the commit that fixed it.

## 02 Requirements recap

Don't skip this because you "already know it." Writing the requirements down first is what keeps the build honest — every component you add later must trace back to one of these.

**Functional** (the verbs): shorten a long URL into a short code; redirect a short code to the original; optionally support a custom alias, an expiry (TTL), and a click counter. Explicitly out of scope for the core: user accounts and a full analytics dashboard — say so, then build the tight core.

**Non-functional** (the qualities that shape the architecture):

| NFR | Target | What it forces into the build |
| --- | --- | --- |
| Availability | Redirects ~always up (99.9%+) | Stateless app tier, replicas, health checks |
| Latency | Redirect p99 < 50 ms | Cache-aside on the hot path, CDN edge |
| Read:write ratio | ~100:1 (read-heavy) | Cache + read replicas, not write scaling first |
| Durability | Never lose a mapping | Durable primary DB, replication, backups |
| Scale | Billions of URLs | Short code with headroom; shard later |

The one-minute estimate that justifies those choices (round hard — a day is ~100,000 seconds):

```
100M new URLs / month  = 100M / 30 / 86,400  ≈ 40 writes/s
reads at 100:1         = 40 × 100           ≈ 4,000 reads/s  (peak ×2-3 ≈ 10k/s)
storage: 100M/mo × 12 × 5yr = 6B URLs
         × ~500 B/row  ≈ 3 TB (× replication)  → big but manageable; shard later
short code: Base62, 7 chars = 62^7 ≈ 3.5 trillion  → dwarfs 6B; 7 chars is plenty
```

Verdict, straight from the numbers: **read-heavy and durable → cache aggressively and add read replicas; storage is large but fits, so shard only when the table actually hurts.** Every decision below is anchored here.

## 03 The architecture

Two paths run through this system, and they could not be more different. The **write path** (create a link) is rare, tolerant of a few hundred milliseconds, and does real work: generate a unique code, persist it. The **read path** (redirect) is ~100× more frequent and must feel instant, so it is optimized to death — served from cache, then a read replica, then a CDN edge for the hottest links.

In words: a client hits the **CDN**, which serves popular redirects straight from the edge. Cache misses fall through to a **load balancer** that terminates TLS and spreads traffic across a fleet of **stateless app servers**. On a redirect, an app server checks **Redis** first; on a hit it returns a 302 in ~1 ms; on a miss it reads **PostgreSQL**, warms the cache, and redirects. On a create, the app server generates a code, writes it to the primary, and returns the short URL. Reads scale out via replicas; writes stay on the primary until sharding is justified.

```
                         ┌──────────────┐
   client  ───────────▶  │   CDN / edge  │   caches hottest redirects
                         └──────┬───────┘
                          miss  │
                                ▼
                         ┌──────────────┐
                         │ Load balancer │   TLS termination, health checks
                         └──────┬───────┘
                  ┌─────────────┼─────────────┐
                  ▼             ▼             ▼
              ┌───────┐     ┌───────┐     ┌───────┐
              │ app 1 │     │ app 2 │     │ app N │   stateless: API + redirect
              └───┬───┘     └───┬───┘     └───┬───┘
                  └──────┬──────┴──────┬──────┘
                  read   │             │  read/write
                         ▼             ▼
                  ┌────────────┐   ┌────────────────────┐
                  │   Redis    │   │     PostgreSQL      │
                  │  (hot codes│   │  primary + replicas │
                  │  cache-side│   │  (durable mappings) │
                  └────────────┘   └────────────────────┘
```

Notice what's *not* here yet: no message queue, no search index, no microservice sprawl. The whole art is adding each box only when an NFR or a measurement forces it. You'll build the simple correct version first, then earn every upgrade.

## 04 Step-by-step build plan

Two phases. **BUILD** gets a correct system running locally and then live on the internet — a link you can paste to a friend. **PRODUCTIONIZE** makes it survive real traffic, failure, and abuse. Do them in order; do not productionize something that doesn't yet work.

### BUILD — from blank repo to a deployed link

1. **API & redirection flow** *(build)* — Two endpoints: a `POST` to create a mapping, a `GET /{code}` that returns a 302. The mapping `code → longUrl` is the entire product.
2. **Unique short-code generation** *(build)* — Pick how `code` is produced: auto-increment → Base62, hash of the URL, or a Snowflake ID → Base62. Trade-off table below.
3. **PostgreSQL schema** *(build)* — One table keyed by `code`, plus an index for TTL sweeps. Durable source of truth behind the cache.
4. **Redis caching** *(build)* — Cache-aside on the redirect path so hot codes never touch the DB. This is what makes the read path fast.
5. **Docker containerization** *(build)* — Multi-stage `Dockerfile` for the app; a `docker-compose` that brings up app + Postgres + Redis with one command.
6. **Deploy on AWS / free tier** *(build)* — Ship the image to a public host: EC2 + Docker, or ECS/Fargate, or a free-tier PaaS. Get a real URL that redirects.

① API & redirection

```
# Create a short URL  (cold path — rare, can be a little slow)
POST /api/v1/urls
  body:  { "longUrl": "https://example.com/very/long/path", "alias": "?", "ttlDays": "?" }
  201 →  { "shortUrl": "https://sho.rt/aB3xK9", "code": "aB3xK9" }

# Redirect  (hot path — ~100x the traffic, must be < 50 ms p99)
GET /{code}
  302 Found, Location: <longUrl>   # use 302, NOT 301 — see the pitfalls table
  404 if unknown or expired
```

② Generating the short code

This is the heart of the problem and the deep-dive interviewers always chase. Know all three cold:

| Approach | Upside | Downside / when |
| --- | --- | --- |
| Auto-increment → Base62 | Dead simple, zero collisions, short codes | Single point of coordination; codes are guessable/sequential. Fine for a single-DB start. |
| Hash(longUrl), take 7 chars | Same URL → same code (free dedupe) | Collisions you must detect and resolve (rehash / add salt). |
| Snowflake ID → Base62 | Unique across many servers, no central counter, roughly time-sortable | A bit more infra; longer codes. The right answer once writes span nodes. |

```
# Base62 encode — turn a numeric id into a short code
ALPHABET = "0-9 a-z A-Z"            # 62 symbols
def encode(n):                       # n = auto-increment id OR a Snowflake id
    s = ""
    while n > 0:
        s = ALPHABET[n % 62] + s
        n //= 62
    return s or "0"

# Snowflake 64-bit layout (why it scales without a central counter):
#  1 bit sign | 41 bits timestamp(ms) | 10 bits machine id | 12 bits sequence
#  → ~4,096 ids per machine per ms, unique across nodes, sortable by time
```

③ PostgreSQL schema

```
CREATE TABLE urls (
  code        VARCHAR(10)  PRIMARY KEY,          -- the Base62 short code
  long_url    TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,                        -- NULL = never expires
  clicks      BIGINT       NOT NULL DEFAULT 0
);
CREATE INDEX idx_urls_expires ON urls (expires_at);  -- cheap TTL sweeps
-- optional dedupe: a UNIQUE index on a hash of long_url if identical URLs reuse a code
```

④ Redis caching (cache-aside)

```
GET /{code}:
  hit = redis.get(code)                    # 1. try cache first (~1 ms)
  if hit: return 302 → hit
  row = db.query("SELECT long_url,expires_at FROM urls WHERE code=?")  # 2. miss → DB
  if not row or expired(row): return 404
  redis.set(code, row.long_url, EX=3600)   # 3. warm cache, 1h TTL
  return 302 → row.long_url                # async: increment clicks (don't block redirect)
```

⑤ Dockerize

```
# Dockerfile — multi-stage keeps the runtime image small
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
FROM node:20-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

```
# docker-compose.yml — app + postgres + redis, one `docker compose up`
services:
  app:   { build: ., ports: ["3000:3000"], depends_on: [db, cache] }
  db:    { image: postgres:16, environment: { POSTGRES_PASSWORD: dev } }
  cache: { image: redis:7 }
```

⑥ Deploy — get a real, public URL

- **Simplest (EC2 + Docker):** launch a t3.micro (free-tier eligible), install Docker, `docker compose up -d`, open port 80/443. One box, fully in your control — great for the first deploy.
- **Managed (ECS/Fargate + ECR):** push your image to ECR, run it as a Fargate service. No servers to patch, and it wires straight into auto-scaling and a load balancer later.
- **Free / zero-cost:** a PaaS like Render, Fly.io, or Railway will run your container on a free tier with a public HTTPS URL in minutes — perfect if you just want the link live.

### PRODUCTIONIZE — make it survive real traffic

7. **Load balancing + auto-scaling** *(prod)* — Put an ALB in front of ≥2 app instances; add a target-tracking auto-scaling policy (e.g., scale on CPU or request count). The app tier is stateless, so this "just works."
8. **CDN integration** *(prod)* — Front the redirect path with CloudFront (or any CDN). The hottest links get served from the edge, cutting latency and origin load dramatically.
9. **Monitoring & observability** *(prod)* — Emit the RED metrics (Rate, Errors, Duration) plus cache hit-rate; ship structured logs; add a `/health` check and dashboards + alerts. You can't defend what you can't see.
10. **CI/CD pipeline** *(prod)* — GitHub Actions: on push → test → build image → push to ECR → deploy the new revision. Every merge to main ships automatically and safely.
11. **Rate limiting + logging** *(prod)* — Token-bucket limit at the edge/gateway (or a Redis counter) to stop abuse and hot-key floods; log every create and redirect with a request id for auditing.

> **Play with it → your tool:** Before you wire up the real ALB, build the intuition: open the [🚦 Load Balancer Playground](../tools/load-balancer-simulator.html) and watch requests spread across your stateless app fleet — then kill a node and see the health check reroute traffic. That's exactly the behavior step 7 gives you in production.

> **Build tip:** Ship the smallest correct thing first — a single container that shortens and redirects, deployed and reachable — *before* touching CDN, auto-scaling, or CI/CD. A live-but-simple system you can demo beats a half-wired "production" one every time, and each productionize step is then a small, verifiable diff.

## 05 Common pitfalls & how to verify each stage

The bugs in this build are famous — they're the same ones interviewers ask you to anticipate. Know the trap and the check for each stage.

| Stage | Common pitfall | How to verify it works |
| --- | --- | --- |
| Redirect | Using **301** — browsers cache it forever, so you lose click analytics and can never repoint the link. | `curl -I sho.rt/x` shows `302` and the right `Location`; changing the target actually takes effect. |
| Code generation | Hash collisions silently overwrite a mapping; or an auto-increment counter becomes a single write bottleneck. | Insert two different URLs that hash-collide and confirm both resolve correctly; load-test creates and watch for duplicate codes (should be zero). |
| Schema | No index on the lookup/expiry columns → full scans as the table grows. | `EXPLAIN` the redirect query shows an index scan on `code`, not a seq scan. |
| Cache | Thundering herd: a hot key expires and thousands of requests stampede the DB at once. | Expire a hot key under load; DB QPS should barely move (single-flight / lock), and cache hit-rate stays high. |
| Cache correctness | Stale entry after a link is updated/deleted — cache still serves the old target. | Update a mapping, then hit it; you get the new target within the TTL window (or immediately if you invalidate on write). |
| Deploy | Security group / firewall closed, or the container binds `localhost` not `0.0.0.0` — "works locally, dead in prod." | Hit the public URL from your phone on cellular (not your LAN); it redirects. |
| Auto-scaling | App holds state (in-memory sessions/counters), so scaling out corrupts data. | Run 2+ instances behind the LB; hammer both and confirm identical, correct behavior — proof the tier is truly stateless. |
| Rate limiting | Limiter is per-instance, so N servers = N× the intended limit. | Exceed the limit across instances; you get `429` at the global threshold, not N× it (shared Redis counter). |

Verify *as you go*, not at the end. Each row above is a checkpoint: don't move to the next stage until its check passes. That discipline is exactly what "productionizing" means.

## 06 What you ship

The capstone is done when you have two artifacts — and both go on your portfolio, GitHub, and résumé.

1. **A live app.** A public URL where anyone can shorten a link and follow the redirect. It runs in a container, behind a load balancer, with a cache and a real database, deployed by your CI/CD pipeline. A recruiter can click it in ten seconds.
2. **A one-page architecture doc** (a README with a diagram is enough) covering: the requirements and estimate, the diagram from Section 03, your short-code decision *and why*, the schema, the cache strategy, how it scales, and the pitfalls you hit with the commits that fixed them. This document *is* your interview script — you'll answer "walk me through a system you built" straight from it.

> **Why the doc matters as much as the code:** Interviewers can't read your whole repo, but they can read one page and ask three sharp questions. The doc is where you turn "I built a URL shortener" into "I chose Snowflake over an auto-increment counter because writes were about to span nodes, and here's the collision test that proved it" — the sentence that gets you hired.

## 07 Your reps this week

Reading a build guide is not building. Do these, in order — this is the two-week capstone loop:

1. **Build the BUILD phase, timeboxed.** Blank repo → deployed public link that shortens and redirects, in the first week. Steps 1–6. Resist every urge to gold-plate; get it *live and correct* first.
2. **Run a design review on your own build.** Paste the rig below into me (or any LLM) with your repo tree and README, and defend every decision against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer reviewing my URL-shortener capstone before I put it on my portfolio. I will paste my repo structure, my schema, and my architecture README. Interrogate my design decisions one at a time and make me justify each: short-code generation (why auto-increment vs hash vs Snowflake), the cache strategy and TTL, the schema and indexes, how a redirect flows on a cache miss, what happens when a hot key expires, and how it scales past one database. Push hard on anything hand-wavy and keep asking "why?" and "how did you verify that?". Do NOT rewrite my code for me. When we're done, give me: (a) a prioritized punch list of what's missing for production, and (b) a 1-5 score on requirements, code-generation choice, data model, caching, scalability, observability, and the clarity of my architecture doc — with the specific thing a strong candidate would have added for each.
```

1. **Write the architecture doc** (Section 06) — the one-pager with the diagram. If you can't explain a box, you haven't earned it; go back and understand it.
2. **Break it on purpose.** Load-test the redirect path (e.g., `k6` / `hey`), then kill a container and expire a hot cache key under load. Watch your dashboards. Fix what breaks and commit the fix with a message that says what you learned.
3. **Flashcards** (make these 5, review at week's end): *Why 302 and not 301 for the redirect? · Auto-increment vs Snowflake — when does each win? · What exactly does the cache-aside read path do on a miss? · Why put a CDN in front of redirects, and what's the freshness risk? · One metric that proves your cache is healthy, and its target?*

## 08 Watch & read

Free videos, hand-picked and link-verified for this capstone. Watch the two URL-shortener walkthroughs and a Snowflake explainer *before* you build; save the deploy videos for when you reach step 6.

- **[Design a URL Shortener (Bitly) — System Design Interview](https://www.youtube.com/watch?v=qSJAvd5Mgio)** — NeetCodeIO · ~24 min · reference build — The clean end-to-end shape of the whole system. Watch this first to see the target you're building.
- **[TinyURL System Design · URL Shortener Interview Question · Bitly](https://www.youtube.com/watch?v=AVztRY77xxA)** — codeKarle · ~25 min · deeper design — Goes hard on code generation, the key-generation service, and scaling the read path — great second pass.
- **[Design a Unique ID Generator (Part V): Twitter Snowflake Approach](https://www.youtube.com/watch?v=jpdVmAPY0wM)** — codestorywithMIK · ~25 min · Snowflake IDs — Bit-by-bit walkthrough of the 64-bit Snowflake layout you'll implement for step 2.
- **[How Snowflake IDs work](https://www.youtube.com/watch?v=aLYKd7h7vgY)** — loops · ~8 min · quick explainer — The fastest mental model for timestamp + machine + sequence bits. Watch if the deep dive was too much.
- **[Learn to Deploy your Docker Container on EC2 in 15 Minutes](https://www.youtube.com/watch?v=awFLzy0XwXo)** — Soumil Shah · ~15 min · deploy (EC2) — The minimal path from a built image to a public EC2 host — your simplest step-6 option.
- **[Hands-on: Setup AWS ECR, ECS and Fargate for a Node.js App in Docker](https://www.youtube.com/watch?v=RgLt3R2A20s)** — Stormit · ~20 min · deploy (managed) — The ECR → ECS/Fargate route when you want auto-scaling without managing servers.

**Read (optional depth):** DDIA Chapter 1 (reliability, scalability, maintainability) for the vocabulary behind your NFRs, plus Chapter 6 (partitioning) for when you shard. And the [System Design Primer](https://github.com/donnemartin/system-design-primer) — its "Design a URL shortener" exercise mirrors this capstone step for step (free).

---
*Source: `modules/21-capstone-url-shortener.html` — System Design Mastery. Interactive version has the live simulators.*
