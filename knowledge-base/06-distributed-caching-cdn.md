# Distributed Caching & CDN

*Phase 2 · Data at Scale·Module 6·Weeks 2-3 · ~13 hrs*

A read that would slam a database can instead be served from memory in a microsecond or from a server one city away — this module is how you place, invalidate, and scale those copies so a feed loads instantly for two billion people.

## 01 Where caching lives

A cache is a **copy of data kept somewhere faster or closer** than its source. That's the whole idea — and it recurs at every layer of a request, from the user's browser down to the database's own memory.

Before you reach for Redis, know the map. A single page load can be satisfied by any of these tiers, each faster and closer than the one behind it:

```
browser cache   on the device — 0 ms, but only that one user
   │
CDN / edge      a PoP near the user — ~10-30 ms, static + cacheable dynamic
   │
app-local cache in-process (L1) — ~100 ns, but per-instance, small
   │
distributed cache Redis / Memcached (L2) — ~0.5 ms network hop, shared
   │
database         buffer pool caches hot pages — then disk at ~10 ms
```

The default read pattern you'll name in almost every interview is **cache-aside** (lazy loading): the app checks the cache; on a hit it returns; on a miss it reads the database, writes the value back into the cache, and returns. Writes get their own policy — **write-through** (write cache and DB together, always fresh, slower writes), **write-back** (write cache now, flush to DB async — fast but can lose data), or **write-around** (write only the DB, let the cache fill lazily). Each is a latency-vs-freshness-vs-durability trade.

> **Key idea:** Phil Karlton's line is the whole module: *"There are only two hard things in computer science: cache invalidation and naming things."* Adding a cache is trivial; keeping it **correct** as the source changes — and knowing what stale data your users can tolerate — is the actual work.

Two failure modes to keep in your pocket from the start. A **hot key** is a single popular entry (a celebrity's profile) whose one cache shard melts under load. A **cache stampede** is what happens when a popular key expires and thousands of concurrent misses all hammer the database at once. We'll defuse both by the end.

## 02 Redis Cluster deep-dive

Redis is an in-memory data-structure store. Unlike a plain key-value cache, its values are **rich data types**, which lets you push logic into the cache instead of round-tripping to the app. Knowing which structure fits a problem is a senior signal:

| Structure | What it is | Classic use |
| --- | --- | --- |
| String | Bytes up to 512 MB; counters via `INCR` | Cached JSON, rate-limit counters, sessions |
| Hash | Field→value map under one key | An object (user profile) without re-serializing |
| List | Ordered, push/pop both ends | Simple queues, recent-items timelines |
| Set | Unordered unique members | Tags, unique visitors, membership tests |
| Sorted set (ZSET) | Members ordered by a score | Leaderboards, **a ranked news feed**, priority queues |
| Bitmap / HyperLogLog | Bit ops / probabilistic cardinality | Daily-active flags; unique counts in ~12 KB |
| Stream | Append-only log with consumer groups | Event pipelines, fan-out messaging |

### How a single Redis stays fast

Redis executes commands on a **single thread**. That sounds like a bottleneck but is a feature: no locks, no context switches, and every command is effectively atomic. The work is in RAM and the limiter is the network, not the CPU — one node comfortably does 100k+ ops/sec. (Redis 6+ added threaded *I/O* for reading sockets, but command execution stays single-threaded.) The corollary: **never run an `O(n)` command on a huge key** (`KEYS *`, a giant `SMEMBERS`) — it blocks every other client for the duration.

### Scaling out: hash slots

One node's RAM and throughput eventually cap out, so **Redis Cluster** shards the keyspace across many masters. It does *not* use classic consistent hashing — it uses a fixed ring of **16,384 hash slots**. Each key is mapped by `CRC16(key) mod 16384`, and every master owns a contiguous range of slots. Add a node and you migrate some slots to it; no full reshuffle.

```
CRC16("user:42:feed") mod 16384  =  slot 9203
                                         │
   ┌─────────────┬──────────────┬───────┴──────┐
 Master A        Master B        Master C
 slots 0-5460    5461-10922      10923-16383
   │  replica      │  replica       │  replica
   └─ A'           └─ B'            └─ C'      async replication → failover

Client asks wrong node → gets  -MOVED 9203 10.0.0.2:6379  and retries
```

Clients are **cluster-aware**: they cache the slot→node map and talk to the right master directly (no proxy). If a slot is mid-migration you get a `-ASK` redirect; if it has permanently moved, a `-MOVED`. To run a multi-key command (e.g. `MGET`) the keys must live in the same slot — force that with a **hash tag**: braces make Redis hash only the tagged part, so `{user:42}:feed` and `{user:42}:profile` co-locate.

### Consistency: what Redis Cluster does NOT promise

Replication from master to replica is **asynchronous**, so Redis Cluster is *not* strongly consistent. A master can acknowledge a write to the client and then crash *before* the replica receives it — that acknowledged write is lost on failover. This is a deliberate AP-leaning choice (recall CAP from Module 1): favor availability and latency, accept a small write-loss window. If a client is partitioned onto a minority side, after `node-timeout` the master stops accepting writes to avoid a split-brain. You can ask for stronger guarantees with `WAIT n ms` (block until `n` replicas ack), and back the data with **persistence** — RDB point-in-time snapshots and/or AOF (append-only file, replay the write log on restart) — but a cache treated as the source of truth is a design smell. Cache first, database of record second.

## 03 Memcached vs Redis

Both are in-memory key-value stores with sub-millisecond latency, and interviewers love asking you to choose. The honest answer in 2026 is "Redis, almost always" — but you earn the point by knowing *where Memcached still wins* and saying so.

| Dimension | Memcached | Redis |
| --- | --- | --- |
| Data model | Opaque strings only (≤1 MB) | Strings, hashes, lists, sets, ZSETs, streams… |
| Threading | Multi-threaded — scales up on many cores | Single-threaded commands (+ threaded I/O in 6+) |
| Persistence | None — purely volatile | Optional RDB snapshots + AOF log |
| Replication / HA | None built in (client-side sharding) | Replicas, Sentinel, Cluster with failover |
| Eviction | LRU per slab | 8 policies (LRU, LFU, TTL, random, noeviction) |
| Extras | Dead simple, tiny footprint | Pub/sub, Lua scripts, transactions, geo, TTLs |

**Pick Memcached** when the job is a pure, huge, simple look-aside cache of opaque blobs and you want to saturate a many-core box with the least operational surface — its multi-threading can edge out Redis on raw string GET/SET throughput. **Pick Redis** for everything with structure: leaderboards, feeds, rate limiters, sessions you can't afford to drop cold on restart, or anything needing replication and failover. Because Redis is a superset of Memcached's use case, most teams standardize on it to avoid running two systems.

> **Interview tip:** Don't just say "Redis is better." Say *"Memcached if I need a simple multi-threaded blob cache and nothing else; Redis the moment I want data structures, persistence, or built-in HA — which is usually."* Naming the boundary is what scores.

## 04 CDN cache-control headers

A CDN doesn't guess how long to hold a copy — **your HTTP response headers tell it**. Getting these right is the difference between a CDN that offloads 95% of traffic and one that stampedes your origin. Three headers carry the weight: `Cache-Control`, `ETag`, and `Vary`.

```
# A versioned, fingerprinted static asset — cache hard, forever
Cache-Control: public, max-age=31536000, immutable
ETag: "9f2b-c1a4"

# A personalized API response — never store shared, always revalidate
Cache-Control: private, no-cache
Vary: Accept-Encoding, Accept-Language

# A news feed page — serve fast, refresh in the background
Cache-Control: public, s-maxage=30, stale-while-revalidate=120
```

**`Cache-Control`** is the policy. Key directives: `max-age` (freshness seconds for any cache), `s-maxage` (overrides it for *shared* caches like the CDN only), `public` vs `private` (may a shared cache store it? — mark anything user-specific `private`), `no-cache` (store, but revalidate before each use), `no-store` (never keep it — for secrets), `immutable` (this bytes-for-this-URL will never change, skip revalidation), and `stale-while-revalidate` (serve the stale copy instantly, refresh async — a stampede killer).

**`ETag`** is a content fingerprint for cheap revalidation. When a cached copy goes stale, the client/CDN sends `If-None-Match: "9f2b-c1a4"`; if the content is unchanged the origin replies `304 Not Modified` with an empty body — you pay one tiny round-trip instead of re-sending the whole payload. (`Last-Modified` + `If-Modified-Since` does the same with timestamps, at one-second granularity.)

**`Vary`** defines the *cache key's extra dimensions*. `Vary: Accept-Encoding` stores gzip and brotli versions separately — correct and cheap. But `Vary: Cookie` or `Vary: User-Agent` explodes the key space into near-uniqueness and destroys your hit rate; those are classic footguns. The rule: cache *shared* content aggressively with `ETag`s, and mark truly personalized content `private` rather than trying to `Vary` your way out.

## 05 Edge caching & latency

A CDN is a fleet of **Points of Presence (PoPs)** — edge servers in hundreds of cities. The physics is the point: a cross-continent round-trip is ~150 ms (Module 1's latency table), but an edge server one metro away answers in ~10-30 ms. Cache the response at the edge and you've deleted the long-haul trip *and* the origin's work in one move.

How a user reaches the nearest edge is usually **Anycast**: the same IP is advertised from every PoP, and internet routing delivers the packet to the closest one automatically. From there the edge does a normal cache-aside against your origin, governed by the headers above.

| Concept | What it means | Why you care |
| --- | --- | --- |
| Pull CDN | Edge fetches from origin on first miss, then caches | Default; origin stays lean, first user pays the miss |
| Push CDN | You upload assets to the CDN ahead of time | Large/predictable files (video, releases) |
| Origin shield | One mid-tier cache all PoPs pull through | Collapses N PoP misses into 1 origin hit |
| TTL | How long the edge holds a copy (from `max-age`) | Trades freshness against origin offload |
| Purge / invalidation | Actively evict a URL before its TTL | Ship a fix without waiting out the TTL |
| Edge compute | Run small logic at the PoP (auth, A/B, rewrite) | Personalize without a trip to origin |

The metric that rules everything here is **cache hit ratio** — the fraction of requests the edge answers without touching origin. Push it toward 95%+ and your origin fleet shrinks, your p99 drops, and a traffic spike lands on the CDN instead of your database. Static assets (images, JS, CSS, video segments) are the natural win; the frontier is caching *dynamic* content for short TTLs with `stale-while-revalidate` so even a personalized-looking page is mostly edge-served.

## 06 Multi-tier caching (L1/L2/L3)

Serious systems don't pick one cache — they **stack** them, each trading capacity for speed like CPU cache levels. A request falls through the tiers and stops at the first hit:

1. **L1 — in-process (local)** *(~100 ns)* — A cache *inside* the app process (Caffeine, Guava, an LRU map). No network at all, so it's the fastest possible hit — but it's per-instance, small, and every replica holds its own copy, so invalidation across instances is the hard part.
2. **L2 — distributed (remote)** *(~0.5 ms)* — A shared Redis/Memcached cluster all app servers hit over the network. One coherent copy, big capacity, survives an app restart. This is the workhorse tier and where "the cache" usually means.
3. **L3 — CDN / edge (or DB buffer pool)** *(~10-30 ms)* — For content servable to many users, the CDN edge is the outermost tier — closest to the user, furthest from origin. (For internal data paths, the database's own page cache plays the L3 role before disk.)

The pattern of L1 in front of a shared L2 is a **near cache**: keep the few hottest keys local to kill the network hop, fall back to Redis for the long tail. The cost is **coherence** — when data changes, an L1 copy on some server can go stale. You manage it with short L1 TTLs, small L1 sizes (hot set only), and pub/sub invalidation messages that tell every instance to drop a key. The golden rule: *add a tier only when the tier behind it is measurably the bottleneck*, and never let a lower tier serve data staler than the product can tolerate.

> **Play with it → your tool:** Open the [🗃️ Cache Playground](../tools/cache-playground.html) and dial the working-set size, TTL, and request skew. Watch the **hit ratio** climb as the hot set fits in cache, see a stampede form when a hot key expires, and feel how L1+L2 tiers change the numbers. Change one knob at a time and build the intuition for why 95% hit rate is a design goal, not luck.

## 07 Cache warming & cold starts

A cache is only fast once it's **warm**. The dangerous moments are the cold ones: right after a deploy, a failover to an empty replica, or a scheduled flush. With the cache empty, every request is a miss, all of them fall through to the database *simultaneously*, and the origin — sized for a 5% miss rate — buckles under 100%. That's a **cache stampede** (a.k.a. thundering herd), and it's how "just restart Redis" takes down the database behind it.

**Warming** pre-fills the hot set before real traffic arrives:

- **Preload on startup** — replay the top-N keys (from analytics or yesterday's access log) into the cache before the instance takes traffic.
- **Shadow / canary traffic** — send a trickle of real requests to a fresh node to warm it, then ramp up.
- **Scheduled refresh** — a background job re-computes expensive, popular entries just before they expire, so users never hit a miss.
- **Write-through** — populate the cache on the write path so data is warm the instant it's created.

And when a miss *does* happen on a hot key, stop the herd rather than let it trample the DB:

- **Request coalescing (single-flight)** — let exactly one request recompute a missing key; everyone else waits for and shares that result.
- **Stale-while-revalidate** — serve the slightly-stale copy instantly and refresh in the background (the same header trick from §4, applied at the app tier).
- **Jittered TTLs + early recompute** — spread expirations with random jitter so a million keys don't die at the same second; probabilistically refresh popular keys a little *before* their TTL (the XFetch idea).

> **Interview tip:** When you add a cache in a design, proactively say *"and on a cold start I'd warm the top keys and coalesce misses so I don't stampede the database."* Anticipating the failure mode of your own solution is exactly the senior instinct interviewers probe for.

## 08 Worked example: Facebook News Feed

Now we run all five framework steps on the canonical caching-heavy problem — *"Design the Facebook News Feed."* Watch how every concept above shows up: Redis sorted sets, a Memcached-vs-Redis choice, CDN headers for media, edge caching, tiering, and warming.

### ① Scope

- **Functional:** a user publishes a post; a user opens their feed and sees a *ranked* list of recent posts from the people/pages they follow, with media, like and comment counts, paged by infinite scroll.
- **Non-functional:** brutally read-heavy, feed must load fast (p99 < ~200 ms), very high availability, **eventual consistency is fine** (a post or like lagging a second or two is acceptable), and it must scale to billions of users.
- **Out of scope (say it):** the ML ranking model itself, ads insertion, messaging. We design the *delivery* system and treat ranking as a scoring function.

### ② Estimate

```
~2B DAU, each opens the feed ~10×/day
  feed reads = 2B × 10 = 20B/day  ÷ 100k  ≈ 200k reads/s avg
                                   × ~3 peak ≈ 600k reads/s   → must be cache-served
posts: ~2B × 0.2/day = 400M writes/day ÷ 100k ≈ 4-5k writes/s 100:1+ read-heavy
avg followees ≈ 200  → naive fan-out = 400M × 200 = 80B feed inserts/day
media: images/video dominate bytes → belongs on a CDN, not the feed store
```

Verdict: reads must never touch the primary DB → **precompute feeds into a cache**. Writes are modest but *fan-out amplifies them 200×* — that amplification is the real design problem. Media bytes go to blob storage + CDN, not into the feed path.

### ③ Interface

```
GET  /v1/feed?cursor=<opaque>&limit=20   → ranked page + next cursor
POST /v1/posts  { "authorId", "text", "mediaIds": [...] }  → 201
```

Cursor-based paging (not offset) so infinite scroll stays stable as new posts arrive.

### ④ High-level design — fan-out

The core choice is **when** to assemble a feed:

| Model | How | Trade-off |
| --- | --- | --- |
| Fan-out on write (push) | On each post, insert its id into every follower's precomputed feed | Reads are instant (just read your list); writes explode for popular authors |
| Fan-out on read (pull) | Build the feed at read time by merging followees' recent posts | Writes are cheap; reads are heavy and slow — bad for 600k reads/s |

Since we're 100:1 read-heavy, we lean **push**: when a post is created, a fan-out service reads the author's followers and pushes the post id into each follower's feed. Each user's feed is a **Redis sorted set** — `ZADD feed:{userId} <score> <postId>`, score = rank/timestamp — so a read is a single `ZREVRANGE` of the top ~20 ids, then a batched `MGET` to hydrate post bodies from a post cache.

```
WRITE:  POST → append to posts DB (source of truth)
             → enqueue fan-out job (Kafka)
             → worker: for each follower  ZADD feed:{follower} score postId

READ:   GET feed → ZREVRANGE feed:{me} 0 19        (top 20 post ids, L2 Redis)
                 → MGET post:{id...}               (hydrate bodies)
                 → media URLs point at the CDN     (images/video never hit us)
```

### ⑤ Deep-dive & scale

- **The celebrity problem (hot fan-out).** Pushing a post from an account with 50M followers is 50M writes — a stampede in itself. Go **hybrid**: push for normal accounts, but for celebrities *don't* fan out; instead pull their recent posts at read time and merge them into the pushed feed. Now write cost is bounded and reads stay cheap.
- **Shard the feed cache.** Feeds live in **Redis Cluster**, sharded by `userId` via the 16,384 hash slots (§2). A user's whole feed is one slot, so reads are single-node. Each master has a replica for failover; a lost, unacked feed insert is harmless — it re-derives from the posts DB.
- **Tier it (§6).** L1 in-process cache holds each app server's currently-scrolling users; L2 Redis Cluster holds all feeds; the **CDN (L3)** serves every image and video segment with `Cache-Control: public, max-age=31536000, immutable` on fingerprinted media URLs (§4) — that alone offloads the vast majority of bytes.
- **Redis vs Memcached here (§3).** The feed *needs* sorted sets and TTLs → **Redis**. The stateless post-body cache is a pure blob look-aside → Memcached would do, but teams keep one Redis to avoid running two systems.
- **Warming & stampedes (§7).** After a deploy or failover, warm the feeds of currently-active users first and coalesce misses so an empty cache doesn't fall through 600k reads/s onto the posts DB. Jitter feed-entry TTLs so they don't all expire together.
- **Consistency.** Everything is eventually consistent by design: your new post appears in followers' feeds as the fan-out drains (usually sub-second); a like count is served from a counter that lags slightly. That's the AP trade we accepted in Step 1 — and it's why this scales.

## 09 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard the News Feed yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end with the 5-step framework, out loud, timed to ~35 minutes — *before* re-reading Section 08 or watching the videos. Force yourself to draw the fan-out and name the sorted set.
2. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your caching decisions against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design the Facebook News Feed." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on the caching layer specifically: make me justify fan-out on write vs read, how I shard the feed cache, what happens to a celebrity with 50M followers, which cache (Redis vs Memcached) and why, how I keep media off the hot path with CDN headers, and what happens on a cold cache after a deploy. Do NOT give me the answer or lead me — keep asking "why?" and "what breaks first?". After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, caching & CDN deep-dives, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Break a cache in the tool.** In the [🗃️ Cache Playground](../tools/cache-playground.html), shrink the cache below the working set and watch the hit ratio collapse; then expire a hot key and watch the stampede. Reproduce the fix (coalescing / stale-while-revalidate) and see the origin load flatten.
2. **Explain it back.** Teach fan-out on write vs read, and why Redis Cluster is AP-not-CP, to a rubber duck (or me) without notes. Gaps you can't explain are gaps you don't have yet.
3. **Flashcards** (make these 5, review at week's end): *What maps a key to a shard in Redis Cluster? · When is Memcached the right call over Redis? · What does `stale-while-revalidate` buy you? · ETag vs Vary — what does each control? · How do you stop a cache stampede on a cold start?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the CDN and caching-systems ones *before* your reps; save the Redis internals deep-dives for when you want to defend the consistency answer.

- **[What Is A CDN? How Does It Work?](https://www.youtube.com/watch?v=RI9np1LWzqw)** — ByteByteGo · ~5 min · how CDN works — Crisp animated primer on PoPs, edge servers, and pull-through caching. Start here.
- **[What is a CDN (Content Delivery Network)?](https://www.youtube.com/watch?v=b4_6thkYZXs)** — Gaurav Sen · ~9 min · edge caching — Whiteboard walk of push vs pull CDNs and where edge caching actually pays off.
- **[Cache Systems Every Developer Should Know](https://www.youtube.com/watch?v=dGAgxozNWFE)** — ByteByteGo · ~8 min · caching tiers — Tours the whole stack — browser, CDN, app, and distributed cache — the map for §6.
- **[Caching in System Design Interviews w/ Meta Staff Engineer](https://www.youtube.com/watch?v=1NngTUYPdpI)** — Hello Interview · ~35 min · Redis vs Memcached — When to reach for Redis vs Memcached and how to actually talk caching in a real interview.
- **[Why and How Is Single-Threaded Redis Fast? | Redis Internals](https://www.youtube.com/watch?v=h30k7YixrMo)** — Arpit Bhayani · ~15 min · Redis internals — The mental model behind one thread saturating the network — groundwork for Redis Cluster.
- **[Can Redis be used as a Primary database?](https://www.youtube.com/watch?v=VLTPqImLapM)** — Hussein Nasser · ~20 min · persistence & consistency — Pushes on Redis durability, persistence, and the consistency limits from §2.

**Read (optional depth):** DDIA Chapter 6 (Partitioning) — the general theory behind Redis Cluster's hash slots and how sharded systems rebalance. And the [System Design Primer — Cache section](https://github.com/donnemartin/system-design-primer#cache) for a crisp tour of cache-aside, write-through/back, and CDN caching (free).

---
*Source: `modules/06-distributed-caching-cdn.html` — System Design Mastery. Interactive version has the live simulators.*
