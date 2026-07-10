# Fault Tolerance & Resilience

*Phase 4 · Production-Grade·Module 13·Weeks 6-8 · ~13 hrs*

Every dependency you draw *will* fail — a disk, a network link, a whole datacenter. This module is about designing systems that **absorb** those failures and keep serving, instead of falling over with them.

## 01 The resilience mindset

A distributed system is a large collection of components that each fail independently and occasionally — so at any real scale, **something is always broken.** The job isn't to prevent every failure; it's to make sure no single failure can take the whole system down with it.

Two words get used loosely, so pin them down. **Fault tolerance** is the property that the system keeps meeting its requirements *despite* faults — a failed component is masked, not surfaced to the user. **Resilience** is the broader discipline: not just tolerating faults, but detecting them fast, degrading gracefully, recovering automatically, and getting *stronger* from each incident. Fault tolerance is a state; resilience is the practice that keeps you there.

The mental model senior candidates carry is the **blast radius**: when component X dies, how much of the system dies with it? Great architecture shrinks that radius on purpose — with redundancy, isolation, timeouts, and fallbacks — so a hard failure in one corner becomes a shrug instead of an outage. Every pattern in this module is a different tool for shrinking the blast radius.

> **Key idea:** Assume failure. Never ask *"what if this dependency goes down?"* — ask *"when it goes down, what happens to everything that calls it?"* If the honest answer is "the whole system stalls," you have a design bug, not an operational one.

## 02 High availability & failover

**Availability** is the fraction of time the system is up and serving correctly, and it's the NFR fault tolerance exists to protect. We talk about it in **"nines"** — and each extra nine costs roughly an order of magnitude more engineering, because you're chasing ever-shorter windows of allowed downtime.

| Target | Nines | Downtime / year | Roughly what it takes |
| --- | --- | --- | --- |
| 99% | two | ~3.65 days | A single well-run server |
| 99.9% | three | ~8.77 hours | Redundancy + health checks + auto-restart |
| 99.99% | four | ~52.6 min | Multi-AZ, automated failover, no SPOFs |
| 99.999% | five | ~5.26 min | Multi-region active-active, ruthless automation |

Don't quote five nines by reflex — it's punishingly expensive and most products don't need it. Match the target to the business: a checkout path might justify 99.99%; an internal analytics dashboard is fine at 99%.

### Redundancy: kill every single point of failure

A **single point of failure (SPOF)** is any component that, alone, can take the system down — one load balancer, one database primary, one shared cache. Redundancy is the cure: run more than one of everything on the critical path so the loss of any one instance is survivable. There are two flavors, and naming which you're using is a seniority signal:

- **Active-active** — all replicas serve traffic simultaneously behind a load balancer. Losing one just sheds a fraction of capacity (so size for N+1). Bonus: you're continuously proving the "spare" actually works.
- **Active-passive (standby)** — one node serves; a hot/warm standby waits and takes over on failure. Simpler for stateful systems like a database primary, but the standby is idle capacity and its takeover path is only exercised during real incidents — so you must rehearse it.

### Why redundancy math actually works

Availability composes very differently depending on *how* components are wired. Two things in **series** (both must be up) multiply — so the whole is *less* available than either part. The same thing **in parallel** (either can serve) fails only if *both* fail — which is why redundancy is so powerful:

```
# Series: request needs BOTH the app AND the db (each 99.9%)
A_series   = 0.999 × 0.999            = 0.998001   → ~99.8%  (worse than either)

# Parallel: two identical 99.9% replicas, either can serve
A_parallel = 1 − (1 − 0.999)²       = 0.999999   → ~99.9999% (six nines)
```

Read that twice: adding dependencies in series quietly *erodes* availability, while duplicating a component in parallel dramatically raises it. This is the arithmetic behind "remove the SPOF" — and behind why long serial dependency chains are fragile.

### Failover: detect, then switch

Redundancy is useless if traffic keeps hitting the dead node. **Failover** is the automatic switch from a failed component to a healthy one, and it has two halves:

- **Detection** — health checks and heartbeats. A load balancer probes `/healthz`; peers exchange heartbeats. Tune the threshold: too twitchy and a GC pause triggers a needless failover (flapping); too slow and you eat extra downtime.
- **Promotion** — for stateless app servers, just stop routing to the dead one. For a stateful primary (a database), a standby must be *promoted*, often via leader election (Raft/Paxos, covered in Module 3) so exactly one primary exists and you never get split-brain — two nodes both thinking they're primary and diverging.

> **Interview tip:** When you draw two of something for redundancy, immediately say the next sentence: *"health check here, automatic failover there, and I'll use leader election on the DB primary to avoid split-brain."* Redundancy without a stated failover mechanism reads as a half-thought — the interviewer will ask "and who decides to switch?"

## 03 Bulkheads: isolate the blast radius

The **bulkhead pattern** is named after ships: a hull is divided into watertight compartments so that a breach floods one section instead of sinking the vessel. In software, you *partition resources* so that one misbehaving dependency can only exhaust *its own* slice — never the pool everything else needs.

The failure it prevents is subtle and lethal. Say your service calls three downstreams — Payments, Search, Recommendations — all sharing one pool of, say, 100 worker threads. Recommendations gets slow. Requests to it pile up, each holding a thread while it waits. Within seconds all 100 threads are parked on Recommendations, and now *Payments and Search calls can't get a thread either*. A slowdown in your least important dependency just took down your most important one. That's **resource exhaustion**, and it's the fuse for most cascading failures.

```
WITHOUT bulkheads — one shared pool of 100 threads
   [Payments][Search][Recommendations]  →  100 shared threads
   Recommendations stalls → all 100 threads parked on it
   → Payments & Search starve too   (whole service down)

WITH bulkheads — a dedicated, capped pool per dependency
   Payments        → [ 40 threads ]   critical: generous slice
   Search          → [ 40 threads ]
   Recommendations → [ 20 threads ]   stalls → only these 20 park
   → Payments & Search keep serving  (blast radius contained)
```

Concretely, bulkheads are **separate connection pools, thread pools, or even separate service instances** per dependency (or per tenant, or per traffic class). Give each a hard cap. When Recommendations saturates its 20 threads, further calls to it fail fast (see the next section) instead of borrowing from Payments. You've traded a little capacity for a guarantee: *the failure of any one dependency is bounded.*

The same idea scales up. Isolating **free-tier from paid-tier** traffic keeps a free-tier stampede from starving paying customers. Giving noisy tenants their own compartment is how multi-tenant systems stop one customer's spike from becoming everyone's outage. Bulkheads are how you make "the blast radius" a design parameter you actually control.

## 04 Timeouts, retries & circuit breakers

Bulkheads cap *how many* resources a bad dependency can hold. Timeouts cap *how long* it can hold them. Together with retries and circuit breakers, they form the standard trio for stopping a **cascading failure** — the domino effect where one slow service drags down everything upstream of it.

### Timeouts: the most under-used line of defense

Every network call must have a timeout. A call with no timeout is a promise to wait forever, and "forever" is exactly how threads leak and pools exhaust. The design choice is a spectrum between two philosophies:

| Strategy | Fail-fast | Wait-and-retry |
| --- | --- | --- |
| Timeout | Short (e.g. p99 + margin) | Longer, tolerant of slow calls |
| On failure | Give up immediately, return error/fallback | Retry (with backoff) hoping it's transient |
| Best when | Interactive path; a fast error beats a slow hang | Idempotent, async, or must-succeed work |
| Risk | Sheds work that might have succeeded | Retries amplify load on an already-sick service |

The rule of thumb: on a **user-facing request**, fail fast — a 200 ms timeout and a graceful fallback beat a 30 s spinner. On **background or must-complete work** (a payment settlement, a queue consumer), wait-and-retry — correctness matters more than latency. And set timeouts *tighter as you go up the stack*: an outer request budget of 1 s can't contain three inner calls that each wait 1 s.

### Retries — and the storm they can cause

Retries recover from *transient* faults (a dropped packet, a brief blip). But naive retries are dangerous: when a service is struggling, every caller retrying immediately triples its load and finishes the job of killing it — a **retry storm**. Three guardrails make retries safe:

- **Exponential backoff** — wait 100 ms, then 200, 400, 800… so you back off as the service struggles instead of hammering it.
- **Jitter** — randomize each delay so ten thousand clients don't retry in a synchronized thundering herd at exactly the same instant.
- **A retry budget / cap** — bound total attempts (e.g. 3), and only retry *idempotent* operations, or you'll double-charge a card.

### Circuit breakers: stop calling a service that's down

Retrying a service that is genuinely *down* (not just blipping) is pure harm — you add load and still fail. A **circuit breaker** wraps a dependency and trips when it sees sustained failures, after which it *fails fast without even making the call* — protecting both the caller (no threads parked waiting) and the callee (breathing room to recover). It's a small state machine:

```
            failures ≥ threshold
   CLOSED  ───────────────────────▶  OPEN
   (calls flow,                       (reject instantly,
    counting failures)                 don't touch downstream)
      ▲                                    │
      │ trial call                         │ after cool-down timer
      │ succeeds                            ▼
      └────────────  HALF-OPEN  ◀──────────┘
                 (let a few probes through)
                 probe fails ─▶ back to OPEN
```

**Closed** is normal. On enough failures it flips to **Open** and short-circuits every call (returning an error or a fallback) for a cool-down. Then it goes **Half-Open** and lets a trickle of trial requests through: if they succeed, close and resume; if they fail, re-open and wait again. This is the single most important cascading-failure defense — it converts "hang and pile up" into "fail instantly and shed load."

> **Play with it → your tool:** Watch a cascade happen and then stop it in the [🔗 Cascade Failure Simulator](../tools/cascade-failure.html). Overload one downstream service and see threads pile up and starve its neighbors; then flip on **timeouts**, **bulkheads**, and a **circuit breaker** and watch the blast radius collapse to a single component. Nothing builds the intuition faster than triggering the dominoes yourself.

## 05 Graceful degradation & fallbacks

When a dependency fails and the circuit opens, you're returning… what, exactly? The answer is a **fallback**, and the discipline of choosing good ones is **graceful degradation**: the system loses a feature, not its life. A degraded product that still does its core job beats a perfect product that's returning 500s.

The move is to rank features by criticality and decide, ahead of time, what each one degrades *to*:

- **Serve stale** — if the live source is down, return the last-known-good value from cache. A slightly stale price or feed is almost always better than an error.
- **Return a sensible default** — recommendations service down? Show a generic "popular items" list instead of a broken panel. Personalization is a nice-to-have; a working page is not.
- **Hide the non-essential** — drop the review count, the "others also bought" carousel, the live badge. The user may not even notice; they can still complete the core task.
- **Read-only / safe mode** — if writes are unsafe (primary DB failing over), keep serving reads and reject writes cleanly with a clear message, rather than accepting writes you might lose.
- **Load shedding** — under extreme overload, deliberately reject a fraction of low-priority requests *early* (return 503 fast) to keep the system responsive for the rest. Shed the cheapest work to protect the most valuable.

The design test to run on every component you draw: *"if this returns an error or never responds, what does the user see?"* If the answer is "a broken page" or "an infinite spinner," you're missing a fallback. If it's "the same page, minus the recommendations strip," you've designed for degradation. Feature flags make this operational — you can toggle an expensive feature off during an incident and restore it after.

> **Interview tip:** Great degradation answers are specific. Not "it degrades gracefully," but *"if the pricing service times out, I serve the cached price with a 'prices may be delayed' note, and disable checkout for that item so we never sell at a stale price."* Naming the exact fallback per dependency is what separates senior from junior.

## 06 Disaster recovery: RTO & RPO

Everything so far handles a component failing. **Disaster recovery (DR)** plans for the big one: an entire region goes dark, a botched deploy corrupts the database, ransomware, a fat-fingered `DROP TABLE`. DR is measured with two numbers you must be able to define instantly — interviewers love this pair:

| Metric | Question it answers | Reduced by |
| --- | --- | --- |
| RTO — Recovery Time Objective | How long can we be *down* before recovery? (max tolerable downtime) | Warm/hot standby, automation, rehearsed runbooks |
| RPO — Recovery Point Objective | How much *data* can we lose? (max acceptable data-loss window) | More frequent backups, synchronous replication |

The clean way to hold them: **RTO looks forward in time** (how long until we're back up), **RPO looks backward** (how far back does our last good copy sit). An RPO of 5 minutes means a disaster may cost you up to the last 5 minutes of writes. An RTO of 1 hour means you must be serving again within an hour. Both are business decisions — a bank targets near-zero on both and pays dearly; a hobby blog is fine losing a day.

### Backups vs replication (not the same thing)

A common trap: "we have replicas, so we're covered." Replicas protect against *hardware* failure but faithfully copy a bad `DELETE` to every node in milliseconds — they don't protect against corruption or human error. **Backups** (point-in-time snapshots you can restore to a past moment) are your defense there. You need both, and you must actually *test restores* — an untested backup is a rumor.

### The DR strategy ladder

Cost rises steeply as you buy down RTO and RPO. Pick the rung the business will pay for:

| Strategy | RTO | RPO | Cost | How it works |
| --- | --- | --- | --- | --- |
| Backup & restore | hours–days | hours | $ | Periodic backups to another region; rebuild on disaster |
| Pilot light | 10s of min | minutes | $$ | Core data replicated & always on; spin up app tier on demand |
| Warm standby | minutes | seconds | $$$ | Scaled-down full copy always running; scale up & cut over |
| Hot / active-active | ~seconds | ~zero | $$$$ | Full live capacity in 2+ regions; traffic already split |

Note the RPO lever is *replication mode*: **synchronous** replication (the write isn't acknowledged until a second region has it) gives near-zero RPO but adds latency to every write; **asynchronous** is fast but risks losing the last few seconds on a sudden regional loss. That trade — write latency vs data-loss window — is the heart of any DR discussion.

## 07 Chaos engineering

Here's the uncomfortable truth about every resilience mechanism above: **the failover you never trigger is a failover you don't actually have.** Standbys rot, health checks get misconfigured, a "redundant" pair quietly shares one power supply. You only find out during a real outage — the worst possible time. **Chaos engineering** flips that: you inject controlled failures *on purpose*, in a controlled way, to verify the system behaves as designed *before* reality tests it for you.

Netflix pioneered it with **Chaos Monkey**, a tool that randomly kills production instances during business hours. The point was cultural as much as technical: if a random server can vanish at any moment, engineers *have* to build services that survive it. The broader "Simian Army" extended this to killing whole availability zones and injecting latency.

The practice is a disciplined experiment, not reckless breakage:

1. **Define steady state** — a measurable "healthy" signal (e.g. successful-checkout rate, p99 latency). This is your hypothesis baseline.
2. **Hypothesize** — "if we kill one DB replica, steady state holds; failover completes under our RTO with no lost orders."
3. **Inject a real fault** — terminate an instance, add 300 ms of network latency, blackhole a dependency, fill a disk.
4. **Minimize blast radius** — start in staging, then a tiny slice of production traffic; have an abort switch. You're probing weakness, not causing an incident.
5. **Learn & fix** — if steady state broke, you found a real gap in a controlled window. Fix it, then automate the experiment so it can never regress.

In practice teams run scheduled **GameDays** — rehearsed disaster drills where they deliberately fail a component and watch the on-call runbook play out. It's the only honest way to know your RTO/RPO numbers are real rather than aspirational.

> **Key idea:** Resilience isn't proven by a diagram; it's proven by *breaking the system on your own terms and watching it recover.* "We do chaos engineering / GameDays to validate failover meets our RTO" is a line that instantly signals operational maturity in a design review.

## 08 Worked example: Online Auction Platform

Let's run the 5-step framework on *"Design an online auction platform like eBay auctions"* — a problem that is **all** about fault tolerance, because there's money on the line and a hard deadline (the auction close) that can't be missed even if a server dies mid-bid.

### ① Scope

- **Functional:** create an auction (item, start price, end time); place a bid; see the current highest bid live; auto-close at end time and declare a winner; settle payment. (Stretch: proxy/max bids, snipe protection, watchlists.)
- **Non-functional (the resilience core):** *high availability* for bidding — especially the frenzied final seconds; *correctness under failure* — never lose a bid, never accept an out-of-order lower bid as the winner, never double-charge; *durability* — an accepted bid is money-adjacent and must survive a node loss (RPO ≈ 0); *graceful degradation* — if search or recommendations die, bidding still works; *low latency* on bid placement.
- **Out of scope (say it):** shipping, disputes, fraud ML — keep the core bidding loop tight.

### ② Estimate

```
10M active auctions, 100M users
50M bids/day        ≈ 50M ÷ 100k  = ~600 bids/s average
BUT bids cluster at close: a hot auction's last 10s
   can spike to 10k–50k bids/s on ONE item        ← the real problem
reads (watchers)   >> writes, very spiky
bid storage: 50M/day × 365 × ~200 B ≈ ~4 TB/yr   durable, must never drop a bid
```

The estimate surfaces the whole design tension: average load is trivial, but a **single hot auction** becomes a write-contention hotspot at the exact moment correctness matters most. That's where we'll spend our fault-tolerance budget.

### ③ Interface

```
POST /auctions                 → create; body {item, startPrice, endTime}
POST /auctions/{id}/bids       → body {amount, userId, idempotencyKey}
       201 {accepted:true, currentHigh}   |   409 {outbid, currentHigh}
GET  /auctions/{id}            → current state (cacheable)
WS   /auctions/{id}/stream     → live bid push to watchers
```

The `idempotencyKey` is deliberate — it lets the client safely retry a bid after a timeout without risking a duplicate, which is exactly what we need when a node fails over mid-request.

### ④ High-level design (happy path)

```
client ─▶ LB ─▶ Bid Service ─▶ Auction DB (strongly consistent per auction)
                    │                │
                    │                └─▶ replicas (sync, cross-AZ) for durable bids
                    ├─▶ Cache (current high, hot reads)
                    ├─▶ Pub/Sub ─▶ WebSocket fanout to watchers
                    └─▶ Close Queue ─▶ Settlement worker ─▶ Payment / Notify
```

The heart is bid ordering: for a given auction, bids must be **serialized** so "highest wins" is unambiguous. Use a conditional/optimistic write — `accept bid only if amount > current_high` — so two simultaneous bids can't both win; the loser gets a clean `409 outbid`. This is a per-auction strong-consistency requirement (CP for the bid write), even though watcher reads can be eventually consistent (AP).

### ⑤ Deep-dive & scale — every pattern from this module, applied

- **High availability & failover (§02):** Bid Service is stateless and runs active-active behind the LB across ≥2 AZs. The Auction DB uses a primary with *synchronous* cross-AZ replicas so an accepted bid is durable before we ACK (RPO ≈ 0), and leader election promotes a replica on primary loss — no split-brain, no lost bids.
- **Bulkheads (§03):** the bid path gets its own thread/connection pools, fully isolated from search, recommendations, and analytics. A slow recommendation query can never starve bid processing. Hot auctions can even be sharded onto dedicated partitions so one viral item's storm doesn't touch its neighbors.
- **Timeouts, retries, circuit breakers (§04):** settlement (Payment) is *off the bid path* — the bid write commits, then a message goes to the Close Queue. A circuit breaker guards Payment so an outage there can't cascade into bid failures; failed settlements retry with backoff from the queue. Bid writes fail fast (short timeout) and the client retries with its idempotency key.
- **Graceful degradation (§05):** if Pub/Sub is down, watchers fall back to polling `GET /auctions/{id}`. If recommendations/search die, hide those panels — bidding is untouched. If the DB primary is mid-failover, go **read-only**: serve the current high from cache and reject new bids with "reopening shortly" rather than accept bids we can't order correctly.
- **Auction close correctness:** the close is a durable, *idempotent* job driven off the queue. If the settlement worker crashes mid-close, another picks the message up and completes exactly once (idempotency key guards against double-charge). **Snipe protection** — extend the auction by N seconds on any last-second bid — doubles as load relief, smoothing the final spike.
- **DR: RTO & RPO (§06):** bids are money-critical → sync replication for RPO ≈ 0, automated failover for an RTO in minutes; an async cross-*region* replica covers a full-region disaster. Point-in-time backups guard against a bad deploy corrupting auction state.
- **Chaos engineering (§07):** run a GameDay that kills the DB primary *during* a simulated high-traffic close and assert zero lost bids and failover under RTO; inject Payment latency to prove the circuit breaker + queue keep bidding alive.

Notice the shape of a senior answer: the happy path is small, and 80% of the discussion is *"here's what breaks first, and here's the specific mechanism that contains it."* That's this entire module, delivered on one problem.

## 09 Your reps this week

Resilience is muscle memory — you build it by breaking things, not by reading about them. Do these in order:

1. **Break something on purpose.** Open the [🔗 Cascade Failure Simulator](../tools/cascade-failure.html), trigger a cascade by overloading one downstream, then add timeouts → bulkheads → a circuit breaker one at a time and watch the blast radius shrink. Narrate *why* each control helps.
2. **Whiteboard the Auction Platform yourself.** In [Excalidraw](https://excalidraw.com) (free), run all five steps out loud, timed to ~35 minutes, *before* re-reading Section 08 — and force yourself to answer "what breaks first?" for every box you draw.
3. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design under pressure:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview focused on fault tolerance and resilience. Give me the prompt: "Design an online auction platform like eBay auctions." Then act as the interviewer — let me drive, ask clarifying and probing questions, and keep pushing on failure modes: "what happens when the DB primary dies mid-bid?", "how do you stop a slow payment service from taking down bidding?", "what's your RTO and RPO, and how do you know they're real?", "how do you guarantee exactly-once settlement across a failover?". Do NOT give me the answer or lead me. After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements & NFRs, capacity estimation, API & data model, high-level design, resilience deep-dives (redundancy, bulkheads, timeouts/circuit breakers, degradation, DR/RTO/RPO, chaos), and communication — with specific feedback and what a strong candidate would have added.
```

1. **Explain it back.** Teach RTO vs RPO, and the timeouts→bulkhead→circuit-breaker trio, to a rubber duck without notes. Any gap you stumble on is a gap you still have.
2. **Flashcards** (write these 5, review at week's end): *RTO vs RPO — one line each? · Why does redundancy in parallel raise availability while adding dependencies in series lowers it? · Fail-fast vs wait-and-retry — when each, and what turns retries into a storm? · The three circuit-breaker states and the transition that finally closes it? · Bulkhead vs circuit breaker — what does each one actually isolate or stop?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the fault-tolerance and bulkhead ones *before* your reps; save the chaos-engineering talk for when you want the operational picture.

- **[8 Most Important Tips for Designing Fault-Tolerant Systems](https://www.youtube.com/watch?v=3Lis4w4_bBc)** — ByteByteGo · ~5 min · high availability — Fast, visual tour of redundancy, failover, and isolation. Watch first.
- **[Bulkhead Pattern | Design Resilient and Fault Tolerant Distributed Systems | System Design Interview](https://www.youtube.com/watch?v=sm6IOzU7pqE)** — SoftwareDude · ~12 min · bulkhead — Walks the ship analogy into real pool isolation, framed for interviews.
- **[Frontend and Backends Timeouts](https://www.youtube.com/watch?v=2GAQVXGT_Zw)** — Hussein Nasser · ~25 min · timeouts — Why every network call needs a timeout, and where they hide. Deep and practical.
- **[The Circuit Breaker Pattern | Resilient Microservices](https://www.youtube.com/watch?v=5_Bt_OEg0no)** — Nick Chapsas · ~7 min · circuit breaker — The closed/open/half-open state machine shown in working code.
- **[Stop Cascading Failures - Circuit Breaker & Bulkhead](https://www.youtube.com/watch?v=4FxrxLYjvRg)** — LearnThatStack · ~5 min · cascading failures — How the trio combines to contain a cascade — ties §03 and §04 together.
- **[IBM's Principles of Chaos Engineering - Haytham Elkhoja](https://www.youtube.com/watch?v=Lzv0UNzv4Po)** — Gremlin · ~20 min · chaos engineering — How a real org adopts chaos experiments and GameDays. Watch for the operational picture.

**Read (optional depth):** DDIA Chapter 8 (*The Trouble with Distributed Systems* — faults, unreliable networks, and clocks) plus the reliability half of Chapter 1. And the [System Design Primer](https://github.com/donnemartin/system-design-primer) sections on availability, failover, and replication (free).

---
*Source: `modules/13-fault-tolerance-resilience.html` — System Design Mastery. Interactive version has the live simulators.*
