# Observability & Monitoring

*Phase 4 · Production-Grade·Module 14·Weeks 6-8 · ~13 hrs*

Once a system is live, the question stops being "will it work?" and becomes "how do I **know** it's working — and how fast can I find out when it isn't?" This module is the instrumentation layer every production architecture needs, and the language senior interviewers expect you to speak.

## 01 The three pillars

**Monitoring** tells you *whether* a system is healthy against questions you thought to ask in advance. **Observability** is the property that lets you ask *new* questions — to explain behaviour you never predicted — without shipping new code. You get there by emitting three complementary kinds of telemetry: **metrics, logs, and traces**.

The distinction matters in an interview. Monitoring is dashboards and alerts on known failure modes ("CPU > 90%"). Observability is the debugging superpower: a novel outage happens, and the data you already emit is rich enough to let you slice, filter, and correlate your way to the root cause. A system can be heavily monitored yet barely observable — walls of green dashboards while a subtle tail-latency regression quietly burns customers.

| Pillar | What it is | Answers the question | Cost shape |
| --- | --- | --- | --- |
| Metrics | Numeric measurements aggregated over time (counters, gauges, histograms) | Is something wrong, and how much? | Cheap — fixed cost per series |
| Logs | Timestamped, discrete event records (ideally structured) | What exactly happened? | Expensive — grows with volume |
| Traces | The end-to-end path of one request across services | Where did the time / error go? | Costly at full fidelity — sample it |

The mental model to carry into any design: **metrics tell you *that* something is wrong, traces tell you *where*, and logs tell you *why*.** You almost always start at a metric (an alert fired), pivot to a trace to localize the slow or failing hop, then read the logs for that exact span to see the stack trace or the bad input. Designing them to link together — so one click carries you from a spiking latency graph to the offending request's logs — is the real skill.

> **Key idea:** Telemetry is not free. Metrics are cheap and always-on; logs and full-fidelity traces get expensive fast. Mature systems keep **high-cardinality detail sampled** and **low-cardinality aggregates complete** — and stitch them with shared IDs so you can drill from the cheap signal down to the expensive one on demand.

## 02 Metrics & time-series

A metric is a name, a set of **labels** (dimensions), and a stream of numeric samples over time — a *time series*. `http_requests_total{route="/checkout", status="500"}` is one series; change any label value and you get a different series. Four metric types cover almost everything:

- **Counter** — only goes up (requests served, errors, bytes). You read its *rate*, not its raw value.
- **Gauge** — goes up and down (in-flight requests, queue depth, memory used, temperature).
- **Histogram** — bucketed distribution of observations (request duration), letting you compute p50/p95/p99 later.
- **Summary** — like a histogram but with quantiles computed client-side; harder to aggregate across instances.

### Percentiles, not averages

Averages lie. If 99 requests take 10 ms and one takes 5 s, the mean is ~60 ms — a number no single user ever experienced, and it hides the customer who timed out. Always reason about **tail latency**: p95, p99, p99.9. At scale the tail is not an edge case — with 100 downstream calls per page, a p99 slow path is hit on the *majority* of page loads. This is why we store histograms: you can't average pre-computed averages back into a real percentile.

### Two recipes: RED and USE

Don't invent metrics ad hoc. Two checklists cover services and resources:

| Method | Use it for | Track |
| --- | --- | --- |
| RED | Request-driven services (APIs) | **R**ate, **E**rrors, **D**uration |
| USE | Resources (CPU, disk, queues) | **U**tilization, **S**aturation, **E**rrors |

Instrument every service with RED and every resource with USE and you will have covered the questions that matter before you ever draw a dashboard. The **cardinality trap** is the one thing to fear: putting a high-cardinality value (user ID, request ID, raw URL with IDs) into a metric label explodes the number of series and can take down your metrics backend. Keep labels bounded — route *templates* (`/users/{id}`), status classes, region — and push the high-cardinality detail into logs and traces where it belongs.

## 03 Structured logging & correlation IDs

A log line written as free-form English (`User 42 failed to pay`) is fine for a human reading one server. Across hundreds of instances it's useless — you can't reliably filter, aggregate, or alert on prose. **Structured logging** emits each event as a machine-parseable object (usually JSON) with consistent, queryable fields.

```
// Unstructured — a dead end at scale
2026-07-07 14:03:11 ERROR payment failed for user 42 order 9987 after 3100ms

// Structured — queryable, aggregatable, alertable
{
  "ts": "2026-07-07T14:03:11Z",
  "level": "error",
  "service": "payment-svc",
  "event": "charge_failed",
  "user_id": "42",
  "order_id": "9987",
  "latency_ms": 3100,
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "error": "gateway_timeout"
}
```

Now you can ask: "count of `charge_failed` by `error` in the last hour," or "every log with `latency_ms > 3000`." The same event that was invisible prose becomes a data point you can graph.

### Correlation IDs: the thread through the maze

In a microservice architecture one user click fans out to a dozen services, each logging independently. Without a shared key those logs are a shuffled deck. A **correlation ID** (a.k.a. request ID) is a unique token minted at the edge — the API gateway — and **propagated on every downstream call**, typically via an HTTP header. Every service stamps it into every log line it writes for that request.

```
client ──▶ gateway            mints request_id = "req-8f2c…"
             │  X-Request-Id: req-8f2c…
             ├──▶ comment-svc   logs {request_id:"req-8f2c…", …}
             ├──▶ fanout-svc     logs {request_id:"req-8f2c…", …}
             └──▶ store-svc      logs {request_id:"req-8f2c…", …}

# One outage, one filter across ALL services:
request_id = "req-8f2c…"   ──▶ the full story of that one request
```

The `trace_id` from distributed tracing (next section) is the natural correlation ID — reuse it so a log field and a trace point to the same identity. That single decision is what lets you jump from "this trace was slow" to "here are exactly the log lines it produced," which is the whole game when you're paged at 3 a.m.

> **Interview tip:** When an interviewer asks "how would you debug this in production?", say the words *"structured logs keyed by a correlation ID that I propagate from the gateway, so I can reconstruct any single request across every service."* It signals you've actually operated systems, not just drawn them.

## 04 Distributed tracing & OpenTelemetry

Metrics tell you the checkout p99 doubled. Logs are a haystack. **Distributed tracing** answers "where did the time go?" by recording a request's entire journey across services as a tree of timed operations.

- A **trace** is the whole request, identified by a `trace_id`.
- A **span** is one unit of work within it (an HTTP handler, a DB query, a cache lookup) with a start time, duration, status, and attributes.
- Spans nest via a **parent span ID**, forming a tree; laid out on a timeline it's a *flame graph / waterfall* that shows exactly which hop was slow or errored.

```
Trace 4bf9…  (total 1180ms)
├─ span: POST /live/123/comments            [gateway]        1180ms
│  ├─ span: auth.check                       [auth-svc]         12ms
│  ├─ span: comment.write                    [comment-svc]      55ms
│  │  └─ span: INSERT comments               [postgres]         41ms  ✓
│  └─ span: fanout.publish                   [fanout-svc]     1090ms  ◀ the culprit
│     └─ span: broker.publish (retry ×3)     [kafka]          1070ms  ◀ retries!
```

One glance and the story is obvious: the write was fine; the fan-out publish retried the broker three times and ate a full second. No amount of staring at averages gives you that — the *shape* of the waterfall does.

### Context propagation & OpenTelemetry

Tracing only works if `trace_id` and the current `span_id` travel with the request across process boundaries. That's **context propagation**, and the industry has standardized it: the **W3C Trace Context** `traceparent` header carries the IDs on every hop.

**OpenTelemetry (OTel)** is the vendor-neutral CNCF standard that ties it all together — a single set of APIs, SDKs, and a wire protocol (OTLP) for metrics, logs, *and* traces. You instrument once (much of it auto-instrumented for common frameworks), ship telemetry to the **OTel Collector**, and fan it out to whatever backend you like — Jaeger, Tempo, Datadog, Honeycomb — without touching app code. That decoupling is the whole point: no vendor lock-in on your instrumentation.

```
# traceparent header — version-traceid-spanid-flags
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  │                                │                │
          version  trace_id (16 bytes)        parent span_id   sampled?
```

**Sampling** is non-negotiable at scale: tracing every request would rival your production traffic in volume and cost. *Head-based* sampling decides at the start (keep 1%); *tail-based* sampling buffers spans and keeps the interesting ones (every error, every slow request) after the fact — more useful, more infrastructure. Either way, keep 100% of errors and a small slice of the happy path.

## 05 Prometheus, Grafana & alerting

The de-facto open-source metrics stack: **Prometheus** collects and stores time-series, **Grafana** visualizes them, and **Alertmanager** routes the alerts. Knowing how the pieces fit is fair game in an interview.

### The Prometheus model: pull, not push

Prometheus **scrapes** — it periodically pulls a `/metrics` HTTP endpoint that each service exposes. This inverts the usual push model, and the trade-off is worth stating: pull means Prometheus controls the load and instantly knows a target is *down* (a failed scrape is itself a signal), and targets don't need to know where to send data. The cost is service discovery — Prometheus must be told what to scrape (via Kubernetes API, Consul, static config). For short-lived batch jobs that vanish before a scrape, a **Pushgateway** bridges the gap.

```
# A service exposes plain text at /metrics; Prometheus scrapes it:
http_requests_total{route="/comments",method="POST",status="200"} 84213
http_requests_total{route="/comments",method="POST",status="500"} 137
request_duration_seconds_bucket{route="/comments",le="0.1"} 80122
request_duration_seconds_bucket{route="/comments",le="0.5"} 83999

# PromQL — error rate over the last 5 minutes:
sum(rate(http_requests_total{status="500"}[5m]))
  / sum(rate(http_requests_total[5m]))

# PromQL — p99 latency from the histogram:
histogram_quantile(0.99,
  sum(rate(request_duration_seconds_bucket[5m])) by (le))
```

**Grafana** sits on top and queries Prometheus (and many other sources) to build dashboards — the RED panels per service, the USE panels per host. Good dashboards are opinionated: a handful of graphs that answer "is the service healthy?" at a glance, not a wall of 50 graphs nobody reads.

### Alerting that doesn't cause pager fatigue

Alerts are defined as PromQL expressions with a duration ("error rate > 2% *for* 5m"); Alertmanager deduplicates, groups, silences, and routes them to PagerDuty/Slack. The cardinal rule from Google's SRE practice: **alert on symptoms, not causes**. Page a human when *users are hurting* (latency SLO burning, error rate up) — not on every high-CPU blip, which may be harmless. Every page should be **actionable and urgent**; anything else is a dashboard or a ticket. Noisy alerting is how on-call engineers learn to ignore the pager, which is far more dangerous than no alert at all.

> **Interview tip:** If asked "how do you decide what to alert on?", anchor on symptoms and error budgets (next section): *"I page when the user-facing SLO is at risk of being missed, using a burn-rate alert — fast burn pages immediately, slow burn opens a ticket."* That one sentence separates people who've carried a pager from people who haven't.

## 06 SLI / SLO / SLA & error budgets

These three acronyms are the vocabulary of reliability, and interviewers use them to check whether you think about "good enough" quantitatively instead of chasing an impossible 100%.

| Term | What it is | Example | Audience |
| --- | --- | --- | --- |
| SLI | **Indicator** — a measured number describing service quality | % of requests served < 200 ms | Engineers |
| SLO | **Objective** — the internal target for an SLI | 99.9% of requests < 200 ms over 30 days | Internal team |
| SLA | **Agreement** — a contract with customers, with penalties | 99.5% or we refund credits | Customers / legal |

The ordering is deliberate: the **SLI** is what you measure, the **SLO** is the bar you hold yourself to, and the **SLA** is the (looser) promise you sell — always set the SLA below the SLO so you have headroom before money and reputation are on the line. A good SLI is expressed as *good events ÷ valid events*, so it's naturally a percentage between 0 and 100.

### The error budget: reliability as a currency

Here's the idea that reframes everything: an SLO of 99.9% is a decision that **0.1% of requests are allowed to fail**. That 0.1% is your **error budget** — a real, spendable amount of unreliability. If you're under budget, you ship features fast and take risks. If you've blown the budget, the policy kicks in: **freeze feature launches and spend engineering on reliability** until you're back in the black. It turns an endless "dev wants speed vs. ops wants stability" argument into arithmetic both sides agreed to in advance.

The magic of the number is how little downtime "three nines" actually buys you:

| Availability SLO | Downtime / year | Downtime / 30 days | Error budget |
| --- | --- | --- | --- |
| 99% (two nines) | 3.65 days | 7.2 hrs | 1.0% |
| 99.9% (three nines) | 8.77 hrs | 43.2 min | 0.1% |
| 99.99% (four nines) | 52.6 min | 4.32 min | 0.01% |
| 99.999% (five nines) | 5.26 min | 26 sec | 0.001% |

Each extra nine is roughly 10× harder and more expensive. This table is why a seasoned engineer pushes back on "we need five nines" — that's 26 seconds of budget a *month*, which forbids most maintenance windows and costs a fortune. You spend availability where it earns its keep and no further. **Burn-rate alerting** operationalizes the budget: alert when you're consuming it fast enough to exhaust it before the window ends (e.g. a 14× burn rate pages now; a 3× burn opens a ticket).

> **Play with it → your tool:** Open the [📉 SLO Calculator](../tools/slo-calculator.html), set a target like **99.9%**, and watch the allowed downtime, monthly error budget, and how many failed requests that actually permits fall right out. Nudge it to 99.99% and feel how brutally the budget shrinks — that visceral sense of "each nine costs 10×" is exactly what makes you credible when you argue an SLO in a design round.

## 07 The blameless post-mortem

Observability's payoff isn't the graph — it's what you do after an incident. The **post-mortem** (a.k.a. incident retro) is a written analysis of an outage: what happened, why, and what changes prevent a recurrence. The word that matters is **blameless**: the premise is that people act reasonably given the information and tools they had, so you fix *systems*, not people. The moment a post-mortem points a finger, engineers stop reporting incidents honestly and your reliability data goes dark.

A solid post-mortem has a predictable skeleton:

1. **Summary & impact** *(what & how bad)* — One paragraph: what broke, who was affected, for how long, quantified against the SLO / error budget spent.
2. **Timeline** *(the facts)* — Timestamped sequence — detection, escalation, mitigation, resolution. Sourced straight from your metrics, logs, and traces (this is why they exist).
3. **Root-cause analysis** *(the why)* — Dig past the surface with techniques like the *5 Whys*. Usually it's a chain of contributing causes, not one villain.
4. **What went well / poorly** *(honest)* — Did detection lag? Was the runbook missing? Did the alert even fire? Praise fast mitigation; name the gaps without blame.
5. **Action items** *(owned & dated)* — Concrete, assigned, tracked fixes — a new alert, a rollback guardrail, an auto-scaling limit. An action item with no owner is a wish.

Two metrics quantify how well your observability actually serves incidents: **MTTD** (mean time to *detect*) and **MTTR** (mean time to *recover*). Great instrumentation crushes both — you find out before customers do, and you localize the fault in minutes instead of hours. When an interviewer asks "how do you know your monitoring is good?", the answer is "my MTTD and MTTR are low and trending down."

## 08 Worked example: Facebook Live Comments

Let's run the 5-step framework on *"Design the live-comments feed for Facebook Live"* — real-time comments streaming under a video as millions watch — and then wire in everything above so we can actually **operate** it. This is a fan-out problem with an observability spine.

### ① Scope

- **Functional:** a viewer posts a comment on a live video; every viewer sees new comments appear in near-real-time as a streaming feed.
- **Non-functional:** low end-to-end latency (comment visible in < 2 s), very high availability, *massive* read fan-out (one comment → millions of screens), eventual consistency is fine (ordering roughly by time), graceful behaviour under viral spikes.
- **Out of scope (say it):** the video encoding/CDN path, comment ranking / spam-ML, and edit/delete history — keep the core tight.

### ② Estimate

```
Popular stream: 10M concurrent viewers
Post rate (peak): ~1% comment per minute → ~100k comments/min
                = ~1,700 comment writes / s          (modest write load)
Naive fan-out:  1,700 writes/s × 10M viewers
                = 17,000,000,000 deliveries / s        ◀ impossible AND unreadable
Comment size:   ~200 bytes  →  raw is trivial; the DELIVERY is the problem
```

The estimate immediately makes the design decision: writes are easy, but the fan-out is astronomical — and no human can read 1,700 comments/s anyway. So we **sample / rate-limit what each viewer is shown** (a few per second) and fan out that reduced stream. Spotting that in the numbers is the whole insight.

### ③ Interface

```
# Post a comment
POST /live/{videoId}/comments   { "text": "🔥🔥🔥" }  →  202 Accepted

# Subscribe to the live feed (server pushes; not polling)
GET  /live/{videoId}/comments/stream            WebSocket / SSE
     ← server pushes {author, text, ts} events as they arrive
```

The asymmetry is the design: writes are a normal REST call; reads are a **persistent push connection** (WebSocket or Server-Sent Events) because polling millions of clients would melt the servers.

### ④ High-level design

```
viewer ─POST─▶ Gateway ─▶ Comment-svc ─▶ store (write)
                                    └─▶ publish to broker topic: video:{id}

                         ┌──────────── broker (partitioned by videoId) ───────────┐
                         ▼                        ▼                        ▼
                    Dispatcher A            Dispatcher B            Dispatcher C
                    (holds ~50k WS)         (holds ~50k WS)         (holds ~50k WS)
                         │                        │                        │
                    viewers…                 viewers…                 viewers…
```

A comment is written once and **published once** to a per-video topic on a broker (Kafka/Redis). A fleet of **dispatcher** nodes each subscribe to that topic and each hold tens of thousands of viewer WebSocket connections; when a comment lands on the topic, every dispatcher pushes it to its local connections. Viewers for a hot video are spread across dispatchers by consistent hashing, so one machine never owns all 10M.

### ⑤ Deep-dive & scale — and how we *know* it's healthy

The scaling moves: **hierarchical fan-out** (publish once, dispatchers multiply it locally), **connection sharding** (a routing layer maps a viewer to a dispatcher; add dispatchers as viewership grows), and **display sampling / rate-limiting** so each viewer receives a readable few-per-second slice under a viral surge. Backpressure drops excess comments rather than toppling a dispatcher.

Now the module's real lesson — at 10M viewers, "looks fine on my laptop" is worthless. We instrument the pipeline so we can prove it and debug it:

| Pillar | What we emit for Live Comments | What it catches |
| --- | --- | --- |
| Metrics (RED/USE) | comment write rate; **delivery latency histogram** (post → client render); active WS connections/dispatcher; broker lag; dropped-message rate; dispatcher CPU & queue depth | "delivery p99 crossed 2 s on video X" — the symptom that pages |
| Traces (OTel) | trace each comment: `POST → store → broker.publish → dispatcher.push`, one span per hop, sampled + all errors kept | which hop ate the latency — broker retries? a hot dispatcher? cross-region push? |
| Logs (structured) | JSON keyed by `trace_id` + `video_id`; connection open/close, drop reasons, backpressure events | why a specific video degraded — filter every service by that `video_id` |

**SLO:** "99% of comments delivered to a subscribed viewer within 2 s, measured over 30 days." **Error budget:** the 1% you're allowed to drop or delay — spent fast during a Super Bowl surge, so a **burn-rate alert** pages on-call the moment delivery latency threatens the budget. **Prometheus** scrapes every dispatcher's connection count and queue depth; **Grafana** shows a per-video dashboard so a producer can watch a marquee stream live.

**Tie it together with a mini post-mortem.** Say a celebrity stream degrades: delivery p99 spikes to 9 s. The *metric* pages via burn-rate alert (symptom, not cause). A *trace* shows `broker.publish` retrying — one Kafka partition for that video is overloaded. The *logs*, filtered by `video_id`, show a single hot partition with no key spread. Root cause: partitioning by `videoId` alone put a viral video on one partition. Action items: sub-partition hot videos, add a partition-lag alert, cap per-dispatcher connections. That is observability closing the loop — metric → trace → log → fix — which is precisely what this module exists to teach.

> **Why this problem:** Live Comments is a favourite because it forces the fan-out realisation in the estimate *and* rewards a candidate who says "here's how I'd monitor it." Bolting SLOs, tracing, and a burn-rate alert onto a real design is exactly the senior signal interviewers are hunting for.

## 09 Your reps this week

Reading about observability doesn't build the reflex — instrumenting and defending a design does. Do these, in order:

1. **Instrument something real.** Take any small service you have (or spin one up) and add a `/metrics` endpoint with a RED counter + a latency histogram, then point a local Prometheus + Grafana at it. Seeing your own request rate move a graph makes the whole module concrete.
2. **Whiteboard Facebook Live Comments yourself.** Open [Excalidraw](https://excalidraw.com) (free) and run the 5-step framework end-to-end, out loud, ~35 minutes — *then* explicitly add the observability layer (SLI/SLO, the three pillars, one alert) before re-reading Section 08. Struggling first is the point.
3. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend both the design *and* how you'd operate it:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design the live-comments feed for Facebook Live." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push back on anything hand-wavy. Make me handle the read fan-out to millions of viewers. Crucially, once I have a high-level design, pivot hard into OPERATIONS: ask what SLI and SLO I'd set, which metrics/logs/traces I'd emit, what I'd alert on and why, and walk me through debugging a live incident where delivery latency spikes. Do NOT give me the answer or lead me. After ~40 minutes (or when I say "done"), grade me 1–5 on each of: requirements & estimation, API design, high-level design, fan-out deep-dive, observability & SLOs, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Compute a budget in the tool.** In the [📉 SLO Calculator](../tools/slo-calculator.html), set your Live Comments SLO (say 99% delivery) and read off the monthly budget of dropped/late comments — then articulate what you'd freeze if you blew it.
2. **Flashcards** (make these 5, review at week's end): *Metrics vs logs vs traces — which answers "that / where / why"? · What is a correlation ID and where is it minted? · SLI vs SLO vs SLA — which one has financial penalties? · If the SLO is 99.9%, how many bad minutes per 30 days? · Why alert on symptoms (burn rate) instead of causes (high CPU)?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the three-pillars and SLO ones *before* your reps; save the metrics-monitoring system-design walkthroughs for *after* your own Live Comments attempt.

- **[Observability and Its Pillars Explained | Logs, Metrics & Traces Simplified](https://www.youtube.com/watch?v=rJfZyA831fI)** — OpenObserve · ~12 min · three pillars — Clean intro to metrics/logs/traces and the "that / where / why" split. Watch first.
- **[Distributed Tracing Explained: OpenTelemetry & Jaeger Tutorial](https://www.youtube.com/watch?v=Oa-zqv-EBpw)** — DevOps & AI Toolkit · ~25 min · tracing / OTel — Spans, context propagation, and OTel wired into Jaeger — the Section 04 ideas in practice.
- **[SLO vs SLI vs SLA vs Error Budget | Google SRE in Plain English](https://www.youtube.com/watch?v=Akri1BlGp10)** — Tech Tutorials with Piyush · ~12 min · SLO / budgets — The reliability vocabulary and error budgets, plainly. Pair it with the SLO Calculator.
- **[Server Monitoring // Prometheus and Grafana Tutorial](https://www.youtube.com/watch?v=9TJx7QTrTyo)** — Christian Lempa · ~25 min · Prometheus + Grafana — Hands-on scrape → store → dashboard flow so the stack in Section 05 stops being abstract.
- **[Design Metrics Monitoring & Alerting System: System Design Interview (Stripe & Amazon Offers)](https://www.youtube.com/watch?v=T-8DgGQ7wUo)** — TechPrep · ~20 min · SD interview — A full interview-style build of a Datadog-like metrics platform. Watch AFTER your own attempt.
- **[Distributed Logging & Metrics Framework | Systems Design With Ex-Google SWE](https://www.youtube.com/watch?v=p_q-n09B8KA)** — Jordan has no life · ~25 min · deeper cut — Depth on ingesting and querying logs/metrics at scale — optional second take.

**Read (optional depth):** DDIA Chapter 1 (reliability, scalability, maintainability — the "reliability" framing underpins SLOs) and the observability/monitoring notes in the [System Design Primer](https://github.com/donnemartin/system-design-primer) (free). For the source of truth on SLIs, SLOs, and error budgets, the [Google SRE Book — Service Level Objectives](https://sre.google/sre-book/service-level-objectives/) chapter is free online.

---
*Source: `modules/14-observability-monitoring.html` — System Design Mastery. Interactive version has the live simulators.*
