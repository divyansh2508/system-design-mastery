# Database Fundamentals

*Phase 2 · Data at Scale·Module 3·Weeks 2-3 · ~13 hrs*

The database is the single decision that shapes every other box on your diagram — its data model, its consistency guarantees, and how it fails under load. This module gives you the vocabulary and the judgment to pick the right one and defend it.

## 01 Why the database decides the design

Pick the wrong database and no amount of caching, sharding, or clever code fully saves you — you've committed to a data model, a consistency story, and a scaling ceiling that everything downstream must live with.

In an interview, "which database?" is never really about naming a product. It's about connecting the **non-functional requirements** you gathered in Step 1 to a storage engine that satisfies them. Read-heavy with a hot working set? You'll reach for caching and replicas. Money moving between accounts? You need transactions and strong consistency. Billions of append-only events with a flexible shape? A wide-column or document store earns its keep. The database is where the abstract NFRs — consistency, availability, latency, durability, scale — become concrete engineering.

This module is the toolkit for that decision. By the end you'll be able to reason out loud like a senior candidate: *"Orders need atomic money-plus-inventory updates, so that's a relational store with ACID; live driver locations are high-write and disposable, so those go in a separate key-value store tuned for throughput — different data, different guarantees, different database."* That sentence — not the product name — is what gets you hired.

> **Key idea:** There is no "best" database — only the best fit for a specific set of requirements. Your job is to make the requirements decide, and to **say the trade-off out loud** every time you choose.

## 02 RDBMS vs NoSQL — and when

A **relational database (RDBMS)** — Postgres, MySQL, SQL Server — stores data in tables with a fixed schema, related through keys, and queried with SQL. Its superpowers are **ACID transactions**, rich joins, and strong consistency. Its classic weakness is scaling *writes*: the traditional path is to scale up (a bigger box), and scaling out means sharding, which is real work.

**NoSQL** is an umbrella over several non-relational shapes, each with a different sweet spot. They generally trade some of SQL's guarantees (ACID, joins, ad-hoc queries) for horizontal scalability, flexible schemas, and very high throughput on their happy path.

| NoSQL type | Shape | Great for | Examples |
| --- | --- | --- | --- |
| Key-value | key → opaque blob | Caches, sessions, high-throughput lookups | Redis, DynamoDB |
| Document | key → JSON document | Flexible/nested entities, catalogs, profiles | MongoDB, Couchbase |
| Wide-column | row key → dynamic columns | Massive write volume, time-series, feeds | Cassandra, Bigtable |
| Graph | nodes + edges | Relationship-heavy queries (social, fraud) | Neo4j, Neptune |

### The decision, boiled down

Don't memorize a flowchart — reason from the data and the NFRs. A few high-signal questions do most of the work:

| Question | Leans RDBMS | Leans NoSQL |
| --- | --- | --- |
| Is the schema stable & relational? | Yes — many entities, many joins | No — varied/nested, few joins |
| Do you need multi-row ACID transactions? | Yes (payments, inventory) | Rarely / single-item only |
| Is write volume enormous & growing? | Manageable | Huge — needs horizontal scale |
| Are access patterns known & narrow? | No — ad-hoc queries needed | Yes — design tables per query |
| Consistency vs availability priority? | Strong consistency | High availability, eventual OK |

The honest senior answer is often **"both"** — a technique called *polyglot persistence*. Keep transactional order and payment state in Postgres for its guarantees, and push the firehose of clicks, locations, or events into Cassandra or DynamoDB for scale. Naming the split, and why each side lives where it does, is exactly the reasoning interviewers reward.

> **Interview tip:** Never open with "I'll use MongoDB because it scales." Open with the requirement: *"Writes dominate at ~2,500/s and the records are self-contained with no cross-entity transactions, so a horizontally scalable store like Cassandra fits — I'd give up joins here, which is fine because I don't need them."* Requirement → choice → trade-off. Every time.

## 03 ACID vs BASE

These are two philosophies of what a database promises. **ACID** is the guarantee model of relational databases; **BASE** describes the looser posture many distributed NoSQL systems take to stay available and scalable.

### ACID — the four letters

- **Atomicity** — a transaction is all-or-nothing. Debit account A *and* credit account B both happen, or neither does. A crash mid-way rolls the whole thing back.
- **Consistency** — every committed transaction moves the database from one valid state to another, respecting all constraints (foreign keys, uniqueness, checks). Invariants never break. *(Note: this is not the same "consistency" as in CAP — see the callout below.)*
- **Isolation** — concurrent transactions don't step on each other; the result is as if they ran one at a time. Databases offer *isolation levels* (read committed → repeatable read → serializable) trading strictness for concurrency.
- **Durability** — once committed, it survives crashes, usually via a write-ahead log flushed to durable storage before the commit returns.

### BASE — the pragmatic opposite

**B**asically **A**vailable, **S**oft state, **E**ventually consistent. The system prioritizes staying up and accepting writes even when nodes are out of sync; replicas converge to the same value *eventually*, not instantly. You trade the "always correct right now" guarantee for availability and scale.

| Dimension | ACID | BASE |
| --- | --- | --- |
| Consistency | Strong, immediate | Eventual |
| Availability | May block to stay correct | Prioritized — always answers |
| Scaling model | Typically scale up / shard | Scale out horizontally |
| Best for | Payments, inventory, bookings | Feeds, sensors, analytics, catalogs |
| Typical home | Postgres, MySQL | Cassandra, DynamoDB, Riak |

Neither is "better." A transfer of money must be ACID — a lost or duplicated debit is unacceptable. A "like" count or a driver's last-known location can be BASE — a second of staleness is invisible to users and buys you enormous availability and throughput. Match the guarantee to the cost of being wrong.

> **Watch the word "consistency":** ACID's **C** means "constraints stay valid within a transaction." CAP's **C** (next section) means "every node returns the latest write." Same word, different concept — interviewers love to see you distinguish them.

## 04 CAP theorem & PACELC

The CAP theorem is the most-quoted and most-mangled idea in system design. Stated precisely: in a distributed system, **when a network partition occurs** (nodes can't all talk to each other), you must choose between **C**onsistency (every read sees the latest write) and **A**vailability (every request gets a non-error response). You cannot have both *during the partition*.

The subtle, important part: **Partition tolerance is not optional** in any real distributed system — networks drop packets and links fail, full stop. So CAP isn't "pick 2 of 3." It's: given that partitions *will* happen, when one does, do you sacrifice C or A? That's the only real choice.

| Choice | During a partition… | Use when | Examples |
| --- | --- | --- | --- |
| CP (consistency) | Reject/block requests rather than serve stale data | Correctness beats uptime (banking, inventory) | Spanner, HBase, ZooKeeper |
| AP (availability) | Keep answering, allow temporarily stale reads | Uptime beats freshness (feeds, carts, locations) | Cassandra, DynamoDB, Riak |

> **Common trap:** CAP only says anything *during a partition*. When the network is healthy, a well-built system gives you both strong consistency and availability — you are not permanently giving up C or A. If a candidate says "Cassandra sacrifices consistency," push them: it does so **only during a partition**, and even then it's tunable per query.

### PACELC — the missing half

CAP is silent about the 99.9% of the time when there's *no* partition — yet distributed systems still make a real trade-off then, between latency and consistency. **PACELC** completes the picture:

```
if there is a Partition (P):     trade Availability (A) vs Consistency (C)
Else, in normal operation (E):   trade Latency    (L) vs Consistency (C)
```

Read it as: "**P** → **A** or **C**; **E**lse → **L** or **C**." The insight is that even with a healthy network, guaranteeing every replica agrees before answering (strong consistency) *costs latency* — you wait for a quorum or the leader. Relax consistency and you can answer from the nearest replica, faster.

| System | PACELC class | Reading |
| --- | --- | --- |
| Cassandra / DynamoDB | PA / EL | Availability under partition; low latency otherwise (both favor A/L over C) |
| Classic single-node RDBMS | PC / EC | Consistency under partition and low-latency-be-damned normally |
| Google Spanner | PC / EC | Chooses consistency in both regimes (pays latency to get it) |

Dropping "PACELC" and correctly placing your chosen database on it is a strong senior signal — it shows you know the trade-off doesn't disappear when the network is fine.

## 05 Indexing: B-tree, hash, composite

An index is a secondary data structure that lets the database **find rows without scanning the whole table**. Without one, a lookup on a billion-row table reads a billion rows (a *full table scan*); with the right index it reads a handful. The whole point of an index is to **eliminate rows from consideration cheaply**.

Indexes aren't free — every write must also update every index on that table, and each index consumes storage. So you index the columns you filter, join, or sort on, and no more. Over-indexing quietly taxes every insert and update.

### B-tree (really B+ tree) — the default

The workhorse index in every relational database is a **B+ tree**: a balanced, high-fan-out tree where all actual keys live in the *leaf* level and the leaves are linked in sorted order. Two consequences matter:

- **O(log n) lookups** — with a fan-out of hundreds, even a billion rows is only ~4–5 levels deep, so a lookup touches a few pages, not the whole table.
- **Range scans are cheap** — because leaves are sorted and linked, `WHERE created_at BETWEEN x AND y`, `<`, `>`, prefix matches, and `ORDER BY` all walk the leaf chain instead of jumping around. This is why B+ trees dominate.

### Hash index — fast equality, nothing else

A hash index stores `hash(key) → row location`. It gives **O(1) equality lookups** (`WHERE id = 42`) and is beautifully simple. The catch: hashing destroys ordering, so it supports *no* range queries, prefix matches, or sorting. Use it when you only ever do exact-match lookups; otherwise a B+ tree is the safer default because it does equality *and* ranges.

| Index | Equality (=) | Range / sort | Cost |
| --- | --- | --- | --- |
| B+ tree | O(log n) | Yes — sorted leaves | Slightly larger, general-purpose |
| Hash | O(1) | No | Compact, equality-only |

### Composite index & the leftmost-prefix rule

A **composite index** covers multiple columns in a defined order, e.g. `INDEX(merchant_id, status, created_at)`. The critical rule: it can be used only for a **leftmost prefix** of its columns. That single index serves:

```
INDEX (merchant_id, status, created_at)  column order matters!

✓ served   WHERE merchant_id = ?
✓ served   WHERE merchant_id = ? AND status = ?
✓ served   WHERE merchant_id = ? AND status = ? AND created_at > ?
✗ NOT      WHERE status = ?                 skips leftmost col
✗ NOT      WHERE created_at > ?             skips two leftmost cols
```

So column order is a design decision: put the column you *always* filter on (usually an equality) first, and the range/sort column last. A *covering index* — one that includes every column a query needs — lets the database answer straight from the index without touching the table at all, the fastest read of all.

> **Rule of thumb:** Index for your **read patterns**: the columns in your `WHERE`, `JOIN`, and `ORDER BY`. Equality columns go left, range columns go right. Then check the query planner (`EXPLAIN`) actually uses it — an index the planner ignores is pure write tax.

## 06 Schema design & query optimization

Schema design is choosing how your data is shaped and split across tables (or documents). The central tension is **normalization vs denormalization**.

- **Normalization** stores each fact once and links by keys. No duplication, so updates are cheap and consistent — but reads pay for *joins* to reassemble the picture. It's the relational default and great for write-heavy, correctness-critical data.
- **Denormalization** deliberately duplicates data (e.g. embedding the merchant's name inside each order row) so a read needs no join. Reads get faster and simpler; the cost is data that can drift and writes that must update many copies. It's how you buy read speed and how most NoSQL modeling works — you shape tables around the queries you'll run.

The senior instinct: normalize by default for transactional data, then denormalize *surgically* on the specific read paths that your estimates show are hot — and name the consistency cost you're accepting.

### Query optimization in practice

Most "slow database" problems are slow *queries*, not slow databases. The toolkit:

- **`EXPLAIN` / query plan** — always the first move. It tells you whether the planner is doing an index seek or a full table scan, and where the time goes.
- **Add or fix an index** — a full scan on a filtered column is the number-one culprit; the right index turns it into a seek.
- **Select only what you need** — avoid `SELECT *`; fetch fewer columns and rows, and paginate large result sets (keyset pagination over huge `OFFSET`s).
- **Kill N+1 queries** — one query in a loop becomes thousands of round-trips; batch them into a single join or `IN (…)`.
- **Watch the hot path** — an unindexed join or a query that sorts a million rows in memory will dominate p99 long before CPU or disk does.

> **Interview tip:** When asked "the database is slow, what do you do?", resist "add a cache" as the reflex. Say: *"First I'd `EXPLAIN` the hot queries to see if we're scanning instead of seeking, add the missing index, and only then reach for caching or replicas."* Diagnose before you scale.

## 07 Performance bottlenecks

Databases almost always break in the same handful of ways. Knowing the failure list lets you predict where a design will strain and fix the real bottleneck instead of guessing.

| Bottleneck | Symptom | Typical fix |
| --- | --- | --- |
| Read overload | Repeated identical reads swamp the DB | Cache (Redis) + read replicas |
| Write overload | Single primary saturates on writes | Shard by key; batch/queue writes |
| Full table scans | Query latency grows with table size | Add the right index |
| Hot partition / hot key | One shard or key gets all the traffic | Better shard key; split the hot key |
| Lock contention | Concurrent writes to same rows stall | Shorter transactions; right isolation level |
| Connection exhaustion | App opens more connections than DB allows | Connection pooling (PgBouncer) |

The standard scaling escalation for a database mirrors Module 1's story — and each step is triggered by a specific symptom, not applied preemptively:

```
one database ──▶ add a cache            (kill repeated reads; hot working set)
             ──▶ add read replicas      (scale reads; primary still takes writes)
             ──▶ shard the database      (scale writes & storage across nodes)
             ──▶ specialize the store    (move firehose data to a fit-for-purpose DB)
```

**The one to watch:** replicas scale reads but *not* writes — the primary still absorbs every write. When writes are the bottleneck, replicas don't help; you must shard (or move that write stream to a store built for it). Naming that distinction — "replica for reads, shard for writes" — is a classic senior tell.

> **Play with it → your tool:** Watch reads pile onto a single backend and then spread across replicas in the [🚦 Load Balancer Playground](../tools/load-balancer-simulator.html). It's the read-scaling half of this section, made tangible — push load until one node saturates, then add capacity and watch p99 recover.

## 08 Case study: Local Delivery Service

Let's run the full 5-step framework on *"Design a local delivery service (like DoorDash for one metro)"* — customers order from nearby merchants, a courier is matched, and everyone tracks the delivery live. Every concept from this module shows up.

1. **Scope** *(requirements)* — Functional: browse nearby merchants, place an order, match the nearest available courier, track the courier live, mark delivered. NFR: high availability (orders must not fail), low-latency live tracking, geo-queries ("couriers near a point"), strong consistency for order + payment state, eventual is fine for live locations.
2. **Estimate** *(the numbers that decide)* — ~500K orders/day and ~10K active couriers pinging location every 4s. Order writes are tiny; location writes are the firehose. That asymmetry decides the whole storage design.
3. **Interface** *(the contract)* — A handful of endpoints for orders, tracking, courier pings, and a geo merchant search — write path and read path have very different profiles.
4. **High-level design** *(happy path)* — Split services by data guarantee: an Order service on a relational DB, a Location service on a fast key-value store, a merchant catalog, a matching service.
5. **Deep-dive & scale** *(where it breaks)* — Geo-indexing for matching, the location write firehose, hot metro partitions, and exactly-once order state.

### ① Scope

- **Functional:** find nearby merchants; place & pay for an order; match the closest available courier; stream the courier's live location to the customer; complete the delivery.
- **Non-functional:** high availability for ordering; near-real-time tracking (updates within a couple seconds); efficient geospatial queries; **strong consistency** for order/payment/inventory (never double-charge, never assign one courier two conflicting jobs); **eventual consistency acceptable** for live location.
- **Out of scope (say it):** merchant onboarding, ratings, promotions, ML for ETA prediction — keep the core tight.

### ② Estimate — the asymmetry that decides everything

```
Orders:     500,000 / day  ÷ 86,400 ≈ 6 writes/s avg
            peak ×5 (lunch/dinner rush)  ≈ 30 order writes/s   → tiny
Tracking reads: each order polled ~20×  = 10M reads/day
            ÷ 86,400 ≈ 116/s avg, peak ×5 ≈ ~600 reads/s      → small

Courier location pings:
            10,000 active couriers × (1 ping / 4s)
            = 2,500 location writes/s (sustained)              → THE firehose

Order storage: 500K/day × ~1 KB × 365 × 3 yr ≈ ~550 GB       → fits one DB, shard later
Location data: ephemeral — only "latest" matters, TTL it
```

**Verdict:** order writes are trivial and demand correctness → relational, ACID. Location writes are ~400× heavier and disposable → a separate high-write, in-memory store. *The estimate just designed the storage layer for us* — this is why we estimate.

### ③ Interface

```
# Find merchants near me (geo read)
GET  /api/v1/merchants?lat=..&lng=..&radius=3km   → 200 [ merchants ]

# Place an order (ACID write — money + inventory)
POST /api/v1/orders   { merchantId, items[], addr }  → 201 { orderId, status }

# Courier pushes location (the firehose)
POST /api/v1/couriers/{id}/location  { lat, lng, ts } → 202 Accepted

# Customer streams live tracking (hot read)
GET  /api/v1/orders/{id}/tracking    → 200 { courierLat, courierLng, eta }
```

### ④ High-level design — split by guarantee

```
                         ┌───────────────┐   Postgres (ACID, sharded by city)
   client ─▶ API GW/LB ─▶ │ Order service │──▶ orders, payments, inventory
                    │     └───────────────┘
                    │     ┌────────────────┐  Redis (GEO + TTL) / Cassandra
                    ├───▶ │ Location svc   │──▶ courier_id → {lat,lng,ts}
                    │     └────────────────┘   2,500 writes/s, eventual OK
                    │     ┌────────────────┐  geo index (geohash / S2 / quadtree)
                    ├───▶ │ Matching svc   │──▶ "couriers within 3km, available"
                    │     └────────────────┘
                    └───▶ Merchant catalog (document store, read-heavy, cached)
```

The key move: **different data, different database.** Order/payment state lives in Postgres so a single transaction can atomically reserve inventory, charge the customer, and create the order (Atomicity + Isolation stop double-charges and double-assignments). Courier locations live in Redis/Cassandra, tuned for 2,500 writes/s with a TTL — losing a stale ping is harmless, so we happily trade consistency for throughput (BASE, AP).

### ⑤ Deep-dive & scale

**Geospatial matching.** "Find couriers within 3 km" can't use a normal B-tree on lat/lng — a 2-D range isn't a leftmost prefix of anything. Encode location with a **geohash** (or S2/quadtree) that maps 2-D proximity to a 1-D sortable string, then a B-tree/sorted lookup on the geohash prefix returns nearby candidates fast. Redis ships this as `GEOADD`/`GEOSEARCH`. This is composite-index thinking applied to geography.

**The location firehose.** 2,500 writes/s must never touch the orders database. Couriers write to the Location service, which keeps only the latest position per courier in Redis (with a short TTL) and optionally streams the raw pings to Kafka for anyone who wants history — the orders DB stays calm and correct.

**Hot partitions.** A dense downtown at dinner concentrates couriers and orders in a few geohash cells. Shard orders by `city_id` to spread load across metros, and for a genuinely hot cell, sub-partition by a finer geohash so one node doesn't take the whole rush.

**Consistency per store, stated explicitly:**

| Data | Store | Model | CAP / PACELC |
| --- | --- | --- | --- |
| Orders, payments, inventory | Postgres (sharded) | ACID, strong | CP / EC |
| Courier live location | Redis / Cassandra | BASE, eventual | AP / EL |
| Merchant catalog | Document + cache | Read-optimized | AP / EL |

**Indexing the order table.** The hot queries are "a merchant's active orders" and "a customer's recent orders." A composite `INDEX(merchant_id, status, created_at)` serves the merchant dashboard (equality on merchant_id + status, range/sort on created_at — a perfect leftmost-prefix fit), and a separate `INDEX(customer_id, created_at)` serves order history. Every index is justified by a query, and each one is checked with `EXPLAIN`.

> **The through-line:** One problem exercised every concept: **RDBMS vs NoSQL** (Postgres for orders, Redis/Cassandra for locations), **ACID vs BASE** (charge-atomically vs ping-eventually), **CAP/PACELC** (CP orders, AP locations), **indexing** (composite + geohash), and **bottlenecks** (firehose writes, hot partitions). That integration — not any single fact — is what a senior interview is measuring.

## 09 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard the delivery service yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end with the 5-step framework, out loud, timed to ~35 minutes — *before* re-reading Section 08. Force yourself to name the store *and* the consistency model for each kind of data.
2. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your database choices under pressure:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design a local delivery service (like DoorDash for a single metro)." Then act as the interviewer — let me drive, ask clarifying and probing questions, push back on anything hand-wavy, and keep asking "why?". Probe specifically on: which data store I use for order state vs courier locations and why; how I index to answer "find available couriers within 3 km of a pickup point"; exactly where I need ACID transactions vs where BASE / eventual consistency is acceptable; and my CAP + PACELC stance for each datastore. Do NOT give me the answer or lead me. After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, deep-dives & trade-offs (indexing, geospatial, consistency), and communication — with specific feedback and what a strong candidate would have added.
```

1. **Estimate it cold** in the [🧮 Capacity Estimator](../tools/capacity-estimator.html) — reproduce the order-writes vs location-firehose split. Did the asymmetry that drives the two-store design fall out of your numbers?
2. **Explain it back.** Teach ACID vs BASE and CAP vs PACELC to a rubber duck (or me) without notes. If you can't say why ACID's "C" differs from CAP's "C," that's a gap you just found.
3. **Flashcards** (make these 5, review at week's end):
 
*When do you choose RDBMS over NoSQL — and vice versa?*
*ACID and BASE each in one sentence — and what does each optimize for?*
*What does CAP force you to choose, and only when? What does PACELC add?*
*Why is a B+ tree the default index but a hash index only good for equality?*
*Given `INDEX(merchant_id, status, created_at)`, which queries does it serve and which does it not (leftmost-prefix)?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the SQL-vs-NoSQL and CAP/ACID ones *before* your reps; save the indexing deep-dives for when you want depth on the B+ tree.

- **[Database Design Tips — Choosing the Best Database in a System Design Interview](https://www.youtube.com/watch?v=cODCpXtPHbQ)** — codeKarle · ~20 min · SQL vs NoSQL — Interview-framed decision tree for picking a database from requirements. Watch first.
- **[SQL vs NoSQL — Tradeoffs](https://www.youtube.com/watch?v=QzLhb1WBFjQ)** — Gaurav Sen · ~8 min · SQL vs NoSQL — The consistency / scalability / transactions lens for choosing between them.
- **[ACID Properties in Databases With Examples](https://www.youtube.com/watch?v=GAe5oB742dw)** — ByteByteGo · ~7 min · ACID — Atomicity, Consistency, Isolation, Durability made concrete with examples.
- **[CAP Theorem Simplified](https://www.youtube.com/watch?v=BHqjEjzAicA)** — ByteByteGo · ~5 min · CAP — The partition-time C-vs-A choice, cleanly explained without the usual myths.
- **[what is a database index?](https://www.youtube.com/watch?v=Jemuod4wKWo)** — Hussein Nasser · ~14 min · indexing — Builds the "indexes eliminate rows" intuition from first principles.
- **[Why do databases store data in B+ trees?](https://www.youtube.com/watch?v=09E-tVAUqQw)** — Arpit Bhayani · ~17 min · B-tree depth — Exactly why B+ trees win — fan-out, sorted linked leaves, and range scans.

**Read (optional depth):** DDIA Chapter 2 (data models & query languages — relational vs document) and Chapter 3 (storage & retrieval — B-trees vs LSM-trees) are the definitive treatment of everything above. And the database section of the [System Design Primer](https://github.com/donnemartin/system-design-primer) (free) for a fast interview-oriented recap of RDBMS, NoSQL, and indexing.

---
*Source: `modules/03-database-fundamentals.html` — System Design Mastery. Interactive version has the live simulators.*
