# Design Thinking & Requirements

*Phase 1 · Foundations·Module 1·Week 1 · ~13 hrs*

Before you learn a single database or cache, you need the **method** — how to walk into any design question and drive it from a blank page to a defensible architecture. This module is the operating system every other module runs on.

## 01 What system design actually is

System design is the craft of deciding a system's **components, its data, and how they communicate** so it meets its requirements — not just today, but at scale and under failure.

Two altitudes get tested. **High-Level Design (HLD)** is the architecture: which services exist, which databases and caches and queues, and how a request flows through them. **Low-Level Design (LLD)** zooms into one service: its classes, method signatures, and design patterns. *This track is about HLD* — that's what senior and Forward-Deployed interviews probe, and it's the thinking that lets you actually architect real systems.

Here's the mindset shift that trips up strong coders: **there is no single correct answer.** A system design interview isn't a puzzle with one solution — it's a conversation where you're judged on how you handle ambiguity, how you reason about trade-offs, and whether you can justify every box you draw. The candidate who says *"I'll use Cassandra because writes dominate and we can tolerate eventual consistency"* beats the one who just says *"I'll use Cassandra"* — even if they draw the same diagram.

> **Key idea:** You are not graded on the diagram. You are graded on the **reasoning that produced it**. Narrate your trade-offs out loud — that's the whole game.

## 02 The 5-step framework

The single most valuable thing you'll take from this entire track is a **repeatable structure** so you never freeze at a blank whiteboard. Interviewers call the popular ones **RESHADED** and **PEDALS**; they're the same idea. Here's the clean version to actually run, with rough timings for a 45-minute round:

1. **Scope** *(~5 min)* — Clarify what you're building. Nail down functional requirements (the features) and the 2–3 non-functional ones that matter (scale, availability, consistency, latency). Explicitly state what's out of scope.
2. **Estimate** *(~5 min)* — Back-of-the-envelope the scale — QPS, storage, bandwidth — but *only the numbers that will change a design decision.* "Read-heavy at 100:1" justifies caching; "3 TB/year" justifies sharding.
3. **Interface** *(~5 min)* — Define the API — the contract between client and system. This forces clarity on inputs and outputs before you touch internals.
4. **Design the happy path** *(~10 min)* — Sketch the data model, then draw the core components and trace one request end-to-end. Keep it simple and correct first — no premature scaling.
5. **Deep-dive & scale** *(~15 min)* — Find where it breaks first, then evolve it to satisfy the NFRs — add caching, replicas, sharding, queues — naming the trade-off at every step. This is where senior candidates separate themselves.

> **Interview tip:** Say the framework out loud as you start: *"Let me clarify requirements, do a quick estimate, define the API, sketch the high-level design, then deep-dive."* It signals seniority in the first 30 seconds and buys you a map.

## 03 Functional vs non-functional

**Functional requirements** are what the system *does* — its features. For a URL shortener: "shorten a long URL," "redirect a short URL to the original," "show click analytics." They're the verbs.

**Non-functional requirements (NFRs)** are the *qualities* the system must have. These are what actually shape your architecture — two systems with identical features but different NFRs get completely different designs. Your job in Step 1 is to pin down the 2–3 that dominate.

| NFR | The question to ask | What it drives |
| --- | --- | --- |
| Scalability | How many users / QPS, and growth? | Horizontal scaling, sharding, caching |
| Availability | What uptime? 99.9%? 99.99%? | Redundancy, replication, failover |
| Latency | How fast must a request feel (p99)? | Caching, CDNs, data locality |
| Consistency | Must all users see the same data instantly? | Strong vs eventual; SQL vs NoSQL |
| Durability | Is losing data catastrophic? | Replication, backups, write guarantees |
| Cost | What's the budget per request? | Storage tier, compute choices |

Availability and consistency are often in tension (you'll meet the CAP theorem below and again in Module 3). A URL shortener wants **high availability** — redirects must always work — and can tolerate a fresh link taking a second to propagate. A bank wants **strong consistency** — you must never see a stale balance. Same-looking systems, opposite designs. That's the power of nailing NFRs early.

## 04 Capacity estimation

Back-of-the-envelope math rattles people in the opening minutes — but it's the most learnable part of the whole interview, because it's just a handful of formulas and aggressive rounding. You estimate to **justify design decisions**: do we need a cache? How many servers? Shard or not?

The one constant to memorize: **a day has ~86,400 seconds — round it to 100,000 (10⁵).** Everything flows from `QPS = daily actions ÷ 100,000`.

### The five quantities

- **QPS** — split reads and writes; compute average, then multiply by a **peak factor** (2–10×) for the real load.
- **Storage** — writes/day × bytes/write × replication × 365 × retention years.
- **Bandwidth** — QPS × payload size.
- **Cache memory** — the hot working set, usually the classic "80% of traffic hits 20% of data."
- **Servers** — peak QPS ÷ what one server handles (~1,000 QPS is a fine default assumption).

A quick worked example — 1M DAU, each doing 10 reads + 1 write per day:

```
writes/day = 1M × 1  = 1,000,000   → ÷ 100k ≈ 10 writes/s avg
reads/day  = 1M × 10 = 10,000,000  → ÷ 100k ≈ 100 reads/s avg  (10:1 read-heavy)
peak (×3)  ≈ 330 QPS total         → tiny; one beefy server + a cache handles this
```

That estimate already made a design decision for you: *it's read-heavy and small, so a single database with a cache is plenty — no sharding yet.* That's the point. Round hard, powers of ten (1 KB=10³ B, 1 MB=10⁶, 1 GB=10⁹, 1 TB=10¹²); a back-of-envelope answer only needs to be right within an order of magnitude.

> **Play with it → your tool:** Open the [🧮 Capacity Estimator](../tools/capacity-estimator.html), hit the **URL Shortener** preset, and watch QPS, storage, bandwidth, cache, and server count fall out — with the arithmetic shown. Change one input at a time and build the intuition for how scale moves.

## 05 API contracts

The API is the contract between the client and your system. Defining it early forces you to be concrete about inputs and outputs before you get lost in internals. Keep it boring and clear: sensible resources, correct HTTP verbs and status codes, versioning, pagination for lists.

```
# Create a short URL
POST /api/v1/urls
  body:    { "longUrl": "https://...", "alias": "optional", "expiresAt": "optional" }
  returns: 201 { "shortUrl": "https://sho.rt/aB3xK9" }

# Redirect (the hot path — must be blazing fast)
GET /{shortCode}
  returns: 302 Found, Location: <longUrl>
```

Notice the write and the read have wildly different profiles: creating a link is rare and can be a little slow; the redirect is ~100× more frequent and must be instant. Spotting that asymmetry in the API is what drives you to cache the read path — and you found it before drawing a single box.

## 06 The trade-off lens

Every real decision is a trade-off: SQL vs NoSQL, strong vs eventual consistency, cache freshness vs load, normalization vs read speed. There is no free lunch — only choices you can defend.

The famous one is the **CAP theorem**: when the network partitions (nodes can't talk), a distributed system must choose between **C**onsistency (everyone sees the same data) and **A**vailability (every request still gets a response). You can't have both *during a partition*. Most consumer web systems pick **AP** — stay up, accept eventual consistency; systems like payments pick **CP** — refuse rather than serve stale. (Much more in Module 3; for now, just carry the intuition.)

### Latency numbers worth internalizing

Good architecture comes from knowing what's fast and what's slow. The exact figures don't matter — the **1,000× jumps** do:

| Operation | Rough latency | Intuition |
| --- | --- | --- |
| Read from RAM | ~100 ns | Effectively free |
| SSD random read | ~150 µs | ~1,000× slower than RAM |
| Network round-trip (same datacenter) | ~500 µs | Cheap within a region |
| Disk (HDD) seek | ~10 ms | ~100,000× slower than RAM |
| Network round-trip (cross-continent) | ~150 ms | The internet is far away |

This one table explains *why* we cache (avoid disk and network), why we replicate data close to users (avoid cross-continent hops), and why "just add a database call" isn't free. Keep it in your head and half of system design becomes obvious.

## 07 Finding the bottleneck

Step 5 of the framework asks "where does this break first?" Trained eyes look for two things: **single points of failure** (one server, one database — kill it and everything stops) and the **component that saturates first** as traffic climbs (usually the database under read load, or a hot key).

Almost every design evolves along the same story, and knowing it lets you scale on demand instead of guessing:

```
single server ──▶ split app & database
             ──▶ add a cache (kill repeated DB reads)
             ──▶ add read replicas (scale reads)
             ──▶ shard the database (scale writes & storage)
             ──▶ add a queue (absorb spikes, decouple work)
```

You don't jump to the end. You start simple and add each piece *only when an NFR or your estimate forces it* — narrating the trade-off each time.

## 08 Worked example: Bitly

Let's run all five steps on the classic opener — *"Design a URL shortener like Bitly."* Read this once, then you'll do it yourself in the reps below.

### ① Scope

- **Functional:** create a short URL from a long one; redirect a short URL to the original. (Stretch: custom alias, expiry, click analytics.)
- **Non-functional:** very high availability (redirects must always work), low-latency redirects, extremely read-heavy (~100:1), durable mappings (never lose a link), scale to billions of URLs.
- **Out of scope (say it):** user accounts, full analytics dashboards — keep the core tight.

### ② Estimate

```
100M new URLs / month ≈ 40 writes/s          (100M ÷ 30 days ÷ 86,400)
read:write 100:1      ≈ 4,000 reads/s         peak ×2–3 ≈ ~10k reads/s
storage: 100M/mo × 12 × 5yr = 6B URLs
         × ~500 B/row ≈ 3 TB (× replication)  → fits, but plan to shard
```

Verdict: read-heavy and durable → **cache aggressively, use read replicas**; storage is large but manageable → shard later, not now.

### ③ Interface

Exactly the API from Section 05 — `POST /urls` and `GET /{shortCode}`.

### ④ Happy-path design

```
Data model (one table):
  urls( short_code PK, long_url, created_at, expires_at? )

Read path:   client → LB → app server → cache(short_code) ─hit─▶ 302 redirect
                                              └─miss─▶ DB → warm cache → 302
Write path:  client → LB → app server → generate short_code → store in DB
```

### ⑤ Deep-dive: how do we generate the short code?

This is the heart of the problem, and a perfect trade-off discussion:

| Approach | Upside | Downside |
| --- | --- | --- |
| Hash(longUrl), take 7 chars | Same URL → same code (dedupe) | Collisions to handle |
| Auto-increment counter → Base62 | Dead simple, no collisions | Single point of coordination; guessable |
| Distributed ID (Snowflake) → Base62 | Scales across servers, unique | Slightly more infra |
| Pre-generated key service (KGS) | Fast, no collision at write time | Extra service to run |

**Why 7 characters?** Base62 (a–z, A–Z, 0–9) with 7 chars = 62⁷ ≈ **3.5 trillion** combinations — comfortably more than our 6B URLs. That's the kind of number you compute live to justify the choice.

**Scaling the reads** (the dominant path): a Redis cache in front absorbs the hot links; read replicas take the misses; a CDN/edge can serve the most popular redirects globally. **Scaling storage:** when the table gets huge, shard by `short_code`. Each move is triggered by the estimate — not guessed.

> **See it move:** The read path you just drew — LB → app servers → cache/DB — is exactly what the [🚦 Load Balancer Playground](../tools/load-balancer-simulator.html) (Module 2) lets you stress and break. You'll build that intuition next.

## 09 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard Bitly yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end using the 5-step framework, out loud, timed to ~35 minutes — *before* re-reading Section 08 or watching the video. Struggling is the point.
2. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design a URL shortener like Bitly." Then act as the interviewer — let me drive, ask clarifying and probing questions, push back on anything hand-wavy, and keep asking "why?". Do NOT give me the answer or lead me. After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, deep-dives & trade-offs, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Defend your numbers** in the [🧮 Capacity Estimator](../tools/capacity-estimator.html) — did your estimate match? Where were you off by an order of magnitude?
2. **Explain it back.** Teach the 5-step framework and functional-vs-non-functional to a rubber duck (or me) without notes. Gaps you can't explain are gaps you don't have yet.
3. **Flashcards** (make these 5, review at week's end): *When AP over CP? · Why cache the read path in Bitly? · Why 7 Base62 chars? · Seconds in a day for estimation? · One reason to shard vs. add a replica?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the framework and estimation ones *before* your reps; save the Bitly walkthrough for *after* your own attempt.

- **[System Design Interview: A Step-By-Step Guide](https://www.youtube.com/watch?v=i7twT3x5yv8)** — ByteByteGo · ~25 min · framework — The canonical 4-step structure to open any interview. Watch first.
- **[Capacity Planning and Estimation: How much data does YouTube store daily?](https://www.youtube.com/watch?v=0myM0k1mjZw)** — Gaurav Sen · ~13 min · estimation — A full DAU → QPS → storage estimation worked end-to-end.
- **[Back-Of-The-Envelope Estimation / Capacity Planning](https://www.youtube.com/watch?v=UC5xf8FbdJc)** — ByteByteGo · ~10 min · estimation — Tight primer on the estimation method as a reusable checklist.
- **[Latency Numbers Every Programmer Should Know](https://www.youtube.com/watch?v=4JSN0VpEv2I)** — Gaurav Sen · ~10 min · fundamentals — Builds intuition for the 1,000× jumps that drive every trade-off.
- **[Design a URL Shortener (Bitly) — System Design Interview](https://www.youtube.com/watch?v=qSJAvd5Mgio)** — NeetCodeIO · ~24 min · Bitly walkthrough — Clean full walkthrough. Watch AFTER your own attempt.
- **[Design a URL Shortener (TinyURL, Bit.ly)](https://www.youtube.com/watch?v=xFeWVugaouk)** — Jordan has no life · ~18 min · deeper cut — Depth on ID generation collisions and sharding — optional second take.

**Read (optional depth):** DDIA Chapter 1 (reliability, scalability, maintainability) — the vocabulary for everything above. And the [System Design Primer](https://github.com/donnemartin/system-design-primer) intro + its back-of-the-envelope section (free).

---
*Source: `modules/01-design-thinking.html` — System Design Mastery. Interactive version has the live simulators.*
