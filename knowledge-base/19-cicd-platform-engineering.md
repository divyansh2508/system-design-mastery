# CI/CD & Platform Engineering

*Phase 5 · Cloud & DevOps·Module 19·Weeks 9–10 · ~13 hrs*

Great architecture is worthless if you can't ship it safely a hundred times a day. This module is about the **delivery machine** — the pipelines, deployment strategies, feature flags, and internal platforms that turn a merged pull request into running production traffic without waking anyone up.

## 01 From CI/CD to platform engineering

Every system you've designed in this track has to be **built, tested, packaged, and rolled out** — over and over, by dozens of teams, without breaking the thing that's already live. That release path is a system too, and it's exactly what senior and Forward-Deployed interviews probe when they ask "…and how would you deploy that?"

**CI/CD** is the automation spine. **Continuous Integration (CI)** means every commit is automatically built and tested against the shared mainline, so integration bugs surface in minutes instead of at a painful end-of-sprint merge. **Continuous Delivery (CD)** means every green build is automatically packaged into a deployable, release-ready artifact — a human still clicks "go." **Continuous Deployment** removes even that click: green build → production, automatically. The distinction matters in interviews — say which one you mean.

**Platform engineering** is the discipline that grew up around all this. Instead of every team reinventing pipelines, dashboards, and on-call runbooks, a central team builds an **internal developer platform (IDP)** — a paved road so a product engineer can go from `git push` to a monitored production service without becoming a Kubernetes expert. The goal is a phrase you should be able to define: **reducing developer cognitive load** while raising the floor on reliability and security.

> **Key idea:** Design isn't done at the architecture diagram. A staff-level answer includes **how the thing ships and how you'd know it's healthy** — pipeline, rollout strategy, kill switch, and the metrics that tell you to roll back. That's the whole point of this module.

## 02 The CI/CD pipeline

A modern pipeline is a chain of automated stages triggered by a code event. The canonical cloud-native path — the one worth being able to draw — is **GitHub Actions → Docker → Kubernetes**: source control triggers a workflow, the workflow builds a container image, the image lands in a registry, and a deployment mechanism rolls it out to a cluster.

```
push / pull_request
   │
   ▼
[ CI ]  lint ─▶ unit tests ─▶ build ─▶ integration tests   (GitHub Actions runners)
   │
   ▼
[ package ]  docker build ─▶ push image to registry        (GHCR / ECR, tagged by git SHA)
   │
   ▼
[ CD ]  deploy to staging ─▶ smoke tests ─▶ deploy to prod  (kubectl / Argo CD / Helm)
   │
   ▼
[ observe ]  metrics + logs + traces ─▶ auto-rollback on SLO breach
```

Here's a minimal but realistic GitHub Actions workflow that does the build-and-push half. Notice the **immutable image tag** (the git SHA) — that's what makes a deploy reproducible and a rollback trivial: you just re-point at the previous SHA.

```
# .github/workflows/deploy.yml
name: build-and-deploy
on:
  push:
    branches: [ main ]
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        run: make test
      - name: Build image
        run: docker build -t ghcr.io/acme/api:${{ github.sha }} .
      - name: Push image
        run: docker push ghcr.io/acme/api:${{ github.sha }}
      - name: Deploy to Kubernetes
        run: kubectl set image deployment/api api=ghcr.io/acme/api:${{ github.sha }}
```

Two ideas do most of the work. **Immutable artifacts:** you build the image *once* and promote that exact bytes-for-bytes artifact through staging → production, so "works in staging" actually means something. **Declarative deploys:** tools like Argo CD watch a git repo of Kubernetes manifests and continuously reconcile the cluster to match — this is **GitOps**, where the desired state of production is a versioned, reviewable, revertible file.

> **Interview tip:** When asked "how do you roll back?", the strong answer isn't "redeploy the old code." It's *"the previous image is still in the registry and the previous manifest is still in git — I re-point the deployment at the last-known-good SHA, which is a config change, not a rebuild."* Immutability is what makes that instant.

## 03 Rolling, blue-green & canary

Once an image is built, *how* you swap old for new is a first-class design decision — because the naïve "stop all, start all" (a **big-bang** deploy) means downtime and a blast radius of 100%. The three strategies you must be able to compare are **rolling**, **blue-green**, and **canary**.

- **Rolling:** replace instances a few at a time — new pods come up, old pods drain — until the fleet is fully updated. This is the Kubernetes default. Zero downtime, no extra fleet cost, but old and new run *simultaneously* mid-roll (so versions must be compatible) and rollback means rolling *back*, which takes time.
- **Blue-green:** stand up a full second environment (green) running the new version alongside the live one (blue), test it, then flip the load balancer so 100% of traffic cuts over instantly. Rollback is an instant flip back. The cost: you're running **two full fleets** during the switch.
- **Canary:** release to a small slice first — 1%, then 5%, 25%, 100% — watching error rates and latency at each step, and abort automatically if a metric regresses. Lowest blast radius of all, but the most tooling to run (traffic splitting + automated metric analysis).

```
canary progression (traffic to the NEW version):

   1%  ──▶  5%  ──▶  25%  ──▶  50%  ──▶  100%
   │        │         │                       ▲
   └────────┴─────────┴── metrics bad? ──▶ auto-rollback to 0%
```

| Strategy | Blast radius | Rollback | Extra cost | Best when… |
| --- | --- | --- | --- | --- |
| Big-bang | 100% (with downtime) | Redeploy old | None | Dev / non-critical only |
| Rolling | Grows as roll proceeds | Roll back (slow-ish) | None | Default; compatible versions |
| Blue-green | 100% at cutover, but pre-tested | Instant traffic flip | 2× fleet briefly | Need instant rollback, hard cutover |
| Canary | Smallest (1–5% first) | Shift traffic back to 0% | Traffic-split + analysis tooling | Risky change, want real-user signal |

Two subtleties that separate senior answers. First, **schema and API compatibility:** rolling and canary run both versions at once, so a database migration must be *backward-compatible* — you use the **expand/contract** pattern (add the new column, deploy code that writes both, backfill, then drop the old column in a later release). Second, **stateful services:** blue-green is clean for stateless API tiers but painful when the two colors must share a database or in-flight sessions — that's when canary or careful rolling wins.

> **Connects to → Module 2:** Every one of these strategies is ultimately the **load balancer** deciding which pool gets a request. Open the [🚦 Load Balancer Playground](../tools/load-balancer-simulator.html) and picture a canary as "route 5% of the weighted pool to the new backend" — the exact knob you'll tune.

## 04 Feature flags & progressive delivery

Deployment strategies control *which binary serves traffic*. **Feature flags** (a.k.a. feature toggles) decouple that from *which features are active* — a runtime `if` that you can flip without shipping new code. This is the key insight of **progressive delivery**: *deploy* is now separate from *release*. You can ship dark code to production, then turn it on for 1% of users next Tuesday.

```
# deploy != release
if (flags.isEnabled("new_matching_algo", user)) {
    return newMatcher.match(request);   // dark-launched, off by default
} else {
    return legacyMatcher.match(request);
}
```

Flags come in a few flavors, and naming them signals fluency: **release toggles** (hide unfinished work behind trunk-based development), **experiment toggles** (A/B tests — split users and measure), **ops toggles / kill switches** (instantly disable an expensive or misbehaving feature during an incident), and **permission toggles** (gate features to specific plans or beta cohorts). A canary and a percentage-based flag rollout are cousins — the flag just does it at the feature level instead of the binary level.

| Tool | What it is | Best fit |
| --- | --- | --- |
| LaunchDarkly | Managed SaaS flag platform; streaming updates via CDN, targeting rules, experiments, audit log | Teams wanting rich targeting & fast propagation out of the box |
| AWS AppConfig | Config + flags in the AWS ecosystem, with validators and monitored, gradual config rollouts + auto-rollback on CloudWatch alarms | AWS-native shops keeping config in-cloud |
| OpenFeature + self-host | Vendor-neutral flag API standard (e.g. with Flagsmith/Unleash backends) | Avoiding lock-in; open-source control |

The one operational danger to mention: flags are **tech debt with a fuse**. A codebase littered with stale toggles becomes an untestable combinatorial mess, so mature teams treat every release toggle as temporary and schedule its removal. And the flag-evaluation path must be *fast and fail-open* — SDKs cache rules locally and fall back to a default if the flag service is unreachable, so your feature system never becomes a new single point of failure.

> **Interview tip:** "How do you launch a risky change to a billion users?" is a layered answer: *deploy dark behind a flag → canary the binary → ramp the flag 1%→100% while watching metrics → keep the kill switch one click away.* Naming all four layers is a senior signal.

## 05 Internal developer platforms

At ten services, engineers can hold the whole system in their heads. At a thousand — Uber, Spotify, any large org — nobody can, and every team wiring up its own CI, dashboards, secrets, and on-call becomes crippling duplicated toil. The answer is an **internal developer platform (IDP)**: a self-service layer, built by a platform team, that offers **golden paths** — opinionated, paved routes for the 80% of common needs (spin up a new service, add a database, deploy) — while still allowing escape hatches for the unusual 20%.

The two names to know:

- **Backstage** (open-sourced by Spotify, now a CNCF project): its heart is a **software catalog** — a live, queryable registry of every service, its owner, its docs, its dependencies, and its health, defined in a `catalog-info.yaml` that lives next to the code. On top sit **software templates** ("scaffolder") that generate a new, fully-wired service from a golden template, and **TechDocs** for docs-as-code. It's highly extensible but you host and build it yourself.
- **Port**: a managed **internal developer portal** built around a flexible **software catalog data model** plus **self-service actions** and **scorecards** (e.g. "does this service have an on-call owner, a runbook, and >80% test coverage?"). Lower setup cost than a self-hosted Backstage; you configure rather than code.

Why an interviewer cares: the catalog is what makes **ownership** and **discoverability** tractable at scale — when a service pages at 3am, the catalog tells you who owns it, what it depends on, and where its runbook is. That's the difference between a scaling org and a scaling mess.

> **One-line definitions to keep:** **Golden path** = the supported, paved way to do a common task. **Software catalog** = the source of truth for what services exist, who owns them, and how they connect. **Self-service** = the product engineer does it without filing a ticket to the platform team.

## 06 DORA metrics

How do you know your delivery machine is actually good? The industry standard is the **DORA metrics** — four measures from Google's *DevOps Research and Assessment* program that, across years of research, distinguish elite performers from low ones. They're deliberately balanced: two for **speed**, two for **stability**, so you can't game one by wrecking the other.

1. **Deployment Frequency** *(speed)* — How often you ship to production. Elite teams deploy on-demand, many times per day; low performers, once a month or less.
2. **Lead Time for Changes** *(speed)* — Time from code committed to code running in production. Measures how quickly the whole pipeline moves an idea to users.
3. **Change Failure Rate** *(stability)* — Percentage of deploys that cause a production failure needing a fix (rollback, hotfix, patch). Lower is better.
4. **Failed-Deployment Recovery Time** *(stability)* — How long to restore service after a bad deploy (the metric formerly framed as MTTR). Fast recovery beats never failing.

| Metric | Elite (roughly) | Low (roughly) |
| --- | --- | --- |
| Deployment frequency | On-demand (multiple / day) | < once per month |
| Lead time for changes | < one day | 1–6 months |
| Change failure rate | ~5% | > 40% |
| Recovery time | < one hour | > one week |

The exact thresholds shift with each year's report — don't quote them as gospel. What matters is the **insight**: speed and stability are *not* a trade-off. Elite teams deploy far more often *and* fail less, because small, frequent, well-tested changes are inherently safer than big rare ones. That single idea justifies canaries, flags, and everything else in this module — and it's a great line to land in an interview.

> **Watch the anti-pattern:** Optimizing one metric alone is a trap: you can hit huge deployment frequency by shipping garbage — the change failure rate exposes it. Always read the four **together**. Tools like Port scorecards or GitLab/Datadog dashboards compute them straight from your CI/CD and incident data.

## 07 Worked example: Design Uber

Let's run the 5-step framework on a heavyweight — *"Design Uber"* (ride-hailing) — and then, in the deep-dive, thread in *this module's* concepts: how would a company operating thousands of microservices actually **ship and de-risk** a change to the matching engine? Read it once; you'll drive it yourself in the reps.

### ① Scope

- **Functional:** rider requests a ride (pickup + destination); system matches a nearby available driver; both see each other's live location; trip has a lifecycle (requested → matched → en-route → in-trip → completed); fare + payment; surge pricing under high demand.
- **Non-functional:** low-latency matching (a driver offer within seconds), very high availability, massive geospatial write load (drivers ping location constantly), regional scale, *eventual* consistency fine for location but *strong* consistency for trip state and payment.
- **Out of scope (say it):** ratings, driver onboarding/KYC, Uber Eats, in-app chat — keep the core tight.

### ② Estimate

```
~1M drivers online at peak, each pings location every 4s
   → 1,000,000 / 4  ≈ 250,000 location writes/sec        huge; must NOT hit a SQL DB

~15M rides/day → 15M / 86,400 ≈ 175 matches/sec avg
   peak ×5      ≈ ~900 matches/sec                       modest vs. the location firehose

trip storage: 15M/day × ~1 KB ≈ 15 GB/day of trip rows   durable, sharded by region
live location: transient → in-memory geo store w/ short TTL, not the trip DB
```

Verdict: the **location update firehose dominates** — that's the real design problem, and it says "in-memory geospatial index, not a relational write per ping." Matching QPS is small by comparison; trip data is durable but modest.

### ③ Interface

```
POST /rides            { pickup:{lat,lng}, dest:{lat,lng} }  → 201 { rideId, status:"MATCHING" }
GET  /rides/{id}                                            → 200 { status, driverLocation }
WS   /drivers/{id}/loc  (stream) { lat, lng, ts }          driver→server, ~every 4s
WS   /rides/{id}/live   (stream)                            server→rider, driver ETA + position
```

The asymmetry is the tell: location is a firehose of tiny writes over persistent connections, while ride creation is comparatively rare. That pushes you toward a dedicated **location-ingest service** separate from the **trip service**.

### ④ High-level design

```
Rider app ─┐                          ┌─▶ Trip Service ──▶ Trips DB (sharded by city/region)
           ├─▶ API Gateway ──▶ Matching Service
Driver app ┘                          └─▶ queries Geo Index (Redis, in-mem)
                                                     ▲
Driver location stream ─▶ Location Service ──────────┘   (updates geo cells)
                                │
                                └─▶ Kafka (location + trip events) ─▶ analytics, surge, ETA
```

- **Location Service** ingests driver pings and updates an in-memory **geospatial index** — no per-ping database write.
- **Matching Service** queries "available drivers near this pickup cell," ranks by ETA, and dispatches an offer.
- **Trip Service** owns the trip **state machine** and persists it durably (strong consistency; the source of truth for billing).
- **Kafka** carries the event firehose to surge pricing, ETA, and analytics consumers.

### ⑤ Deep-dive & scale

**Geospatial indexing** is the heart. You can't scan a million drivers per request, so you bucket the map into cells and only search the relevant ones. The classic options: a **geohash** (recursively subdivided lat/lng string prefix), a **QuadTree** (splits dense areas into finer cells), or Google's **S2** / Uber's own **H3 hexagonal grid**. A pickup maps to a cell; you query that cell plus its neighbors. **Shard by geography** (city/region) — rides are inherently local, so a driver in NYC never needs data from Tokyo, and each region scales independently.

Now the part *this module* adds — **how do you safely ship a change to that matching engine?** This is where DevOps meets architecture:

| Concern | Technique from this module |
| --- | --- |
| Roll out a new matching algorithm | **Feature flag** it (dark launch, off by default), then **canary** the binary + ramp the flag 1%→100% by city, watching match latency & cancel rate |
| Bad algo tanks conversions in one city | **Kill switch** (ops toggle) reverts to the legacy matcher instantly — no redeploy |
| Deploy the stateless API gateway | **Blue-green** for instant cutover + instant rollback; **rolling** for the fleet by default |
| Schema change to the Trips DB | **Expand/contract** migration so old & new versions coexist during the roll |
| Thousands of microservices, who owns what | **Backstage/Port** software catalog for ownership, runbooks, and scorecards |
| Is delivery healthy across all teams? | **DORA metrics** dashboards — deploy frequency, lead time, change failure rate, recovery time |

That's the senior move: you didn't just draw geospatial boxes, you explained how a real org would **evolve the matcher in production without downtime** — canary + flag to de-risk, kill switch for the fast abort, and DORA to prove the whole pipeline stays healthy. Architecture and delivery are one answer.

> **Why this framing wins:** Most candidates stop at "shard by geohash." Adding "…and I'd roll the new matcher out behind a flag with a canary and a kill switch, tracked on DORA" is what makes an interviewer write *"thinks about operability, not just design."*

## 08 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard Uber yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end with the 5-step framework, out loud, timed to ~40 minutes — *before* re-reading Section 07. Force yourself to reach the delivery deep-dive: how do you ship a matcher change safely?
2. **Draw the three deployment strategies from memory.** Rolling, blue-green, canary — sketch each, then write one sentence on blast radius, rollback speed, and extra cost. If you can't, re-read Section 03.
3. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design Uber (ride-hailing)." Then act as the interviewer — let me drive, ask clarifying and probing questions, push back on anything hand-wavy, and keep asking "why?". Make sure you push me on the DELIVERY side too: how would I deploy a change to the matching algorithm safely, what deployment strategy and feature-flag plan I'd use, how I'd roll back, and which DORA metrics I'd watch. Do NOT give me the answer or lead me. After ~40 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, deep-dives & trade-offs (including deployment/operability), and communication — with specific feedback and what a strong candidate would have added.
```

1. **Explain it back.** Teach "deploy vs. release" and why elite teams are both faster and more stable (the DORA insight) to a rubber duck, without notes. Gaps you can't explain are gaps you don't have yet.
2. **Flashcards** (make these 5, review at week's end): *When canary over blue-green? · Name the four DORA metrics. · Difference between a release toggle and a kill switch? · Why must driver-location pings stay out of the primary SQL DB? · What does a Backstage/Port software catalog give you that a wiki doesn't?*

## 09 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the pipeline and deployment ones *before* your reps; the hands-on GitHub Actions tutorial is worth doing with your own repo open.

- **[The CI/CD Pipeline, Explained](https://www.youtube.com/watch?v=w6Y19RWawc0)** — Eye on Tech · ~7 min · CI/CD concept — Fast, clean mental model of CI vs. CD vs. continuous deployment. Watch first.
- **[GitHub Actions Tutorial — Basic Concepts and CI/CD Pipeline with Docker](https://www.youtube.com/watch?v=R8_veQiYBjI)** — TechWorld with Nana · ~32 min · hands-on — Build a real GitHub Actions → Docker pipeline step by step. Do it with your own repo.
- **[Deployment Strategies Explained: Blue-Green vs. Canary vs. Rolling](https://www.youtube.com/watch?v=H5z70EBtEow)** — CodeLucky · ~12 min · deployment — The core comparison for Section 03 — blast radius, rollback, and when to pick each.
- **[Kubernetes Deployment Strategies with Demos | Canary | Blue Green | Rolling Update](https://www.youtube.com/watch?v=0QhUhrWGB9k)** — Abhishek.Veeramalla · ~24 min · deployment (hands-on) — See each strategy actually run on a cluster — great after the concept video.
- **[Feature Flags Explained in 6 Minutes (Feature Toggles)](https://www.youtube.com/watch?v=c8KgKTgyFUE)** — CoderDave · ~6 min · feature flags — Tight primer on toggles and "deploy vs. release." Watch before Section 04.
- **[DORA Metrics Explained: The Four Key Measures of DevOps Performance](https://www.youtube.com/watch?v=lqsENcje41w)** — Harness · ~5 min · DORA — Crisp walkthrough of the four metrics and why speed and stability aren't a trade-off.

**Read (optional depth):** DDIA Chapter 4 (encoding & evolution) is the theory behind backward-compatible rollouts and expand/contract migrations — exactly why rolling and canary demand schema care. For breadth, skim the [System Design Primer](https://github.com/donnemartin/system-design-primer)'s sections on availability patterns and CI/CD (free), and Martin Fowler's classic ["Feature Toggles"](https://martinfowler.com/articles/feature-toggles.html) essay.

---
*Source: `modules/19-cicd-platform-engineering.html` — System Design Mastery. Interactive version has the live simulators.*
