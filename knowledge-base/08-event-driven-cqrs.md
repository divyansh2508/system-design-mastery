# Event-Driven Architecture & CQRS

*Phase 3 · Communication·Module 8·Weeks 4-5 · ~13 hrs*

When one action must fan out to a dozen services and stay correct after a crash, synchronous request/response stops scaling — this module is the communication toolkit for systems that talk in **events**, keep a perfect audit trail, and stay consistent across services without distributed locks.

## 01 Why events: the communication shift

Event-driven architecture (EDA) is a style where services communicate by publishing and reacting to **events** — immutable facts about something that already happened — instead of calling each other directly and blocking for a reply.

The default way services talk is **request/response**: the checkout service calls the inventory service, waits, calls the payment service, waits, calls the email service, waits. It's simple to reason about, but it's *temporally coupled* — every callee must be up, fast, and reachable *right now*, and the caller's latency is the sum of everyone downstream. Add a service and you edit the caller. One slow dependency and the whole chain stalls.

EDA inverts the flow. The checkout service does its own job, then emits `OrderPlaced` to a **broker** (Kafka, RabbitMQ, AWS SNS/SQS) and moves on. Inventory, payment, and email each *subscribe* and react on their own schedule. The producer doesn't know who listens; consumers don't know who produced. That decoupling is the whole point — you can add a fraud-check consumer next quarter without touching checkout.

### Commands vs events — a distinction interviewers probe

These get muddled constantly, and the difference is load-bearing:

|  | Command | Event |
| --- | --- | --- |
| Intent | "Please do X" — a request | "X happened" — a fact |
| Tense | Imperative: `ChargePayment` | Past tense: `PaymentCharged` |
| Recipients | Exactly one handler | Zero to many subscribers |
| Can be rejected? | Yes — it may fail validation | No — it already occurred |
| Coupling | Sender knows the receiver | Producer is oblivious to consumers |

You get real benefits — loose coupling, independent scaling, natural buffering during spikes (the broker soaks up bursts), and easy fan-out — but you pay for them in **eventual consistency**, harder debugging (no single call stack — you trace a flow across topics), and duplicate delivery you must design around. The rest of this module is the set of patterns that make those costs manageable.

> **Key idea:** An **event names a fact in the past tense** and is broadcast to whoever cares; a **command** is a request aimed at one handler that can still say no. Confusing the two is the fastest way to design a "pub/sub" system that's secretly a tangle of point-to-point RPCs.

## 02 Event sourcing

Ordinary systems store **current state** and mutate it in place. Update a row and the previous value is gone forever — you kept the *answer* but destroyed the *history* that produced it. **Event sourcing** flips that: the source of truth is an **append-only log of events**, and current state is derived by replaying them in order. Nothing is ever overwritten; you only append new facts.

This is a **persistence** decision, and it is *independent* of the other two big ideas in this module. Event sourcing is not the same as event-driven architecture (a communication style), and it is not CQRS (a read/write modelling split). They compose beautifully, but you can do any one without the others — keep them separate in your head or you'll say something an interviewer catches.

Picture a warehouse tracking stock for one SKU. Instead of a single mutable `quantity` column, you keep the events and fold over them:

```
# Event stream for aggregate  sku:ABC123  (append-only, ordered)
  v1  StockReceived   { qty: 10 }
  v2  StockReceived   { qty:  5 }
  v3  StockShipped    { qty:  6 }
  v4  StockAdjusted   { qty: -2, reason: "damaged" }

# current state = left-fold over the events
  quantity = 10 + 5 − 6 − 2 = 7
```

The unit that owns a stream is the **aggregate** — the consistency boundary (one SKU, one bank account, one order). To change state you load its events, rebuild the in-memory object, run a command that validates and *appends* a new event. Concurrency is handled with an **expected version**: "append `v5` only if the stream is still at `v4`," which gives optimistic locking without holding a database lock.

### Replaying millions of events? Snapshots.

Rebuilding an aggregate with 2 million events on every request would be absurd. The fix is a **snapshot**: periodically persist the folded state at version *N*, then on load start from the snapshot and replay only events after *N*. The log stays the source of truth; the snapshot is a cache you can always throw away and regenerate.

| Dimension | State-oriented (CRUD) | Event sourcing |
| --- | --- | --- |
| Stores | Latest state, mutated in place | Every state change, appended forever |
| History | Lost on update | Complete, replayable audit trail |
| "How did we get here?" | Unanswerable | Replay to any point in time |
| Reads | Query the table directly | Need projections (see CQRS) |
| Cost | Simple, familiar | Schema evolution, replay complexity |

You reach for event sourcing when history *is* the product: audit and compliance ("prove this balance"), debugging by replay, temporal queries ("what did the cart look like at 14:02?"), and the freedom to spin up a brand-new read model later by replaying the log through it. The costs are real — evolving event schemas over years, and the fact that you can't run an ad-hoc `WHERE` over a log. That second problem is exactly what the next pattern solves.

## 03 CQRS: split reads from writes

**Command Query Responsibility Segregation (CQRS)**, coined by Greg Young, is the idea that the model you use to *change* data and the model(s) you use to *read* data don't have to be the same model. Split them. The **write side** handles commands — validation, invariants, consistency — and is often normalized (or an event store). The **read side** is one or more **denormalized projections**, each shaped for a specific query and kept in whatever store serves it best.

Here's the guardrail that separates strong candidates from shaky ones: **CQRS does not require event sourcing, and event sourcing does not require CQRS.** Plenty of teams run CQRS over a plain relational write DB, publishing change events to build read replicas. They just pair naturally — an event log is a perfect source to build projections from — which is why the two are so often discussed together.

```
WRITE SIDE (source of truth)                     READ SIDE (projections)
                                                 ┌───────────────────────────┐
  command ─▶ [validate + apply] ─▶ append event ─┼─▶ projector ─▶ Search index (Elasticsearch)
                    │                            ├─▶ projector ─▶ Leaderboard (Redis sorted set)
                    ▼                            └─▶ projector ─▶ Reporting DB (denormalized SQL)
              event log / write DB                        ▲
                                                          │
                              client queries ─────────────┘   (fast, purpose-built reads)
```

Each projection subscribes to the write side's event stream and updates its own store. Reads never touch the write model — they hit a table (or index, or cache) already shaped like the answer. The trade-off is baked in: the read side is **eventually consistent**, lagging the write side by the projection delay (usually milliseconds). If a user must read-their-own-write instantly, you either read from the write model for that one case or show an optimistic UI.

Reach for CQRS when reads and writes have **asymmetric shapes or scale**: reads vastly outnumber writes, the read queries are complex or varied (a dozen dashboards over the same data), or the two sides need to scale and be stored independently. Skip it for simple CRUD — a split model is real complexity you should only buy when the asymmetry is paying for it.

> **Interview tip:** Say the seam out loud: *"I'll use CQRS here — the write model enforces invariants, and I'll build a denormalized read model per query shape, accepting eventual consistency on the read side."* Then immediately name how you'll keep projections updated (consume the event stream) and what happens on a stale read. That one sentence signals you understand the cost, not just the buzzword.

## 04 The saga pattern

Split a monolith into services, each with its own database, and you lose the one thing a single database gave you for free: the **ACID transaction** spanning everything. "Charge the card AND reserve the seat AND book the hotel" now touches three services and three databases. There is no `BEGIN … COMMIT` that wraps all three.

The textbook fix is **two-phase commit (2PC)**: a coordinator asks every participant to *prepare*, then tells all of them to *commit*. It gives real atomicity — but participants hold locks through the whole exchange, the coordinator is a single point of failure that can leave everyone blocked, and most modern datastores and message brokers don't support it well. It doesn't scale, and it's fragile. So distributed systems reach for a different bargain.

A **saga** is a sequence of **local** transactions. Each step commits in its own service and emits an event that triggers the next step. If a step fails, the saga runs **compensating transactions** — explicit, business-level "undo" operations — to walk back the steps that already committed. You trade ACID atomicity for eventual consistency plus a documented rollback path.

1. **Charge payment** *(forward)* — Payment service authorizes and captures. Local commit. Emits `PaymentCharged`. Compensation: `RefundPayment`.
2. **Activate subscription** *(forward)* — Account service flips the user to premium. Local commit. Emits `SubscriptionActivated`. Compensation: `DeactivateSubscription`.
3. **Grant entitlements** *(fails ✗)* — Entitlement service tries to unlock premium content — and errors out. No local commit here.
↩. **Compensate in reverse** *(rollback)* — Run `DeactivateSubscription`, then `RefundPayment`. The system is back to a consistent state — money returned, access revoked — without ever holding a cross-service lock.

Two properties make sagas actually work in production. Compensations must be **idempotent** and effectively **retryable-until-success** — a refund that's applied twice must not double-refund, and it must eventually go through even if the payment service is briefly down. And because a saga has *no isolation* (other transactions can observe the half-finished intermediate state), you add countermeasures: **semantic locks** (mark the record `PENDING` so nothing else acts on it), commutative updates, or re-reads before committing.

|  | Two-phase commit (2PC) | Saga |
| --- | --- | --- |
| Atomicity | True, all-or-nothing | Eventual; undone via compensation |
| Isolation | Yes (locks held) | No — intermediate state is visible |
| Locks | Held across the whole exchange | Only within each local transaction |
| Failure mode | Coordinator down ⇒ everyone blocks | Step fails ⇒ compensate & move on |
| Scales? | Poorly; rarely used at web scale | Yes — the distributed-systems default |

Notice that "undo" is a *business* decision, not a database rollback. You can't un-send an email — so the compensation for "email sent" might be a follow-up correction email. Designing sensible compensations is most of the real work in a saga.

## 05 Choreography vs orchestration

A saga still needs someone to decide *what happens next* and *when to compensate*. There are exactly two ways to wire that coordination, and knowing when to pick each is a classic senior signal.

### Choreography — no conductor

There is no central brain. Each service subscribes to the events it cares about, does its local work, and emits its own event, which the next service happens to be listening for. The workflow is an **emergent property** of who-listens-to-what.

```
PaymentCharged ─▶ (Account listens) ─▶ SubscriptionActivated
                                    ─▶ (Entitlement listens) ─▶ EntitlementsGranted
                                                            ─▶ (Notification listens) ─▶ ReceiptSent
```

Upside: maximally decoupled, no extra component, easy to add a listener. Downside: the end-to-end flow lives *nowhere* — it's smeared across five services' subscriptions, so no one can point at "the workflow." It invites cyclic dependencies and gets very hard to follow past a few steps, and compensation logic is scattered.

### Orchestration — a conductor

A dedicated **orchestrator** (a saga coordinator) owns the workflow. It sends a command to each participant, waits for the reply, tracks progress in a state machine, and on failure issues the compensating commands in reverse. The whole process is readable in one place.

```
            ┌──────────────── Saga Orchestrator (state machine) ────────────────┐
            │  → ChargePayment    → ActivateSub    → GrantEntitlements  → SendReceipt
   on fail: │  ← RefundPayment    ← DeactivateSub  ← (revoke)                     │
            └───────────────────────────────────────────────────────────────────┘
```

Upside: the workflow is explicit, testable, and easy to extend with branching logic; compensation is centralized. Downside: it's a component you build, run, and keep from turning into a god-object that hoards business logic.

|  | Choreography | Orchestration |
| --- | --- | --- |
| Control | Decentralized; event reactions | Central coordinator issues commands |
| Coupling | Loosest | Participants coupled to orchestrator |
| Visibility | Flow is implicit, hard to trace | Flow is explicit in one place |
| Best for | Simple, linear, ≤ ~4 steps | Complex, branching, business-critical |
| Risk | Cyclic deps, scattered logic | Orchestrator becomes a bottleneck |

Most large systems use **both**: choreography for high-throughput, loosely-coupled pipelines, and orchestration for the gnarly stateful workflows where you must see and control every step.

> **Play with it → your tool:** Open the [🔀 Saga Flow](../tools/saga-flow.html) playground and step a saga through its forward path, then force a failure at step 3 and watch the compensating transactions fire in reverse. Toggle between **choreography** and **orchestration** views to *see* how the same business flow looks when there's no conductor versus when there is one — the fastest way to make this section stick.

## 06 The outbox pattern

Every event-driven service hits the same trap on its very first write. It needs to do two things that must both happen or neither: **update its own database** and **publish an event** to the broker. But the database and Kafka are two separate systems with no shared transaction. This is the **dual-write problem**, and both naive orderings are broken:

- **DB first, then publish:** commit the order, then the process crashes (or Kafka is down) before publishing. The order exists but no event was ever emitted — downstream services never find out. *Lost event.*
- **Publish first, then DB:** emit `OrderPlaced`, then the DB commit fails and rolls back. Now the world believes in an order that doesn't exist. *Phantom event.*

The **transactional outbox** removes the dual write entirely. You write the event into an **outbox table in the very same local transaction** as the business change. One atomic commit — either both the row and the outbox record land, or neither does. A separate **relay** process then reads unsent outbox rows and publishes them to the broker, marking each as sent.

```
-- ONE local ACID transaction: business row + event, atomically
BEGIN;
  INSERT INTO orders(id, user_id, total, status) VALUES (…);
  INSERT INTO outbox(id, aggregate, type, payload, published_at)
         VALUES (…, 'order', 'OrderPlaced', '{…}', NULL);   -- published_at = NULL ⇒ pending
COMMIT;

# Relay (separate process): drain the outbox → broker
for row in outbox where published_at is null:
    publish(row.type, row.payload)          # to Kafka
    mark row.published_at = now()           # at-least-once: a crash here re-publishes
```

One consequence to say out loud: the relay gives **at-least-once** delivery. If it publishes a row and crashes before marking it sent, it'll publish that row again on restart. That's a deliberate trade — never lose an event, occasionally duplicate one — which is why **every consumer must be idempotent** (dedupe by event ID). "At-least-once + idempotent consumers" is the reliable-messaging phrase to have ready.

| Approach | Guarantee | Verdict |
| --- | --- | --- |
| Naive dual write | None — lost or phantom events | Broken; never do this |
| 2PC across DB + broker | Atomic, but locking & fragile | Rarely supported; avoid |
| Transactional outbox | Atomic write, at-least-once publish | The standard solution |

The only open question the outbox leaves is *how* the relay tails the table. Polling works, but there's a cleaner mechanism — which is the next section.

## 07 Change data capture (CDC)

**Change data capture** turns a database's changes into a stream of events. The crude version is **query-based** polling — `SELECT … WHERE updated_at > :last` on a timer — which is simple but adds load, adds latency, and silently misses hard-deletes and rows that changed twice between polls.

The production version is **log-based CDC**: read the database's own **transaction log** — the Postgres *WAL*, the MySQL *binlog* — the same log the database already writes for durability and replication. Every committed change is there, in commit order, with before/after images. Tailing it is low-overhead, misses nothing, and preserves ordering. **Debezium** is the popular open-source CDC platform that does exactly this: it runs as a set of Kafka Connect source connectors, tails the WAL/binlog, and emits a change event to a Kafka topic for every row change.

CDC and the outbox pattern **compose** — this is the connection interviewers love to hear:

```
service ──▶ [tx: business row + outbox row]        # §6, atomic local commit
              │
              ▼  (WAL / binlog)
          Debezium ──▶ Kafka topic  "orders.events"  # §7, tails the log, no polling
              │
              ▼
          consumers (idempotent)
```

Point Debezium at the **outbox table** and it becomes the cleanest possible relay: no polling loop to run, near-real-time latency, and the publishing concern fully decoupled from your service code. Because you emit *domain events* you authored (`OrderPlaced`) rather than raw row diffs, downstream stays clean.

| Approach | Overhead / latency | Catch |
| --- | --- | --- |
| Query-based polling | Extra DB load; polling lag | Misses deletes & intra-interval changes |
| Log-based CDC (Debezium) | Low; near-real-time | Needs WAL/binlog access & a connector |

You *can* also run Debezium straight on your business tables to derive events without an outbox — but then you get **row-level diffs**, not domain events: the stream leaks your table schema and loses the *intent* behind a change (a row where `status` went `PENDING→SHIPPED` doesn't tell you it was an `OrderShipped` business event). The outbox-plus-CDC combo keeps the reliability of log-based capture while letting *you* decide the event shape. That's the pairing to reach for.

## 08 Worked example: Design LeetCode

Let's run the five-step framework on *"Design an online judge like LeetCode"* — users submit code, it runs against hidden tests in a sandbox, and they get a verdict; plus contests with a live leaderboard. It's a near-perfect stage for everything above: async judging (event-driven), verdict history (event sourcing), leaderboards & stats (CQRS projections), premium purchase (saga), and never-lose-a-submission (outbox + CDC).

### ① Scope

- **Functional:** submit a solution → run it against hidden test cases in an isolated sandbox → return a verdict (*Accepted / Wrong Answer / TLE / Runtime Error*) with runtime & memory; view your submission history; per-problem stats (acceptance rate, total submissions); contests with a near-real-time leaderboard. Stretch: premium subscription.
- **Non-functional:** submissions must **never be lost** (durability); judging is **asynchronous** and slow (seconds), so it must be elastic and handle brutal **contest spikes**; heavily **read-heavy** for stats and leaderboards (~100:1); the leaderboard may be **eventually consistent** (near-real-time is fine); each verdict recorded **effectively once** (idempotent); code execution must be securely **isolated**.
- **Out of scope (say it):** the sandbox's container-security internals, the discussion forum, and editorial content — keep the core tight.

### ② Estimate

```
3M submissions/day ÷ 100k  ≈ 30 writes/s average
contest spike: 20k users submit within ~2 min ≈ 150+/s bursts   → must buffer
reads 100:1 (problem pages, leaderboards) ≈ 3,000 reads/s        → CQRS read models + cache
storage: 3M × ~2.5 KB (code + metadata) ≈ 7.5 GB/day ≈ ~2.7 TB/yr (× replication)
judge compute: 30/s × ~3 s per run ≈ ~90 concurrent slots avg    → autoscale to 100s at peak
```

Verdict: writes are modest *on average* but **spiky** → put a broker in front to absorb bursts and autoscale judge workers on lag. Reads dominate → build denormalized read models. Never-lose-a-submission → outbox on the write path.

### ③ Interface

```
POST /api/v1/submissions        { problemId, language, code }
     → 202 { submissionId, status:"QUEUED" }          # async — judging happens out of band
GET  /api/v1/submissions/{id}
     → 200 { status, verdict, runtimeMs, memoryKb }
GET  /api/v1/problems/{id}/stats
     → 200 { accepted, total, acceptanceRate }
GET  /api/v1/contests/{id}/leaderboard?top=100
     → 200 { rankings:[ { rank, userId, score, penalty } … ] }
POST /api/v1/subscriptions      { plan:"premium", paymentToken }
     → 202 { status:"PROCESSING" }
```

The submit returns `202 Accepted`, not `200` — the client gets a ticket and polls (or subscribes over WebSocket). That asymmetry *is* the event-driven core, spotted before a single box is drawn.

### ④ High-level design (happy path)

```
SUBMIT  client ─▶ API ─▶ [tx: INSERT submission row + INSERT outbox row] ─▶ 202 QUEUED
                              │  (code blob → object storage; row keeps the pointer)
RELAY   Debezium tails outbox (WAL) ─▶ Kafka topic  "submissions"
JUDGE   judge-worker pool consumes ─▶ run code in sandbox ─▶ emit "SubmissionJudged" ─▶ Kafka
PROJECT projectors consume "SubmissionJudged" and update read models:
            • user submission history   (read DB)
            • problem stats             (accepted / total counters)
            • contest leaderboard       (Redis sorted set, score+penalty)
QUERY   client polls GET /submissions/{id}; stats & leaderboard served from read models
```

The `submissions` table is the write-side source of truth, and the `SubmissionJudged` stream is effectively an **event-sourced** log of every verdict. The leaderboard, acceptance-rate stats, and history are **CQRS projections** — each optimized for its query (a Redis sorted set ranks in *O(log n)*; counters answer stats in *O(1)*) and each rebuildable by replaying the event log through a fresh projector.

### ⑤ Deep-dive & scale

- **Reliable ingestion (outbox + CDC).** We deliberately do *not* publish to Kafka directly from the API — that's the dual-write trap (§6). The API writes the submission row and an outbox row in one transaction; Debezium tails the WAL and publishes (§7). A crash can never accept a submission that then goes un-judged.
- **The judge pipeline is choreography.** `submissions → SubmissionJudged → projected` is a short, linear flow with no central coordinator — each stage simply reacts to the previous stage's event. Perfect fit for choreography.
- **Idempotency under at-least-once.** Kafka and the outbox both deliver at-least-once, so events carry a `submissionId` and every consumer dedupes on it: the history projector *upserts* by `submissionId`; the stats counter records "already counted" IDs so a redelivered `SubmissionJudged` never double-increments the acceptance rate.
- **Premium purchase is an orchestrated saga.** *charge payment → activate premium → grant entitlements → send receipt*, and if entitlements fail, compensate in reverse (deactivate, refund). This needs branching and visible state, so an orchestrator owns it — exactly what the [🔀 Saga Flow](../tools/saga-flow.html) tool visualizes. (Choreography for the pipeline, orchestration for the money — both, in one system.)
- **Contest spikes = backpressure.** Thousands submit at once; Kafka buffers the burst and judge workers autoscale on consumer-group lag. Per-user rate limits and an in-flight cap stop abuse. The leaderboard updates near-real-time as events flow — eventual consistency here is expected and fine.
- **Hot leaderboard key.** A marquee contest's Redis sorted set is a hot partition; shard by `contestId`, and compute any global ranking by periodic aggregation rather than a per-event global sort.
- **Event schema evolution.** `SubmissionJudged` will grow new fields and verdict types over years; use a schema registry with backward-compatible changes so old projectors keep working and you can replay full history to build new read models.

> **See it move:** The premium-purchase saga you just designed — charge → activate → grant → receipt, with compensations on failure — is exactly what the [🔀 Saga Flow](../tools/saga-flow.html) playground lets you step through and break. Run it after your own attempt below.

## 09 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard LeetCode yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end with the 5-step framework, out loud, timed to ~40 minutes — *before* re-reading Section 08. Force yourself to place the outbox, name where you use event sourcing vs CQRS, and pick choreography or orchestration for each flow.
2. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend every trade-off against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design an online judge like LeetCode — users submit code that is run against hidden test cases and get a verdict, plus contests with a live leaderboard." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on: how I make submissions reliable end-to-end (dual-write / outbox / CDC), whether my leaderboard and acceptance-rate are event-sourced CQRS projections, where I use a saga and whether it's choreography or orchestration, how consumers stay idempotent under at-least-once delivery, and how the system behaves during a contest spike. Do NOT give me the answer or lead me. Keep asking "why?". After ~40 minutes (or when I say "done"), grade me 1–5 on each of: requirements & scope, capacity estimation, API design, high-level (event-driven) design, deep-dives & trade-offs (event sourcing / CQRS / saga / outbox / CDC), and communication — with specific feedback and what a strong candidate would have added.
```

1. **Break a saga in the tool.** In the [🔀 Saga Flow](../tools/saga-flow.html) playground, run the premium-purchase saga forward, then force a failure mid-flow and watch the compensations fire in reverse. Switch between choreography and orchestration views and note what changes.
2. **Explain it back.** Teach the difference between *event sourcing*, *event-driven architecture*, and *CQRS* to a rubber duck (or me) without notes. If you can't keep the three cleanly apart, that's the gap to close before the interview.
3. **Flashcards** (make these 5, review at week's end): *Event sourcing vs event-driven vs CQRS — one line each? · What exact problem does the outbox pattern solve, and how? · Choreography vs orchestration — when each? · Why does at-least-once delivery force idempotent consumers? · One reason log-based CDC (Debezium) beats query-based polling?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the mindset and pattern explainers *before* your reps; save the deeper cuts for *after* your own LeetCode attempt.

- **[What's an Event Driven System?](https://www.youtube.com/watch?v=rJHTK2TfZ1I)** — Gaurav Sen · ~12 min · mindset — The producer/broker/consumer shift and why decoupling wins. Watch first.
- **[Event Sourcing Example & Explained in plain English](https://www.youtube.com/watch?v=AUj4M-st3ic)** — CodeOpinion · ~12 min · event sourcing — Append-only log, aggregates, and rebuilding state by replay — in plain English.
- **[What is CQRS Pattern? How does it work?](https://www.youtube.com/watch?v=BjTVdcGtnh8)** — Javarevisited · ~10 min · CQRS — Splitting the write model from denormalized read projections, and when to bother.
- **[Saga Pattern | Distributed Transactions | Microservices](https://www.youtube.com/watch?v=d2z78guUR4g)** — ByteMonk · ~12 min · saga — Local transactions, compensating actions, and choreography vs orchestration.
- **[This is How You Can Scale The Outbox Pattern](https://www.youtube.com/watch?v=G6ZhgdHBcUI)** — Milan Jovanović · ~15 min · outbox · deeper cut — The dual-write fix in practice, plus how the relay behaves at scale. Watch after the basics land.
- **[Kafka System Design Deep Dive w/ a Ex-Meta Staff Engineer](https://www.youtube.com/watch?v=DU8o-OTeoCc)** — Hello Interview · ~45 min · the broker/log — How the log substrate under every pattern here actually works in an interview. Optional depth.

**Read (optional depth):** DDIA Chapter 11 (*Stream Processing*) is the perfect companion — it covers event sourcing, change data capture/change streams, and building derived state from a log; Chapter 12 (*The Future of Data Systems*) sharpens the CQRS/derived-data angle. Free alternative: the [System Design Primer](https://github.com/donnemartin/system-design-primer) sections on asynchronism and message queues.

---
*Source: `modules/08-event-driven-cqrs.html` — System Design Mastery. Interactive version has the live simulators.*
