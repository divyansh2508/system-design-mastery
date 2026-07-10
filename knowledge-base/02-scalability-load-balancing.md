# Scalability & Load Balancing

*Phase 1 · Foundations·Module 2·Week 1 · ~13 hrs*

One server always dies first. This module is about the two moves that let a system outgrow that single box — **adding more machines** and **spreading traffic across them** — and the discipline that makes both actually work.

## 01 Vertical vs horizontal scaling

Scalability is a system's ability to **handle more load by adding resources** — and ideally to do it in proportion, so twice the machines get you roughly twice the throughput. There are exactly two directions to add those resources.

**Vertical scaling (scale up)** means making one machine bigger: more CPU cores, more RAM, faster disks. It's the path of least resistance — no code changes, no new failure modes, your single database just gets a beefier box. Start here. A surprising number of real systems never need anything else.

**Horizontal scaling (scale out)** means adding *more* machines and splitting the work across them. This is how every internet-scale system is actually built, because it removes the two ceilings that eventually stop vertical scaling cold: the biggest box money can buy, and the fact that one box is still a **single point of failure**.

| Dimension | Vertical (scale up) | Horizontal (scale out) |
| --- | --- | --- |
| How | Bigger machine | More machines |
| Ceiling | Hard — largest box exists | Effectively none |
| Fault tolerance | Single point of failure | Survives node loss |
| Cost curve | Super-linear (top-end HW is pricey) | Roughly linear (commodity boxes) |
| Complexity | Low — no app changes | High — needs a load balancer, stateless app, distributed data |
| Downtime to scale | Usually a reboot | Zero — add nodes live |

The two aren't rivals; real architectures use both. You scale a single node up until the price-per-unit-of-work gets ugly or you can't tolerate it being a single point of failure, *then* you scale out. The interesting engineering — and everything else in this module — lives in the horizontal column, because scaling out only works if the machines are interchangeable. Which brings us to the one prerequisite that makes it all possible.

> **Key idea:** Vertical scaling buys you time; horizontal scaling buys you a future. The senior move is knowing **which ceiling you're about to hit** — capacity or availability — and scaling in that direction, not reflexively reaching for a cluster on day one.

## 02 Stateless architecture

Horizontal scaling has one hard requirement: the machines behind your load balancer must be **interchangeable**. Any request can land on any server and get an identical, correct response. That property is called being **stateless**, and it is the single most important architectural habit in this entire module.

A server is **stateful** when it keeps request-relevant data in its own local memory — a user's session, an upload's progress, a shopping cart. The moment it does, that user is *tied* to that specific box. If the box dies, the state is gone; if the load balancer sends the next request elsewhere, the new server has no idea who the user is. You can no longer freely add or remove machines, which quietly kills horizontal scaling.

A **stateless** server keeps *no* per-client state between requests. Everything it needs either arrives *in* the request (a token, an ID) or lives in **shared external storage** every server can reach — a database, a Redis cache, an object store. The server itself becomes a pure, disposable compute unit.

```
# Stateful — session lives in THIS server's RAM (does not scale)
login()      -> server A stores session in local memory
next request -> LB routes to server B -> "who are you?" -> 401

# Stateless — session lives in shared store (scales freely)
login()      -> write session to Redis, return signed token to client
next request -> ANY server -> read token / Redis -> authorized
```

The payoff is enormous. Stateless servers can be added, removed, restarted, or killed by a crash with *zero* user impact — the load balancer just stops routing to the dead one. This is what makes auto-scaling, rolling deploys, and cheap fault tolerance possible. When an interviewer asks "how do you scale the application tier?", the first sentence out of your mouth should be *"keep it stateless and put a load balancer in front."*

> **Interview tip:** "Where does the state live?" is the question that separates a design that scales from one that doesn't. Push every piece of state *out* of your app servers — into a database, a cache, or the request itself — and say so explicitly. It signals you understand *why* horizontal scaling works, not just that it does.

## 03 Load balancers: what & where

A **load balancer (LB)** is the traffic cop that sits in front of your pool of servers and decides which one handles each request. It gives you three things at once: it **distributes load** so no single server drowns, it provides **fault tolerance** by routing around servers that fail health checks, and it hands clients a **single stable address** so the fleet behind it can grow, shrink, and get replaced invisibly.

That last point matters more than it looks: the LB decouples "the address clients talk to" from "the machines that do the work." Clients hit `api.example.com` forever, while you swap the ten boxes behind it for fifty without anyone noticing.

### Layer 4 vs Layer 7

Load balancers operate at one of two levels of the network stack, and the distinction comes up constantly:

- **Layer 4 (transport)** balances on TCP/UDP — it sees only IP addresses and ports, never the actual content. It just forwards packets to a chosen backend. Extremely fast and cheap because it doesn't inspect anything, but it also can't make content-aware decisions.
- **Layer 7 (application)** balances on the HTTP request itself — it can read the URL path, headers, cookies, and method. That lets it route `/api/*` to one pool and `/images/*` to another, terminate TLS, and do sticky sessions by cookie. More CPU per request, far more flexible. Most web systems use L7.

```
                          ┌──▶ app server 1  (stateless)
   clients ──▶  LOAD       ├──▶ app server 2  (stateless)
               BALANCER    ├──▶ app server 3  (stateless)
   (single address)        └──▶ app server N  (stateless)
                              ▲
                health checks ┘  drop any server that fails,
                                 route only to healthy ones
```

One caution: the load balancer itself is now a single point of failure. In production you run it **redundantly** (an active–passive pair, or a managed offering like AWS ELB that's internally replicated across availability zones), so the thing protecting your fleet doesn't become the thing that takes it all down.

## 04 Load-balancing algorithms

Once the LB has a pool of healthy servers, it needs a rule for *which* one gets the next request. The three you must be able to compare on sight are round-robin, least-connections, and IP hash. Each optimizes for a different assumption about your traffic.

| Algorithm | How it picks | Best when | Weakness |
| --- | --- | --- | --- |
| Round-robin | Next server in a rotating cycle | Requests are uniform & servers are equal | Ignores that some requests are heavy — a slow one still gets its turn |
| Weighted round-robin | Rotation biased by server capacity | Mixed hardware (big + small boxes) | Weights are static; doesn't react to live load |
| Least-connections | Server with fewest active connections | Requests vary wildly in duration | Slightly more state to track per server |
| Least response time | Fastest-responding healthy server | You care about tail latency | Needs live latency probing |
| IP hash | hash(client IP) → fixed server | You need the same client on the same server | Uneven spread; breaks when the pool changes |

**Round-robin** is the sensible default: dead simple, no per-server bookkeeping, and if requests are roughly uniform it spreads load evenly. Its blind spot is duration — it hands out turns in strict rotation even if one server is stuck on a 30-second request while another is idle.

**Least-connections** fixes exactly that. By routing to whichever server currently has the fewest open connections, it naturally steers traffic away from a box that's bogged down with long-running requests. When request cost is uneven — some cheap, some expensive — this is usually the better choice.

**IP hash** is different in kind: it's *deterministic*. It hashes the client's IP and always maps that client to the same server, which is how you pin a user to one machine without a cookie. That determinism is also its curse — if the server pool changes size, the hash remaps and clients scatter to new servers (a foreshadowing of the sticky-session failure mode in the next section, and of consistent hashing in Module 5).

> **Play with it → your tool:** Open the [🚦 Load Balancer Simulator](../tools/load-balancer-simulator.html) and flip between **round-robin** and **least-connections** while sending a mix of fast and slow requests. Watch a heavy request pile up on one server under round-robin, then vanish under least-connections. Then kill a server mid-stream and see the LB route around it via health checks — the whole point of this module, on one screen.

## 05 Sticky sessions & their failure modes

A **sticky session** (session affinity) is when the load balancer deliberately routes a given user to the *same* backend server for the whole session — usually by setting a cookie (L7) or hashing the source IP (L4). Teams reach for it as a shortcut: if a server keeps a user's session in local memory, stickiness makes sure the user keeps coming back to the server that has it.

It works, and it's tempting, because it lets you skip building shared session storage. But it's a shortcut that quietly re-introduces the exact statefulness you worked to eliminate — and it fails in ways that bite in production:

- **Lost sessions on server death.** If a sticky server crashes, every user pinned to it loses their in-memory state and gets logged out. You've re-created the single point of failure per user.
- **Uneven load ("hot" servers).** Stickiness pins load, not just users. A server that happened to catch a burst of heavy users stays overloaded while freshly added servers sit idle — the LB can't rebalance existing sessions.
- **Scaling friction.** Add servers and only *new* sessions use them; the old ones are stuck. Remove a server and you forcibly evict its users. Auto-scaling and rolling deploys turn ugly.

> **The clean alternative:** Don't make servers sticky — make them **stateless** and move the session to a **shared store** (Redis, or a signed token the client carries). Now any server can serve any user, the LB is free to balance perfectly, and a dying server takes zero sessions with it. Reach for sticky sessions only as a deliberate, temporary trade-off — never as your scaling strategy.

## 06 Auto-scaling policies

Once your app tier is stateless and load-balanced, you can let the fleet **size itself**. Auto-scaling adds servers when load rises and removes them when it falls, so you pay for roughly what you use instead of provisioning for peak 24/7. There are three common policies:

| Policy | Trigger | Good for |
| --- | --- | --- |
| Target-tracking (reactive) | Keep a metric at a target, e.g. CPU ≈ 60% | The default — smooth, self-correcting |
| Step / threshold | Add N servers when CPU > 80% for 5 min | Coarse, explicit control |
| Scheduled (predictive) | Scale up at 8am, down at midnight | Known daily/weekly patterns |

Two details separate a real answer from a naive one. First, **scale out fast, scale in slow.** Adding capacity late means dropped requests; removing it too eagerly means thrashing (add, remove, add again). A *cooldown* after each action prevents oscillation. Second, new servers aren't instant — there's a **warm-up lag** (boot, deploy, cache-fill) before a fresh box is useful, so reactive scaling always trails a spike. For sharp, predictable spikes (a product launch, a 9am rush), pre-scale on a schedule instead of waiting for the metric to catch up.

> **Interview tip:** Auto-scaling is only possible *because* the tier is stateless — mention that link explicitly. And name what you scale **on**: CPU is the easy default, but a queue-backed worker should scale on *queue depth*, and a latency-sensitive API on *p99 latency*. Picking the right metric is the senior signal.

## 07 Going global: multi-region distribution

Adding servers scales your *capacity*, but it does nothing for a user in Sydney hitting a datacenter in Virginia — physics still charges them ~150 ms per round trip (recall the latency table from Module 1). To fix *latency* and to survive a whole datacenter failing, you distribute across **multiple geographic regions**.

The moves stack from cheapest to most involved:

- **CDN / edge caching.** Push static and cacheable content (images, video, JS) to edge locations near users. The single highest-leverage latency win, and it offloads huge traffic from your origin. (Deep dive in Module 6.)
- **GeoDNS / global load balancing.** DNS resolves each user to their *nearest* healthy region, so requests enter the network close to home and route around a region that's down.
- **Multi-region compute + data.** Run the full stateless app tier in several regions, each with a local load balancer. Straightforward for compute. The *data* is the hard part: replicating a database across regions forces the CAP trade-off (Module 1) — do you serve possibly-stale reads locally (AP) or pay a cross-region hop for strong consistency (CP)? Common shapes are active-passive (one write region, others read) and active-active (writes anywhere, plus conflict resolution).

> **Rule of thumb:** Distributing **stateless compute** across regions is easy; distributing **state** is the entire hard problem. Reach for a CDN and GeoDNS long before you take on multi-region *writes* — and when you do, be explicit about the consistency model you're buying.

## 08 Cost vs performance

Every scaling lever you've met costs money, and the senior skill is spending it where it moves an NFR — not everywhere. A few trade-offs worth saying out loud in an interview:

| Lever | Buys you | Costs you |
| --- | --- | --- |
| Vertical scale | Simplicity, no app changes | Super-linear price at the top end; a ceiling; an SPOF |
| Horizontal scale | Near-limitless capacity, fault tolerance | LB + orchestration complexity; distributed-data headaches |
| Over-provisioning | Headroom for spikes | Idle machines you pay for 24/7 |
| Auto-scaling | Pay ≈ what you use | Warm-up lag; risk of under-serving a sudden spike |
| Multi-region | Low global latency + DR | Duplicated infra + cross-region replication/egress bills |
| Caching / CDN | Huge latency + origin-load win | Staleness + invalidation complexity |

The two cost traps that catch people: **over-provisioning** (renting for a peak that's rare, paying for idle boxes all night) and, in the cloud, **data egress** — moving bytes between regions or out to the internet is often billed more than the compute itself, which is exactly why a CDN that keeps bytes at the edge pays for itself. There's no universally right answer; there's the point on the cost/performance curve your NFRs justify, stated as a deliberate choice.

## 09 Worked example: Design Dropbox / file-sync

Let's run the 5-step framework from Module 1 on a file-sync service like Dropbox, using it to exercise everything above — stateless tiers, load balancing, auto-scaling, multi-region, and the cost trade-offs. Read it once, then you'll do it yourself in the reps.

### ① Scope

- **Functional:** upload a file; download a file; *sync* a folder across a user's devices so an edit on the laptop appears on the phone; share a file/folder with other users.
- **Non-functional:** extreme **durability** (never, ever lose a file — this dominates everything), high availability, low sync latency (changes propagate in seconds), huge and growing storage, and a very read-heavy download pattern. It is also **bandwidth-heavy**, which makes it different from Bitly.
- **Out of scope (say it):** real-time collaborative editing (that's Google Docs), a permissions/ACL deep-dive, and versioning internals — keep the core sync tight.

### ② Estimate

```
50M DAU, avg 100 files each, avg file 1 MB
storage:  50M users × 100 files × 1 MB      = 5 PB   (× replication → plan to tier & dedup)
uploads:  50M × 5 files/day ÷ 100k s        ≈ 2.5k writes/s  peak ×3 ≈ ~8k/s
downloads/sync: ~10× uploads                ≈ 25k reads/s    read-heavy, bandwidth-bound
bandwidth: 25k reads/s × 1 MB               ≈ 25 GB/s egress → CDN is not optional
```

Verdict: the numbers say this is a **storage- and bandwidth-bound** system, not a QPS-bound one. That reframes the whole design — the hard parts are moving bytes cheaply (dedup, chunking, CDN) and never losing them (replication), not raw request throughput.

### ③ Interface

```
# Chunked upload — files are split client-side into blocks
POST /api/v1/files/{fileId}/chunks
  body:    { chunkId, index, hash, bytes }
  returns: 200 { received: true }   // skip if hash already stored (dedup)

# Download / sync
GET  /api/v1/files/{fileId}/manifest   -> ordered list of chunk hashes
GET  /api/v1/chunks/{hash}             -> chunk bytes (served from CDN/edge)

# Sync — client learns about remote changes
GET  /api/v1/sync?since={cursor}       -> changes; long-poll or WebSocket push
```

### ④ High-level design

```
                          ┌─▶ metadata service ─▶ Metadata DB (file tree,
                          │      (stateless)          chunk lists, versions)
 devices ─▶ LB ─▶ API ────┤
            (L7)  tier    ├─▶ block service ─────▶ Object store (S3-like,
          (stateless)     │     (stateless)         replicated, the chunks)
                          └─▶ notification svc ──▶ push "you changed" to a
                                                    user's other devices

 downloads/chunks served from  CDN / edge  (offload the 25 GB/s)
```

Note the split every senior answer makes: **metadata** (small, structured, transactional — who owns what, which chunks make a file) lives in a database; the **file blocks** (huge, immutable blobs) live in an object store built for durability and cheap bytes. Never put file bytes in your primary DB.

### ⑤ Deep-dive & scale

- **Stateless API tier + load balancer.** Every API server is stateless — an upload's progress lives in the object store and metadata DB, not local memory — so an L7 load balancer spreads requests with **least-connections** (uploads vary wildly in size, so duration-aware beats round-robin here). Any server can resume any client's upload; a dying server drops zero work. This is Sections 02–04 applied directly.
- **No sticky sessions for sync.** The long-poll/WebSocket sync connection is tempting to pin, but we keep it stateless: connection state (which user, which cursor) lives in a shared store, so we can add sync servers and rebalance freely (Section 05).
- **Chunking + dedup = the bandwidth win.** Splitting files into content-hashed blocks means an edit re-uploads only the changed chunk, and identical chunks across all users are stored once. This is what makes the 5 PB and 25 GB/s estimates survivable.
- **Auto-scaling on the right metric.** The API tier auto-scales, but on **bandwidth / connection count**, not CPU — this workload is I/O-bound, so CPU would under-scale it during a big-file storm (Section 06).
- **CDN + multi-region.** Chunk downloads are served from the edge so a user pulls bytes from nearby, slashing latency and origin egress. The stateless tier runs in multiple regions via GeoDNS; the object store replicates across regions for durability and disaster recovery (Sections 07–08).
- **Cost.** Cold files move to cheaper storage tiers; dedup shrinks the footprint; the CDN keeps egress bills sane. Each is a deliberate cost/performance choice, not a default.

> **See it move:** That stateless API tier behind a least-connections LB — with servers you can kill mid-upload — is exactly what the [🚦 Load Balancer Simulator](../tools/load-balancer-simulator.html) lets you stress. Send big "uploads," compare algorithms, and drop a node to watch the fleet absorb it.

## 10 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Break a load balancer on purpose.** Open the [🚦 Load Balancer Simulator](../tools/load-balancer-simulator.html), send a mix of fast and slow requests under round-robin until one server is clearly hot, then switch to least-connections and watch it self-correct. Now kill a server mid-stream. Narrate what the health check does. Build the muscle memory before the mock.
2. **Whiteboard Dropbox yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design file-sync end-to-end with the 5-step framework, out loud, timed to ~35 minutes — *before* re-reading Section 09 or watching the videos. Force yourself to say where state lives and why the app tier is stateless.
3. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design a file-sync service like Dropbox." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on scalability specifically: make me justify vertical vs horizontal scaling, prove my app tier is stateless (ask "where does the session/upload state live?"), defend my load-balancing algorithm choice, and interrogate sticky sessions, auto-scaling metrics, and multi-region data. Do NOT give me the answer or lead me. Keep asking "why?". After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, scalability & load-balancing depth, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Defend your numbers** in the [🧮 Capacity Estimator](../tools/capacity-estimator.html) — did your Dropbox storage and bandwidth estimates hold up? Bandwidth is the one people miss.
2. **Flashcards** (make these 5, review at week's end): *When does vertical scaling hit a wall — capacity or availability? · Why must app servers be stateless to scale horizontally, and where does the state go instead? · Round-robin vs least-connections — which for uneven request durations, and why? · Name two failure modes of sticky sessions. · What should Dropbox's upload tier auto-scale on, and why not CPU?*

## 11 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the scaling and load-balancing basics *before* your reps; save the interview-framing one for when you're consolidating.

- **[System Design BASICS: Horizontal vs. Vertical Scaling](https://www.youtube.com/watch?v=xpDnVSmNFX0)** — Gaurav Sen · ~8 min · scaling — The clearest intuition for scale-up vs scale-out and when each hits its ceiling. Start here.
- **[Vertical Vs Horizontal Scaling: Key Differences You Should Know](https://www.youtube.com/watch?v=dvRFHG2-uYs)** — ByteByteGo · ~4 min · scaling — Tight, animated recap of the two axes — great to lock the comparison in your head.
- **[What is LOAD BALANCING? ⚖️](https://www.youtube.com/watch?v=K0Ta65OqQkY)** — Gaurav Sen · ~6 min · load balancing — What a load balancer is and why it's the front door to any horizontally-scaled system.
- **[Top 6 Load Balancing Algorithms Every Developer Should Know](https://www.youtube.com/watch?v=dBmxNsS3BGE)** — ByteByteGo · ~5 min · algorithms — Round-robin, weighted, least-connections, hash, and more — exactly the table in Section 04, animated.
- **[Stateful vs Stateless Architecture Explained with Real-World Examples](https://www.youtube.com/watch?v=QDiPjMWeVC0)** — ByteMonk · ~8 min · stateless — Why statelessness is the prerequisite for horizontal scale — the core idea of Section 02.
- **[Load Balancers for System Design Interviews](https://www.youtube.com/watch?v=chyZRNT7eEo)** — Exponent · ~9 min · interview framing — How to talk about load balancing under interview pressure. Watch while consolidating.

**Read (optional depth):** DDIA Chapter 1 — the "Describing Load" and "Approaches for Coping with Load" sections give you the precise vocabulary (throughput, load parameters, scaling up vs out) for everything above. And the [System Design Primer](https://github.com/donnemartin/system-design-primer) sections on *load balancing* and *horizontal scaling* (free).

---
*Source: `modules/02-scalability-load-balancing.html` — System Design Mastery. Interactive version has the live simulators.*
