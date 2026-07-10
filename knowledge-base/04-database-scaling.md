# Database Scaling

*Phase 2 · Data at Scale·Module 4·Weeks 2-3 · ~13 hrs*

One database is the quiet default of every system — until reads flood it, writes back up, or the disk fills. This module is the toolkit for what happens next: **partition, replicate, route, and pool** your way from one box to a fleet, naming the trade-off at every step.

## 01 When one database isn't enough

A single primary database scales *much* further than beginners fear — a well-indexed Postgres box on decent hardware serves thousands of queries a second. The instinct to shard on day one is almost always wrong. But three distinct walls eventually stop a single node, and the whole craft of database scaling is **naming which wall you've hit** so you reach for the right tool.

The tempting first move is **vertical scaling** — a bigger box: more CPU, more RAM, faster NVMe. It's the cheapest fix because your code doesn't change. But it has a hard ceiling (the biggest instance money can rent), the price curve turns brutal near the top, and one box is still a **single point of failure**. Past that ceiling you must scale *horizontally* — spread the work across many machines — and that's where the three walls diverge:

| The wall you hit | Symptom | The right tool |
| --- | --- | --- |
| Read throughput | SELECTs pile up; CPU pinned on read queries; p99 latency climbs | Read replicas + a cache |
| Write throughput / storage | One primary can't absorb the write rate; the dataset outgrows one disk | Sharding (horizontal partitioning) |
| Availability | The node dies and everything stops; maintenance means downtime | Replication + automated failover |

These do not substitute for one another, and mixing them up is the most common scaling mistake. Read replicas multiply read capacity but do *nothing* for write throughput — every write still lands on the one primary. Sharding splits writes and storage but, on its own, buys you no extra copies for failover. Get the diagnosis right and the prescription is obvious.

> **Key idea:** Match the technique to the **bottleneck**. "Add replicas" is the answer to *reads*; "shard" is the answer to *writes and storage*; "replicate + fail over" is the answer to *availability*. Diagnose before you prescribe.

## 02 Sharding & horizontal partitioning

**Partitioning** means splitting one logical dataset into pieces. There are two axes. **Vertical partitioning** splits by *columns* — move a rarely-read `blob` column or a whole table to its own store so the hot table stays lean. **Horizontal partitioning** splits by *rows* — put rows 1–1M here, 1M–2M there. When those row-groups live on *separate database servers*, we call it **sharding**. (Splitting rows within one server — e.g. Postgres declarative partitions — is horizontal partitioning but not sharding; the "separate servers" part is what unlocks new capacity.)

### The shard key is everything

A shard lives or dies by its **shard key** (a.k.a. partition key) — the column you route on. Choose it well and load spreads evenly and your common queries stay on one shard. Choose it badly and you get hotspots, scatter-gather reads, and a painful migration to fix it. There are three classic routing strategies:

| Strategy | How it routes | Upside | Downside |
| --- | --- | --- | --- |
| Range-based | Key ranges → shards (id 0–1M → A, 1M–2M → B) | Range scans stay on one shard; simple | Skew & hotspots — e.g. time-ordered keys make the newest shard hot |
| Hash-based | `hash(key) mod N` → shard | Even, uniform distribution by default | Range queries fan out; changing `N` reshuffles almost everything |
| Directory / lookup | A lookup service maps key → shard explicitly | Flexible; rebalance by editing the map | Lookup table is an extra hop and a potential SPOF |

Routing itself is simple — resolve the key to a shard, then talk to that shard:

```
# hash-based routing, N = 4 shards
shard = hash(user_id) % 4
db    = shards[shard]          # → db2
db.query("SELECT * FROM orders WHERE user_id = ?", user_id)

# the pain: a query WITHOUT the shard key must hit every shard
"SELECT * FROM orders WHERE status = 'refunded'"
   ──▶ scatter to A,B,C,D ──▶ gather & merge   # slow, fan-out
```

Sharding is powerful but it is *not free*. It introduces genuinely hard problems: **cross-shard queries** (any query missing the shard key becomes a scatter-gather; joins across shards are miserable), **hotspots** (a "celebrity" key whose shard gets all the traffic), **rebalancing** (adding a shard means moving data live), and **distributed transactions** (an atomic write spanning shards needs two-phase commit or a saga). Each is a whole topic; the takeaway is that they all follow from one decision — the shard key.

> **Interview tip:** Shard *as late as you can defend*. In a design round, exhaust the cheaper moves first — a bigger box, read replicas, a cache — and only shard when your estimate shows write throughput or storage genuinely exceeds one node. Then lead with the shard key and its trade-offs; that's the senior signal.

## 03 Consistent hashing for shard routing

Plain `hash(key) mod N` has a fatal flaw the moment you grow: change `N` from 4 to 5 and the modulus shifts for *almost every key*. Nearly all your data has to move at once, and if this hash sits in front of a cache, every key misses simultaneously — a cache stampede that can topple the database behind it. Adding capacity should not require reshuffling the world.

**Consistent hashing** fixes this. Map the hash output onto a ring (the space `0 … 2³²−1` wrapped into a circle). Place each *node* on the ring by hashing its id, and place each *key* on the ring by hashing the key. A key belongs to the **first node clockwise** from its position. Now add or remove a node and only the keys in *one arc* — roughly `1/N` of them — need to move. The rest never notice.

```
            hash ring (0 … 2^32-1, wraps around)

                 ● NodeA
             k7      \
          .           \        k1
        k6             \      /   ● NodeB
         |     add NodeD here  \  /
         |          ↓           k2
        k5     ● NodeD          |
           \      only k4,k5   k3
            \     remap here   /
             ● NodeC ────── k4

   key → walk clockwise → first node owns it
   add/remove a node → only its arc (~1/N keys) moves
```

One refinement makes it production-grade: **virtual nodes**. Instead of placing each physical server once, place it at many points on the ring (say 100–200 "vnodes" per server). This smooths out distribution (no server gets an unlucky giant arc), lets you weight bigger machines with more vnodes, and — critically — when a node dies, its load is spread across *all* the remaining nodes rather than dumped on a single neighbor. This is exactly how **Dynamo, Cassandra, ScyllaDB, and Riak** place data, how memcached client libraries pick a server, and how many load balancers and CDNs route requests.

> **Play with it → your tool:** Open the [💍 Consistent Hashing Playground](../tools/consistent-hashing.html), drop keys onto the ring, then **add and remove nodes** and watch how few keys actually move — compare it to naïve mod-`N` where nearly everything jumps. Toggle virtual nodes on and off to *see* distribution even out. This is the single best way to make the ring stick.

## 04 Read/write separation: primary–replica

Sharding attacks writes and storage; the other great lever is **replication** — keeping full copies of the data on multiple nodes. The workhorse pattern is **primary–replica** (older names: leader–follower, master–slave). One node, the **primary**, accepts *all writes*. It streams every change to one or more **replicas**, which apply those changes in order and serve *reads*. Your application routes writes to the primary and reads to replicas.

### How the changes travel

The primary ships its changes as a log. Three flavors: **statement-based** (replay the SQL — fragile with `NOW()` or random values), **write-ahead-log / physical** (ship the exact byte-level changes — what Postgres streaming replication does), and **logical / row-based** (ship the resulting row changes — flexible, cross-version). Followers apply the stream in the same order the primary committed it, so they converge on the same state.

### Synchronous vs asynchronous — the durability dial

The single most important replication choice is *when the primary tells the client "done."*

| Mode | Primary acks after… | Trade-off |
| --- | --- | --- |
| Asynchronous | …writing locally (doesn't wait for replicas) | Fast, always available for writes — but a crash can lose the last few writes not yet shipped |
| Synchronous | …a replica confirms it has the write | No data loss on failover — but slower, and a stalled replica blocks writes |
| Semi-synchronous | …*at least one* replica confirms | The common middle ground: bounded loss, tolerable latency |

When the primary dies, **failover** promotes a replica to primary. This is where the mode bites: with async replication the promoted replica may be missing the primary's last writes (they're gone). Failover also risks **split-brain** — two nodes both believing they're primary — which is why real systems use a consensus layer or an external orchestrator to elect exactly one, and pick the *most caught-up* replica to promote.

## 05 Read replicas for read-heavy loads

Most consumer systems are wildly **read-heavy** — think 100 reads per write. That asymmetry is a gift: point reads at replicas and you multiply read capacity almost linearly. Add *N* read replicas and you get roughly *N*× the read throughput, for the price of running more copies. It is the cheapest large win in database scaling, which is why it's usually the *first* move once a cache isn't enough.

But asynchronous replicas lag. The primary commits, and a heartbeat or a few seconds later the replica catches up. That window — **replication lag** — creates two classic anomalies you must design around:

- **Read-your-own-writes:** a user posts a comment (write → primary), immediately refreshes (read → a lagging replica), and their own comment is missing. Infuriating. Fixes: route *that user's* reads to the primary for a short window after they write; use sticky/"read-from-leader" sessions; or serve their own recent writes from a cache.
- **Monotonic reads:** a user reads a fresh replica, then a stale one, and sees data *move backwards in time*. Fix: pin a user to the same replica (e.g. hash their id to a replica) so they never travel back.

The good news: for most content — feeds, product pages, search results, analytics — a second of staleness is completely fine, so replicas are a natural fit. Reserve strong, read-from-primary reads for the handful of flows (a user's own just-written data, a balance check) that actually need it.

> **Say this in the interview:** **Read replicas scale reads, not writes.** Every write still funnels to the single primary, so if *write* throughput or storage is your wall, replicas won't save you — that's the moment you shard. Naming this boundary out loud is a strong senior signal.

## 06 Multi-leader & conflict resolution

Single-leader replication has one inconvenient limit: *all* writes go to one node, which may be an ocean away from half your users, and if it's unreachable, writes stop. **Multi-leader** (multi-master) replication puts a writable leader in *each* region (or datacenter). Users write to their nearest leader for low latency, each leader replicates to the others, and writes survive a region outage. It's the standard shape for global, write-latency-sensitive, or offline-capable apps.

The price is steep and specific: two leaders can accept **conflicting writes to the same record at the same time** — record X set to "red" in the US and "blue" in the EU before they've synced. Single-leader replication makes conflicts *impossible by construction*; multi-leader trades that away for availability and locality, so now you must resolve conflicts. The main tools:

- **Last-write-wins (LWW):** attach a timestamp, keep the newest. Dead simple, but it silently *discards* the loser's write and depends on clocks you can't fully trust.
- **Version vectors / vector clocks:** track causality so you can *detect* that two writes were concurrent (rather than one following the other) and hand both to the app or user to merge.
- **CRDTs** (conflict-free replicated data types): data structures — counters, sets, collaborative-text — engineered to *merge deterministically* with no coordination. The backbone of collaborative editors and shopping carts.
- **Avoid the conflict:** route every write for a given record to the *same* home leader (partition by user's home region). No concurrent writes, no conflict.

A close cousin is **leaderless** replication (Dynamo, Cassandra): clients write to several nodes and read from several, using **quorums** (`R + W > N`) to guarantee overlap, with *read repair* and *hinted handoff* to heal divergence. Here's the landscape:

| Topology | Who takes writes | Conflicts? | Fits |
| --- | --- | --- | --- |
| Single-leader | One primary | None by design | Most apps; strong-ish consistency |
| Multi-leader | One leader per region | Yes — must resolve | Multi-region, offline, low write latency |
| Leaderless | Any node (quorum) | Yes — read repair / quorums | High availability, tunable consistency |

## 07 Connection pooling

Here's a bottleneck that has nothing to do with data volume and everything to do with *connections*. Opening a database connection is expensive: a TCP handshake, a TLS handshake, authentication, and — on Postgres especially — the server **forks a whole backend process** per connection, each eating memory. A few hundred connections can exhaust a database that would happily serve the same queries over a dozen. Open a fresh connection per web request and you pay that cost on the hot path *and* risk toppling the DB under a traffic spike.

A **connection pool** solves it: keep a small set of already-established connections open and *reuse* them. A request borrows a connection, runs its query, and returns it to the pool. Two places to pool:

- **In-process pools** — a library inside your app (HikariCP for the JVM, or your ORM's built-in pool). Great, but each app instance keeps its own pool, so 50 instances × 20 connections = 1,000 connections hitting the DB.
- **External poolers** — a dedicated proxy in front of the database (**PgBouncer**, ProxySQL, RDS Proxy) that multiplexes thousands of client connections onto a small pool of real backend connections. Transaction-mode pooling (hand back the connection after each transaction) gives the highest reuse.

Sizing is counter-intuitive: **more connections is not more throughput**. Past a small multiple of the database's CPU cores, extra connections just contend and add latency — a pool of ~20–50 often beats a pool of 500. And the pattern is essential for **serverless** functions, where thousands of short-lived instances would otherwise open a "connection storm" — an external pooler is mandatory there.

> **Where it compounds:** Once you've sharded and added replicas, pooling multiplies: you hold a pool *per shard, per role* (primary vs replica). Pooling and routing are the same conversation — a request resolves its shard key, picks primary-or-replica, then borrows from that specific pool.

## 08 Worked example: News Aggregator

Let's run every technique in this module end-to-end on one prompt — *"Design a news aggregator"* (think Google News / Apple News): it ingests articles from thousands of sources and serves each user a ranked feed. Follow the same 5-step framework from Module 1.

1. **Scope** *(~5 min)* — **Functional:** ingest articles from many sources; serve a ranked home feed per user; open a full article; follow topics/sources; like/save. **NFR:** extremely read-heavy (feed reads ≫ writes), high availability, low-latency feed (<200 ms), fresh-ish (new articles within seconds — eventual is fine), huge and growing storage, durable. **Out of scope:** the ranking ML itself, auth.
2. **Estimate** *(~5 min)* — Numbers that change decisions: reads dominate, the corpus grows without bound, interactions are a moderate write stream. (Worked below.)
3. **Interface** *(~5 min)* — A cursor-paginated feed read, an article read, and a couple of write endpoints.
4. **Happy path** *(~10 min)* — Ingestion workers → article store; feed service → cache → article store; simple pull-model feed.
5. **Deep-dive & scale** *(~15 min)* — Replicas for the read-heavy feed, shard the growing corpus (routed by consistent hashing), pool every connection, and reason about multi-region.

### ② Estimate

```
50M DAU × 10 feed-opens/day = 500M reads/day
   500M ÷ 100k ≈ 5,000 reads/s avg  · peak ×3 ≈ ~15k reads/s   → very read-heavy

ingestion: ~1M new articles/day ÷ 100k ≈ ~12 writes/s          → tiny write rate…
storage:   1M/day × 365 × 5yr = 1.8B articles
           × ~5 KB/article ≈ 9 TB  (× replication ≈ ~27 TB)    → …but storage forces a shard

interactions (likes/saves): 50M DAU × 5/day = 250M/day
           250M ÷ 100k ≈ ~2,500 writes/s · peak ×3 ≈ ~7.5k/s    → real write load
```

**Verdict:** feed reads scream for *replicas + cache*; the ever-growing article corpus forces *sharding*; a few thousand interaction writes/s is a real stream that also wants sharding. Every tool in this module earns its place.

### ③ Interface

```
GET  /v1/feed?cursor=<opaque>&limit=20   # ranked article summaries, paginated
GET  /v1/articles/{articleId}            # full article (hot read)
POST /v1/articles/{articleId}/like       # interaction write
POST /v1/follows   { "target": "topic:tech" | "source:reuters" }
```

### ④ Happy-path design

```
Data model:
  articles( article_id PK, source_id, topic, published_at, title, body_ref )
  follows ( user_id, target )
  interactions( user_id, article_id, type, ts )

Read path:  client → LB → feed svc → cache(feed page) ─hit─▶ return
                                          └─miss─▶ article replicas → rank → warm cache
Write path: crawlers/RSS → ingest workers → articles (primary)
            client like  → LB → interaction svc → interactions (primary)
```

Start with a **pull model**: on a feed request, query recent articles from the user's followed sources/topics, rank, and return. Cheap writes, heavier reads — which we're about to make cheap.

### ⑤ Deep-dive & scale — apply the module

**Reads → primary–replica + cache.** All writes (ingest, likes, follows) hit primaries; all feed and article reads hit *read replicas*. A Redis layer caches hot articles and rendered feed pages, so the ~15k reads/s barely touch the databases. This alone handles the dominant load.

**Storage → shard the articles corpus.** 1.8B rows won't fit one node, so shard. The shard-key choice *is* the deep-dive:

| Shard key | Upside | Downside |
| --- | --- | --- |
| `published_at` (range) | Recent-news queries are a range scan | **Hotspot** — every read wants today, so the newest shard melts |
| `source_id` | A source's articles colocate → per-source feeds are single-shard | Celebrity source (huge outlet) becomes a hot shard |
| `hash(article_id)` | Even distribution; no hotspot | "Recent from these sources" fans out (scatter-gather) |

A defensible pick: `hash(article_id)` for even load, and route it with **consistent hashing** so that as the corpus grows and we add shards, only ~1/N of articles relocate instead of a full reshuffle. To keep feeds fast despite the fan-out, we lean on the cache and on a per-user precomputed feed for heavy followers (a hybrid pull/push — the same trade-off you'd make for a social timeline).

**Interactions → shard + read-your-writes.** Shard `interactions` by `user_id` so a user's likes colocate. Because replicas lag, a user who just liked an article and refreshes might hit a stale replica and not see their like — so serve *their own* recent interactions from the primary (or cache) for a short window.

**Global users → multi-region.** Users are worldwide and want a sub-200 ms feed. The article corpus is read-mostly, so replicate it to every region and read locally — easy. Interactions are writes, so either keep a single write region (simplest) or go **multi-leader** per region; if you do, like-*counts* are the conflict surface, so model them as **CRDT counters** that merge without coordination, or route each user's writes to their home region to sidestep conflicts entirely.

**Everywhere → connection pooling.** The feed service is high-fan-out and highly concurrent; without pooling it would open a storm of connections and exhaust the Postgres backends. Put **PgBouncer** in front of each shard and each replica, size pools to a small multiple of cores, and the fleet stays healthy under peak.

> **See the through-line:** Notice how the estimate *drove* every move: read-heavy → replicas+cache; growing corpus → shard (consistent-hashed); lagging replicas → read-your-writes handling; global writes → multi-leader + CRDT counters; concurrency → pooling. You never guessed — each tool answered a specific number.

## 09 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard News Aggregator yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end with the 5-step framework, out loud, timed to ~35 minutes — *before* re-reading Section 08. Force yourself to name a shard key and defend it.
2. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design under pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design a news aggregator like Google News." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on the data layer specifically: which shard key and why, what breaks when I add a shard, how I handle replication lag and read-your-writes, when replicas stop helping, and how I'd resolve conflicts if I go multi-region. Do NOT give me the answer or lead me. After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, deep-dives & trade-offs, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Break the ring.** In the [💍 Consistent Hashing Playground](../tools/consistent-hashing.html), add and remove nodes and count how many keys move vs. naïve mod-`N`. Toggle virtual nodes and watch distribution flatten.
2. **Explain it back.** Teach a rubber duck (or me) *why replicas scale reads but not writes*, and *what replication lag does to read-your-writes* — without notes. Gaps you can't explain are gaps you don't have yet.
3. **Flashcards** (make these 5, review at week's end): *Range vs hash sharding — one trade-off each? · Why does consistent hashing beat hash-mod-N when you add a shard? · Do replicas scale reads or writes, and why? · What is replication lag and one fix for read-your-writes? · Why put a connection pooler in front of Postgres?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the consistent-hashing and sharding ones *before* your reps; the replication one pairs with Sections 04–05.

- **[What is CONSISTENT HASHING and Where is it used?](https://www.youtube.com/watch?v=zaRkONvyGr8)** — Gaurav Sen · ~10 min · consistent hashing — The clearest first look at the hash ring and why it beats mod-N. Watch this before opening the tool.
- **[Database Sharding Crash Course (with Postgres examples)](https://www.youtube.com/watch?v=d1fXBLqnFvc)** — Hussein Nasser · ~35 min · sharding — Shard keys and horizontal partitioning made concrete — real Postgres shards spun up in Docker.
- **[Database Sharding and Partitioning](https://www.youtube.com/watch?v=wXvljefXyEo)** — Arpit Bhayani · ~20 min · partitioning — First-principles take on partition vs shard and the range / hash / directory strategies. Rigorous and precise.
- **[All Types of Database Replication Discussed](https://www.youtube.com/watch?v=aE2UPg3Ckck)** — Hussein Nasser · ~18 min · replication — Primary–replica, read replicas, and synchronous vs asynchronous — the read/write-split foundation with trade-offs.
- **[Consistent Hashing: Easy Explanation for System Design Interviews](https://www.youtube.com/watch?v=vccwdhfqIrI)** — Hello Interview · ~15 min · interview framing — How to actually present consistent hashing for shard routing under interview time pressure.

**Read (optional depth):** DDIA **Chapter 5 (Replication)** and **Chapter 6 (Partitioning)** are the canonical deep dives for everything above — leaders/followers, replication lag, and partitioning/rebalancing in Martin Kleppmann's own words. For a free skim, the [System Design Primer](https://github.com/donnemartin/system-design-primer) sections on *replication* and *sharding/denormalization*.

---
*Source: `modules/04-database-scaling.html` — System Design Mastery. Interactive version has the live simulators.*
