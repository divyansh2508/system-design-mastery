# Microservices Fundamentals

*Phase 4 · Production-Grade·Module 11·Weeks 6-8 · ~13 hrs*

How to split one big program into many small services without splitting your sanity — the boundaries, the wiring, and the data-ownership rules that separate a clean distributed system from a distributed *mess*.

## 01 Monolith vs microservices

A **monolith** is one codebase, one deployable, usually one database. A **microservices** architecture splits that into many small, independently deployable services, each owning one business capability and its own data. Neither is "advanced." The senior move is knowing *which one the problem in front of you actually needs.*

The mistake that gets punished in interviews and in production alike is treating microservices as the default because they sound sophisticated. They are not free — you trade in-process function calls (nanoseconds, transactional, type-checked by the compiler) for network calls (milliseconds, partial-failure-prone, versioned by hand). You buy independent deployability and team autonomy with the currency of operational complexity: service discovery, distributed tracing, retries, idempotency, eventual consistency, and a dozen dashboards. **You should only make that trade when the pain of the monolith is real and specific.**

### When a monolith is the right answer

Start with a monolith — ideally a *modular* monolith with clean internal module boundaries — when you have a small team, an unproven product, and a domain you don't fully understand yet. You get one repo to reason about, one deploy, one database with real ACID transactions, and refactoring is a compiler-checked rename instead of a cross-service migration. Most successful products live happily as a monolith far longer than engineers expect.

### When to split

Reach for microservices when you can point at a concrete force pushing you there — not a vibe:

- **Team scaling.** Many teams stepping on one deploy pipeline and one codebase. Conway's Law says your architecture will mirror your org chart anyway — services let independent teams ship independently.
- **Independent scaling.** One component's load dwarfs the rest. Strava's GPS-upload path and its social feed have wildly different traffic shapes; forcing them to scale together wastes money.
- **Independent deployability & blast radius.** A bad release to the cart shouldn't take down search. Separate services contain failures and let you ship a fix to one capability without redeploying the world.
- **Technology heterogeneity.** The ML-scoring path wants Python + GPUs; the transactional path wants the JVM. Services let each pick its own stack.

| Dimension | Monolith | Microservices |
| --- | --- | --- |
| Deployment | One artifact, one pipeline | Many independent deploys |
| Scaling | Whole app scales together | Per-service, per-load |
| Data | One DB, real transactions | DB per service, eventual consistency |
| Failure blast radius | One bug can down everything | Contained to a service (if done right) |
| Call cost | In-process, ~ns, type-safe | Network, ~ms, partial failure |
| Team fit | Small, co-located | Many autonomous teams |
| Cognitive load | Low — one system | High — distributed system ops |

> **Key idea:** Microservices are an **organizational** solution first and a technical one second. If you don't have the team-scaling, independent-scaling, or blast-radius problem, you're paying the distributed-systems tax for nothing. "Start monolith, extract services when a seam hurts" is the answer that reads as senior.

## 02 Bounded contexts & DDD

Once you decide to split, the hard question is *where to cut.* Cut in the wrong place and you get "distributed monolith" — services so chatty and co-dependent that you have all the cost of microservices and none of the independence. The tool that tells you where to cut is **Domain-Driven Design (DDD)**, and its central concept is the **bounded context**.

A bounded context is a boundary within which a particular **domain model** and its **ubiquitous language** are consistent and unambiguous. The same word can mean genuinely different things in different parts of a business, and a bounded context is where one precise meaning holds. Consider the word "Athlete" at Strava:

```
# The same "Athlete" is a different model in each context

Identity context:     Athlete = { id, email, password_hash, oauth }
Social context:       Athlete = { id, followers[], following[], blocked[] }
Activity context:     Athlete = { id, weight, ftp, heart_rate_zones }   # for calorie/power calcs
Billing context:      Athlete = { id, plan, payment_method, renews_at }
```

Trying to build one giant shared "Athlete" object that serves all four is the classic mistake — it becomes a god-object that every team must coordinate on, which is the opposite of autonomy. DDD says: let each context own its own model of the athlete, keyed by a shared `athlete_id`, and keep the fields that only *it* cares about. The contexts overlap on identity, not on internals.

### The vocabulary you need

- **Domain** — the whole problem space (endurance-sports tracking).
- **Subdomain** — a slice of it (activity recording, social feed, segments, billing). Some are *core* (segments/leaderboards are Strava's differentiator), some are *supporting*, some are *generic* (billing — buy, don't build).
- **Bounded context** — the explicit boundary where one model + one language applies. In practice, a bounded context is your best first guess at a service boundary.
- **Ubiquitous language** — the shared, precise vocabulary that engineers and domain experts both use inside a context. "Kudos," "Segment," "Effort" mean exactly one thing inside the social/segments contexts.
- **Context map** — how contexts relate: which one is upstream, which downstream, and the contract (translation layer) between them.

> **Heuristic:** Draw one service per bounded context, then sanity-check by asking: *"Can this team change its schema and deploy without coordinating with another team?"* If two services must always deploy together or constantly chat to complete a single user action, your boundary is wrong — you cut through a domain concept instead of around it.

## 03 Service communication

Once services are separate processes, they must talk over the network — and *how* they talk is a first-class design decision. The split is **synchronous** (caller waits for a reply) vs **asynchronous** (caller fires a message and moves on).

### Synchronous: REST and gRPC

Synchronous request/response is the natural fit when the caller genuinely needs the answer *right now* to continue — a client fetching a profile, an API gateway assembling a page. **REST over HTTP/JSON** is the lingua franca: universal, human-readable, cacheable, easy to debug with `curl`. **gRPC** (HTTP/2 + Protocol Buffers) is the choice for high-throughput internal service-to-service calls: binary and compact, a typed contract via `.proto` files, code-gen for many languages, and native streaming. Rule of thumb: *REST at the edge (public/browser), gRPC in the mesh (internal, hot paths).*

The trap with synchronous calls is **temporal coupling**: if service A calls B calls C synchronously, then C being slow or down makes A slow or down. Chains of blocking calls turn one flaky dependency into a system-wide outage unless you defend with timeouts, retries with backoff, and circuit breakers (Module 12).

### Asynchronous: queues and event streams

Asynchronous messaging via a broker (RabbitMQ, Amazon SQS, or a log like Apache Kafka) decouples the producer from the consumer *in time*. The producer writes a message and returns immediately; consumers process it whenever they can. This is the right tool when the work can happen in the background, when you need to absorb spikes, or when one event should fan out to many independent consumers.

```
# Strava: one upload, many downstream reactions — perfect for async
Upload service  --("activity.uploaded" {id, athlete})-->  [ QUEUE / LOG ]
                                                              |
                        +-------------------------+-----------+-----------+
                        v                         v                       v
                Segment-matching          Feed fan-out            Achievements
                 (heavy geo work)        (notify followers)      (PRs, badges)
# Upload returns in ~100ms; the slow, spiky work runs later, independently.
```

The cost of async is a harder mental model: eventual consistency (a follower's feed updates a second later), message ordering and deduplication concerns, and the need for **idempotent** consumers (a broker may deliver the same message twice). You also need a dead-letter queue for messages that repeatedly fail.

| Style | Best for | Watch out for |
| --- | --- | --- |
| REST / HTTP | Public APIs, browser clients, simple CRUD | Verbose; chatty over many hops |
| gRPC | Internal hot paths, typed contracts, streaming | Not browser-native; binary is harder to eyeball |
| Async queue / log | Background work, spikes, fan-out, decoupling | Eventual consistency; needs idempotency + DLQ |

> **Interview line:** "Use synchronous when the caller *needs the result to proceed*; use asynchronous when the work *can happen later or fan out*." Say that, then justify each edge in your diagram with it. Naming why an arrow is sync or async is exactly the trade-off reasoning interviewers grade.

## 04 Service discovery

In a monolith, module B's address is "wherever B's function lives in memory." In microservices, instances of a service come and go constantly — autoscaling adds them, deploys replace them, crashes remove them — each on a different host and port. Hard-coding IPs is hopeless. **Service discovery** is the mechanism that answers, at request time: *"Where are the healthy instances of service X right now?"*

The heart of it is a **service registry** — a live database of `{service name → healthy instance addresses}`. Instances *register* on startup and *deregister* on shutdown, and they send periodic **heartbeats**. If a heartbeat stops arriving, the registry evicts that instance so no traffic is routed to a dead process. Tools: Consul, etcd, ZooKeeper, Netflix Eureka; Kubernetes ships this built in.

```
# Registry lifecycle
instance boots  --register(name, ip:port)-->  [ SERVICE REGISTRY ]
instance alive  --heartbeat every ~10s----->  (keeps entry fresh)
no heartbeat    --------- evicts stale entry after timeout ------
caller          --"give me healthy Segment instances"-->  [1.2.3.4:9000, 1.2.3.9:9000]
```

### Client-side vs server-side discovery

There are two places to put the "pick an instance" logic:

- **Client-side discovery.** The caller queries the registry itself, gets the list of healthy instances, and load-balances across them in its own process (e.g., Eureka + a client-side balancer like Ribbon). Fewer network hops and smart balancing, but every service — in every language — must embed discovery logic, which is a lot of duplicated client complexity.
- **Server-side discovery.** The caller sends the request to a stable endpoint — a load balancer, gateway, or the platform's virtual IP — and *that* intermediary queries the registry and forwards to a healthy instance (e.g., a cloud load balancer, or Kubernetes Services + kube-proxy). The client stays dumb and language-agnostic; the cost is an extra hop and a component you must keep highly available.

| Aspect | Client-side | Server-side |
| --- | --- | --- |
| Who picks the instance | The calling service | A load balancer / gateway |
| Network hops | Fewer (direct) | One extra (via LB) |
| Client complexity | High — logic per language | Low — client stays dumb |
| Coupling to registry | Every client knows it | Only the LB knows it |
| Typical stack | Eureka + Ribbon | K8s Services, cloud LB, service mesh |

Modern platforms increasingly hide this entirely behind a **service mesh** (a sidecar proxy next to each service that handles discovery, balancing, retries, and mTLS) — you get server-side-style simplicity for the app with client-side-style locality. That's a Module 12 topic; for now, know the two patterns and the trade-off.

## 05 Data ownership boundaries

Here is the single rule that most separates real microservices from a distributed monolith: **each service owns its own data, and no other service touches that database directly.** The service's API is the *only* door to its data. This is "database per service," and it is what actually delivers the independence you split for.

Why it matters: a service's schema is its *internal implementation detail.* If the Activity service alone reads and writes the activity tables, it can add a column, denormalize for speed, or migrate Postgres → Cassandra without asking anyone. The moment another service reaches into those tables, that schema becomes a public contract frozen by every consumer — and you've lost the freedom you paid for.

```
# Right: data is private; the API is the contract
   Social service  ──HTTP/gRPC──▶  Activity service  ──owns──▶  [ Activity DB ]
                                   (only door in)

# Wrong: Social reaches straight into Activity's tables (see §06)
   Social service  ──────SQL──────────────────────────────────▶ [ Activity DB ]
```

Owning your data also means you get to pick the *right* store per service — the "polyglot persistence" payoff. At Strava: the Activity service leans on object storage for raw GPS streams; Segments/Leaderboards want a Redis sorted set; Social wants a graph or well-indexed relational store; Search wants Elasticsearch. One shared database could never be optimal for all of these at once.

The bill for this independence comes due in two places, both real interview talking points: **no cross-service transactions** (you can't `BEGIN…COMMIT` across two databases — you use the Saga pattern and accept eventual consistency, Module 12), and **no cross-service JOINs** (you assemble data via API composition or by keeping a local read-model built from events). You trade easy consistency for autonomy — on purpose, and you should say so.

## 06 The shared-database anti-pattern

The most seductive shortcut in microservices is letting two services share one database — "it's right there, just read the table." It feels efficient. It is the fastest known way to build a **distributed monolith**: the operational cost of many services with the tight coupling of one.

What goes wrong when the Social service reads Activity's tables directly:

- **Schema lock-in.** Activity can no longer rename or restructure a column — an invisible consumer would break. Every migration becomes a cross-team negotiation. Deploys are no longer independent, which was the whole point.
- **Hidden coupling.** The dependency isn't in any API contract; it's buried in a SQL string. Nobody discovers it until a change breaks production.
- **No encapsulation of rules.** Business logic and invariants that the Activity service enforces (validation, derived fields, permissions) get bypassed entirely by a direct writer.
- **Contended failure domain.** One service's runaway query locks tables or saturates connections and takes down the other — you've merged their fates while pretending they're separate.

> **Nuance worth voicing:** "Shared database" is an anti-pattern, not a law of physics. A read-only reporting replica, or a deliberately shared DB between two services that are really one bounded context split for scaling, can be a pragmatic choice — *if you name the coupling and the constraints out loud.* Seniority is knowing the rule **and** when a conscious exception is cheaper than the ceremony.

The fix is always the same shape: put the data behind the owning service's API and communicate through it — a synchronous query when you need it live, or an emitted event that lets the consumer keep its own local copy. Coupling moves from the invisible schema to a visible, versioned contract.

## 07 Worked example: Strava

Let's run the 5-step framework from Module 1 on *"Design Strava"* — and this time every step is an excuse to spend one of the concepts above. Attempt it yourself first (reps below); read this as the model answer.

### ① Scope

- **Functional:** record & upload an activity (a GPS/sensor time-series — a "ride" or "run"); view an activity with its map and stats; a *social feed* of the people you follow (with kudos & comments); *segments* (named stretches of road/trail) with *leaderboards*.
- **Non-functional:** **durability** — never lose a recorded activity (an athlete's data is sacred); very **read-heavy** feed & leaderboards; **write bursts** at upload (mornings, race days, Strava's infamous holiday spikes); **eventual consistency is fine** for feed, kudos, and leaderboards (a second of lag is invisible); geospatial queries must be fast.
- **Out of scope (say it):** live GPS tracking/"Beacon," full billing, route planning, DM chat. Keep the core tight.

### ② Estimate

Round hard (powers of ten; day ≈ 10⁵ s from Module 1). The one number that changes the design is *points per activity*:

```
Say 10M DAU, ~1 activity each/day        ≈ 10M uploads/day  → ÷100k ≈ 100 uploads/s avg
peak (race morning ×10)                  ≈ ~1,000 uploads/s  → absorb with a queue
1 GPS point / few sec × ~1hr ride        ≈ ~1,000 points/activity
10M activities/day × 1,000 pts × ~30 B   ≈ ~300 GB/day of raw stream → object storage, NOT a row/point
feed reads: 10M users refresh ~10×/day   ≈ 100M reads/day → ~1k QPS avg, cache-friendly
```

Decision the estimate just made for you: *store the raw GPS stream as a blob in object storage (S3-style) and keep only lightweight metadata in a database.* A row per GPS point would be billions of rows/day for no benefit — you almost always read the whole stream at once to draw a map.

### ③ Interface

```
POST /api/v1/activities        # upload; body = metadata + GPS stream (or a presigned URL)
   returns 202 { "activityId": "a_88f3" }   # 202 Accepted — processing continues async
GET  /api/v1/activities/{id}    # activity detail: stats, map polyline, segment efforts
GET  /api/v1/feed?cursor=...    # the follow-feed, paginated
POST /api/v1/activities/{id}/kudos
GET  /api/v1/segments/{id}/leaderboard?window=all|year|following
```

Note the upload returns **202 Accepted**, not 200 with the finished result. That single status code encodes the whole architecture: we durably accept the activity fast, then do the heavy work (segment matching, feed fan-out) asynchronously. Spotting that in the API — before drawing a box — is the senior move from Module 1.

### ④ High-level design — bounded contexts become services

Each service from §02 owns its own datastore (§05). An API gateway fronts them and leans on service discovery (§04) to route:

```
            ┌─────────────── API Gateway ───────────────┐
 client ───▶ │  (edge REST; auth; routes via discovery)   │
            └───┬───────┬───────────┬───────────┬────────┘
                │       │           │           │
          Upload/    Social/     Segment      User/
          Activity    Feed      & Leaderboard  Identity
             │          │            │           │
        [Meta DB +  [Feed store/  [Redis        [Users DB]
         GPS blobs]  graph]       sorted sets]

 Upload flow (sync in, async out):
   1. POST → Activity service stores metadata + GPS blob  → 202 fast   (durable)
   2. emits "activity.uploaded" ─▶ [ QUEUE ]
   3. Segment-matching consumes ─▶ finds segments on the route, writes efforts
   4. Feed consumes ─────────────▶ fans out to followers' feeds
   5. Leaderboard consumes ──────▶ updates Redis sorted sets (ZADD by time)
```

That one diagram exercises the whole module: **sync REST at the edge** (§03) for the upload and reads, an **async queue** (§03) for the fan-out, **service discovery** (§04) at the gateway, and **data owned per service** (§05) — Social never reads Activity's tables; it reacts to the event and keeps its own feed store.

### ⑤ Deep-dive & scale

**Segment matching** is Strava's core, differentiating subdomain — so we invest here. Naively checking each new activity against every segment is O(activities × segments); hopeless. Index geospatially instead: cover the map with a **geohash / quadtree** grid, look up only the segments whose bounding boxes overlap the ride's cells, then run precise polyline matching on that small candidate set. The estimate (heavy CPU per upload) is exactly why this runs off the queue, not in the request.

| Feature | The problem | The move |
| --- | --- | --- |
| Raw GPS stream | Huge, read whole-at-once | Blob in object storage; metadata in DB |
| Segment matching | O(all segments) per upload | Geohash/quadtree candidate set + async |
| Leaderboards | "Rank of my time" is hot | Redis sorted set (ZADD / ZRANK) |
| Social feed | Read-heavy, must feel instant | Fan-out-on-write to per-user feed + cache |
| Upload spikes | 10× on race mornings | Queue absorbs the burst; consumers drain |

**Feed fan-out** repeats the classic trade-off: fan-out-on-write (push each new activity into followers' feed lists) makes reads cheap but is expensive for someone with millions of followers — a pro cyclist. So use the **hybrid**: fan-out-on-write for normal athletes, and for celebrity athletes, *fan-out-on-read* (pull their recent activities in at feed-render time) so one upload doesn't trigger millions of writes. Each escalation is triggered by an NFR or the estimate — never guessed.

> **See it move → your tool:** The gateway-to-services routing you just drew is exactly the traffic the [🚦 Load Balancer Playground](../tools/load-balancer-simulator.html) lets you stress. Push the upload spike, kill an instance, and watch discovery route around the dead one — the §04 concepts, live.

## 08 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard Strava yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end with the 5-step framework, out loud, timed to ~35 minutes — *before* re-reading Section 07. For every service you draw, say the bounded context it maps to and name its private datastore.
2. **Draw the seams.** Take any monolith you know (or the one at work) and mark three bounded contexts you'd extract first, and the concrete force that justifies each cut (team scaling? independent scaling? blast radius?). If you can't name the force, don't split it.
3. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your Strava design against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design Strava." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on the microservices fundamentals specifically: make me justify monolith-vs-microservices and WHERE I split (bounded contexts), which calls are sync vs async and WHY, how services discover each other, who owns which data, and whether any two services share a database. Keep asking "why?" and never lead me to the answer. After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements & scoping, service decomposition (bounded contexts), communication choices (sync/async), data ownership & consistency, deep-dives & scaling, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Explain it back.** Teach "database per service" and the shared-database anti-pattern to a rubber duck (or me) without notes — including the one case where a shared DB is a defensible exception. Gaps you can't explain are gaps you don't have yet.
2. **Flashcards** (make these 5, review at week's end): *What concrete force justifies splitting a monolith? · What is a bounded context, in one sentence? · Sync vs async — when each? · Client-side vs server-side discovery — who picks the instance? · Why is a shared database an anti-pattern, and one time it isn't?*

## 09 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the monolith-vs-microservices and DDD ones *before* your reps; the discovery and communication ones deepen Sections 03–04. (Durations are approximate.)

- **[What is a MICROSERVICE ARCHITECTURE and what are its advantages?](https://www.youtube.com/watch?v=qYhRvH9tJKw)** — Gaurav Sen · ~10 min · monolith vs microservices — The clean intro: why you'd decompose a monolith at all. Watch first.
- **[What Are Microservices Really All About? (And When Not To Use It)](https://www.youtube.com/watch?v=lTAcCNbJ7KE)** — ByteByteGo · ~8 min · when to split — The senior framing — including when a monolith is the right call.
- **[Domain-Driven Design: Bounded Contexts Explained! 🚀](https://www.youtube.com/watch?v=8SPVfacnFvM)** — ByteMonk · ~10 min · DDD / bounded contexts — Where to cut: the boundary concept that stops you building a distributed monolith.
- **[DDD Bounded Contexts & Subdomains](https://www.youtube.com/watch?v=NvBsEnDgA4o)** — Drawing Boxes · ~12 min · DDD / subdomains — Domains, subdomains, and context maps with clear worked examples.
- **[Service discovery and heartbeats in micro-services](https://www.youtube.com/watch?v=lWE_UIbm8NA)** — Gaurav Sen · ~11 min · service discovery — The registry, heartbeats, and how callers find healthy instances — Section 04, visualized.
- **[System Design — Microservice Communications | HTTP | Message Driven](https://www.youtube.com/watch?v=YSquncQY9LQ)** — Code with Irtiza · ~15 min · sync vs async — Synchronous HTTP vs message-driven async, and when to reach for each.

**Read (optional depth):** DDIA Chapter 1 (reliability, scalability, maintainability) — the "evolvability/maintainability" argument *is* the case for services and clean boundaries. Then the [System Design Primer](https://github.com/donnemartin/system-design-primer) sections on *Microservices* and *Service Discovery* (free) for a crisp reference.

---
*Source: `modules/11-microservices-fundamentals.html` — System Design Mastery. Interactive version has the live simulators.*
