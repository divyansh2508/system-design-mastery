# Real-Time & Async API Patterns

*Phase 3 · Communication·Module 10·Weeks 4-5 · ~13 hrs*

When the **server must speak first** — pushing the instant something happens, whether to a browser or another backend — this is the toolkit for it: long polling, SSE, WebSockets, webhooks, BFF, and fan-out, plus the judgment to pick the cheapest one that meets the requirement.

## 01 Push vs pull: the problem

Ordinary REST is **client-initiated pull**: the client asks, the server answers, the connection closes. That model is perfect for "load my profile" and hopeless for "tell me the moment a message arrives" — because the server has no way to speak first.

Real-time features (chat, live scores, presence, collaborative editing, ride tracking, notifications) need the **server to deliver data as events happen**, not when the client next thinks to ask. There is a small, well-worn family of techniques to make that happen over the web, and they trade off along three axes: **direction** (one-way vs bidirectional), **latency** (how fresh), and **cost** (connections, servers, complexity).

- **Short polling** — client asks on a timer. Simple, wasteful, always a little stale.
- **Long polling** — client asks, server *holds* the request until there's news. Near-real-time over plain HTTP.
- **Server-Sent Events (SSE)** — one long-lived HTTP response the server streams down. One-way, server→client.
- **WebSockets** — a full-duplex socket. Bidirectional, lowest per-message overhead, most infra.
- **Webhooks** — the server-to-server cousin: a provider POSTs to *your* URL when an event fires, so you never poll it.

> **Key idea:** The question is never "which is coolest." It's **"what is the cheapest transport that meets the freshness and direction requirement?"** Start at polling and escalate only when an NFR forces it. Reaching for WebSockets on a one-way feed is a classic over-engineering tell in interviews.

## 02 Long polling

**Short polling** is the naïve baseline: the client hits `GET /messages?since=…` every few seconds. Most responses are empty, you burn request/response overhead on nothing, and worst-case freshness is your whole interval. It scales badly and feels laggy.

**Long polling** fixes the waste with one trick: the server *doesn't answer immediately*. It holds the request open until either new data is ready or a timeout (say 30 s) fires, then responds. The client reads the result and *immediately* re-issues the request. From the user's perspective, updates arrive within milliseconds of existing — yet it's all vanilla HTTP, so it sails through corporate proxies, firewalls, and ancient load balancers.

```
# Long polling loop (client side)
loop:
  GET /updates?cursor=1042        # server HOLDS this open…
  <-- 200 { events:[…], cursor:1055 }   # …until data exists (or 30s timeout → 204)
  render(events); cursor = 1055
  # immediately reconnect →
```

The costs are real, though. Every cycle re-sends full HTTP headers (and re-does TLS/cookie work if not kept alive). The server holds an open connection *per waiting client*, which pins memory and, on thread-per-request stacks, a thread. There's a tiny blind gap between "server answered" and "client reconnected" where an event can be missed unless you carry a **cursor / last-seen ID** so the next request resumes exactly where you left off. And a broadcast that wakes every long-poll at once is a **thundering herd** of simultaneous reconnects. Long polling is the right answer when you need near-real-time on infrastructure that only speaks plain HTTP — otherwise SSE or WebSockets are cleaner.

## 03 Server-Sent Events (SSE)

SSE is the purpose-built answer to **one-way, server→client streaming**. The client opens a single HTTP request; the server responds with `Content-Type: text/event-stream` and simply *never closes it*, writing newline-delimited event frames down the pipe as things happen. In the browser it's three lines of code with the built-in `EventSource`.

```
# The wire format — a plain, long-lived HTTP response
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

id: 1055
event: rating_update
data: {"businessId":"b_42","rating":4.3,"count":1288}

id: 1056
event: rating_update
data: {"businessId":"b_42","rating":4.4,"count":1289}

# Client: const es = new EventSource('/stream'); es.onmessage = …
```

SSE's underrated superpower is **automatic reconnection with resume**. If the connection drops, the browser reconnects on its own and sends a `Last-Event-ID` header equal to the last `id:` it saw — so the server can replay exactly what was missed. That makes SSE genuinely reliable for feeds with almost no client code.

The limits: it's **server→client only** (client requests still go over normal HTTP), **text/UTF-8 only** (no binary frames), and over HTTP/1.1 a browser caps at ~6 concurrent connections per origin — so a page with many streams starves. HTTP/2 multiplexing dissolves that last one. Reach for SSE whenever the data flows one direction: notifications, live dashboards, sports scores, LLM token streaming, progress bars, the "someone just reviewed this business" ticker.

## 04 WebSockets & scaling them

When you truly need **bidirectional, low-latency** messaging — chat, collaborative editing, multiplayer, live trading, cursors moving in real time — WebSockets are the tool. A WebSocket is a persistent, **full-duplex** channel over a single TCP connection: after setup, either side can send a message at any moment with almost no per-message overhead.

It begins life as an HTTP request so it traverses the normal web stack, then **upgrades**:

```
# The upgrade handshake — HTTP in, WebSocket out
GET /ws HTTP/1.1
Host: yelp.example
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13

HTTP/1.1 101 Switching Protocols          # handshake accepted
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=

# from here: framed messages both directions, ~2–14 byte frame header
# (vs. a full HTTP header block on every long-poll round-trip)
```

That efficiency is the payoff. The **bill** is statefulness, and it dominates the scaling conversation:

- **Sticky, pinned connections.** A live socket lives on *one* server. You can't round-robin a message to the user — you must route it to whichever node holds their connection. Load balancers need `Upgrade` support and long idle timeouts, and typically consistent-hash or sticky-route sockets.
- **Cross-node delivery needs a backplane.** If Alice is on gateway A and Bob is on gateway B, a message Alice sends must reach B. Solve it with a **pub/sub backplane** (Redis pub/sub, Kafka, NATS): gateways publish to a topic and every gateway subscribed to that topic pushes to its local sockets. (Section 08.)
- **Connection storms.** A deploy or network blip disconnects everyone; they all reconnect at once. You need reconnect **backoff + jitter**, graceful connection draining on rollout, and headroom for the spike.
- **Memory & the C10K/C10M wall.** Each idle socket still costs kernel + heap memory. Millions of concurrent connections means dozens of tuned gateway nodes and a registry of "which user is on which node."

> **Interview tip:** Don't open an interview by drawing WebSockets. Say: *"This feed is one-directional, so I'd start with SSE; I'd only move to WebSockets for the parts that need the client pushing too — and then I owe you a pub/sub backplane and sticky routing."* Naming the cost *before* you're asked is what reads as senior.

## 05 Choosing a transport

Put them side by side. The decision almost always falls out of two questions: *which direction does data flow,* and *how fresh must it be?*

| Transport | Direction | Freshness | Cost / complexity | Best for |
| --- | --- | --- | --- | --- |
| Short polling | Client pull | Interval-stale | Trivial | Cheap "good enough" refresh |
| Long polling | Client pull (held) | Near-real-time | Low; HTTP-only | Real-time on legacy/proxy-bound infra |
| SSE | Server → client | Real-time | Low; auto-reconnect | Feeds, notifications, live counters, token streams |
| WebSockets | Bidirectional | Real-time | High; stateful + backplane | Chat, collab editing, multiplayer, trading |
| Webhooks | Server → server | Event-driven | Medium; retries + signing | Integrations between backends (Stripe, GitHub) |

A useful ladder: **polling → long polling → SSE → WebSockets**, climbing only when the previous rung can't meet the requirement. Most "real-time" product features are one-directional and are perfectly served by SSE; reserve WebSockets for genuine two-way interaction.

> **Play with it → your tool:** Open the [📡 Real-time Transport Playground](../tools/realtime-transport.html) and watch the same "new event" ripple through short polling, long polling, SSE, and a WebSocket side by side — see the wasted empty polls, the held request, the streamed frames, and the duplex channel, with request counts and latency for each. Toggle event rate and client count to feel exactly where each transport starts to hurt.

## 06 Webhooks

Everything above pushes to a *browser*. **Webhooks** push between *backends*. Instead of your service polling Stripe every minute asking "any new charges?", you register a URL and Stripe **POSTs to you** the instant a charge succeeds. They're often called "reverse APIs" or "push APIs" — the provider becomes the client, your endpoint becomes the server. Three things make a webhook system production-grade: delivery, retries, and signature verification.

### Delivery — accept fast, work later

A webhook handler must do the absolute minimum synchronously: **verify the signature, enqueue the event, return `2xx` immediately.** If you do real work inside the handler, you risk timing out the provider (which then retries and double-processes) and coupling your throughput to theirs. The pattern is *receive → validate → enqueue → 200*, then a worker drains the queue. Because networks fail, providers guarantee **at-least-once** delivery — the same event *will* arrive twice sometimes — so your consumer must be **idempotent**, deduping on the provider's stable `event id`.

### Retries — the provider's job, but design for it

If your endpoint returns non-2xx, times out, or is unreachable, the provider retries with **exponential backoff + jitter** over minutes to days. After N failures it parks the event in a **dead-letter queue** and may auto-disable the endpoint and alert you. Good providers expose a **manual replay** so you can reprocess after a fix. Your side of the contract: be fast, be idempotent, and return 2xx *only* once you've durably accepted the event.

### Signature verification — is this really from them?

Your webhook URL is public; anyone can POST forged events to it. So the provider **signs** each payload with a shared secret using **HMAC-SHA256** and sends the signature in a header. You recompute the HMAC over the *raw request body* and compare:

```
# Incoming request
POST /webhooks/reviews
X-Signature: t=1720310400,v1=8b2e…c91f      # timestamp + HMAC
Content-Type: application/json

{"id":"evt_9f3","type":"review.created","data":{…}}

# Verification (server side)
signed  = f"{timestamp}.{raw_body}"                # bind the timestamp in
expected = HMAC_SHA256(secret, signed)
if not constant_time_equal(expected, v1):  reject 400
if now - timestamp > 300:                  reject 400   # replay guard: 5-min window
if already_processed(event.id):            return 200   # idempotent dedupe
enqueue(event); return 200
```

Three non-negotiables live in that snippet: hash the **raw bytes** (below), a **constant-time compare** so attackers can't time-leak the secret byte by byte, and a **signed timestamp** with a short freshness window so a captured-and-replayed request is rejected.

> **The bug everyone ships once:** Verify the signature against the **exact raw body bytes** you received — *not* a parsed-then-re-serialized JSON object. Reordered keys, dropped whitespace, or a different float rendering change the bytes, and every signature check fails mysteriously in production. Capture the raw body *before* your JSON middleware touches it.

## 07 Backend-for-Frontend (BFF)

One generic public API trying to serve a web app, an iOS app, an Android app, and a smart-TV app drifts to a **lowest-common-denominator** contract. Mobile over-fetches fields it doesn't render; web makes five round-trips to assemble one screen; every client is coupled to every other client's needs. The **Backend-for-Frontend** pattern gives each frontend its *own* thin backend — a per-experience API, ideally owned by the same team that ships that UI.

```
                 ┌─────────────┐        ┌──────────────┐
   Web  ───────▶  │  Web  BFF   │ ─┐     │  Business svc │
                 └─────────────┘  ├───▶ ├──────────────┤
                 ┌─────────────┐  │     │  Review   svc │
 Mobile ───────▶ │ Mobile BFF  │ ─┘     ├──────────────┤
                 └─────────────┘        │  Waitlist svc │
   each BFF: aggregate + shape          └──────────────┘
   for ITS client; talk to the same downstream services
```

A BFF is a specialized **API gateway** — but instead of *one* gateway for everyone, there's one *per client type*. What it buys you:

- **Tailored payloads.** The mobile BFF returns a compact object; the web BFF returns the richer one. No client parses fields it won't show.
- **Aggregation kills round-trips.** The BFF fans out to Business + Review + Waitlist services and returns one screen-shaped response, cutting mobile latency on flaky networks.
- **Independent cadence.** The mobile team evolves its BFF on the app's release schedule without a cross-team API negotiation.
- **Client-specific concerns.** Auth/session handling can live here — e.g. the BFF holds the OAuth token server-side and hands the browser only a secure cookie (the "token-handler / BFF auth" pattern), keeping tokens out of JavaScript.

The costs: **duplicated logic** across BFFs (guard against it with shared client libraries, and keep *business* rules in the downstream services), and one more network hop and deployable to operate. In real-time systems the BFF earns its keep twice over: it's the natural place to **terminate the SSE or WebSocket connection** for its client type and shape the event stream — the web BFF might push rich review objects while the mobile BFF pushes a slim "refresh" nudge.

## 08 Fan-out at scale

The defining hard problem of real-time systems: one event must reach **N interested clients**. How you spread it — **fan-out** — decides whether you survive a hot key. Two base strategies, mirroring the delivery choices you met with feeds and timelines:

| Strategy | How | Wins | Hurts |
| --- | --- | --- | --- |
| Fan-out on write (push) | On the event, write/push to all N subscribers now | Reads are instant & cheap | Write amplification; a "celebrity" event = millions of writes |
| Fan-out on read (pull) | Store the event once; each client assembles its view on read | Writes are cheap & simple | Reads are heavier / slower; recompute every time |
| Hybrid | Push for the common case, pull for hot/celebrity keys | Bounds the worst case | Two code paths to maintain |

For **live connections** specifically, the mechanism that makes fan-out tractable across a fleet is a **pub/sub backplane**. Producers publish an event to a topic; every gateway holding a subscriber to that topic pushes it to its local sockets. Gateways stay stateless about *who* produced the event, and you scale connections and producers independently.

```
  review.created(business=b_42)
        │
        ▼
   ┌──────────┐   publish topic="biz:b_42"   ┌──────────────┐
   │ Producer │ ─────────────────────────▶  │  Pub/Sub bus  │
   └──────────┘                              │ (Redis/Kafka) │
                                             └──────┬────────┘
                    ┌───────────────┬───────────────┤  (each gateway
                    ▼               ▼               ▼   subscribes to the
              ┌─────────┐     ┌─────────┐     ┌─────────┐ topics its clients
              │Gateway A│     │Gateway B│     │Gateway C│ care about)
              └────┬────┘     └────┬────┘     └────┬────┘
             SSE/WS to        SSE/WS to        SSE/WS to
            viewers of b_42   viewers of b_42  viewers of b_42
```

The remaining sharp edges: a **connection registry** (which user/topic lives on which gateway) so you can target a single user; **topic sharding** so no one bus partition is a hotspot; and the **celebrity problem** — a viral topic with millions of viewers. For a broadcast (everyone gets the *same* update) that's fine, because it's one publish fanned out by the bus. It only explodes when you'd write a *personalized* copy per user — so for hot keys, prefer broadcasting a lightweight "something changed, refetch" (or a shared delta) over materializing per-user pushes.

## 09 Worked example: Yelp (the real-time slice)

Yelp's *whole* product includes geo-search and ranking — a different module. Here we design the **real-time and async slice**: the live waitlist, live review/rating updates on a business page, owner alerts, and partner webhooks. Run all five framework steps, steering every one toward this module's tools.

### ① Scope

- **Functional:** (a) *Waitlist* — a diner joins a restaurant's virtual line and sees live position, then a "your table is ready" push. (b) *Live business page* — rating and new reviews update in near-real-time as people post. (c) *Owner alerts* — the business owner is notified the instant a new review/photo lands. (d) *Partner webhooks* — reservation/delivery partners subscribe to events like `review.created` and `waitlist.seated`.
- **Non-functional:** low-latency notifications (seconds), **high availability** — the waitlist must never lose your spot; heavily **read-heavy / high fan-out** on popular business pages; **durable, at-least-once** event delivery to partners; both mobile and web clients.
- **Out of scope (say it):** geo-search ranking, photo storage/CDN, and the review spam-ML pipeline. Name them, defer them.

### ② Estimate

```
50M DAU · 5M businesses
reviews:   10M/day ÷ 86,400  ≈ 115 writes/s avg   peak ×4 ≈ ~500/s
biz-page views: 500M/day     ≈ 6,000 reads/s       → cache + read-model, huge fan-out
live connections at peak     ≈ 2M concurrent (SSE/WS)
  ÷ ~100k conns/gateway node ≈ 20–40 gateway nodes  + headroom for reconnect storms
webhook partners             ≈ 50k endpoints × event rate → async dispatcher fleet
```

Verdict: writes are modest, but **fan-out is the whole game** — millions of viewers on hot pages and millions of live connections. That points at SSE for the one-way page updates, a pub/sub backplane, and a durable event log feeding both the real-time gateways and the webhook dispatcher.

### ③ Interface

```
# Writes — plain REST
POST /v1/businesses/{id}/reviews   { "rating":4, "text":"…" }  → 201
POST /v1/businesses/{id}/waitlist  { "partySize":2 }          → 201 { "ticketId":"…","pos":7 }

# Real-time reads
GET  /v1/businesses/{id}/stream     # SSE: rating_update, review_created events (one-way)
GET  /v1/waitlist/{ticketId}/stream # SSE: position_update, table_ready

# Partner integration — webhooks (server→server)
POST /v1/webhook-endpoints  { "url":"https://partner/hook", "events":["review.created","waitlist.seated"] }
  → we POST signed events (HMAC-SHA256 + timestamp) to that URL, with retries
```

Note the deliberate transport choices: the diner's waitlist and the page ticker are **server→client**, so SSE — cheaper and auto-reconnecting — beats WebSockets. We'd only introduce a WebSocket if a feature needed the client streaming *up* (e.g. live typing in an owner-diner chat).

### ④ High-level design

```
Clients ─▶ Web BFF / Mobile BFF ─▶ Review svc ─▶ [ Reviews DB ]
                                      │ emit event
                                      ▼
                               ┌─────────────┐
                               │  Event log  │  (Kafka: durable, replayable)
                               └──────┬──────┘
             ┌────────────────────────┼───────────────────────────┐
             ▼                        ▼                            ▼
     Read-model updater      Real-time fan-out           Webhook dispatcher
     (rating cache, feed)    (Redis pub/sub ─▶ SSE        (signed POST + retry
                              gateways ─▶ viewers)          + DLQ to partners)
```

A write goes through the BFF to the Review service, which persists it and emits one immutable event to a **Kafka log**. Three independent consumers fan out from that single source of truth: one updates the cached rating and read model, one broadcasts to the real-time gateways over a pub/sub backplane, and one dispatches signed webhooks to partners. Decoupling through the log means a slow partner never slows a diner's page.

### ⑤ Deep-dive & scale

- **Page fan-out (hot business).** Viewers of a business subscribe (via their BFF) to an SSE stream keyed on `biz:{id}`. A new review publishes once to that topic; the bus fans it to every gateway holding those viewers. A viral page with millions of viewers is a *broadcast*, so it stays a single publish — and for the very hottest pages we push a lightweight "rating changed → refetch" rather than a personalized payload per viewer, dodging write amplification.
- **Waitlist correctness beats freshness.** The DB (or a durable queue) is the source of truth for your position; the SSE stream is just a fast delivery channel. On reconnect the client *re-fetches* current position rather than trusting it never missed a push — and "table ready" is at-least-once, so the UI renders idempotently. Never let an in-memory push be the only record of your spot.
- **Webhook delivery to partners.** The dispatcher reads the Kafka log, signs each payload (HMAC-SHA256 over the raw body + timestamp), POSTs, and expects a fast 2xx. Failures retry with exponential backoff + jitter, then land in a DLQ; after N failures we disable the endpoint and alert the partner, and expose manual replay. Every event carries a stable `event id` so partners dedupe.
- **BFF shaping.** The web BFF aggregates business + recent reviews + rating into one response and streams rich review objects; the mobile BFF returns a compact page and streams slim nudges — same downstream services, two tuned experiences, and the SSE connection terminates at the BFF.
- **Availability of the gateway fleet.** Connection state lives in gateway memory plus a Redis registry (user → gateway); the LB consistent-hashes sockets and supports long-lived streams. On deploy we drain gracefully and clients auto-reconnect — SSE's `Last-Event-ID` replays anything missed, so a rollout doesn't drop a diner's "table ready."

> **Why this is a real-time answer, not a generic one:** Swap "Yelp" for any CRUD app and this design would *change* — because its spine is the event log, the SSE fan-out, the pub/sub backplane, the signed retrying webhook dispatcher, and per-client BFFs. That's the litmus test: the case study must exercise the module, not just wear its name.

## 10 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard the Yelp real-time slice yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design the waitlist + live page + partner webhooks end-to-end with the 5-step framework, out loud, timed to ~35 minutes — *before* re-reading Section 09. Draw the event log, the SSE fan-out, and the webhook dispatcher explicitly.
2. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your transport choices against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design Yelp, focusing on its real-time and async features — a live restaurant waitlist, live review/rating updates on a business page, business-owner alerts, and webhook integrations for partners." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on: when I'd use SSE vs WebSockets vs long polling and why; how I fan out an update to millions of viewers of a hot business; how webhook delivery handles retries, idempotency, and signature verification; and where a BFF earns its place. Do NOT give me the answer or lead me. After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, deep-dives & trade-offs, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Feel the transports move** in the [📡 Real-time Transport Playground](../tools/realtime-transport.html) — crank the event rate and client count and watch where short polling wastes requests, where long polling holds, and where SSE/WebSockets pull ahead. Match what you see to the table in Section 05.
2. **Explain it back.** Teach two things to a rubber duck without notes: *how HMAC webhook signature verification works (and why you hash the raw body)*, and *fan-out on write vs on read plus the celebrity problem*. Gaps you can't explain are gaps you don't have yet.
3. **Flashcards** (make these 5, review at week's end):
 *When do you actually need WebSockets over SSE? · How does HMAC signature verification work, and why hash the raw bytes + include a timestamp? · Fan-out on write vs on read — when does each win, and what's the celebrity problem? · Why put a BFF in front of your microservices instead of one shared API? · Long polling vs short polling — what does long polling save, and what does it still cost?*

## 11 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the transport comparison first; save the live-fan-out walkthrough for *after* your own Yelp attempt.

- **[Polling vs WebSockets vs SSE vs Webhooks (When to Use What?)](https://www.youtube.com/watch?v=MbgfLUovCwA)** — Kathan Vakharia · ~19 min · transports — All four patterns mapped to when-to-use in one sitting. Watch first.
- **[WebSockets Crash Course — Handshake, Use-cases, Pros & Cons and more](https://www.youtube.com/watch?v=2Nt-ZrNP22A)** — Hussein Nasser · ~48 min · websockets — The definitive primer: the upgrade handshake, framing, and honest pros/cons.
- **[How to scale WebSockets to millions of connections](https://www.youtube.com/watch?v=vXJsJ52vwAA)** — Ably Realtime · ~13 min · scaling — The stateful-connection wall and the pub/sub backplane that gets you past it.
- **[What is a Webhook? Webhooks for Beginners](https://www.youtube.com/watch?v=mrkQ5iLb4DM)** — Mehul Mohan · ~12 min · webhooks — Clean mental model of the reverse-API push before you design delivery + signing.
- **[Expert Guide: Backend for Frontend (BFF) in Microservices](https://www.youtube.com/watch?v=Pmzrogq4W4I)** — ByteMonk · ~11 min · BFF — Why one API per client beats a shared lowest-common-denominator gateway.
- **[System Design Interview: Design Live Comments w/ an Ex-Meta Staff Engineer](https://www.youtube.com/watch?v=LjLx0fCd1k8)** — Hello Interview · ~33 min · real-time fan-out — End-to-end real-time updates + fan-out, interview-framed. Watch AFTER your Yelp attempt.

**Read (optional depth):** DDIA Chapter 11 (Stream Processing) — the definitive treatment of event logs, at-least-once delivery, and consumers, which is the backbone of every async design above. And the [System Design Primer](https://github.com/donnemartin/system-design-primer) sections on asynchronism and communication (free).

---
*Source: `modules/10-realtime-async-apis.html` — System Design Mastery. Interactive version has the live simulators.*
