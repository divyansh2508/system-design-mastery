# Caching Fundamentals

*Phase 2 · Data at Scale·Module 5·Weeks 2–3 · ~13 hrs*

A cache is the single highest-leverage move in system design — it can cut latency and shield your database by 100× — but only if you can defend **which pattern, which eviction policy, and how you keep it honest** when the data underneath it changes.

## 01 Why caching works

A cache is a small, fast store that keeps a copy of data close to where it's used, so you can skip the slow, expensive work of fetching or recomputing it. Everything in this module is a variation on that one bet.

Recall the latency table from Module 1: RAM is ~100 ns, an SSD read ~150 µs, a disk seek ~10 ms, a cross-continent round-trip ~150 ms. A cache exists to **trade cheap memory for avoided slow work**. It pulls exactly two levers: **latency** (serve from RAM instead of disk or network) and **load** (absorb reads so the slow backend never sees them). In a read-heavy system those two levers are most of your scaling story.

### The one number that matters: hit ratio

A cache is only as good as its **hit ratio** — the fraction of reads it serves without touching the backend. Effective read latency is a weighted average of the fast path and the slow path, and because a miss is so much more expensive than a hit, the *top* of the hit-ratio curve is where the money is:

```
effective read latency  ≈  h·T_hit + (1 − h)·T_miss

  T_hit   ≈ 0.5 ms    RAM / same-datacenter Redis
  T_miss  ≈ 30  ms    DB query + deserialize + repopulate cache

  h = 0.90 → 0.90·0.5 + 0.10·30 = 3.45 ms   the 10% of misses dominate the average
  h = 0.99 → 0.99·0.5 + 0.01·30 = 0.80 ms   the last 9 points of hit-rate are worth ~4×
```

The same jump does something even bigger for **load**: at 99% hit ratio the database sees only 1% of reads — a **100× reduction** in query volume. That single fact is why "add a cache" is the standard first move once your estimate says a system is read-heavy.

### Caching needs locality

Hit ratio is only high when access is **skewed** — a small hot set is requested over and over (the classic "80% of traffic hits 20% of the data," or a Zipf distribution where a handful of keys dominate). If every key in a huge keyspace is equally likely, your cache evicts an item just before it's next needed, the hit ratio collapses toward the cache-size-over-keyspace ratio, and you've bought nothing but a coherence problem.

> **Key idea:** A cache is a **bet on locality plus a tolerance for staleness**. If your access pattern isn't skewed, or your data can never be even slightly stale, the cache is the wrong tool — you'll learn to say so out loud in Section 08.

## 02 Where caches live

"Add a cache" isn't one decision — there's a cache at almost every layer between the user and the source of truth, and each has a different cost and coherence story. A request can be served by whichever one hits first:

- **Client / browser cache** — the response never leaves the device. Governed by HTTP headers (`Cache-Control`, `ETag`). Free and instant, but you can't invalidate it once it's out there.
- **CDN / edge cache** — a copy near the user, at the network edge. The best tool for static and semi-static content; it's a read-through cache in front of your origin. (Its own module — Module 6 — so we only gesture at it here.)
- **Reverse-proxy / gateway cache** — Varnish or Nginx in front of your app, caching whole HTTP responses.
- **Application (in-process) cache** — an in-memory map inside the app process (Caffeine, Guava). Nanosecond-fast, no network hop, but *per-node*: each server has its own copy, so it's incoherent and small.
- **Distributed cache** — a shared remote store like Redis or Memcached. One coherent copy all app servers read, at the cost of a network round-trip. This is the workhorse of the patterns below; scaling and coherence of this layer is Module 6.
- **Database-internal caches** — the buffer pool, query cache, and materialized views. Real caches you get "for free," worth knowing before you bolt another one on top.

| Dimension | Local (in-process) | Distributed (remote) |
| --- | --- | --- |
| Access latency | ~100 ns | ~0.5 ms |
| Capacity | Bounded by one node's RAM | Scales across many nodes |
| Coherence | Per-node — copies drift | One shared copy for all app servers |
| Blast radius on failure | One node degrades | Shared dependency (SPOF if unclustered) |
| Best for | Tiny, ultra-hot, staleness-tolerant keys | Shared hot data across a fleet |

These aren't rivals — real systems stack them. A common high-scale pattern is a small **local cache in front of a distributed cache** (a two-tier cache) so the hottest keys never even pay the Redis network hop. Hold that thought; it's exactly what rescues the Ticketmaster on-sale in Section 09.

## 03 Read patterns: cache-aside & read-through

There are two ways to structure reads through a cache. The difference is simply **who is responsible for loading data on a miss** — your application, or the cache itself.

### Cache-aside (lazy loading)

The application owns the logic: it checks the cache, and on a miss it reads the database, populates the cache, and returns. The cache sits "aside" the main path — the app talks to both.

```
def get_user(id):
    u = cache.get(id)              # 1. try the cache
    if u is not None:
        return u                   # HIT — done
    u = db.query(id)               # 2. MISS — read source of truth
    cache.set(id, u, ttl=300)      # 3. populate for next time
    return u
```

**Why it's the default:** only data that's actually requested ever gets cached (no wasted memory), and the cache is *optional* — if Redis is down, reads fall through to the database and the system stays up (just slower). **The costs:** the first request for each key is always a miss (a cold cache is a slow cache), the cache can go stale relative to the DB, the same load-on-miss code gets copy-pasted across every read path, and — crucially — concurrent misses on a hot key all stampede the database at once (Section 07).

### Read-through

The cache sits *inline*: the application only ever talks to the cache, and the cache itself knows how to load from the database on a miss (via a configured loader function or a caching library that wraps the datastore).

```
app ──get(id)──▶ [ cache ] ──miss──▶ loader ──▶ [ database ]
                     ▲                              │
                     └──────── populate ◀───────────┘
app never sees the database directly.
```

**Upside:** the load logic lives in exactly one place, and application code shrinks to a single `cache.get(id)`. **Downside:** the cache is now a hard dependency — if it's down, reads fail (so it must be clustered), the first read of a key is still slow, and you need a cache that supports the read-through pattern rather than a plain key-value store. A CDN is the read-through pattern you already use every day: on a miss it fetches from your origin, caches the result, and serves it.

## 04 Write patterns: through, behind, around

Reads decide how you populate the cache; writes decide how you **keep it consistent with the source of truth**. The three write patterns trade write latency against consistency and durability.

- **Write-through** — write to the cache *and* the database synchronously, as one operation, before acking the client. The cache is always in step with the DB for written keys, so subsequent reads are fresh hits. The price is higher write latency (two writes on the critical path) and a cache full of data that may never be read.
- **Write-behind (write-back)** — write to the cache, ack the client immediately, and flush to the database asynchronously (often batched or coalesced). This gives the fastest writes and absorbs write bursts beautifully. The danger is a **data-loss window**: if the cache node dies before the flush, unflushed writes vanish — plus you inherit ordering, retry, and durability complexity.
- **Write-around** — write straight to the database and skip the cache entirely; the cache is populated later, lazily, on the next read (via cache-aside). This avoids polluting the cache with write-heavy data that's rarely read back. The trade-off: a just-written key is a guaranteed miss the first time someone reads it.

| Pattern | Path | Consistency | Write latency | Main risk / best for |
| --- | --- | --- | --- | --- |
| Cache-aside | App reads DB on miss | Eventual | Low | Stampede on hot keys · the general-purpose default |
| Read-through | Cache loads DB on miss | Eventual | Low | Cache is a SPOF · clean app code |
| Write-through | Cache + DB, sync | Strong (cache↔DB) | Higher | Caches unread data · read-after-write freshness |
| Write-behind | Cache now, DB later | Eventual | Lowest | Data loss on crash · write-heavy, bursty loads |
| Write-around | DB direct, cache on read | Eventual | Low | First read is a miss · write-heavy, read-rarely data |

In practice you compose these. The overwhelmingly common web combination is **cache-aside reads + write-around writes**, where each write to the database *deletes* the affected cache key rather than trying to update it. That "invalidate, don't update" rule is subtle enough to earn its own warning:

> **Interview tip:** On a write, prefer to **delete the cached key, not overwrite it**. If two writers race — A writes v1 then B writes v2 to the DB, but their cache-updates arrive out of order — an *update* can leave the cache pinned on the stale v1 forever. A *delete* just forces the next reader to reload the current truth. Deleting is self-correcting; updating is a race waiting to happen.

## 05 Eviction: LRU, LFU, FIFO

A cache has bounded memory. When it's full and a new key needs to go in, the cache must throw something out — the **eviction policy** decides the victim. A good policy keeps the items you're about to need and drops the ones you aren't; the whole game is predicting the future from the past.

| Policy | Evicts | Best when | Weakness |
| --- | --- | --- | --- |
| FIFO | Oldest-inserted item | Age really does track usefulness | Ignores access — drops hot items just because they're old |
| LRU | Least-recently-used item | Temporal locality (recent ⇒ soon again) | A big one-time scan flushes the hot set (no scan resistance) |
| LFU | Least-frequently-used item | Popularity is stable over time | Yesterday's star gets stuck; needs aging/decay; more bookkeeping |

**FIFO** is the simplest — a queue, evict from the front — but it's usually the worst, because insertion age says nothing about whether an item is hot. **LRU** is the workhorse default: it assumes an item touched recently will be touched again soon, which holds for most web traffic. Its famous failure is a *scan* — one bulk read of a million cold keys evicts your entire hot set. **LFU** counts accesses and keeps the genuinely popular items, which is better for stable, skewed popularity, but without a decay mechanism a key that was hot last week clings to the cache long after it's gone cold.

LRU is implemented in **O(1)** with a hash map plus a doubly linked list — the map finds any node instantly, the list orders nodes by recency, and every access splices the touched node to the front:

```
LRU = hash map (key → node)  +  doubly linked list (MRU ⟷ LRU)

  get(k):   node = map[k]; move node to head; return node.val     # O(1)
  put(k,v): insert at head; map[k]=node
            if size > capacity: evict tail (the LRU item)           # O(1)

     head ─▶ [K7] ⟷ [K2] ⟷ [K9] ⟷ [K4] ◀─ tail
            (most recent)            (evicted next)
```

Real systems rarely run these textbook forms exactly. Redis approximates LRU and LFU by *sampling* a few random keys rather than maintaining perfect global order (its `allkeys-lru`, `allkeys-lfu`, `volatile-ttl`, `noeviction` modes), and high-end libraries like Caffeine use **W-TinyLFU** — a frequency sketch that gets LFU's smarts with LRU's recency and built-in scan resistance. You don't need to implement these; you need to name the trade-off and reach for the right default.

> **Play with it → your tool:** Open the [🗃️ Cache Playground](../tools/cache-playground.html) and drive it: set the cache size, pick **LRU vs LFU vs FIFO**, dial the request distribution from uniform to sharply skewed, and watch the **hit ratio** and backend load move in real time. Then shrink the cache until a scan tanks LRU — and see how the same workload treats LFU differently. Change one knob at a time and build the intuition.

## 06 Invalidation: TTL, event, tag

"There are only two hard things in computer science: cache invalidation and naming things." Eviction is about *space* — dropping items to make room. **Invalidation is about truth** — making sure the cache never serves data that the source of truth has already changed. Three strategies, in rising order of freshness and cost:

- **TTL (time-based expiry)** — stamp each entry with a lifetime; after it elapses the entry is considered stale and reloaded on the next read. Dead simple, zero coordination, and it bounds staleness to the TTL. The costs: you knowingly serve stale data for up to one TTL, and if a batch of keys was written together they all expire together and stampede the backend at the same instant — so you **jitter** the TTL (add a random ± spread).
- **Event / write-based invalidation** — when the source of truth changes, the write path actively deletes (or refreshes) the affected cache key. This is the freshest option — no staleness window — but it requires the writer to know *exactly* which keys a change affects, and it couples your write path to your caching layer, often across service boundaries. (And remember Section 04: delete, don't update.)
- **Tag / group-based invalidation** — attach tags to cache entries (`event:987`, `user:123`) and invalidate by tag to drop a whole related set at once. When one seat sells, you don't want to hunt down every derived key — you flush everything tagged `event:987`. It needs a tag → keys index (a reverse map), and it's exactly what CDN "surrogate keys" give you at the edge.

| Strategy | Freshness | Coordination cost | Best for |
| --- | --- | --- | --- |
| TTL | Stale up to the TTL | None | Data that can lag a little; the safe default |
| Event-based | Near-immediate | High — writer must know the keys | Data that must be fresh right after a write |
| Tag-based | Near-immediate, in bulk | Medium — needs a tag index | One change fans out to many cached entries |

A fourth trick worth knowing is **versioned / namespaced keys**: prefix keys with a version (`v7:event:987:...`) and "invalidate everything" by simply bumping the version number — old keys are never read again and age out on their own, no bulk delete required. And **stale-while-revalidate** lets you serve the expired value *once* while a single background refresh runs, so users never wait on a miss. In real systems you layer these: a short TTL as a safety net *plus* event-based deletes for freshness gives you both correctness and a backstop if an event is ever missed.

## 07 Cache stampede & thundering herd

This is the failure mode that separates senior candidates: a cache that works beautifully at steady state can *cause* the outage it was meant to prevent.

A **cache stampede** (a.k.a. thundering herd or dogpile) happens when a hot key expires or misses and *many concurrent requests all miss at the same instant* — so instead of one recompute, thousands of identical requests slam the database simultaneously to rebuild the same value. It strikes at the worst possible moment: on a popular key, under peak load, right after a TTL expiry, a cold start, or a cache flush. The backend, sized to serve the 1% of reads that normally miss, suddenly takes 100% of them and falls over.

```
t=0.000  cache key "event:987" TTL expires
t=0.001  10,000 in-flight requests all call cache.get → MISS
t=0.001  10,000 requests all fire the SAME db.query(...)   ← the herd
t=0.050  database saturates, latency spikes, timeouts cascade
                                                     the cache made it WORSE
```

Four mitigations, each a nameable trade-off:

- **Request coalescing / single-flight (per-key lock)** — the first miss takes a lock and does the one recompute; every other concurrent request for that key waits for the shared result (or is served the stale value). One key ⇒ one backend call, no matter how big the crowd. This is the primary defense.
- **Probabilistic early recompute (XFetch)** — refresh a key *before* it expires, with a probability that rises as expiry approaches, so one lucky request rebuilds it early and the synchronized expiry cliff never forms.
- **TTL jitter** — never give a batch of keys the same expiry; spread it (e.g. 300 s ± 10%) so they don't all die on the same tick.
- **Stale-while-revalidate** — keep serving the last good value to everyone while exactly one background worker refreshes it. Users never block on a miss.

```
# single-flight: turn a herd into a single backend call
def get(key):
    v = cache.get(key)
    if v is not None:
        return v                         # hit
    if lock.acquire(key, nx=True, ttl=5): # only the FIRST miss wins the lock
        try:
            v = db.query(key)
            cache.set(key, v, ttl=jitter(300))
        finally:
            lock.release(key)
        return v
    else:
        wait_briefly(); return cache.get(key) or serve_stale(key)  # the herd waits
```

Two cousins to keep in your pocket: **cache penetration** — repeated misses for keys that *don't exist* (often malicious), fixed by *negative caching* (briefly cache the "not found") or a Bloom filter guarding the lookup; and **cache warming** — pre-loading known-hot keys before a traffic spike so the first request is never a miss. All of these show up in the Ticketmaster deep-dive next.

## 08 When NOT to cache

A cache is not free. It adds a second copy of the truth that you now have to keep coherent, a new failure mode, real memory cost, and cold-start behavior. Reaching for one reflexively is a junior tell; knowing when to *refuse* is a senior one. Don't cache when:

- **There's no locality.** Uniformly random access over a huge keyspace means the hit ratio can't climb above cache-size ÷ keyspace — you're paying for RAM and coherence to get almost no hits.
- **The workload is write-heavy with little re-read.** Entries are invalidated as fast as they're written; you pay all the invalidation cost and harvest almost no hits.
- **Correctness beats latency and staleness is a bug.** Account balances, seat inventory at the moment of purchase, authorization decisions — if a stale answer is a *wrong* answer with real consequences, read the source of truth. (You can still cache the display of that data; just never the decision.)
- **The data is already fast.** If it's a trivial indexed lookup or cheap to compute, a cache only adds a network hop, a coherence bug surface, and ops burden for no real win.
- **Responses are highly personalized and rarely repeat.** Per-user, one-off results have almost no reuse, so nothing to amortize.

> **The senior move:** Add a cache because an **NFR or your capacity estimate forces it** — then **measure the hit ratio**. A cache running at a 20% hit ratio is a liability pretending to be an optimization: rip it out. The decision rule is simple — cache when the cost of a slightly-stale answer is far smaller than the cost of the slow one, and not otherwise.

## 09 Worked example: Ticketmaster

Let's run all five framework steps on a design that lives or dies on caching decisions — *"Design a ticketing system like Ticketmaster."* It's the perfect capstone because it forces you to cache one thing aggressively (browsing) while refusing to cache another (the seat you're buying).

1. **Scope** *(~5 min)* — **Functional:** search/browse events, view an event's detail and seat map, reserve seats (hold → pay → confirm). **Non-functional:** brutally read-heavy browse traffic with extreme flash-crowd spikes (a marquee on-sale), low-latency browse, but *strong consistency on the booking path — never double-sell a seat.* **Out of scope:** payment internals, recommendations, fraud.
2. **Estimate** *(~5 min)* — The estimate exists to justify the design: it proves the load is read-dominated *and* savagely concentrated on a few hot events — the exact shape caching is made for, and the exact shape stampedes are made for.
3. **Interface** *(~5 min)* — Split the API into a cacheable read surface and a strongly-consistent write surface — the seam runs right down the middle of the design.
4. **High-level design** *(~10 min)* — CDN + app cache for the read path; a separate reservation service over a consistent store for the write path.
5. **Deep-dive & scale** *(~15 min)* — Survive the on-sale hot key without ever double-selling a seat — where every concept in this module gets used at once.

### ① Scope

The whole design hinges on one observation you should say out loud in the first minute: **browsing and buying have opposite requirements.** Browsing is read-heavy, spiky, and totally fine slightly stale — cache it hard. Buying is a write that must be exactly correct — do not cache the truth of it. Nail that split and the rest falls out.

### ② Estimate

```
100M registered users; a marquee on-sale draws ~10M fans in minutes.

steady-state browse         ≈ 10,000 reads/s
on-sale spike, ONE event    ≈ 1,000,000+ reads/s  → concentrated on a single hot key

writes (reservations): a 50k-seat arena, sold out in ~10 min
   50,000 ÷ 600 s           ≈ 83 writes/s          tiny — but must be exactly-once

on-sale read : write        ≈ 1,000,000 : 83  ≈  12,000 : 1
```

Verdict: reads dominate by ~4 orders of magnitude and collapse onto a *single* event page → **cache the browse path aggressively, and expect a thundering herd on that one key.** Writes are trivially small in volume but consistency-critical → **do not cache seat availability as truth; guard it with the database.**

### ③ Interface

```
# READ surface — highly cacheable
GET /events/{id}              # event details: long TTL, tag-invalidated
GET /events/{id}/seatmap      # availability: very short TTL + stale-while-revalidate
GET /search?q=...             # cache-aside per query, short TTL

# WRITE surface — strongly consistent, NOT cached
POST /events/{id}/reservations   { "seats": ["A12","A13"] }  → 201 hold (expires in 10 min)
POST /reservations/{id}/purchase { "paymentToken": "..." }   → 200 confirmed
```

### ④ High-level design

```
            ┌─── static: images, event pages ──▶ [ CDN / edge ]
 client ──▶ │
            └─── dynamic ──▶ [ LB ] ──▶ [ app servers ]
                                            │  cache-aside + local L1
                                            ▼
                                        [ Redis ]  ── miss ──▶ [ events DB ]
                                        (event meta, search,
                                         seatmap snapshot)

 booking (separate, consistent path):
   [ app ] ──▶ [ reservation service ] ──▶ [ seat inventory DB ]
                     ▲                        (row locks / conditional
              [ virtual waiting room /         update — source of truth)
                queue paces the spike ]
```

Map each concept onto the boxes: **event details** = cache-aside + long TTL, **tag-invalidated** on `event:{id}` when an organizer edits it. **Search** = cache-aside keyed by query string, short TTL. **Seatmap for display** = a read-through snapshot with a very short TTL and stale-while-revalidate — good enough to render, never trusted to sell. The **reservation service** owns the real seat state in a strongly-consistent store, completely outside the cache.

### ⑤ Deep-dive: surviving the on-sale without double-selling

The estimate promised two problems; here's how the module's tools solve them together:

- **The hot key (thundering herd).** One event = one cache key = the entire 1M-RPS flash crowd on a single entry. Defend it with **single-flight** so one recompute serves millions, **TTL jitter** so nothing expires in lockstep, and a two-tier **local L1 cache in front of Redis** so the hottest key never even pays the network hop — and replicate that key across cache nodes so one shard doesn't melt. Serve the seatmap **stale-while-revalidate**: a half-second-old availability view is fine to look at.
- **The waiting room.** Don't let 10M people hit the booking path at once — a **virtual queue** admits users in controlled batches, shedding and pacing load so the consistent store is never stampeded. This is load management, not caching — the flip side of the same spike.
- **Consistency at purchase (when NOT to cache).** The seatmap can say "A12 available" from a slightly-stale cache, but the *reservation* is an atomic operation against the database — a conditional update / `SELECT … FOR UPDATE` / optimistic version check — so two fans racing for A12 are safely serialized and exactly one wins. The cache can be wrong; the write cannot. On a successful hold, **event-based invalidation** refreshes the seatmap so the display trends back toward truth.

That's the whole story in one sentence: **cache what people look at, guard what people buy.** Every concept in this module — patterns, eviction, TTL, tag invalidation, stampede defense, and the discipline to *not* cache the seat inventory — earns its place in that one design.

> **See it move:** The flash-crowd + waiting-room dynamic you just designed — pacing a 1M-RPS spike so the backend survives — is exactly what the [🚦 Load Balancer Playground](../tools/load-balancer-simulator.html) (Module 2) lets you stress and break. Pair it with the Cache Playground to watch both halves of the on-sale at once.

## 10 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard Ticketmaster yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end with the 5-step framework, out loud, timed to ~35 minutes — *before* re-reading Section 09. Force yourself to name where you cache and where you refuse to.
2. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your caching decisions against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design a ticketing system like Ticketmaster." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on the caching decisions specifically: which read paths I cache and why, my eviction policy, my TTL and invalidation strategy, and — above all — how I prevent a cache stampede on a hot on-sale AND how I guarantee two people can never buy the same seat. Keep asking "why?" and never let me hand-wave "just add Redis." Do NOT give me the answer or lead me. After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, caching deep-dives & trade-offs (patterns, eviction, invalidation, stampede, and when-not-to-cache), and communication — with specific feedback and what a strong candidate would have added.
```

1. **Tune it in the tool.** Open the [🗃️ Cache Playground](../tools/cache-playground.html), reproduce a stampede on a hot key, then turn on single-flight and watch backend load drop. Compare hit ratios under LRU vs LFU on a skewed workload — did your intuition match the numbers?
2. **Explain it back.** Teach a rubber duck (or me), without notes: cache-aside vs read-through, write-through vs write-behind, and three ways to stop a stampede. Gaps you can't explain are gaps you don't have yet.
3. **Flashcards** (make these 5, review at week's end): *Cache-aside vs read-through — who loads on a miss? · Write-through vs write-behind — what's the failure trade-off? · LRU vs LFU — when does each win, and how does a scan pollute LRU? · Name three ways to stop a cache stampede. · Name two situations where you should NOT cache.*

## 11 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the strategy and eviction ones *before* your reps; save the stampede deep-dives for when you're wrestling with the Ticketmaster on-sale.

- **[Caching in System Design Interviews w/ Meta Staff Engineer](https://www.youtube.com/watch?v=1NngTUYPdpI)** — Hello Interview · ~30 min · strategies — The best single overview: where caches live, cache-aside, and how to talk about caching in an interview. Watch first.
- **[Cache Systems Every Developer Should Know](https://www.youtube.com/watch?v=dGAgxozNWFE)** — ByteByteGo · ~6 min · read/write patterns — Tight visual tour of cache-aside, read-through, write-through, write-back, and write-around.
- **[Cache Eviction Policies | System Design Interview | LRU LFU FIFO TTL](https://www.youtube.com/watch?v=ZqI7i3v4baQ)** — Lazy Programmer · ~11 min · eviction — Walks LRU vs LFU vs FIFO vs TTL side by side — exactly the Section 05 comparison.
- **[The hardest problem in computer science — cache invalidation](https://www.youtube.com/watch?v=ROfrHShYKLQ)** — Syntax · ~3 min · invalidation — Fast, intuitive take on why keeping a cache honest is genuinely hard.
- **[How PayPal Beat the Thundering Herd Problem and Fixed Their Architecture](https://www.youtube.com/watch?v=pFBCgFzS2W8)** — Arpit Bhayani · ~17 min · stampede — A real production stampede — how one cache miss floods the backend, and the fix. Watch during the deep-dive.
- **[Thundering Herd Problem and How not to do API retries](https://www.youtube.com/watch?v=8sTuCPh3s0s)** — Arpit Bhayani · ~15 min · stampede — Backoff, jitter, and coalescing — the mitigation toolkit from Section 07, applied.

**Read (optional depth):** the [System Design Primer — Caching section](https://github.com/donnemartin/system-design-primer#cache) (free) is the tightest written summary of these patterns and their trade-offs. For deeper context, **DDIA Chapter 1** gives you the reliability/scalability/maintainability vocabulary these caching trade-offs live inside, and Chapter 11 (derived data & materialized views) frames a cache as one more piece of derived state you must keep in sync.

---
*Source: `modules/05-caching-fundamentals.html` — System Design Mastery. Interactive version has the live simulators.*
