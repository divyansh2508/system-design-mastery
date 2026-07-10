# Capstone: Real-Time Chat System

*Phase 6 · Capstones·Module 23-24·Weeks 11-12 · ~13 hrs*

The URL shortener was stateless and easy to scale — chat is neither. Here you **build and deploy a real-time messaging system** where the long-lived connection itself is the hard part, making this the single most complete rep in the whole track.

## 01 What you're building & why it's the ultimate rep

You're building a real, deployed real-time chat app: open two browser tabs, type in one, and the message appears in the other *instantly* — backed by persistent WebSocket connections, a durable message store, live presence, a Kafka + Redis fan-out layer, then hardened until it survives crashing servers and millions of open sockets.

The URL shortener (Module 21-22) was the perfect first capstone because it's **stateless** — any app server can answer any request, so scaling is "add more boxes." Chat throws that away. A WebSocket is a **stateful, long-lived connection pinned to one specific server**, and everything hard about this system flows from that one fact: how do you route a message to a user whose socket lives on a *different* server? How do you know who's online? What happens to 50,000 open connections when their server crashes? This is why chat is the ultimate rep — it forces you to reason about state, connection lifecycle, fan-out, ordering, and delivery guarantees, not just request/response.

It still assembles the whole course into one artifact — an API and real-time protocol (Module 9), a data model and a write-optimized store (Modules 1, 3), a cache and a session registry (Module 5), a message queue for fan-out and durability (Module 8), load balancing with sticky sessions and auto-scaling (Module 2), object storage and a CDN for media (Module 6), a push-notification pipeline (Module 15), observability (Module 14), a CI/CD pipeline (Module 19), and multi-region deployment (Module 17). But it adds the one layer the shortener never made you confront: **managing millions of concurrent stateful connections.**

> **Key idea:** In a stateless system you scale by adding servers. In a chat system the **connection is the state**, so the entire architecture is about answering one question: "user A's socket is on gateway 3, user B's is on gateway 47 — how does A's message reach B in under 100 ms?" Everything else is detail.

## 02 Requirements recap

Write these down before you write a line of code — every component you add later must trace back to one of them, and "real-time" hides at least four distinct requirements people forget to separate.

**Functional** (the verbs): send and receive 1:1 messages in real time; group chats; delivery status (sent / delivered / read receipts); user **presence** (online / last-seen); persisted message history a client can scroll back through; **offline delivery** (a message sent to an offline user is stored and pushed when they return); media/file attachments. Explicitly out of scope for the core: end-to-end encryption, voice/video calls, and full search — name them, then build the tight core.

**Non-functional** (the qualities that shape the architecture):

| NFR | Target | What it forces into the build |
| --- | --- | --- |
| Latency | Message delivered p99 < 100-500 ms | Persistent WebSockets, in-memory routing, no polling |
| Concurrency | Millions of simultaneous open connections | A dedicated, horizontally-scaled connection (gateway) tier |
| Availability | ~always up (99.9%+); reconnect seamlessly | Stateless-ish gateways, health checks, client auto-reconnect |
| Durability | Never lose a delivered message | Persist before ack; a write-optimized store; replication |
| Ordering | Messages in a conversation arrive in order | Per-conversation sequence numbers / partition keys |
| Delivery | At-least-once, then dedupe to exactly-once feel | Client-generated message IDs, idempotent writes, acks |

The one-minute estimate that justifies those choices (round hard — a day is ~100,000 seconds):

```
50M DAU × 40 msgs/day  = 2B messages/day
2B / 86,400            ≈ 23,000 messages/s avg  (peak ×4 ≈ ~100k/s)
concurrent connections ≈ 10M sockets open at peak
  one gateway holds ~50k-100k sockets  → ~100-200 gateway servers just to hold connections
storage: 2B/day × ~300 B/msg = ~600 GB/day
         × 365 × retention   → 100s of TB → write-heavy, must shard (Cassandra-class store)
```

Verdict, straight from the numbers: **write-heavy and connection-heavy → a separate connection tier from the business logic, a message queue to absorb the write firehose and fan out, and a horizontally-sharded write-optimized store.** This is the opposite of the read-heavy, cache-everything shortener — and that contrast is exactly what makes it worth building. Every decision below is anchored here.

## 03 The architecture

The core move is to **split the connection tier from the logic tier**. A fleet of **WebSocket gateways** does one job: hold millions of open sockets, authenticate them, and shuttle bytes. They are dumb pipes. All the real work — persistence, fan-out, presence — happens behind them, so you can scale "hold connections" independently from "process messages."

When user A sends a message to B, the flow is: A's gateway receives it over the socket and hands it to the **chat service**, which (1) writes it to the durable **message store** so it can never be lost, and (2) needs to deliver it to B. To do that it consults a **session registry in Redis** — a `userId → gatewayId` map kept fresh by heartbeats — to learn *which gateway holds B's socket*. It then routes the message to that gateway (via **Redis Pub/Sub** for direct 1:1 hops, or via a **Kafka topic** for durable, replayable group fan-out), and B's gateway pushes it down B's socket. If B is offline (no entry in the registry), the message is already safely stored and a **notification service** fires a push via APNs/FCM; B pulls the missed messages on reconnect. Media never travels over the socket — clients upload to **S3** with a pre-signed URL and send only the object key. A **presence service** turns those same heartbeats into online / last-seen state.

```
   user A                                                        user B
     │  WebSocket (persistent, stateful)          WebSocket        │
     ▼                                                             ▼
 ┌─────────┐        ┌──────────────────┐               ┌─────────┐
 │ Load    │        │  Load balancer   │               │ Load    │
 │ balancer│        │ (sticky / L4 WS) │               │ balancer│
 └────┬────┘        └──────────────────┘               └────┬────┘
      ▼                                                      ▼
 ┌──────────┐                                          ┌──────────┐
 │ Gateway 3│◀───── holds A's socket    holds B's ────▶│Gateway 47│
 └────┬─────┘                                          └────▲─────┘
      │ 1. inbound msg                    5. push to B's socket│
      ▼                                                        │
 ┌───────────────┐   2. persist    ┌──────────────────────┐   │
 │  Chat service │────────────────▶│  Message store        │   │
 │  (stateless)  │                 │  (Cassandra: sharded, │   │
 └───┬───────────┘                 │   write-optimized)    │   │
     │ 3. who holds B?             └──────────────────────┘   │
     ▼                                                         │
 ┌──────────────────┐   4. route to B's gateway               │
 │ Session registry │──────────────────────────────────────────┘
 │ (Redis: user→gw) │        via  Redis Pub/Sub (1:1)
 │  + presence      │         or  Kafka topic  (group fan-out, durable)
 └──────────────────┘
        │  B offline?  ──▶ ┌───────────────────┐   ┌─────────────┐
        └────────────────▶ │ Notification svc  │──▶│ APNs / FCM  │
                           └───────────────────┘   └─────────────┘
   media:  client ──pre-signed PUT──▶ [ S3 ] ──served via──▶ [ CDN ]
```

Notice the two independent scaling axes: the **gateway tier scales with connection count** (millions of idle sockets), while the **chat service + queue + store scale with message throughput** (writes per second). Decoupling them is the whole design — a group message to 500 people is one write plus a fan-out job, not 500 synchronous pushes blocking the sender. You'll build the simple correct version first, then earn every box.

## 04 Step-by-step build plan

Two phases. **BUILD** gets two browser tabs talking in real time through a durable, multi-server backend — a link you can share so a friend can chat with you. **SCALE** makes it survive real traffic, geography, media, offline users, and crashing servers. Do them in order; do not scale something that doesn't yet reliably deliver a message.

### BUILD — from blank repo to two tabs chatting for real

1. **WebSockets + message delivery + persistence** *(build)* — Stand up a WebSocket gateway: a client connects, authenticates, sends a message; the server persists it to the store *before* acking, then delivers it to the recipient on the same server. Real-time 1:1 chat, single node.
2. **User presence & connection management** *(build)* — Track the connection lifecycle: register `userId → connection` on open, heartbeat (ping/pong) to detect dead sockets, clean up on close, and expose online / last-seen. Handle client auto-reconnect with backoff.
3. **Kafka fan-out** *(build)* — Insert a Kafka topic between ingestion and delivery. The gateway produces the message; consumers persist and fan it out. This decouples "receive" from "deliver," absorbs write spikes, gives you durability + replay, and makes group fan-out a background job.
4. **Redis Pub/Sub** *(build)* — Now go multi-server. Each gateway subscribes to a Redis channel for the users it holds; to deliver to a user on another gateway, publish to that gateway's channel and it pushes down the socket. This is what makes A-on-gw3 → B-on-gw47 work.

① WebSocket protocol & the delivery path

```
# Client opens ONE persistent socket, then frames messages over it
WS  /connect?token=<jwt>            # upgrade HTTP → WebSocket, authenticate once

# client → server frame
{ "type":"SEND", "clientMsgId":"uuid", "to":"userB", "convId":"c42", "body":"hi" }

# server → client frames
{ "type":"ACK",      "clientMsgId":"uuid", "serverMsgId":"...", "seq":1013 }  # persisted
{ "type":"MESSAGE",  "serverMsgId":"...", "convId":"c42", "from":"userA", "body":"hi", "seq":1013 }
{ "type":"RECEIPT",  "serverMsgId":"...", "state":"DELIVERED|READ" }

# delivery rule: PERSIST before you ACK — the DB write is the source of truth,
# the socket push is best-effort. clientMsgId makes retries idempotent.
```

② Presence & connection management

```
on connect:    redis.SET  presence:{userId} = {gatewayId, ts}  EX 30
heartbeat 15s: redis.EXPIRE presence:{userId} 30      # ping/pong keeps it alive
on disconnect: redis.DEL  presence:{userId}           # + broadcast "offline" to contacts
last-seen:     write ts to the user row on clean close

# the presence key IS the session registry: userId → which gateway holds the socket.
# a missing key = offline = route to the notification pipeline instead of a socket.
```

③ Kafka fan-out (why a queue, not a direct write)

```
gateway ──produce──▶  Kafka topic "messages"  (key = convId  → per-conversation order)
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                 ▼
   persist consumer   fan-out consumer   receipts/analytics
   (write to store)   (look up members,  (delivered/read,
                       push to each)      unread counts)

# keying by convId puts one conversation on one partition → ordered, replayable.
# a 500-person group is ONE produce + a background fan-out, not 500 blocking pushes.
```

④ Redis Pub/Sub (cross-gateway routing)

```
each gateway:  SUBSCRIBE gw:{gatewayId}          # its own delivery channel

deliver(msg, toUser):
  gw = redis.GET presence:{toUser}              # which gateway holds the socket?
  if gw:  redis.PUBLISH gw:{gw} = msg           # that gateway pushes down the socket
  else:   enqueue to notification pipeline      # user offline → push + store for pull

# Redis Pub/Sub = fast, fire-and-forget 1:1 hops between gateways.
# Kafka = durable, replayable fan-out for groups + anything that must not be lost.
# Real systems use BOTH: Pub/Sub for the live hop, Kafka for durability/replay.
```

### SCALE — make it survive real traffic, geography & failure

5. **Multi-region deployment + traffic routing** *(scale)* — Run gateways in multiple regions; use GeoDNS / Anycast so users connect to the nearest one, cutting handshake and round-trip latency. Replicate the store cross-region and decide your consistency story for a user who reconnects in a new region.
6. **Presence scaling + sticky sessions** *(scale)* — A WebSocket must stay pinned to the gateway that holds it — configure sticky routing (L4/connection-level) at the LB. Scale presence with a sharded/clustered Redis (or gossip), and make sure draining a node re-registers its users, not just drops them.
7. **S3 file uploads** *(scale)* — Keep media off the socket: the server hands the client a **pre-signed S3 URL**, the client uploads directly, and the chat message carries only the object key + metadata. Downloads go through a CDN. Sockets stay small and fast.
8. **Notification pipelines** *(scale)* — A notification service consumes from Kafka; when a recipient is offline (no presence key) it fires a push via APNs/FCM and increments an unread badge. On reconnect the client pulls everything it missed from the store.
9. **Chaos testing + production-readiness review** *(scale)* — Kill a gateway holding thousands of sockets, drop the network to Redis/Kafka, partition a region. Verify clients reconnect with jittered backoff, no message is lost, and per-conversation order holds. Then do the readiness pass: dashboards, alerts, runbooks, load test.

> **Play with it → your tool:** Before you configure sticky sessions on the real LB, build the intuition: open the [🚦 Load Balancer Playground](../tools/load-balancer-simulator.html) and watch what happens when you spread *stateful* connections across a fleet, then kill a node — the reconnect storm you see is exactly what steps 6 and 9 make you handle for real. Sticky routing is what keeps a live socket from bouncing between gateways mid-conversation.

> **Build tip:** Ship the smallest correct thing first — *two tabs, one gateway, messages persisted and delivered* — before you touch Kafka, multi-region, or push. Real-time systems fail in subtle, timing-dependent ways, so each new box (queue, second gateway, Pub/Sub) must be a small, independently-verified diff. A single-node chat that never drops a message beats a distributed one that sometimes does.

## 05 Common pitfalls & how to verify each stage

The bugs in a chat build are famous — and they're precisely the failure modes interviewers ask you to anticipate. Know the trap and the check for each stage, and verify *as you go*.

| Stage | Common pitfall | How to verify it works |
| --- | --- | --- |
| WebSockets | Load balancer doesn't support the WS upgrade / sticky routing, so connections drop or bounce between gateways. | Open a socket, run for 10 min behind the LB with 2+ gateways; it stays connected and always lands on the same gateway. `wscat` / browser devtools show one long-lived 101 connection. |
| Delivery | Acking before persisting — the socket push "succeeds," the server crashes, the message is gone forever. | Kill the server the instant after an ACK under load; every acked message is still in the store on restart. Zero acked-but-lost messages. |
| Ordering | Messages in a conversation arrive out of order (parallel consumers / multiple partitions per conversation). | Blast 100 ordered messages into one conversation; the recipient sees a strictly increasing `seq`. Key Kafka by `convId` so a conversation maps to one partition. |
| Duplicates | At-least-once delivery + client retries produce duplicate messages in the thread. | Force a retry (drop the ACK); the message appears once. The server dedupes on `clientMsgId` (idempotent write). |
| Presence | Ghost online: a client's laptop sleeps, the socket half-dies, presence still says "online" forever. | Kill a client ungracefully (no close frame); status flips to offline within the heartbeat TTL (~30 s), not never. |
| Cross-gateway routing | A-on-gw3 messages B-on-gw47 and it silently vanishes because gw3 only knew its own local sockets. | Force the two users onto different gateways; the message still arrives. The session registry + Pub/Sub route it across. |
| Fan-out | Group send loops synchronously over N members, so the sender blocks and huge groups time out. | Send to a 500-member group; the sender gets its ACK in <100 ms while delivery happens async off the queue. |
| Offline delivery | Message to an offline user is pushed to a dead socket and lost — no store, no push. | Send to a logged-out user; they receive it on next reconnect (pulled from the store) *and* got a push notification. |
| Reconnect storm | A gateway with 50k sockets dies; all 50k reconnect at once and stampede the survivors (thundering herd). | Kill a loaded gateway; clients reconnect with **jittered exponential backoff**, survivors absorb them, no cascade. |

Each row is a checkpoint: don't move to the next stage until its check passes. That discipline — especially the crash and reconnect tests — is exactly what "production-ready real-time" means, and it's what turns "I'd handle failures" into "here's the chaos test and the commit that fixed it."

## 06 What you ship

The capstone is done when you have two artifacts — and both go on your portfolio, GitHub, and résumé.

1. **A live chat app.** A public URL where anyone can open two tabs (or two phones) and message in real time: messages deliver instantly, presence shows who's online, history persists and scrolls, an offline user gets the message on return, and it all keeps working when you reconnect. It runs across multiple gateways behind a load balancer, with a queue, a durable store, and a session registry, deployed by your CI/CD pipeline. A recruiter can try it in ten seconds.
2. **A one-page architecture doc** (a README with the Section 03 diagram is enough) covering: the requirements and estimate; the connection tier vs logic tier split and why; *how a message reaches a user whose socket is on another gateway*; your fan-out choice (Redis Pub/Sub vs Kafka — and why you used each); the delivery + ordering guarantees and how you enforce them; presence and offline handling; how it scales across regions; and the chaos tests you ran with the commits that fixed what broke. This document *is* your interview script.

> **Why the doc matters as much as the code:** Interviewers can't read your whole repo, but they can read one page and ask three sharp questions. The doc is where "I built a chat app" becomes "I split the connection tier from the logic tier, routed cross-gateway delivery through a Redis session registry, keyed Kafka by conversation for ordering, and here's the chaos test that proved no message is lost when a gateway holding 50k sockets dies" — the sentence that gets you hired.

## 07 Your reps this week

Reading a build guide is not building. Do these, in order — this is the two-week capstone loop:

1. **Build the BUILD phase, timeboxed.** Blank repo → two tabs chatting in real time through a durable, multi-gateway backend, in the first week. Steps 1–4. Resist every urge to gold-plate; get it *live and never-drops-a-message* first.
2. **Run a mock interview / design review.** Paste the rig below into me (or any LLM) and defend your design against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design WhatsApp / a real-time chat system." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on the things that actually make chat hard: how a message reaches a user whose WebSocket is on a different server, the session registry, presence and how you detect a dead connection, ordering within a conversation, exactly-once vs at-least-once delivery and dedupe, group fan-out, offline delivery and push, sticky sessions, and what happens when a gateway holding 50k connections crashes. Keep asking "why?" and "how would you verify that?". Do NOT give me the answer or lead me. After ~40 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, connection/gateway design, real-time delivery & fan-out, data model & ordering, failure handling & presence, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Write the architecture doc** (Section 06) — the one-pager with the diagram. If you can't explain how a cross-gateway message is routed, you haven't earned that box; go back and build the intuition.
2. **Break it on purpose.** Load-test with thousands of concurrent sockets (e.g. `k6` / `artillery` WebSocket mode), then kill a gateway under load and expire a hot presence key. Watch your dashboards — no lost messages, order holds, clients reconnect with jittered backoff. Commit each fix with a message saying what you learned.
3. **Flashcards** (make these 5, review at week's end): *How does a message reach a user whose socket is on a different gateway? · Redis Pub/Sub vs Kafka for fan-out — when does each win? · How do you guarantee ordering within one conversation? · At-least-once + dedupe — what makes delivery feel exactly-once? · Why do WebSockets need sticky sessions, and what breaks without them?*

## 08 Watch & read

Free videos, hand-picked and link-verified for this capstone. Watch a WhatsApp/chat design walkthrough and the WebSocket-scaling one *before* you build; save the Redis Pub/Sub and fan-out deep-dives for when you reach steps 3–4.

- **[Design Whatsapp: System Design Interview w/ a Ex-Meta Senior Manager](https://www.youtube.com/watch?v=cr6p0n0N-VA)** — Hello Interview · WhatsApp mock interview — A full mock WhatsApp interview run by an ex-Meta manager — the clearest end-to-end shape of the whole system. Watch first.
- **[FAANG System Design Interview: Design A Chat System (WhatsApp, Facebook Messenger, Discord, Slack)](https://www.youtube.com/watch?v=okrR1KXNLtA)** — ByteByteGo · chat architecture — The canonical chat architecture — WebSockets, presence, sequencing, and fan-out — across the four big messengers. Great second overview.
- **[Load balancing WebSockets Streams efficeintly](https://www.youtube.com/watch?v=ugAZsDdmwJQ)** — Hussein Nasser · scaling WebSockets — Why persistent WebSocket connections are hard to load-balance, and how L4 vs L7 changes the game. Watch before step 6.
- **[Scaling Websockets with Redis, HAProxy and Node JS - High-availability Group Chat Application](https://www.youtube.com/watch?v=gzIcGhJC8hA)** — Hussein Nasser · Redis Pub/Sub fan-out — The exact pattern from steps 3–4: Redis Pub/Sub fanning messages across multiple WebSocket servers. Watch before you go multi-gateway.
- **[WhatsApp System Design | FB Messenger System Design | System Design Interview Question](https://www.youtube.com/watch?v=RjQjbJ2UJDg)** — codeKarle · deep walkthrough — A detailed message-flow, storage, and delivery walkthrough — a strong deep second pass after the overviews.
- **[WHATSAPP System Design: Chat Messaging Systems for Interviews](https://www.youtube.com/watch?v=vvhC64hQZMk)** — Gaurav Sen · messaging deep dive — Goes hard on group messaging, message states / read-receipts, and media sharing — the classic chat-interview deep dive.

**Read (optional depth):** DDIA Chapter 11 (stream processing) for the queue/fan-out mental model behind Kafka, and Chapter 5 (replication) for your cross-region story. And the [System Design Primer](https://github.com/donnemartin/system-design-primer) — its real-time / messaging notes and the "Design a chat/messenger" discussions mirror this capstone (free).

---
*Source: `modules/22-capstone-realtime-chat.html` — System Design Mastery. Interactive version has the live simulators.*
