# System Design Mastery

A free, self-hosted **System Design learning site** — **28 module guides, 13 interactive simulators, and 8 Docker labs** — built around one idea:

> Don't just *read* about load balancing. **Watch it, break it, and build it.**

No build step, no dependencies, no accounts. Every page is a single self-contained HTML file. Open `index.html` and start.

---

## Why this exists

Most system-design resources are either walls of dense text or a playlist of "design Instagram in 40 minutes" videos. This flips the format:

- **Notes** for the theory (hand-written, at interview depth)
- **Interactive simulators** for the intuition — you *operate* the concept: pick a load-balancing algorithm and watch servers overload, drag nodes on a hash ring and watch keys remap, fire bursts at a rate limiter and watch it throttle
- **Docker labs** for the hands — spin up *real* Nginx, Postgres, Redis, Kafka, Prometheus, and Keycloak and break them
- **Case studies + mock-interview prompts** for the interview itself

Every dynamic or structural concept that text explains badly gets a tool you can play with.

---

## What's inside

| | Count |
|---|---|
| 📘 Module guides | **28** (foundations → capstones + a GenAI track) |
| 🎮 Interactive simulators | **13** |
| 🐳 Docker sandbox labs | **8** |
| ▶️ Curated free videos | **150+** (all links verified) |

### The path — 6 phases + a GenAI track

1. **Foundations** — requirements, back-of-envelope estimation, scaling, load balancing
2. **Data at Scale & Caching** — RDBMS vs NoSQL, indexing, sharding, replication, caching, CDN
3. **Communication** — messaging & Kafka, event-driven & CQRS, REST/GraphQL/gRPC, real-time APIs
4. **Production-Grade** — microservices, resilience, observability, security & compliance
5. **Cloud & DevOps** — AWS, containers & Kubernetes, CI/CD, serverless & AI-integrated systems
6. **Capstones** — build a URL shortener and a real-time chat system, end to end
- **Track B — GenAI** — prompt engineering, RAG, AI agents & MCP

### 🎮 The 13 simulators (`tools/`)

| Tool | What it makes tangible |
|---|---|
| Capacity Estimator | DAU → QPS, storage, bandwidth, servers — with the math shown |
| Load Balancer Playground | routing algorithms, overload, server failure, auto-scaling |
| Consistent Hashing Ring | why adding a node moves ~1/N keys vs. ~everything under `hash % N` |
| Cache Playground | LRU vs LFU vs FIFO eviction, hit ratio, hot keys |
| Message Queue | Kafka partitions, consumer groups, offsets, lag, rebalancing |
| Saga Flow | distributed transactions + compensating rollbacks |
| REST vs GraphQL vs gRPC | round-trips, payload size, over/under-fetching |
| Real-Time Transport | WebSocket vs SSE vs long-polling |
| Rate Limiter | token / leaky bucket, fixed / sliding window |
| Cascade & Circuit Breaker | failure propagation and how a breaker contains it |
| SLO & Error Budget | nines → downtime; error-budget burn |
| OAuth 2.0 Flow | the auth-code + PKCE dance, with live SHA-256 |
| RAG Pipeline | query → embed → retrieve → LLM, with and without retrieval |

### 🐳 The 8 Docker labs (`sandboxes/`)

Nginx load balancing · Postgres indexing & replication · Redis caching & eviction · Kafka partitions & consumer groups · REST/GraphQL/gRPC side by side · WebSocket chat with Redis fan-out · Prometheus + Grafana · OAuth 2.0 with Keycloak.

---

## How to use it

### Option A — just browse (zero setup)
Double-click **`index.html`**. Everything works over `file://`.

### Option B — run a tiny local server (recommended)
Keeps your roadmap progress saved across pages and gives clean URLs:
```bash
cd "System Design"
python3 -m http.server 8000
```
Then open **http://localhost:8000**.

### Option C — run a Docker lab
Each folder under `sandboxes/` is a self-contained stack (needs Docker Desktop):
```bash
cd sandboxes/04-kafka
docker compose up -d
# follow the steps in lab.html, then:
docker compose down -v
```

---

## How each module works — the 4-part loop

Every module runs the same loop:

1. **Learn** — the notes + a verified free video + a deep-dive reference
2. **See it** — the interactive simulator (or a Docker lab)
3. **Drill** — the case study, whiteboarded, then attacked with a copy-paste mock-interview prompt
4. **Lock it** — spaced-repetition flashcards + an explain-it-back pass

---

## Repo layout

```
.
├─ index.html               # start here — the hub
├─ roadmap-dashboard.html   # the 28-module roadmap + progress tracker
├─ modules/                 # 28 module guides (interactive HTML)
├─ knowledge-base/          # the same 28 lessons as plain Markdown (~110k words)
├─ tools/                   # 13 interactive simulators
└─ sandboxes/               # 8 Docker labs (compose + guides)
```

Pure HTML/CSS/JS — no framework, no bundler, works offline.

**Prefer plain text?** [`knowledge-base/`](knowledge-base/) has every lesson as clean Markdown — readable right here on GitHub, or drop it into Obsidian/Notion.

---

## Credits & attribution

- The **topic sequence** follows the structure of the **GeeksforGeeks "System Design"** program syllabus.
- The **interview delivery framework** draws on **Hello Interview**'s method.
- **Depth references:** *Designing Data-Intensive Applications* (Martin Kleppmann), Alex Xu's *System Design Interview* Vol 1 & 2, and the [System Design Primer](https://github.com/donnemartin/system-design-primer).
- **Videos** linked throughout belong to their creators — Gaurav Sen, ByteByteGo, Hussein Nasser, NeetCode, Arpit Bhayani, Hello Interview, CodeKarle, and others.

This is a **personal study project** for learning purposes and is **not affiliated with or endorsed by** any of the above.

## License

Original notes, simulators, and lab code are released under the **MIT License** (see `LICENSE`). Linked third-party videos, books, and courses remain the property of their respective owners.
