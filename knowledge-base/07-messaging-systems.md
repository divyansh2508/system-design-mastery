# Messaging Systems

*Phase 3 · Communication·Module 7·Weeks 4-5 · ~13 hrs*

The moment two services stop calling each other directly and start passing **messages through a broker**, you unlock decoupling, spike absorption, and independent scaling — and inherit duplicates, ordering, and delivery guarantees as the price. This module is how you wield that trade cleanly.

## 01 Synchronous vs asynchronous

Two services can communicate in two fundamentally different ways, and picking the wrong one is the source of a huge share of production outages.

**Synchronous** is a direct request/response: service A calls service B and *blocks* until B answers. It's simple and you get an immediate result — but A and B are now **temporally coupled**. If B is slow, A is slow. If B is down, A's call fails. Chain five services synchronously and their failure probabilities and latencies *compound*: one slow dependency drags the whole request down, and a burst of traffic hits every hop at once.

**Asynchronous** breaks that coupling. Instead of calling B, service A writes a **message** to a broker (a queue or a log) and moves on. B consumes it whenever it's ready. A doesn't wait, doesn't know or care whether B is up right now, and doesn't fall over when B does. The broker sits between them as a durable buffer.

| Dimension | Synchronous (request/response) | Asynchronous (messaging) |
| --- | --- | --- |
| Coupling | Temporal — both must be up together | Decoupled in time and space |
| Result | Immediate, in-band | Deferred; caller gets an ack, not the answer |
| Traffic spikes | Hit the downstream directly | Buffered by the broker (load leveling) |
| Failure blast radius | Propagates up the call chain | Contained — consumer down ≠ producer down |
| Scaling | Coupled; slowest hop dominates | Producer & consumer scale independently |
| Cost | Simple to reason about | Eventual consistency, duplicates, ordering to manage |

The three things async buys you, in the language interviewers reward: **decoupling** (deploy and scale producer and consumer on their own schedules), **load leveling** (a queue absorbs a 10× spike so the consumer drains it at a steady rate instead of crashing), and **resilience** (a downstream outage becomes a growing backlog, not a cascade of failed requests). You reach for it whenever work can happen *after* the response — sending email, encoding video, updating a search index, fanning out a notification.

> **Key idea:** Async doesn't delete the work — it **moves it off the request path** and hands you a buffer. In exchange you accept eventual consistency and must design for *duplicate* and *out-of-order* messages. Everything else in this module is about paying that price on purpose.

## 02 RabbitMQ & AMQP

**RabbitMQ** is the classic message broker — a *smart broker, dumb consumer* system that speaks **AMQP** (Advanced Message Queuing Protocol, 0-9-1). Its whole job is to accept messages and route them to the right queues, then push them to consumers. The routing intelligence lives in the broker.

The AMQP model has four moving parts you must be able to name:

- **Producer** — publishes a message, but *never* directly to a queue. It publishes to an exchange with a **routing key**.
- **Exchange** — the router. It receives every message and decides which queues get a copy based on its type and the bindings attached to it.
- **Binding** — a rule linking an exchange to a queue, often carrying a routing-key pattern. Bindings are the routing table.
- **Queue** — the buffer that holds messages until a consumer acknowledges them. When multiple consumers attach to one queue, they *compete* — each message goes to exactly one of them (the competing-consumers pattern, i.e. a work queue).

### Exchange types — the routing vocabulary

| Exchange type | Routes by | Use it for |
| --- | --- | --- |
| Direct | Exact routing-key match | Point-to-point / severity routing (e.g. `order.created`) |
| Topic | Wildcard pattern (`*` one word, `#` many) | Flexible pub/sub (`payments.*.eu`) |
| Fanout | Ignores the key — copies to every bound queue | Broadcast (cache invalidation, notify all) |
| Headers | Message header attributes, not the key | Multi-attribute routing when keys are too rigid |

Here's a topic exchange fanning one publish out to the queues whose bindings match — and dropping it for those that don't:

```
publish  routing_key = "order.eu.created"
                     │
             ┌───────▼─────────┐   exchange: "orders" (topic)
             │   bindings:     │
             │  order.eu.*  ───┼──▶ [ eu-fulfilment queue ]   match ✓
             │  order.#     ───┼──▶ [ audit-log queue ]        match ✓
             │  order.us.*  ───┼──▶ [ us-fulfilment queue ]    no match ✗ — dropped
             └─────────────────┘
```

**Acknowledgements & prefetch.** RabbitMQ *pushes* messages to consumers. A consumer processes a message and sends an `ack`; only then does the broker delete it. If the consumer dies before acking, RabbitMQ redelivers to another consumer — that's how it gives you at-least-once. `prefetch` caps how many un-acked messages a consumer may hold, which is your flow-control knob so a fast broker doesn't bury a slow worker.

RabbitMQ shines when you need **rich routing**, per-message priorities, request/reply (RPC) over a queue, and a "do this task once" work-queue model. Its weakness is throughput ceiling and the fact that an acked message is *gone* — there is no rewind.

## 03 Apache Kafka

Kafka flips the RabbitMQ philosophy on its head: it is a *dumb broker, smart consumer* system. At its core Kafka is not a queue at all — it's a **distributed, append-only commit log**. Producers append events to the end; consumers read forward at their own pace and track their own position. The broker does almost no routing and never decides who has "finished" a message.

### Topics, partitions & offsets

A **topic** is a named stream of events. Each topic is split into one or more **partitions**, and a partition is the real unit of everything: it's an ordered, immutable sequence of messages, each stamped with a monotonically increasing **offset** (0, 1, 2, …). Two guarantees follow directly and you must state them precisely:

- **Ordering is per-partition, not per-topic.** Kafka guarantees order *within* a partition and makes no promise across partitions. If two events must be processed in order, they must land in the same partition.
- **Partition is chosen by key.** Producers hash the message key to pick a partition (`hash(key) % numPartitions`). Same key → same partition → preserved order. No key → round-robin for balance, order sacrificed.

**Retention, not consumption.** Unlike a queue, reading a Kafka message does *not* remove it. Messages live for a configured retention window (say 7 days) or size cap, regardless of who has read them. This is the superpower: consumers can **replay** history, a new consumer can read from offset 0, and multiple independent teams can read the same stream without stepping on each other.

### Consumer groups

A **consumer group** is how Kafka does both work-sharing and pub/sub with one mechanism. The rule: *within a group, each partition is consumed by exactly one consumer.* So you scale a workload by adding consumers up to the partition count — **partitions are the ceiling on parallelism**. Add more consumers than partitions and the extras sit idle. Meanwhile, *different* groups each get their own full copy of the stream and their own offsets — that's pub/sub across teams.

```
topic "swipes"  (4 partitions, key = userId)

  P0: [o0][o1][o2][o3]───▶            group "match-service"          group "analytics"
  P1: [o0][o1][o2]──────▶   consumerA ⟵ P0,P1                        consumerX ⟵ P0,P1,P2,P3
  P2: [o0][o1][o2][o3]──▶   consumerB ⟵ P2,P3                        (separate offsets,
  P3: [o0][o1]──────────▶                                             replays independently)

  • each partition → exactly one consumer *within* a group
  • parallelism of a group is capped at 4 (the partition count)
  • the two groups read the same data at their own offsets  ← pub/sub
```

Consumers commit their offsets (stored in the internal `__consumer_offsets` topic). Commit *after* processing and a crash replays the last batch — at-least-once. Commit *before* processing and a crash skips it — at-most-once. That single choice is the whole delivery-guarantee story, which is Section 05. Under the hood each partition is replicated to a leader + followers (the in-sync replica set) so a broker failure doesn't lose data.

Kafka is the tool when you need **high throughput** (millions of msgs/s), **replay**, event sourcing, or one stream fanned to many independent consumers. Its cost: no per-message routing, no priorities, and ordering only if you partition deliberately.

## 04 Queue vs log: choosing a broker

Most "RabbitMQ or Kafka?" confusion dissolves once you hold the one mental-model difference: a **queue deletes on consume**, a **log retains and lets consumers track a position**. Everything else is downstream of that.

| Aspect | RabbitMQ (queue / broker) | Kafka (distributed log) |
| --- | --- | --- |
| Core model | Smart broker routes; message removed on ack | Dumb log; message retained, consumer tracks offset |
| Delivery | Push to consumer | Pull by consumer |
| Replay | No — once acked it's gone | Yes — re-read any offset within retention |
| Ordering | Per-queue (weakens with competing consumers) | Strict per-partition |
| Throughput | Tens of thousands msg/s | Millions msg/s |
| Routing | Rich (direct/topic/fanout/headers, priorities) | Minimal — partition by key, consumers filter |
| Best for | Task queues, RPC, complex routing, "do once" | Event streaming, replay, many consumers, analytics |

The interview-grade heuristic: pick **RabbitMQ** when the message is a *command* — a unit of work you want done once and then forgotten, with routing logic ("send this to the EU fulfilment worker"). Pick **Kafka** when the message is an *event* — a fact that happened, that several independent systems will want to read now and possibly re-read later. Commands to a queue; events to a log. Say that sentence in an interview and you sound senior.

## 05 Delivery guarantees

Every messaging system makes one of three promises about how many times a message reaches its consumer. The choice is a trade between *losing* data and *duplicating* it, and it comes down to **when you acknowledge relative to when you process**.

| Guarantee | Mechanism | Failure mode | Use when |
| --- | --- | --- | --- |
| At-most-once | Ack / commit offset *before* processing | Message can be lost on crash | Metrics, logs — a dropped one is harmless |
| At-least-once | Ack / commit offset *after* processing | Message can be duplicated on retry | The default for almost everything |
| Exactly-once | At-least-once + idempotency / transactions | Complex, narrower scope than it sounds | Money movement, dedup-critical pipelines |

**At-least-once is the workhorse.** You process the message, *then* acknowledge. If you crash between the two, the broker redelivers and you handle it again. That means duplicates are not an edge case — they are guaranteed to happen eventually — so an at-least-once consumer *must* be idempotent (Section 07). This is the design most real systems actually run.

> **The exactly-once truth:** Exactly-once *delivery* across an unreliable network is **impossible in the general case** — a sender that gets no ack can't tell whether the message was lost or the ack was lost, so it must either risk losing it or risk resending it. What engineers actually build is exactly-once *processing*: **at-least-once delivery + an idempotent consumer** (or deduplication). The message may arrive twice; its *effect* lands once.

**What Kafka's "exactly-once semantics" (EOS) actually covers.** Kafka can give you exactly-once for a *read-process-write loop that stays inside Kafka*, via two pieces working together:

- **Idempotent producer** — Kafka assigns each producer a Producer ID and a per-partition sequence number, so a retried send is de-duplicated by the broker and written to the log only once.
- **Transactions** — a producer can atomically write to multiple partitions *and* commit its input offsets in one transaction, so a consume-transform-produce step is all-or-nothing.

The load-bearing caveat, and the thing a senior interviewer will probe: **EOS does not extend to external side effects.** If your consumer reads Kafka and then writes a row to Postgres, charges a card, or sends an SMS, Kafka cannot roll those back. For anything that touches the outside world, you are back to at-least-once + idempotency. Don't oversell exactly-once — name its boundary.

> **Play with it → your tool:** Open the [📨 Message Queue Simulator](../tools/message-queue.html) and watch these guarantees become concrete: enqueue faster than the consumer drains and see the backlog build (load leveling); kill a consumer mid-process and watch the un-acked message **redeliver** (at-least-once → a visible duplicate); then flip on an idempotency key and see the duplicate get swallowed. Change one knob at a time and build the muscle memory.

## 06 Dead letter queues

At-least-once has a nasty failure mode: a **poison message**. Suppose one message can never be processed — malformed payload, a referenced record that was deleted, a bug that always throws. The consumer fails, the broker redelivers, it fails again… forever. That single message blocks the queue behind it and burns CPU in an infinite retry loop.

A **dead letter queue (DLQ)** is the release valve. After a message fails a bounded number of times, instead of redelivering it endlessly you *route it aside* to a separate queue (or topic). The main flow keeps moving; the failed message is preserved — not dropped — for inspection, alerting, and later replay once you've shipped a fix.

A message typically dead-letters when it is: **rejected/nacked** past a retry limit, **expired** (TTL elapsed), or the queue hit a **length limit**. The healthy pattern is bounded retries *with backoff*, then DLQ:

```
consume ─▶ process ──ok──▶ ack ✓
   ▲            │
   │          fail
   │            ▼
   └── retry (attempt < N, exponential backoff: 1s, 4s, 16s…)
                │
          attempt == N
                ▼
        ┌──────────────┐   route aside, DON'T redeliver
        │  dead letter  │   → alert on depth, inspect, fix, replay
        └──────────────┘
```

**How each broker does it.** RabbitMQ has first-class support: configure a *dead-letter-exchange* (DLX) on a queue and rejected/expired messages are republished there automatically. Kafka has *no native DLQ* — you implement one by having your consumer (or Kafka Connect / Kafka Streams) catch the failure and produce the bad record to a dedicated `<topic>.DLT` topic, usually with headers recording the original topic, offset, and exception.

> **Operational rule:** A DLQ is worthless if nobody watches it. **Alert on DLQ depth > 0.** A growing dead-letter queue is your earliest, cleanest signal that a downstream contract broke — treat it like a page, not a log.

## 07 Idempotency patterns

Because at-least-once *will* hand you duplicates, the reliability of an async system rests on one property: an operation is **idempotent** if applying it many times has the same effect as applying it once. Idempotency is what turns "the message may arrive twice" into "who cares." Here are the patterns, from simplest to most robust:

- **Idempotency key.** The producer stamps each logical operation with a unique key (a UUID, or a natural key like `(userId, targetId)`). The consumer records processed keys and short-circuits a repeat. This is the workhorse — it's how Stripe's API dedupes retried payments.
- **Natural / semantic idempotency.** Design the write so repeating it is a no-op. Prefer *SET to a value* or *UPSERT with a deterministic ID* over *INCREMENT* or blind *INSERT*. "Set status = shipped" is idempotent; "add 1 to count" is not.
- **Dedup store.** Keep a set of seen message IDs (Redis with a TTL, or a unique DB constraint). Check-then-apply; a duplicate hits the constraint and is dropped. The TTL bounds the memory to your retry window.
- **Optimistic concurrency.** Attach a version number and use compare-and-set (`UPDATE … WHERE version = N`). A stale duplicate updates 0 rows and is safely ignored — this also protects against concurrent writers.
- **Transactional outbox.** Solves the *dual-write problem* — the trap of "write to my DB, then publish to Kafka," where a crash between the two loses or fabricates an event. Instead, write the state change *and* an `outbox` row in one local transaction; a separate relay reads the outbox and publishes. The publish becomes at-least-once and consumers dedup on the outbox row's ID.

A minimal idempotent consumer, spelling out the check-apply-record cycle:

```
def handle(msg):
    key = msg.idempotency_key          # e.g. (user_id, target_id) or a UUID
    if dedup_store.exists(key):        # seen it → this is a duplicate
        ack(msg); return               # swallow, effect already applied

    with db.transaction():             # apply + record atomically
        apply_effect(msg)              # the real work (upsert, not blind insert)
        dedup_store.add(key, ttl=24h)  # remember within the retry window

    ack(msg)                           # ack AFTER work → at-least-once
```

Note the ordering: apply-and-record inside one transaction, *then* ack. If you crash before the ack, the broker redelivers, the dedup check catches it, and the effect stays singular. That single discipline — at-least-once delivery wrapped in an idempotent consumer — is exactly-once processing, built from parts you can actually reason about.

## 08 Worked example: Tinder

Let's run the five-step framework on *"Design Tinder"*, keeping the lens on the messaging spine — swipes, matches, chat, and notifications — because that's where this module's ideas earn their keep.

### ① Scope

- **Functional:** swipe on a profile (like / pass); detect a *match* when two users like each other; deliver a real-time *chat* between matched users; push a *notification* on a new match or message. (Out of scope, say it: recommendation/ranking of the deck, geolocation search, media uploads.)
- **Non-functional:** enormous write volume (swipes dwarf everything); low-latency match notification (feels instant); chat must be **reliable and ordered per conversation**; high availability; eventual consistency is fine for the deck, but a chat message must never be silently lost.

### ② Estimate

```
50M DAU × ~100 swipes/day  = 5B swipes/day
5B ÷ 100,000 (s/day)       ≈ 50k swipes/s avg   peak ×3 ≈ ~150k/s
matches ≈ ~1% of swipes    ≈ 500/s of match events
chat: 10M msgs/day         ≈ 100 msgs/s avg     peak ×5 ≈ ~500/s
```

Verdict: swipes are a **firehose of small events** → a partitioned log (Kafka) built for throughput and replay, not a per-message-routing broker. Match and chat volumes are modest — the hard part there is *correctness and ordering*, not raw scale.

### ③ Interface

```
POST /api/v1/swipes
  header: Idempotency-Key: <uuid>              # dedupe double-taps / client retries
  body:   { "targetUserId": "...", "action": "like" | "pass" }
  returns 202 Accepted   { "matched": false }  # match resolves async

GET  /api/v1/matches
POST /api/v1/matches/{matchId}/messages
  body:   { "clientMsgId": "...", "text": "..." }   # clientMsgId = dedup key
WS   /ws  → live match + message push
```

### ④ High-level design

```
              ┌── Swipe Svc ──▶ Kafka "swipes" (key = userId, N partitions)
 client ─LB─▶ API GW           │
              │                └─▶ Match Worker (consumer group)
              │                       │  reciprocal like in store?
              │                       └─yes─▶ Kafka "matches" ──┬─▶ Notification Svc ─▶ push
              │                                                 └─▶ Chat Svc (opens conversation)
              └── Chat Svc ◀─WS─▶ client
                     └─▶ msgs → queue → deliver + persist (shard by conversationId)
```

Swipes are accepted fast (202) and dropped onto Kafka; a match-worker consumer group does the reciprocal-like check off the hot path; a match emits an event that fans out to notifications and chat.

### ⑤ Deep-dive & scale — where this module pays off

- **Idempotent swipes (Section 07).** Double-taps and client retries are constant on mobile. The write is an *upsert* keyed on `(userId, targetUserId)` plus the `Idempotency-Key` — a second identical swipe is a no-op, so we never fabricate a phantom like or a duplicate match.
- **Match detection over a partitioned stream (Section 03).** Partition `swipes` by `userId` so one user's actions are ordered and one consumer owns them. The worker records the like and checks for the reciprocal in the likes store; on a hit it emits to `matches`. Scale throughput by adding partitions and consumers together — remember partitions cap parallelism.
- **Delivery guarantee for chat (Section 05).** Choose **at-least-once** for messages — losing a text is unacceptable, a rare duplicate is not. Make the message store idempotent via `clientMsgId` (unique constraint), and preserve per-conversation order by partitioning/sharding on `conversationId`. That's exactly-once *processing* without pretending we have exactly-once *delivery*.
- **DLQ for notifications (Section 06).** Push delivery fails routinely — stale device tokens, APNs/FCM hiccups. Retry with backoff, then route failures to a `notifications.DLT` topic and alert on its depth; a bad token shouldn't wedge the notification consumer or drown a healthy user in retries.
- **Don't oversell exactly-once.** We never claim a push is sent exactly once — the network won't allow it. We make the notification consumer idempotent (dedup on notification ID) so a redelivery doesn't double-buzz the phone. Naming that boundary is the senior move.

> **See it move:** The redelivery-and-dedupe behavior your chat pipeline depends on is exactly what the [📨 Message Queue Simulator](../tools/message-queue.html) makes visible — kill a consumer mid-message and watch at-least-once produce the duplicate that your `clientMsgId` constraint then swallows.

## 09 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard Tinder's messaging spine yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design the swipe → match → chat → notification flow end-to-end using the 5-step framework, out loud, timed to ~35 minutes — *before* re-reading Section 08. Force yourself to name a delivery guarantee and an idempotency strategy for every arrow.
2. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design Tinder — focus on the swipe, match, and chat/messaging pipeline." Then act as the interviewer — let me drive, ask clarifying and probing questions, push back on anything hand-wavy, and keep asking "why?". Probe specifically on: how I make swipe writes idempotent, how match detection works over a partitioned event stream, which delivery guarantee I pick for chat and why, where a dead letter queue belongs, and whether my "exactly-once" claim survives external side effects. Do NOT give me the answer or lead me. After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, deep-dives & trade-offs, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Break it in the simulator.** In the [📨 Message Queue Simulator](../tools/message-queue.html), reproduce all three behaviors by hand: build a backlog (load leveling), force a redelivery (at-least-once duplicate), and dead-letter a poison message. If you can't cause each on demand, you don't understand it yet.
2. **Explain it back.** Teach a rubber duck (or me) the queue-vs-log distinction and why exactly-once delivery is impossible — without notes. Gaps you can't explain are gaps you don't have yet.
3. **Flashcards** (make these 5, review at week's end): *Sync vs async — one thing async buys you, one it costs? · Which RabbitMQ exchange type broadcasts to every bound queue? · In Kafka, what is guaranteed ordered — a topic or a partition? · Why is exactly-once delivery impossible, and what do we build instead? · What sends a message to a DLQ, and why not retry forever?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the Kafka primer and the queue-vs-log comparison *before* your reps; save the deep dives for when you want depth.

- **[System Design: Apache Kafka In 3 Minutes](https://www.youtube.com/watch?v=HZklgPkboro)** — ByteByteGo · ~4 min · Kafka primer — The fastest correct mental model of topics, partitions, and consumers. Watch first.
- **[Kafka vs RabbitMQ: The Best Message Queue Explained](https://www.youtube.com/watch?v=PQHf_IzmUXE)** — The Coding Gopher · ~13 min · queue vs log — Side-by-side on the push-vs-pull and delete-vs-retain difference from Section 04.
- **[RabbitMQ Crash Course](https://www.youtube.com/watch?v=Cie5v59mrTg)** — Hussein Nasser · ~43 min · RabbitMQ tutorial — AMQP, exchanges, bindings, and acks — hands-on with Docker. The RabbitMQ half of this module.
- **[System Design Interview - Distributed Message Queue](https://www.youtube.com/watch?v=iJLL-KPqBpM)** — System Design Interview · ~55 min · delivery guarantees — Walks at-most/at-least/exactly-once and dead letter queues from first principles — the core of Sections 05–06.
- **[Kafka System Design Deep Dive w/ a Ex-Meta Staff Engineer](https://www.youtube.com/watch?v=DU8o-OTeoCc)** — Hello Interview · ~35 min · interview deep dive — How to actually wield Kafka in an interview — partitions, consumer groups, trade-offs. Watch before your Tinder rep.

**Read (optional depth):** DDIA Chapter 11, "Stream Processing" (message brokers, partitioned logs, and delivery guarantees — the canonical treatment of everything above). And the [System Design Primer](https://github.com/donnemartin/system-design-primer) section on asynchronism & message queues (free).

---
*Source: `modules/07-messaging-systems.html` — System Design Mastery. Interactive version has the live simulators.*
