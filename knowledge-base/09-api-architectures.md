# API Architectures: REST, GraphQL, gRPC

*Phase 3 · Communication·Module 9·Weeks 4-5 · ~13 hrs*

Every service in a distributed system talks to another one over an API. This module is the **vocabulary of that conversation** — how to model a clean REST resource, when GraphQL earns its complexity, why gRPC dominates the wire between microservices, and how a gateway ties it all together at the edge.

## 01 APIs are contracts

An API is a **promise**: given this request, in this shape, the service will do this and return that. Every choice in this module is really a choice about what kind of promise you want to make — and who pays for its rigidity.

The three architectures you'll meet are not competitors so much as tools for different jobs. **REST** models your system as a set of nouns (resources) manipulated with a fixed set of verbs — the lingua franca of public web APIs. **GraphQL** hands the client a query language so it can ask for exactly the data it wants in one round-trip — a cure for the over-fetching and endpoint-sprawl that REST creates for rich, evolving frontends. **gRPC** makes a call to a remote service feel like calling a local function, over a compact binary protocol — the default for the chatty, internal traffic between microservices.

Here's the senior framing to carry through the whole module: **the "best" API style is the one whose strengths line up with your traffic and whose weaknesses you can afford.** A payments team exposing a public API optimizes for caching, tooling, and stability (REST). A mobile team fighting round-trips on a flaky network optimizes for one flexible request (GraphQL). A pair of internal services exchanging millions of messages a second optimizes for latency and payload size (gRPC). Same building, different doors.

> **Key idea:** You are not choosing a "winner." You are matching an **API style to a traffic profile**: public vs internal, read-shape variety, payload size, latency budget, and how fast the contract will change. Name that profile out loud and the choice makes itself.

## 02 REST done right

REST (Representational State Transfer) isn't a protocol — it's a set of constraints on how to use HTTP well. Get three things right and 90% of REST design falls into place: **resource modeling**, **statelessness**, and using HTTP's own semantics instead of reinventing them.

### Resource modeling: nouns, not verbs

A REST API is a collection of *resources* — the nouns of your domain — each addressable by a URL, each manipulated with the standard HTTP verbs. The discipline is to keep verbs *out* of your URLs and let the HTTP method carry the action:

```
# Good — resource nouns, HTTP verbs do the work
GET    /v1/users/42            → fetch user 42
GET    /v1/users/42/messages   → that user's messages (sub-resource)
POST   /v1/users/42/messages   → create a message
PATCH  /v1/messages/8817       → partial update
DELETE /v1/messages/8817       → remove it

# Anti-pattern — verbs in the path, method ignored
POST   /v1/getUserMessages
POST   /v1/deleteMessage?id=8817
```

Match verbs to intent and status codes to outcome: `200` OK, `201` Created (with a `Location` header), `204` No Content, `400` bad request, `401/403` auth, `404` not found, `409` conflict, `429` rate-limited, `5xx` server fault. Two properties are worth naming in an interview because they show maturity: **safe** methods (`GET`, `HEAD`) never mutate state, and **idempotent** methods (`GET`, `PUT`, `DELETE`) can be retried without changing the result beyond the first call. `POST` is neither — which is why "create" endpoints need an idempotency key to survive a client retry safely.

### Statelessness: the property that lets you scale

Every REST request must carry everything the server needs to process it — identity, params, body. The server keeps *no* per-client session in memory between requests. This is the constraint that makes horizontal scaling trivial: because no server "owns" a client, any request can hit any server, and a load balancer can spray traffic across a fleet, add nodes, or lose one without a broken session. State that must persist lives in a database or a shared cache, not in the app server's RAM. (This is the same statelessness that made the app tier scale-out in Module 2 — REST bakes it into the contract.)

### The Richardson Maturity Model

Leonard Richardson's model grades how "RESTful" an API actually is across four levels. It's a fast, memorable way to critique a design out loud:

| Level | What it adds | Smell test |
| --- | --- | --- |
| 0 — The Swamp of POX | One URL, one verb (usually `POST`), RPC-over-HTTP | Everything is `POST /api` with an action in the body |
| 1 — Resources | Many URLs, one per resource | You have `/users/42` but still `POST` everything |
| 2 — HTTP verbs | Proper GET/POST/PUT/DELETE + status codes | Where most "good" REST APIs live — and it's enough |
| 3 — HATEOAS | Responses embed links to the next valid actions | Client discovers transitions from hypermedia, not docs |

The honest, senior take: **Level 2 is the pragmatic target** for almost every real API. Level 3 (HATEOAS — Hypermedia As The Engine Of Application State) is elegant but rarely pays for its complexity outside of a few large public APIs. Knowing the ladder lets you say "this design is Level 2, and that's the right place to stop here" — which sounds far better than an unexamined "it's RESTful."

> **Interview tip:** When you sketch a REST API, narrate two things: *"these are my resources"* and *"this endpoint is idempotent, so client retries are safe."* Idempotency on writes is the detail interviewers probe when networks get flaky — have an answer ready (idempotency keys, dedupe on a client-generated ID).

## 03 Versioning an API

The moment a second team depends on your API, you can't change it freely — a rename or a removed field breaks their code at 3 a.m. Versioning is how you **evolve a contract without breaking existing clients**. Three mainstream strategies, each with a real trade-off:

| Strategy | Looks like | Trade-off |
| --- | --- | --- |
| URL path | `GET /v1/users/42` | Dead obvious, easy to route & cache; but the version leaks into every URL and "v2" can duplicate a lot |
| Custom / Accept header | `Accept: application/vnd.api.v2+json` | Clean URLs, one resource identity; but invisible in a browser and easy to forget in a curl |
| Query parameter | `GET /users/42?version=2` | Trivial to add; but muddies caching and mixes versioning with filtering |

**Content negotiation** is the header-based approach done properly: the client states what representation it can accept via the `Accept` header, and the server picks the matching version (or media type — JSON vs CSV). It's the most "correct" per HTTP's design and keeps a resource's URL stable forever, which is why hypermedia purists prefer it. In practice, **URL-path versioning wins on sheer legibility** — you can see the version in a log line, a bookmark, a gateway route — and that operational clarity is worth a lot.

Whichever you pick, the golden rule is the same: **additive changes don't need a new version.** Adding an optional field or a new endpoint is backward-compatible; renaming a field, removing one, or changing a type is breaking and forces a bump. Design responses so new fields can appear without harm, and you'll bump versions far less often. (You'll see this exact principle again in Module 10 for event schemas, and in gRPC's Protocol Buffers below, where numbered fields make forward/backward compatibility a first-class feature.)

## 04 GraphQL

GraphQL, from Meta, flips the control of shape. In REST, the *server* decides what each endpoint returns; a mobile screen that needs a user plus their last three messages plus unread counts might hit three endpoints and throw away half the payload. GraphQL exposes a **single endpoint** and a **type system**, and lets the *client* ask for exactly the fields it wants — no more, no less — in one round-trip.

### Schema, queries, mutations

The **schema** is the contract: strongly-typed nouns and the entry points to reach them. The client's query mirrors the shape of the data it wants back:

```
# Schema (Schema Definition Language)
type User {
  id: ID!
  name: String!
  messages(last: Int): [Message!]!   # fields can take arguments
}
type Message { id: ID!, body: String!, sentAt: String! }

type Query    { user(id: ID!): User }
type Mutation { sendMessage(to: ID!, body: String!): Message! }
type Subscription { messageReceived(userId: ID!): Message! }

# One request, exactly the fields the screen needs
query {
  user(id: "42") {
    name
    messages(last: 3) { body sentAt }
  }
}
```

That single query kills two classic REST pains at once: **over-fetching** (getting fields you don't need) and **under-fetching** (the "N+1 round-trips" where one call's result forces several follow-up calls). The frontend evolves its data needs by editing the query, not by begging the backend for a new endpoint.

### Resolvers: where the data actually comes from

A GraphQL server doesn't magically know where `User.messages` lives. Every field is backed by a **resolver** — a function that fetches that piece, possibly from a different database, cache, or downstream service. The engine walks the query tree and calls resolvers to fill it in. This is GraphQL's superpower (one schema can stitch together many backends) and its sharpest footgun:

> **Watch out — the N+1 resolver trap:** A query for 100 users, each resolving `messages` separately, fires 1 + 100 database calls. The fix is **batching** — a "DataLoader" collects all the message lookups in one tick and issues a single batched query. Knowing this failure mode (and its fix) is exactly the depth an interviewer wants when you say "GraphQL."

### Subscriptions: real-time push

Beyond queries (read) and mutations (write), GraphQL defines **subscriptions** — a long-lived connection (typically over WebSockets) where the server *pushes* new data as it happens. A `messageReceived` subscription lets a chat client receive messages the instant they arrive instead of polling. That's your bridge from request/response into the real-time world of Module 10 — and a natural segue into WhatsApp below.

The cost of all this flexibility: caching is harder (you can't just cache a URL when every query is unique), a naive client can craft an expensive deep query (so you add depth limits and cost analysis), and you run a query engine. GraphQL earns its keep when you have **many client shapes over a rich, connected graph** — think a product app with dozens of screens — and is overkill for a simple CRUD service.

## 05 gRPC & Protocol Buffers

gRPC (a Google RPC framework) optimizes for the opposite world from public web APIs: **internal, high-volume, low-latency service-to-service traffic**. Its pitch is that calling a remote service should look like calling a local method — you define the service once, and gRPC generates typed client and server stubs in a dozen languages.

### Protocol Buffers: the schema and the wire format

You describe the service and its messages in a `.proto` file. Protocol Buffers (protobuf) then serialize messages to a **compact binary format** — far smaller and faster to parse than JSON, because the field *names* never travel on the wire, only their numeric tags do:

```
// chat.proto
syntax = "proto3";

message Message {
  string id     = 1;   // the number is the wire tag — never reuse it
  string body   = 2;
  int64  sent_at = 3;
  map<string, string> headers = 4;
}

service Chat {
  rpc Send(Message) returns (Ack);                 // unary
  rpc Subscribe(SubReq) returns (stream Message);  // server streaming
  rpc Upload(stream Chunk) returns (Ack);          // client streaming
  rpc Connect(stream Event) returns (stream Event);// bidirectional
}
```

Those field numbers are the key to **schema evolution**: add a field with a new number and old clients simply ignore it; never renumber or reuse a tag and old and new binaries stay compatible. It's the same "additive changes are safe" rule from versioning, enforced by the format itself — which is why gRPC services often avoid explicit API versions entirely.

### HTTP/2 and the four streaming modes

gRPC rides on **HTTP/2**, which gives it multiplexed streams over one connection (no head-of-line blocking across calls), header compression, and — crucially — full-duplex **streaming**. That unlocks four call shapes you saw in the proto above:

| Mode | Shape | Fits |
| --- | --- | --- |
| Unary | 1 request → 1 response | Ordinary RPC; the REST-like default |
| Server streaming | 1 request → N responses | Feeds, live subscriptions, large result sets |
| Client streaming | N requests → 1 response | File/metric upload, batched writes |
| Bidirectional | N ⇄ N, both directions at once | Chat, real-time sync, presence |

The catch: gRPC is *binary* and HTTP/2-native, so it's not friendly to browsers directly (you need gRPC-Web + a proxy) and you can't just `curl` and eyeball a response. That's fine for its home turf — the backend — and exactly why teams pair it with a REST or GraphQL edge for external clients while speaking gRPC internally.

## 06 Choosing between them

Put them side by side and the decision stops being about hype and starts being about your traffic profile. This is the table to be able to reproduce from memory:

| Dimension | REST | GraphQL | gRPC |
| --- | --- | --- | --- |
| Transport | HTTP/1.1+ | HTTP (single endpoint) | HTTP/2 |
| Payload | JSON (text) | JSON (text) | Protobuf (binary) |
| Data shape | Server-defined per endpoint | Client picks exact fields | Fixed by `.proto` |
| Streaming | No (workarounds) | Subscriptions | Native, bi-directional |
| Caching | Excellent (HTTP/CDN) | Hard (one endpoint) | Manual |
| Browser-native | Yes | Yes | No (needs gRPC-Web) |
| Sweet spot | Public APIs, CRUD, caching | Rich/varied frontends | Internal microservices |

A rule of thumb that holds up under pushback: **REST at the public edge for its caching and universality, gRPC between internal services for its speed, and GraphQL when a diverse set of clients query a connected graph.** These aren't mutually exclusive — a mature system runs all three: a GraphQL or REST gateway facing clients, gRPC humming between the services behind it.

> **Play with it → your tool:** Open the [🔌 Protocol Compare](../tools/protocol-compare.html) tool, put REST, GraphQL, and gRPC head-to-head, and toggle a traffic profile — payload size, read-shape variety, streaming, browser reach. Watch which style each choice favors, and build the reflex to justify the pick from the *profile*, not from taste.

## 07 The API gateway

Once you have many services, you don't want clients talking to each one directly — that leaks your topology, duplicates auth in every service, and makes cross-cutting concerns a nightmare. An **API gateway** is a single front door: every external request lands there first, and it handles the concerns that *every* service would otherwise re-implement.

```
            ┌──────────────────────────────────┐
 clients ──▶ │            API GATEWAY           │
  (web,      │  authn/z · rate-limit · routing  │
   mobile)   │  TLS term · logging · aggregation│
            └───────┬─────────┬─────────┬───────┘
                    │         │         │
                  gRPC      gRPC      gRPC   (internal, binary)
                    ▼         ▼         ▼
                 [ Users ] [ Chat ]  [ Media ]
```

The gateway's core jobs:

- **Routing** — match the request path/host to the right upstream service, and often **translate protocols**: accept REST or GraphQL from the outside, speak gRPC to the services inside.
- **Authentication & authorization** — validate the token (e.g. a JWT) once, at the edge, and pass a trusted identity downstream. Services no longer each re-check credentials.
- **Rate limiting** — protect the fleet from abuse and spikes with per-client quotas (token-bucket / leaky-bucket), returning `429` when a client exceeds its budget. This is your first line against a thundering herd.
- **Cross-cutting glue** — TLS termination, request/response logging and metrics, and sometimes **aggregation** (fan out to several services and compose one response, so a mobile client makes one call instead of five).

The trade-off to name: a gateway is a shared choke point, so it must be **highly available and horizontally scaled** (it's stateless, like the REST services behind it, so it scales the same way), and you keep its logic thin — routing and policy, not business logic. Done well, it's the seam where all three API styles in this module meet: a clean public contract at the edge, fast binary RPC within.

## 08 Worked example: WhatsApp

Let's run the 5-step framework on *"Design WhatsApp"*, keeping the lens on **API and protocol decisions** — the heart of this module. (The heavy real-time fan-out and delivery machinery is Module 10; here we decide how the bytes should move.)

### ① Scope

- **Functional:** send and receive 1:1 messages; delivery/read receipts (sent → delivered → read); presence (online / last-seen); deliver messages that arrive while a user is offline. (Stretch: groups, media.)
- **Non-functional:** very low delivery latency, extreme scale (billions of messages/day), **reliable, in-order** per-conversation delivery (never lose or duplicate a message), works over flaky mobile networks, and is battery/bandwidth-frugal — the phone can't hammer the network.
- **Out of scope (say it):** end-to-end encryption internals, the media-storage pipeline, spam — keep the core message path tight.

### ② Estimate

```
~2B users, ~100B messages/day
  100B ÷ 100,000 s   ≈ 1,000,000 msgs/s average
  peak ×3            ≈ 3,000,000 msgs/s          → writes AND pushes
message payload      ≈ 100 B text + envelope     → protobuf, not JSON: ~5–10× smaller
concurrent devices   ≈ hundreds of millions online
  → each holds ONE persistent connection         → millions of live sockets per box
```

Two estimates already forced two decisions: at millions of messages/second the **envelope size matters** → prefer a compact binary format (protobuf) over JSON; and hundreds of millions of *concurrent* devices means the design is about **holding live connections**, not serving stateless request/response.

### ③ Interface — the pivotal choice

This is where the module pays off. A message must be able to arrive *unprompted* — the server has to push to the recipient. Plain REST is request/response: the client would have to **poll** ("any new messages?") every second, which is a latency, battery, and bandwidth disaster at this scale. So the message path uses a **persistent, bidirectional connection** — a WebSocket, or gRPC bidirectional streaming — with protobuf frames:

```
// The hot path: a long-lived bidi stream, not a REST call
service Messaging {
  rpc Connect(stream ClientFrame) returns (stream ServerFrame);
}
message ClientFrame { oneof body { SendMsg send = 1; Ack ack = 2; } }
message ServerFrame { oneof body { Deliver deliver = 1; Receipt rcpt = 2; } }
message SendMsg { string client_msg_id = 1; string to = 2; bytes body = 3; }

# Everything NOT latency-critical stays plain REST/HTTP:
POST /v1/media          # get an upload URL
GET  /v1/users/42       # profile, last-seen
```

That split is the senior move: **persistent stream for the real-time message path, boring cacheable REST for everything else.** A `client_msg_id` generated on the phone makes sends idempotent, so a retry after a dropped connection can't create a duplicate.

### ④ High-level design

```
phone ──persistent stream──▶ [ Gateway / LB ]
                                   │  (auth on connect, route)
                                   ▼
                            [ Connection service ]  ◀── holds the live socket
                                   │                     for each online user
                     writes msg    ▼
              [ Chat service ] ──▶ session registry (Redis): user → which box?
                     │                       │
            recipient ONLINE?  ──yes──▶ push down their open stream ──▶ deliver
                     │
                    no ──▶ [ offline inbox / queue ] ──▶ flush on reconnect
```

Flow: the phone opens one authenticated stream to a **connection service** (via the gateway, which validates the token on connect). To send, it pushes a `SendMsg` frame; the **chat service** persists it, looks up the recipient in a **session registry** (a Redis map of user → connection-server) and, if they're online, pushes a `Deliver` frame down *their* stream. If they're offline, the message lands in a per-user inbox and is flushed when they reconnect. Receipts (`delivered`, `read`) flow back over the same streams.

### ⑤ Deep-dive & scale

- **Why a stream, not polling?** Polling billions of idle phones every second wastes battery and bandwidth and still adds latency. One persistent connection delivers in milliseconds and stays quiet when idle — the decisive protocol call.
- **Why protobuf on the wire?** At 3M frames/s, a 100-byte protobuf frame vs a bloated JSON one is the difference between one datacenter and several. Binary framing also parses faster on a phone CPU.
- **gRPC bidi stream vs raw WebSocket?** gRPC gives you typed frames, codegen, and HTTP/2 multiplexing for free; raw WebSockets are simpler to terminate at the edge and friendlier to browsers. Many real systems use a custom protocol over WebSocket for the phone hop and gRPC *between* internal services — name the trade-off either way.
- **Reliability & ordering:** at-least-once delivery + the client-generated `client_msg_id` for dedupe gives effectively-once; a per-conversation sequence number preserves order even if frames arrive out of turn.
- **Scaling connections:** the session registry lets any chat server find any user's connection box, so you add connection servers horizontally as concurrency grows — the same stateless-fleet story, now for sockets. (Group fan-out and the delivery pipeline: Module 10.)

> **The through-line:** Every big decision here was an **API/protocol decision**: stream over poll, binary over text, persistent over stateless, REST kept for the cold path. That's this module's whole thesis — match the protocol to the traffic profile, and justify it out loud.

## 09 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Design three contracts for one feature.** Take "fetch a user's last 20 messages" and write it as (a) a REST endpoint, (b) a GraphQL query + schema, and (c) a gRPC `.proto` rpc. Feeling the same feature in three shapes is the fastest way to internalize their trade-offs.
2. **Whiteboard WhatsApp yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end with the 5-step framework, out loud, timed to ~35 minutes — *before* re-reading Section 08 or watching the videos. Force yourself to justify the protocol choice at Step 3.
3. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a system design interview. Give me the prompt: "Design WhatsApp." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on the API and protocol layer specifically: make me justify REST vs GraphQL vs gRPC, why (or why not) a persistent connection instead of polling, the wire format, how versioning and schema evolution work, and where an API gateway fits. Push back on anything hand-wavy and keep asking "why?". Do NOT give me the answer or lead me. After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API/interface design, high-level design, deep-dives & trade-offs, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Compare the protocols in the tool.** Run your three contracts through the [🔌 Protocol Compare](../tools/protocol-compare.html) tool and check whether the profile it favors matches the choice you argued.
2. **Flashcards** (make these 5, review at week's end): *Name the 4 Richardson Maturity levels · When gRPC over REST? · What is the GraphQL N+1 resolver problem and its fix? · Two API-versioning strategies and a downside of each · Why a persistent connection over REST polling for chat?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the comparison and GraphQL ones *before* your reps; save the WhatsApp-adjacent gRPC deep-dive for when you want depth.

- **[REST API vs GraphQL vs gRPC - The Complete Guide](https://www.youtube.com/watch?v=I45eIDOSwlg)** — Memi Lavi - The Software Architect · ~20 min · comparison — The three styles head-to-head with an architect's decision lens. Watch first.
- **[API Gateways in System Design Interviews w/ Ex-Meta Staff Engineer](https://www.youtube.com/watch?v=7-6F3b14baA)** — Hello Interview · ~20 min · API gateway — Exactly how to reason about a gateway when the interviewer probes the edge.
- **[Learn GraphQL in 7 Minutes For Beginners](https://www.youtube.com/watch?v=Zg4XIpnLWQg)** — PedroTech · ~7 min · GraphQL — Fastest clean intro to schema, queries, and why GraphQL exists.
- **[This is why gRPC was invented](https://www.youtube.com/watch?v=u4LWEXDP7_M)** — Hussein Nasser · ~15 min · gRPC — The motivation and problems that led to gRPC — the "why" before the "how."
- **[gRPC Crash Course — Modes, Examples, Pros & Cons and more](https://www.youtube.com/watch?v=Yw4rkaTc0f8)** — Hussein Nasser · ~80 min · gRPC deep-dive — Protocol Buffers and all four streaming modes with real code. The deep cut.
- **[API Gateway: Key Features Explained in System Design](https://www.youtube.com/watch?v=u6pYBP92l84)** — ByteMonk · ~10 min · API gateway — Routing, auth, rate limiting, aggregation — the gateway's job list, tightly.

**Read (optional depth):** DDIA Chapter 4 (Encoding and Evolution) — it covers Protocol Buffers, REST vs RPC, and forward/backward schema compatibility, the backbone of everything above. And the [System Design Primer](https://github.com/donnemartin/system-design-primer) sections on APIs (REST vs RPC) — free.

---
*Source: `modules/09-api-architectures.html` — System Design Mastery. Interactive version has the live simulators.*
