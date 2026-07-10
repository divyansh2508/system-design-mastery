# Advanced Microservices

*Phase 4 · Production-Grade·Module 12·Weeks 6-8 · ~13 hrs*

Splitting a monolith is the easy part. This module is the **hard-won operational playbook** — circuit breakers, smart retries, safe migrations, sidecars, service mesh, and progressive delivery — that keeps a fleet of services from turning one failure into an outage.

## 01 Why services need a resilience toolkit

In a monolith, a slow function is a slow function. In microservices, a slow **dependency** is a landmine: every caller waiting on it holds a thread, threads run out, and the failure walks upstream until the whole product is down. That chain reaction is a **cascading failure**, and it is the defining hazard of a distributed system.

The root cause is almost always the same. Service A calls B synchronously. B gets slow (a GC pause, a hot shard, a bad deploy). A's requests to B stop returning, so A's own request threads pile up waiting. Now A is slow too — and everything calling A starts to stall. Within seconds a single degraded leaf node has saturated the entire call graph. The scary part: *A is healthy.* It has plenty of CPU. It is simply **blocked on someone else**.

The patterns in this module are the standard, battle-tested defenses against exactly this. Each one answers a specific question:

- **Circuit breaker** — "stop calling a dependency that's clearly down, so I don't waste my own threads waiting."
- **Retry with backoff & jitter** — "retry a *transient* blip without turning it into a self-inflicted stampede."
- **Strangler fig** — "migrate off the old system incrementally, with a rollback at every step."
- **Sidecar & service mesh** — "push resilience, security, and observability out of every service and into shared infrastructure."
- **Canary & feature flags** — "ship change to 1% first, watch the graphs, and undo it in seconds if it's bad."

> **Key idea:** Resilience is not one big feature — it's a **layered set of defaults** applied at every network hop. Interviewers reward candidates who reach for these by name and, crucially, name the *failure mode each one prevents*.

## 02 Circuit breaker pattern

Borrowed straight from electrical engineering: when current spikes, the breaker **trips** and cuts the circuit so the wiring doesn't melt. In software, the circuit breaker wraps every call to a remote dependency, watches the failure rate, and — once failures cross a threshold — **fails fast** instead of letting callers pile up on a dead service. The dependency gets breathing room to recover; the caller gets an instant error (or a fallback) instead of a hung thread.

### The three states

A circuit breaker is a small state machine sitting between your code and the network:

| State | What happens | Transitions when… |
| --- | --- | --- |
| Closed | Calls pass through normally; failures are counted in a rolling window. | Failure rate crosses the threshold → **Open** |
| Open | Calls short-circuit instantly — no network hop, return an error or fallback. | A cooldown timer expires → **Half-Open** |
| Half-Open | A few trial requests are let through to probe if the dependency recovered. | Trials succeed → **Closed**; any fail → back to **Open** |

```
        failures > threshold
   ┌───────────────────────────────▶  ( OPEN )
   │                                     │  fail fast, no calls
( CLOSED )                               │  cooldown timer (e.g. 30s)
   ▲  normal traffic                     ▼
   │                              ( HALF-OPEN )
   │  trial calls succeed          let N trial calls through
   └───────────────────────────────┘
        any trial fails ─▶ back to OPEN
```

The tuning knobs you should be able to name: the **error threshold** (e.g. "trip if >50% of the last 20 calls failed"), the **volume threshold** (don't trip on 1 failure out of 2 — need a minimum sample), the **cooldown / sleep window** (how long to stay open before probing), and the **half-open trial count**. Slow calls should count as failures too — a dependency that answers in 10 s is as toxic as one that returns 500s.

> **Interview tip:** Always pair a circuit breaker with a **fallback** and a **timeout**. "When the breaker is open, I serve stale cache / a default / a queued write" shows you thought about the user, not just the plumbing. And a breaker is useless without an aggressive timeout — otherwise the breaker never sees the failures it's meant to catch.

In practice you rarely hand-roll this. Netflix's **Hystrix** popularized it (now in maintenance mode); today it's **Resilience4j** in the JVM world, Polly in .NET, or — as we'll see below — pushed entirely into the **service mesh** so no application code changes at all. The pattern also naturally pairs with the **bulkhead** (isolate each dependency in its own thread pool so one slow dependency can't drain the shared pool).

## 03 Retry, backoff & jitter

Many failures are **transient**: a dropped packet, a leader election, a millisecond of overload. Retrying is the obvious fix — and the obvious trap. A naive retry loop is how a small hiccup becomes a full outage, because every failing client retries *at the same moment* and slams the recovering service with a synchronized wall of traffic. That's the **thundering herd** (a.k.a. retry storm), and it's why retries need two disciplines: back off, and add randomness.

### Exponential backoff

Instead of retrying at a fixed interval, wait longer after each failure — the delay grows exponentially, capped at a ceiling:

```
base = 100ms,  cap = 20s,  factor = 2

attempt 1 → wait base·2^0 = 100ms
attempt 2 → wait base·2^1 = 200ms
attempt 3 → wait base·2^2 = 400ms
attempt 4 → wait base·2^3 = 800ms
   ...        min(cap, base · 2^attempt)
```

Backoff alone gives the dependency room to recover between waves. But if 10,000 clients all failed at `t=0`, they *all* retry at `t=100ms`, then all at `t=300ms` — the herd is still synchronized, just spaced out. That's what jitter fixes.

### Jitter — the counter-intuitive fix

**Jitter** adds randomness to each delay so retries de-correlate and smear into a smooth, near-constant arrival rate instead of spikes. AWS's canonical write-up compares the strategies:

| Strategy | Sleep formula | Verdict |
| --- | --- | --- |
| No jitter | `min(cap, base·2^n)` | Herd stays synchronized — worst case |
| Full jitter | `random(0, min(cap, base·2^n))` | Best spread; the usual default |
| Equal jitter | `half + random(0, half)` | Keeps some floor between retries |
| Decorrelated | `min(cap, random(base, prev·3))` | Great throughput, self-adjusting |

The result is genuinely surprising the first time you see it: *adding randomness reduces total load and completes the work faster*, because the server never sees a coordinated spike. **Full jitter** is the safe default to reach for.

> **Do not retry blindly:** Only retry **idempotent** operations (or make them idempotent with a request/idempotency key) — retrying a non-idempotent `POST /charge` can double-charge a customer. Set a **retry budget** (cap total retries to, say, 10% of traffic), stop retrying on non-transient errors (a `400` will never succeed), and **combine retries with a circuit breaker** so you stop retrying a dependency that's genuinely down.

## 04 Strangler fig migration

The name comes from the strangler fig vine, which grows around a host tree, gradually envelops it, and eventually stands on its own after the tree inside has died. Martin Fowler borrowed it for the safest way to retire a legacy monolith: **don't rewrite it, grow a new system around it and route traffic over piece by piece.**

You put a routing layer — an API gateway, proxy, or facade — in front of the old system. Every request flows through it. When a slice of functionality has been rebuilt as a new service, you flip that route to point at the new service; everything else still hits the legacy code. Repeat, endpoint by endpoint, until nothing routes to the monolith and you delete it.

```
            ┌──────────────────────────┐
 clients ──▶ │  Facade / API Gateway    │
            └───────┬───────────┬───────┘
      /orders/*  ───┘           └─── everything else
          │                            │
          ▼                            ▼
   ┌───────────────┐            ┌──────────────┐
   │ new Orders svc│            │  Legacy       │
   │  (migrated)   │            │  Monolith     │
   └───────────────┘            └──────────────┘

  Each migrated route is flipped one at a time.
  Anything not yet built still falls through to the monolith.
```

Why it beats the tempting "big-bang rewrite": every step is small, independently shippable, and **instantly reversible** — if the new Orders service misbehaves, flip the route back to the monolith. You deliver value continuously instead of disappearing for 18 months into a rewrite that never quite reaches parity. The costs to acknowledge: you run **two systems in parallel** for a while, and you often need a **data-sync / dual-write strategy** so both sides stay consistent during the overlap.

> **Interview tip:** When asked "how would you migrate this?", say *strangler fig* and describe the facade + route-by-route cutover with rollback. It signals you've done real migrations and understand that **the risk is in the transition, not the destination.**

## 05 The sidecar pattern

Every service needs the same cross-cutting plumbing: TLS, retries, timeouts, metrics, tracing, service discovery, rate limiting. Building that into each service means re-implementing it in every language your fleet speaks and redeploying every service to change a timeout. The **sidecar pattern** extracts all of it into a helper process that runs *alongside* each service instance — same host/pod, sharing its network namespace — like a motorcycle's sidecar attached to the bike.

```
          ┌─────────── Pod / Host ───────────┐
 traffic  │   ┌──────────┐      ┌──────────┐  │
 ───────────▶ │ Sidecar  │ ───▶ │   App    │  │
          │   │  proxy   │ ◀─── │ (your    │  │
 ───────────▶ │ (Envoy)  │      │  code)   │  │
          │   └────┬─────┘      └──────────┘  │
          └────────┼─────────────────────────┘
                   ▼
      mTLS · retries · timeouts · metrics · tracing
      handled OUTSIDE your application code
```

The application talks to `localhost` and stays blissfully simple; the sidecar intercepts all inbound and outbound traffic and applies the policy. Because it's a separate process, it's **language-agnostic** (a Go service and a Python service share the exact same sidecar), independently upgradable (patch the proxy fleet without touching app code), and isolates the concern (a crash in the sidecar doesn't take your business logic's memory with it).

The trade-offs are real: an extra network hop per call (small added latency), more memory/CPU per instance (one proxy per service instance adds up across thousands of pods), and operational complexity. The most famous sidecar is **Envoy**, and when you deploy a sidecar to *every* service and give them a shared control plane, you've built a **service mesh** — which is exactly the next section.

## 06 Service mesh: Istio & Linkerd

A **service mesh** is a dedicated infrastructure layer that manages all service-to-service communication, implemented as a fleet of sidecar proxies (the **data plane**) coordinated by a central **control plane**. Instead of each team coding retries, mTLS, and traffic-splitting, the platform team declares it once as config and the mesh enforces it uniformly across every service — in any language, with zero app-code changes.

```
 CONTROL PLANE  (config, certs, policy, telemetry)
        │  pushes config to every proxy
        ▼
 ┌───────────┐   ┌───────────┐   ┌───────────┐
 │ svc A     │   │ svc B     │   │ svc C     │
 │ [sidecar] │◀─▶│ [sidecar] │◀─▶│ [sidecar] │   ◀── DATA PLANE
 └───────────┘   └───────────┘   └───────────┘
   all traffic flows proxy-to-proxy: mTLS, retries,
   canary routing, and metrics happen here for free
```

What the mesh gives you, uniformly: **traffic management** (weighted routing for canaries, mirroring, fault injection), **security** (automatic mutual-TLS between every service, plus authz policy), and **observability** (golden-signal metrics, distributed traces, and a service dependency map — for free, because the proxy sees every request).

### Istio vs Linkerd

The two dominant open-source meshes make a classic trade-off — **power vs simplicity**:

| Dimension | Istio | Linkerd |
| --- | --- | --- |
| Data-plane proxy | Envoy (C++), very feature-rich | linkerd2-proxy (Rust), purpose-built & tiny |
| Philosophy | Maximum features & flexibility | Minimal, fast, "just works" |
| Resource footprint | Heavier per-proxy | Very light — lower latency & memory |
| Complexity | Steep learning curve, many CRDs | Simple to install and operate |
| Best when | You need advanced routing, multi-cluster, extensibility | You want mTLS + metrics + reliability with minimal ops |

Rough rule of thumb: reach for **Linkerd** when you want the 80% (mutual TLS, retries, golden metrics) with the least operational weight, and **Istio** when you genuinely need its advanced traffic-shaping and extensibility and have a platform team to run it. And the honest senior take: a mesh is **not free** — it adds a proxy hop, real operational surface, and a new failure domain. Don't reach for one until you have enough services that duplicating this logic per-service is the bigger pain.

> **Interview tip:** If asked "where does the circuit breaker / retry / mTLS live?", the senior answer is: *"I'd push it into the service mesh so it's uniform and language-agnostic, rather than re-implementing it in every service."* Then name the cost — an extra hop and operational complexity — so it doesn't sound like a silver bullet.

## 07 Canary releases & feature flags

The last resilience layer is about **how you ship change**. A big-bang deploy to 100% of users is a bet with no hedge; if it's bad, everyone is affected at once. **Progressive delivery** replaces that bet with a controlled, observable, reversible rollout. The two core tools are canary releases and feature flags.

### Canary releases

Named after the "canary in a coal mine": deploy the new version to a small slice of production traffic first, watch its metrics against the old version, and only widen the rollout if the canary stays healthy.

```
v2 rollout:  1%  ─▶  5%  ─▶  25%  ─▶  50%  ─▶  100%
             │        │        │
             └─ watch error rate, p99 latency, business KPIs ─┘
                any regression → automatically roll back to v1
```

The mesh from the last section makes this trivial — weighted routing sends 1% of requests to `v2`, and its per-proxy metrics tell you instantly whether the canary is worse. Automated canary analysis tools (Argo Rollouts, Flagger) promote or roll back on metric thresholds with no human in the loop.

### Feature flags

Canaries operate at the **deploy** level; feature flags operate at the **code path** level. A flag is a runtime switch (`if flags.enabled("new_checkout", user)`) that lets you turn a feature on or off — for everyone, or a cohort, or a single user — *without deploying*. This decouples **deploy** (ship the code, flag off) from **release** (flip the flag on), which is what makes trunk-based development and instant kill-switches possible.

| Technique | Granularity | Rollback speed | Best for |
| --- | --- | --- | --- |
| Canary release | Traffic % to a new build | Minutes (shift traffic) | Validating a whole new version safely |
| Feature flag | Per-feature, per-user cohort | Seconds (flip a switch) | Decoupling release from deploy; A/B tests; kill-switch |
| Blue-green | Whole environment swap | Instant (repoint LB) | All-or-nothing cutover with fast fallback |

They compose beautifully: deploy `v2` as a canary to 5% with the risky feature behind a flag that's off, confirm the build itself is stable, then flip the flag on for 1% of users and widen from there. Two independent safety valves on the same change.

## 08 Case study: Distributed Rate Limiter

Time to put it together. *"Design a distributed rate limiter"* is a favorite Forward-Deployed / senior question because it hides real depth — algorithms, distributed coordination, and the resilience patterns above. We'll run the same 5-step framework from Module 1.

1. **Scope** *(~5 min)* — Cap how often a client may call an API (e.g. 100 req/min per API key). Return HTTP 429 + a Retry-After header when over. Must be low-latency (adds <1ms), fault-tolerant (a limiter outage must not take down the API), and reasonably accurate at scale. Out of scope: billing, auth.
2. **Estimate** *(~5 min)* — 1M req/s at the gateway → the limiter is on the hot path of *every* request. Each check must be O(1) and sub-millisecond. State per key is tiny (a counter + timestamp, ~50 B); even 100M active keys ≈ 5 GB — fits in memory in Redis.
3. **Interface** *(~5 min)* — Internal call the gateway makes: `allow(key, cost=1) → {allowed: bool, remaining, retryAfter}`. Externally it's a middleware; clients just see `429 Too Many Requests` with `X-RateLimit-*` headers.
4. **High-level design** *(~10 min)* — Rate-limit middleware at the API gateway checks a shared counter store (Redis) before forwarding. Over-limit → 429 immediately; under-limit → decrement and forward.
5. **Deep-dive & scale** *(~15 min)* — Pick the algorithm (token bucket), make it correct under concurrency (atomic Lua in Redis), then scale and harden it (sharding, local buckets, fail-open).

### ① & ② Scope + estimate, concretely

```
Limit:   100 requests / minute / API key
Traffic: 1,000,000 req/s across the fleet   → limiter is on EVERY request
Budget:  < 1 ms added latency, O(1) per check
State:   ~50 B/key × 100M keys ≈ 5 GB        → in-memory (Redis), not a DB
```

That estimate already forces two decisions: the store must be **in-memory** (a disk DB can't do sub-ms at 1M QPS), and the check must be **atomic** (concurrent requests for the same key must not race).

### ⑤a Choosing the algorithm

Four classics, each a trade-off between accuracy, memory, and burst behavior:

| Algorithm | How it works | Trade-off |
| --- | --- | --- |
| Fixed window | Count per calendar minute; reset at the boundary | Simplest, but allows 2× burst at the window edge |
| Sliding window log | Store timestamp of every request; count those in the last 60s | Exact, but memory grows with request volume |
| Sliding window counter | Weighted blend of current + previous window | Great accuracy/memory balance; the common choice |
| Token bucket | Tokens refill at a steady rate; each request spends one | O(1) memory, allows controlled bursts — the default |

**Token bucket** is the go-to: a bucket holds up to *N* tokens and refills at *R* tokens/sec. A request takes one token if any remain, else it's rejected. It naturally permits a short burst (up to the bucket size) while enforcing a steady long-run rate, and its entire state is just two numbers — `(tokens, last_refill_ts)`. Refill is computed lazily on each request, so there's no background timer:

```
# lazy token-bucket check, evaluated per request
now       = current_time()
elapsed   = now - last_refill_ts
tokens    = min(capacity, tokens + elapsed * refill_rate)  # refill
last_refill_ts = now
if tokens >= 1:
    tokens -= 1
    return ALLOW          # remaining = tokens
else:
    return DENY (429, Retry-After = (1 - tokens) / refill_rate)
```

### ⑤b Making it correct & distributed

At 1M QPS across many gateway nodes, two requests for the same key can hit different nodes simultaneously. A read-modify-write on a shared counter **races** — both read 1 token left, both allow, and you've leaked over the limit. Fixes, in order of preference:

- **Centralized Redis + atomic Lua script.** The whole read-refill-decrement runs as one atomic operation inside Redis, so there's no race. This is the standard production answer. Redis's single-threaded execution makes the script serializable per key.
- **Shard by key** so each key's counter lives on exactly one Redis node — spreads the 1M QPS and keeps per-key operations atomic on their owner.
- **Local bucket + async sync** for extreme scale: each node enforces a local slice of the budget in-memory (zero network hop) and periodically reconciles with the central store. Trades a little accuracy for huge throughput and resilience.

> **Play with it → your tool:** Open the [🚥 Rate Limiter](../tools/rate-limiter.html), pick the **Token Bucket** mode, and hammer it with bursts — watch tokens drain, refill at rate *R*, and requests flip to 429 the instant the bucket empties. Switch to fixed vs sliding window and *see* the boundary-burst problem for yourself. Building that intuition beats memorizing the formulas.

### ⑤c Resilience — apply this module

This is where the whole module pays off. The rate limiter sits in front of everything, so **it must never be the thing that takes you down:**

- **Fail open, not closed.** If Redis is unreachable, the limiter should *allow* traffic (or fall back to a local best-effort limit) rather than 429 the entire internet. Losing rate limiting for a minute beats a full outage.
- **Circuit breaker + timeout** on the call to Redis — if the store is slow, trip the breaker and fail open instead of adding latency to every request.
- **Deploy the check as a sidecar / in the service mesh** so every service gets identical limiting with no per-service code, and the mesh's own metrics show you exactly who's getting throttled.
- **Canary + feature flag** any change to the limits — roll a new threshold to 1% and watch 429 rates before applying it fleet-wide, with a flag to instantly disable a misconfigured rule.

Notice the shape of a strong answer: pick the obvious algorithm quickly, then spend your time on **concurrency correctness** and **what happens when the limiter itself fails**. That second half is where seniority shows.

## 09 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard the Distributed Rate Limiter yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end with the 5-step framework, out loud, timed to ~35 minutes — *before* re-reading Section 08. Force yourself to reach the concurrency + fail-open discussion; that's the part that's graded.
2. **Draw the three circuit-breaker states from memory** and label every transition and tuning knob (threshold, cooldown, half-open trials). If you can't, re-watch the breaker video below.
3. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design a distributed rate limiter." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on the areas candidates skip: which algorithm and why (token bucket vs sliding window), how you keep the counter correct under concurrency across many nodes, and — most important — what happens when the rate-limiter's own datastore (Redis) goes down. Keep asking "why?" and never hand me the answer. After ~35 minutes (or when I say "done"), grade me 1-5 on each of: requirements gathering, capacity estimation, API design, high-level design, deep-dives & trade-offs (algorithm choice, concurrency, fail-open, circuit breaker), and communication — with specific feedback and what a strong candidate would have added.
```

1. **Explain it back.** Teach a rubber duck (or me) why exponential backoff *needs* jitter, and why a rate limiter should fail open. Gaps you can't explain are gaps you don't have yet.
2. **Flashcards** (make these 5, review at week's end): *What are the three circuit-breaker states and what triggers each transition? · Why does exponential backoff need jitter? · Strangler fig — what's the one-line pitch vs a big-bang rewrite? · Istio vs Linkerd — the core trade-off in one sentence? · A distributed rate limiter — fail open or fail closed, and why?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the pattern explainers *before* your reps; save the Hello Interview rate-limiter walkthrough for *after* your own attempt.

- **[Circuit Breaker Pattern in Distributed Systems | System Design Interview | Implement Circuit Breaker](https://www.youtube.com/watch?v=SdB-Mdh6Sls)** — SoftwareDude · ~15 min · circuit breaker — Closed / open / half-open walked through in a system-design framing. Watch first.
- **[Rate Limiter System Design: Token Bucket, Leaky Bucket, Scaling](https://www.youtube.com/watch?v=YXkOdWBwqaA)** — ByteByteGo · ~12 min · rate limiting — The token bucket + leaky bucket algorithms and how to scale them. Core prep for the case study.
- **[Retry Storms Explained: How Exponential Backoff with Jitter Prevents System Meltdowns](https://www.youtube.com/watch?v=WjEmM1Jy79M)** — SystemDR - Scalable System Design · ~10 min · backoff & jitter — Why naive retries cause a thundering herd and how jitter smooths the spike.
- **[Istio & Service Mesh - simply explained in 15 mins](https://www.youtube.com/watch?v=16fgzklcF7Y)** — TechWorld with Nana · ~15 min · service mesh — Data plane vs control plane, sidecars, and what a mesh gives you — the clearest intro out there.
- **[Retries & Exponential Backoff - Deep Dive](https://www.youtube.com/watch?v=EW2Cc0r2mbc)** — glich.stream · ~15 min · resilience — A deeper cut on retry budgets, idempotency, and backoff math. Optional second take.
- **[Design a Distributed Rate Limiter w/ a Ex-Meta Staff Engineer: System Design Breakdown](https://www.youtube.com/watch?v=MIJFyUPG4Z4)** — Hello Interview · ~30 min · case study — A full staff-level walkthrough of the exact case study above. Watch AFTER your own attempt.

**Read (optional depth):** DDIA Chapter 8 (*The Trouble with Distributed Systems*) for why retries, timeouts, and partial failure are so hard — the theory under this whole module. For the canonical circuit-breaker and bulkhead write-ups, Michael Nygard's *Release It!* is the source text. And the [System Design Primer](https://github.com/donnemartin/system-design-primer) sections on rate limiting and resilience (free).

---
*Source: `modules/12-advanced-microservices.html` — System Design Mastery. Interactive version has the live simulators.*
