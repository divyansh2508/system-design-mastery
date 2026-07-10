# Serverless, Edge & AI-Integrated Systems

*Phase 5 · Cloud & DevOps·Module 20·Weeks 9-10 · ~13 hrs*

The modern design toolbox has three new power tools — **run code without servers**, **run it close to the user**, and **ground an LLM in your own data**. This module teaches when each earns its place, and how they compose into a real product.

## 01 Why serverless & edge changed the shape of systems

For most of this track you provisioned servers — you decided how many, how big, and how they scale. **Serverless flips the default:** you hand the provider a function and a trigger, and it runs (and bills) only while your code executes, scaling from zero to thousands of concurrent copies with no capacity plan.

Two forces make this matter in a design interview. First, **spiky and event-driven workloads** — a thumbnail generated on upload, a webhook, a nightly report — are wasteful on always-on servers and near-free on functions. Second, **latency is a function of distance**: no amount of CPU beats the speed of light, so pushing compute to the *edge* (hundreds of points of presence near users) removes the cross-continent round trip you met back in Module 1's latency table. Layer on a third shift — teams now want products to *reason over their own data* with an LLM — and you get the three themes of this module.

The senior move is not "use serverless everywhere." It is knowing the trade — you give up control over the runtime, accept **cold starts** and execution limits, and lean harder on a provider — in exchange for zero ops and elastic scale. Name that trade out loud and you sound like someone who has run these systems, not just read about them.

> **Key idea:** Serverless, edge, and AI are not architectures — they are **placement decisions**. The interview question is always the same: *which work belongs on a function, which belongs at the edge, and which belongs on a boring always-on server or database?*

## 02 AWS Lambda & cold starts

**AWS Lambda** is the canonical Function-as-a-Service (FaaS). You upload a handler; you wire it to a **trigger** — an HTTP request via API Gateway, a new object in S3, a message on a queue, a scheduled cron, a DynamoDB stream — and Lambda runs one instance of your code per concurrent event. There is no server for you to patch, no autoscaling group to tune. You are billed per **request × duration × memory**, rounded to the millisecond, and idle costs nothing.

### The event-driven mental model

Think of Lambda as glue between managed services. The killer pattern is *"when X happens, run this"* without a server sitting around waiting for X. A user uploads a photo → S3 fires an event → Lambda resizes it → writes thumbnails back to S3. No queue you manage, no worker fleet, no idle cost between uploads.

```
# A Lambda triggered by an S3 upload (pseudocode handler)
def handler(event, context):
    key = event["Records"][0]["s3"]["object"]["key"]
    img = s3.get(bucket, key)              # pull the original
    for size in (128, 512):
        s3.put(bucket, thumb_key(key,size), resize(img, size))
    return {"status": "ok"}                # scales 0→N with upload volume
```

### Cold starts — the one thing they will probe

When a request arrives and no warm instance is available, Lambda must **provision a fresh execution environment**: pull your code, start the runtime, and run your initialization before the handler even begins. That first-request penalty is the **cold start**. A warm instance stays around for a while and serves later requests with none of it.

- **What makes it worse:** large deployment packages, heavy init (loading an ML model, opening DB pools), JVM/.NET runtimes, and — historically — attaching to a VPC.
- **What tames it:** smaller packages, lazy-loading, lighter runtimes, and **provisioned concurrency** (keep N instances pre-warmed — you pay to eliminate the spike). SnapStart snapshots an initialized environment to restore fast.
- **When it does not matter:** async/batch work (image processing, ETL) shrugs off a few hundred ms; a user-facing checkout does not.

| Option | Scaling | Cold start | Best for |
| --- | --- | --- | --- |
| Lambda (FaaS) | 0 → thousands, instant | Yes (ms–seconds) | Spiky, event-driven, glue |
| Containers (ECS/K8s) | Managed, minutes to add nodes | No (long-lived) | Steady load, custom runtime |
| Always-on VM (EC2) | Manual / ASG | No | Predictable, stateful, high-throughput |

**The cost crossover** is the trade-off to name: Lambda is dramatically cheaper for bursty, low-duty-cycle work, but a function pinned at high, constant utilization can cost *more* than an equivalent always-on box. "Serverless until it's busy" is a real and defensible design line.

> **Interview tip:** Never say "I'll use Lambda" and stop. Say *"the resize is async and spiky, so a function is ideal — I'll accept cold starts because it's not user-facing, and reach for provisioned concurrency only if a synchronous path needs it."* The reasoning is the point.

## 03 S3: object storage done right

**Amazon S3** is the internet's default bucket for *blobs* — images, videos, backups, logs, ML artifacts, static sites. It is not a filesystem and not a database; it is a flat namespace of `key → object` with effectively unlimited capacity, 11 nines of durability (data spread across devices and availability zones), and a simple HTTP API. When a design says "store the raw file," it almost always means S3.

### Presigned URLs — let clients talk to S3 directly

The pattern every senior candidate should reach for: **do not proxy large uploads/downloads through your app servers.** Instead your backend mints a **presigned URL** — a time-limited, cryptographically signed link granting one specific operation (PUT this key, or GET that key) — and hands it to the client. The bytes flow straight between client and S3; your server never touches the payload.

```
# Direct-to-S3 upload without streaming bytes through your app
1. client  → app:  "I want to upload profile.jpg"
2. app     → S3:   create presigned PUT (key, 5-min expiry)
3. app     → client: { uploadUrl }          # signed, single-use
4. client  → S3:   PUT profile.jpg to uploadUrl   # app never sees the bytes
5. S3      → Lambda: object-created event   # kick off processing
```

This removes your app tier from the bandwidth path entirely — the single biggest scaling win for any upload-heavy product.

### Versioning & lifecycle

**Versioning** keeps every revision of a key, so an overwrite or delete is recoverable (a delete just adds a "delete marker"). It is your safety net against accidental loss and a building block for audit trails. **Lifecycle policies** then move or expire objects automatically as they age — the tiering that quietly controls storage cost:

| Tier | Access pattern | Relative cost |
| --- | --- | --- |
| S3 Standard | Hot, frequent reads | Highest storage, cheap retrieval |
| Standard-IA | Infrequent, still instant | Lower storage, retrieval fee |
| Glacier / Deep Archive | Cold, rare, minutes–hours to restore | Cheapest storage, slow + costly retrieval |

A lifecycle rule like *"Standard for 30 days → IA for 90 → Glacier after a year → delete after 7 years"* is exactly how you'd retain trade confirmations or logs affordably. Note the crossover with the estimation habit from Module 1: tiering is a cost decision your storage math justifies.

## 04 RDS: the managed relational core

Serverless and edge grab headlines, but most systems still need a **strongly consistent, transactional store of record** — a ledger, an orders table, user accounts. **Amazon RDS** is managed relational (Postgres, MySQL, etc.): AWS runs the engine, patching, backups, and failover so you keep SQL and ACID transactions without babysitting a server. In an interview it's your default answer whenever the data has relationships and correctness beats raw scale.

### Multi-AZ — availability, not scale

**Multi-AZ** keeps a *synchronous standby replica* in a second availability zone. Every commit lands on both before it's acknowledged, so if the primary's zone fails, RDS promotes the standby and repoints the DNS endpoint — automatic failover in a minute or two, no data loss. Crucially, the standby serves *no* traffic; Multi-AZ buys **durability and availability**, never read throughput. That distinction is a classic gotcha.

### Read replicas — scale, not availability

**Read replicas** are the opposite tool: *asynchronous* copies you can point read traffic at, offloading the primary. They scale a read-heavy workload horizontally but lag slightly (eventual consistency), and they are not automatic failover targets. The interview one-liner writes itself:

| Feature | Multi-AZ standby | Read replica |
| --- | --- | --- |
| Replication | Synchronous | Asynchronous (lag) |
| Serves reads? | No | Yes |
| Purpose | Availability / failover | Read scaling |
| Consistency | Strong | Eventual |

You often use **both**: Multi-AZ for the write path's resilience, plus replicas to absorb reads. When writes or storage themselves become the ceiling, that's your cue to shard (Module 3) or reach for a purpose-built store — RDS scales up gracefully but not infinitely.

### Backups & point-in-time recovery

RDS takes **automated daily snapshots** and streams the transaction log, giving **point-in-time recovery** — restore to any second within the retention window (e.g. the moment before a bad migration). For regulated products you also take manual snapshots before risky changes and replicate them cross-region for disaster recovery. "How do you not lose the orders table?" has a crisp answer: Multi-AZ for zone failure, PITR for human error, cross-region snapshots for catastrophe.

## 05 Edge computing: Workers & Lambda@Edge

A CDN caches *static* bytes near users. **Edge computing** goes further — it runs *your logic* at those same hundreds of points of presence, so dynamic decisions happen a few milliseconds from the user instead of a cross-continent hop to your origin. The two names to know:

- **Cloudflare Workers** — code runs in lightweight **V8 isolates** (not containers or micro-VMs). Isolates share a process and spin up in well under a millisecond, so Workers have *effectively no cold start* — a sharp contrast to Lambda, and a great trade-off to name aloud.
- **Lambda@Edge / CloudFront Functions** — AWS's way to run functions at CloudFront edge locations, hooked into the CDN request/response lifecycle (viewer-request, origin-request, and so on).

### What belongs at the edge

Edge shines for **latency-sensitive, mostly-stateless** work that every request touches: auth-token checks, A/B routing and feature flags, request rewriting and redirects, header/geo personalization, bot filtering, and light HTML assembly. What does *not* belong at the edge is anything needing your primary database, heavy CPU, or complex stateful orchestration — those stay at the origin. The clean pattern is *edge for the fast, universal decision; origin for the heavy, authoritative work.*

```
Without edge:   user ──150ms──▶ origin (auth check) ──150ms──▶ user   # 300ms wasted

With edge:      user ──3ms──▶ edge PoP (auth check, cache hit) ──▶ user
                                   └─ only cache misses / writes ──▶ origin
```

Two constraints keep you honest: edge runtimes cap CPU/memory per request and lean on *eventually-consistent* edge storage (Cloudflare KV, edge config). So you push **reads and decisions** outward and keep **authoritative writes** at the center — the same read/write asymmetry you've exploited since the Bitly example, now expressed in geography.

> **Rule of thumb:** If the work is **the same for many users and can tolerate slightly stale state**, it wants the edge. If it must be **correct and consistent for one user right now**, it wants the origin. Latency-critical reads move out; the source of truth stays in.

## 06 Serving AI models at scale

Training a model is a batch job. **Serving** it — answering live requests with low latency and predictable cost — is a systems problem, and it's the one interviews now ask about. The shape mirrors everything else in this track, with a few AI-specific twists.

### Self-hosted inference vs a hosted LLM API

Your first fork is *build or buy*. Call a hosted **LLM API** (Anthropic's Claude, OpenAI, Bedrock) and you get frontier quality with zero GPU ops — you pay per token and design around network latency and rate limits. **Self-host** a model (on GPU instances behind a server like Triton or vLLM) and you own latency, data residency, and unit economics at high volume — but also GPU capacity planning, batching, and cold starts measured in *model-load seconds*. Most products start with an API and self-host only when scale or data-control demands it.

### The levers that make inference affordable

- **Dynamic batching** — a serving layer holds incoming requests for a few milliseconds and runs them through the GPU together. GPUs are throughput machines; batching is the single biggest cost/throughput win.
- **Caching** — identical or semantically-similar prompts can return a cached completion; embeddings for unchanged documents are computed once and stored, never recomputed.
- **Model tiering / cascades** — route easy requests to a small cheap model and escalate only the hard ones to the large model, the same "small model until it's not enough" logic as serverless-until-busy.
- **Autoscaling on GPUs** is coarse and slow — instances are expensive and load slowly — so you keep a warm floor of capacity and absorb bursts with a queue rather than scaling to zero.

The non-functional requirements are familiar with new units: **latency** is now "time to first token" plus tokens/second for a streamed response; **throughput** is tokens/sec per GPU; **cost** is dollars per million tokens. Estimate those exactly as you estimated QPS and storage in Module 1 — the discipline transfers directly.

## 07 RAG architecture

An LLM only knows what it saw in training — it can't cite your private docs and it will confidently hallucinate. **Retrieval-Augmented Generation (RAG)** fixes both: at query time you *retrieve* the most relevant chunks of your own data and stuff them into the prompt as context, so the model answers **grounded in real, current, attributable sources** instead of its frozen memory.

### Two pipelines: offline ingest, online query

Every RAG system is two pipelines that meet at a **vector store**. The offline one prepares knowledge; the online one answers questions.

```
# OFFLINE — ingest / indexing (runs when documents change)
docs ─▶ chunk (e.g. ~500 tokens, overlap) ─▶ embedding model ─▶ vectors
                                                         └─▶ upsert into vector DB (vector + metadata)

# ONLINE — query (runs per user request)
question ─▶ embed ─▶ vector DB: top-k nearest neighbors ─▶ build prompt
        ─▶ [ system + retrieved chunks + question ] ─▶ LLM ─▶ grounded answer + citations
```

The **embedding model** turns text into a vector that captures meaning, so semantically similar text lands nearby in high-dimensional space (Module 1's "same idea, different words still match"). The **vector database** stores those vectors and does fast **approximate nearest-neighbor (ANN)** search — indexes like HNSW or IVF trade a hair of recall for enormous speed, because exact search over millions of vectors is too slow. You keep the **original text plus metadata** alongside each vector so you can inject the real snippet and show a citation.

### Choosing a vector store

| Option | Shape | Reach for it when |
| --- | --- | --- |
| pgvector (Postgres) | Extension on your existing RDS | Modest scale; you want one database and SQL filters |
| Pinecone / managed | Hosted vector service | You want zero ops and elastic scale |
| Weaviate / Milvus / Qdrant | Purpose-built vector DB | Large corpora, hybrid search, self-hosting |
| FAISS | In-process library | Batch / research; you manage persistence yourself |

### Where RAG breaks — and how you defend it

RAG's quality is **capped by retrieval**: garbage chunks in, garbage answer out. The senior deep-dives are chunking strategy (too big dilutes relevance, too small loses context), **hybrid search** (combine keyword/BM25 with vector similarity to catch exact terms like tickers and IDs), **re-ranking** the top-k with a stronger model before it hits the LLM, keeping the index fresh as documents change, and grounding guardrails so the model says "I don't know" when nothing relevant was retrieved. Name retrieval quality as the bottleneck and you've shown you've actually built one.

> **Play with it → your tool:** Open the [🧠 RAG Pipeline](../tools/rag-pipeline.html) and run a question end-to-end: watch it **chunk → embed → retrieve top-k → assemble the prompt → answer**. Change the chunk size and *k* and see retrieval quality (and the final answer) shift — that's the intuition behind every RAG deep-dive above.

## 08 Worked example: Robinhood

Now compose it all. *"Design Robinhood — a commission-free stock-trading app."* This one is beautiful because it forces the hardest trade in the module: **a firehose of read-heavy, latency-critical market data** living next to **a small, sacred, strongly-consistent order-and-money path.** Run the five steps.

### ① Scope

- **Functional:** stream real-time quotes & watchlists; place/cancel orders (market & limit); view portfolio, positions, and P&L; price alerts; an AI "explain this stock" research assistant.
- **Non-functional:** *ultra-low-latency, high-fanout* quote delivery; *strong consistency & durability* on the order and cash ledger (never oversell, never double-execute, never lose a fill); very high availability during market hours; brutal *thundering-herd* spikes at the 9:30 open; a full regulatory *audit trail*.
- **Out of scope (say it):** KYC/onboarding, tax documents, crypto, options Greeks. And name the key fact: **Robinhood is a broker, not an exchange** — it does *not* run a matching engine; it routes orders to external market makers/venues and records the fills.

### ② Estimate

```
users: 25M registered, ~8M DAU
orders:  8M DAU × ~3/day = 24M/day ÷ 86,400 ≈ 280 orders/s avg
         market-open peak ×10           ≈ ~2,800 orders/s     (small! correctness > volume)
market data (the firehose):
  ~5,000 symbols × ~10 ticks/s = 50k ticks/s ingested
  fanned out to millions of live WebSocket subscribers        → read amplification is the story
storage:
  order/ledger rows: 24M/day × ~1 KB × 365 ≈ ~9 TB/yr (durable, RDS)
  raw tick history: enormous → archive to S3 + Glacier, not the hot DB
```

Verdict: two systems in a trench coat. The **write/order path is tiny but must be perfect** → relational, transactional, Multi-AZ. The **read/quote path is a fanout monster** → pub/sub + cache + edge + WebSockets. Design them separately.

### ③ Interface

```
# Real-time quotes — a long-lived stream, not polling
WS   /stream        subscribe { symbols:[...] } → server pushes { symbol, price, ts }

# Place an order — idempotent, the sacred path
POST /api/v1/orders
  Idempotency-Key: <uuid>                 # retries must never double-execute
  body:    { symbol, side:"buy", type:"limit", qty, limitPrice }
  returns: 201 { orderId, status:"pending" }

GET  /api/v1/portfolio                    # positions, cash, P&L
POST /api/v1/assistant  { question }       # RAG over filings/news
```

### ④ High-level design

```
                          ┌───────────────── QUOTE PATH (read firehose) ─────────────────┐
market-data feed ─▶ ingest ─▶ Kafka ─▶ quote service ─▶ Redis (last price) ─▶ WS fanout ─▶ edge PoPs ─▶ clients
                                                                                     (millions of subscribers)

                          ┌───────────────── ORDER PATH (sacred, small) ─────────────────┐
client ─▶ API gateway ─▶ order service ─▶ risk/validation ─▶ broker/order-routing gateway ─▶ external venues
                                   │                                   ▲
                                   ▼                                   │ fills return async
                          ledger DB (RDS, Multi-AZ, ACID) ◀── settle & update positions ──┘
                                   │
                                   └─▶ event stream ─▶ notifications (Lambda), audit log (S3), analytics

AI assistant:  question ─▶ RAG (embed ─▶ vector DB of filings/news ─▶ LLM) ─▶ grounded answer + citations
```

Trace one order: client POSTs with an idempotency key → order service validates buying power against the ledger → hands it to the **order-routing gateway**, which sends it to an external market maker → the fill returns asynchronously → the ledger records the execution in a transaction and updates positions → an event fans out to notifications, the S3 audit log, and analytics. The quote path is entirely separate: the market feed lands on Kafka, the quote service keeps last prices hot in Redis, and a WebSocket fanout tier (fronted by edge PoPs) pushes ticks to every subscriber.

### ⑤ Deep-dive & scale

- **Quote fanout (the read monster):** never let millions of clients poll the DB. Ingest → Kafka → a pub/sub fanout tier holding WebSocket connections, with the *latest* price in Redis. Terminate WebSockets at the **edge** so ticks travel the last mile in milliseconds. Coalesce updates (send the latest, drop stale intermediate ticks) so a hot symbol can't overwhelm a slow client.
- **Order correctness (the sacred path):** the **idempotency key** makes retries safe (exactly-once execution); a **double-entry ledger** in RDS with ACID transactions guarantees cash and positions can never drift; Multi-AZ survives a zone failure with no data loss; point-in-time recovery covers human error. Volume is low — you are optimizing for *never wrong*, not *fast*.
- **Market-open thundering herd:** the 9:30 spike hits both paths. Absorb the order burst with a **queue** in front of the order service (backpressure, not dropped orders); pre-warm the fanout tier; and lean on Redis + edge caching so the quote reads never touch a database.
- **Serverless where it fits:** price alerts, push notifications, end-of-day statement generation into **S3**, and webhook handlers are spiky and async → perfect **Lambda** jobs triggered off the event stream. Cold starts are irrelevant here; keep them off the trading path.
- **The AI assistant:** "explain why NVDA moved today" is **RAG** over SEC filings, earnings transcripts, and news — embed the corpus into a vector store, retrieve top-k at query time, ground the LLM, and *always cite* (financial answers without sources are a liability). Use **hybrid search** so an exact ticker like "NVDA" is never missed by pure vector similarity.

> **Interview tip:** The trap is designing one uniform system. Win by splitting early: *"There are two workloads here with opposite requirements — a read-heavy quote firehose and a tiny consistency-critical order ledger — so I'll design them separately and only share the event stream."* That sentence is the whole interview.

## 09 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard Robinhood yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end with the 5-step framework, out loud, timed to ~40 minutes — *before* re-reading Section 08. Force yourself to split the quote path from the order path on your own.
2. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design Robinhood — a commission-free stock-trading app." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on the tension between the real-time market-data firehose and the strongly-consistent order/money ledger. Probe specifically on: quote fanout to millions of WebSocket clients, idempotent order execution and exactly-once fills, why Robinhood is a broker (routes orders) and not an exchange (no matching engine), the market-open thundering herd, where serverless (Lambda/S3) fits and where it must NOT, and how the RAG "explain this stock" assistant is grounded and cited. Do NOT give me the answer or lead me; keep asking "why?". After ~40 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, deep-dives & trade-offs, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Build the RAG intuition.** In the [🧠 RAG Pipeline](../tools/rag-pipeline.html), change chunk size and *k* and watch retrieval quality move — then explain out loud why retrieval, not the LLM, is the usual bottleneck.
2. **Explain it back.** Teach "serverless-until-busy," Multi-AZ vs read replicas, and edge-vs-origin placement to a rubber duck without notes. Gaps you can't explain are gaps you don't have yet.
3. **Flashcards** (make these 5, review at week's end): *What causes a Lambda cold start & two ways to tame it? · Multi-AZ vs read replica — which scales reads? · Why mint a presigned URL instead of proxying an upload? · Why do Cloudflare Workers have near-zero cold start (isolates)? · In RAG, what is the usual bottleneck and one way to fix it?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the serverless and edge primers *before* your reps; save the RAG and vector-DB ones for when you build the Robinhood assistant.

- **[What is Serverless?](https://www.youtube.com/watch?v=vxJobGtqKVM)** — IBM Technology · ~10 min · serverless — Clean mental model of FaaS, event triggers, and pay-per-use. Watch first.
- **[What is edge computing?](https://www.youtube.com/watch?v=cEOUeItHDdo)** — IBM Technology · ~7 min · edge — Why moving compute to the edge cuts latency — the geography of Section 05.
- **[What is Retrieval-Augmented Generation (RAG)?](https://www.youtube.com/watch?v=T-D1OfcDW1M)** — IBM Technology · ~7 min · RAG — The canonical "why ground an LLM in your data" explainer. Watch before the tool.
- **[Vector Databases simply explained! (Embeddings & Indexes)](https://www.youtube.com/watch?v=dN0lsF2cvm4)** — AssemblyAI · ~4 min · vector DB — Embeddings and ANN indexes in plain terms — the engine under RAG retrieval.
- **[RAG Explained | All about RAG - Retrieval Augmented Generation](https://www.youtube.com/watch?v=dDkynerzV-Q)** — codebasics · ~20 min · RAG deep dive — A longer walk through chunking, embeddings, and the full pipeline. Watch after the intro.

**Read (optional depth):** DDIA Chapter 5 (Replication) sharpens the Multi-AZ-vs-read-replica and sync-vs-async distinctions from Section 04. For the serverless and CDN/edge fundamentals, skim the [System Design Primer](https://github.com/donnemartin/system-design-primer) sections on CDNs, asynchronism, and caching (free).

---
*Source: `modules/20-serverless-edge-ai.html` — System Design Mastery. Interactive version has the live simulators.*
