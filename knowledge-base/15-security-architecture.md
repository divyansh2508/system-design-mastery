# Security Architecture

*Phase 4 · Production-Grade·Module 15·Weeks 6-8 · ~13 hrs*

Security is not a service you bolt on at the end — it's a property of every boundary a request crosses, so in this module you learn to design **identity, trust, and secrets** into the architecture itself.

## 01 Defense in depth

Defense in depth is the principle that **no single control should be load-bearing**. You assume every layer will eventually fail, so you stack independent controls such that a breach of one still leaves the attacker outside the next.

The old model was a hard perimeter and a soft interior: a firewall at the edge, and everything inside the network implicitly trusted. That model dies the moment one host is compromised — a phished laptop, a leaked credential, an exploited dependency — because the attacker is now *inside* the trusted zone and can move freely. Defense in depth replaces the single wall with a series of them, each one a place where an intruder can be stopped or at least detected.

Think of it as concentric rings around your data, each an independent chance to say "no":

| Layer | Control | What it stops |
| --- | --- | --- |
| Edge | WAF, DDoS scrubbing, rate limits | Volumetric attacks, injection at the door |
| Network | Segmentation, private subnets, security groups | Lateral movement between services |
| Identity | AuthN + AuthZ on every request | Unauthenticated or over-privileged access |
| Application | Input validation, output encoding, least privilege | Injection, logic abuse, privilege escalation |
| Data | Encryption at rest & in transit, tokenization | Exfiltration of a stolen disk or backup |
| Detect | Audit logs, anomaly alerts, honeytokens | Nothing — but it tells you the others failed |

Two related principles keep the rings honest. **Least privilege**: every human, service, and token gets the minimum access it needs and nothing more, so a compromise is contained. **Fail secure**: when a check can't complete — the auth service is down, the token can't be verified — you deny, not allow. A door that swings open when the lock breaks is not a lock.

> **Key idea:** Assume breach. Design as if the attacker is already past your outermost wall — because one day they will be. The question a senior engineer answers is not "how do I keep them out?" but **"when they get one layer, what stops them at the next?"**

## 02 Zero trust architecture

Zero trust is defense in depth taken to its logical end: **there is no trusted network**. Being inside the corporate VPN, the VPC, or the service mesh grants you exactly zero implicit access. Every request — user-to-service and service-to-service alike — must prove who it is and be authorized for the specific thing it's asking for, every single time.

The slogan is **"never trust, always verify."** It rests on three moves:

- **Verify explicitly.** Authenticate and authorize on identity, device posture, and context (location, time, risk score) for each request — not once at login and then forever.
- **Least-privilege access.** Grant just-in-time, just-enough permissions, scoped narrowly and expiring quickly, so a stolen token is a small, short-lived blast radius.
- **Assume breach.** Segment everything, encrypt everywhere, log everything, and design so a foothold in one service cannot become a foothold in the next.

Architecturally, zero trust splits the world into a **policy decision point (PDP)** — the brain that answers "is this request allowed?" — and **policy enforcement points (PEPs)** — the gates (API gateway, service-mesh sidecar, load balancer) that ask the brain and enforce the answer. NIST SP 800-207 is the reference model worth knowing by name.

```
# Perimeter model: trust is a location
request ──▶ [firewall] ──▶ (trusted LAN: everything talks to everything)

# Zero trust: trust is an identity, re-checked every hop
request ──▶ [PEP: verify identity + device + policy] ──▶ service A
service A ──▶ [PEP: verify service A's identity + policy] ──▶ service B
                       every arrow is authenticated, authorized, encrypted, logged
```

> **Interview tip:** When an interviewer asks "how do the services trust each other?", the wrong answer is "they're in the same VPC." The senior answer is *"they don't trust the network — each service presents an identity (mTLS cert or signed token) and the callee authorizes it explicitly."* That one sentence signals you've internalized zero trust.

## 03 OAuth 2.0 & OIDC

OAuth 2.0 is an **authorization** framework: it lets a user grant an application limited access to their resources on another service *without handing over their password*. When "Log in with Google" gives a photo-printing app read access to your Google Photos, that's OAuth. The app never sees your Google password; it receives a scoped, revocable **access token** instead.

Keep the four roles straight — they show up in every diagram:

| Role | Who it is | Example |
| --- | --- | --- |
| Resource Owner | The user who owns the data | You |
| Client | The app wanting access | The photo-printing app |
| Authorization Server | Issues tokens after consent | Google's OAuth server |
| Resource Server | Holds the data, checks the token | Google Photos API |

### The Authorization Code flow (with PKCE)

Of OAuth's several grant types, the **Authorization Code flow** is the one to know — it's what web and mobile apps should use. The key trick: the browser never touches the access token. The client first gets a short-lived **authorization code** via the browser redirect, then exchanges that code for tokens over a direct back-channel call. Codes are single-use and expire in seconds, so intercepting one is nearly useless.

**PKCE** (Proof Key for Code Exchange, "pixie") closes the last gap for public clients — mobile apps and SPAs that can't safely keep a client secret. The client invents a random `code_verifier`, sends its hash (`code_challenge`) up front, and must present the original verifier to redeem the code. An attacker who steals the code off the redirect can't use it without the verifier they never saw. OAuth 2.1 makes PKCE mandatory for all authorization-code flows.

```
# Authorization Code + PKCE — the flow to draw on the whiteboard
1. client makes  verifier = random();  challenge = SHA256(verifier)
2. browser ─▶ /authorize?client_id&redirect_uri&scope&code_challenge
3. user logs in + consents at the Authorization Server
4. AS ─▶ browser redirect back with ?code=abc123        (single-use, ~30s TTL)
5. client ─▶ POST /token  { code, code_verifier }        (back channel)
6. AS verifies SHA256(verifier)==challenge, returns:
      access_token  (scoped, short-lived)  +  refresh_token  (+ id_token if OIDC)
7. client ─▶ Resource Server  Authorization: Bearer <access_token>
```

### OIDC: authentication on top of OAuth

OAuth answers "what is this app allowed to do?" — it says nothing reliable about *who the user is*. **OpenID Connect (OIDC)** is a thin identity layer on top of OAuth 2.0 that adds exactly that: an **ID token** (a JWT) describing the authenticated user, plus a standard `/userinfo` endpoint. Rule of thumb: *OAuth = authorization (access to resources); OIDC = authentication (proof of identity).* "Sign in with Google" is OIDC; "let this app read my Google Photos" is OAuth. Most real logins use both at once.

> **Play with it → your tool:** Open the [🔐 OAuth Flow Visualizer](../tools/oauth-flow.html) and step through the Authorization Code + PKCE handshake one message at a time — watch the code get issued, the verifier get checked, and the token come back. Toggle PKCE off to see exactly which attack it defends against. This is the fastest way to make the seven steps above stick.

## 04 JWT validation at the gateway

A **JSON Web Token** is a signed, self-contained credential: three Base64url parts — `header.payload.signature` — joined by dots. The payload carries *claims* (who the user is, what they can do, when the token expires); the signature lets anyone with the right key verify the token was issued by your auth server and hasn't been tampered with. Because it's self-contained, a resource server can validate it **without a database lookup** — that statelessness is exactly why JWTs scale.

```
# A JWT is three dot-separated parts
eyJhbGciOiJSUzI1NiJ9  .  eyJzdWIiOiJ1XzQyIiwiZXhwIjoxNzM...  .  Rf8s...sig
     header (alg)              payload (claims)                 signature

# Decoded payload — the claims you actually check
{ "iss":"https://auth.fb.com", "sub":"u_42", "aud":"post-search-api",
  "scope":"search:read", "exp":1751932800, "iat":1751929200 }
```

The architectural decision that matters: **validate the JWT once, at the API gateway**, before the request ever reaches a backend service. The gateway is the single policy enforcement point at the edge; centralizing validation there means every internal service can trust that the request is already authenticated, and you never duplicate crypto logic across 40 microservices.

### What "validate" actually means

Verifying a signature is necessary but not sufficient. A correct gateway checks all of these — skip one and you have a vulnerability:

- **Signature** — verify against the auth server's public key (fetched from its JWKS endpoint and cached). Use asymmetric `RS256`/`ES256`, so services only hold the public key.
- **Algorithm** — pin the expected algorithm. Reject `alg: none` and never let the token's own header talk you into a weaker algorithm — that's a classic bypass.
- **Expiry** — enforce `exp` (and `nbf`). Short-lived access tokens (5–15 min) limit the damage of a leak.
- **Issuer & audience** — `iss` must be your auth server; `aud` must name *this* API. This stops a token minted for service X being replayed against service Y.

> **The revocation gotcha:** JWTs are stateless, so you can't "delete" one — it's valid until `exp`. That's the trade-off for skipping the DB lookup. Mitigate with **short lifetimes plus refresh tokens** (revoke at refresh time), and keep a small deny-list of `jti` IDs for emergency "log out everywhere." If an interviewer asks "how do you log a user out instantly?", *this* is the tension they're probing.

## 05 Secrets management

Every system has secrets: database passwords, API keys, signing keys, TLS private keys. The failure mode is depressingly common — secrets hard-coded in source, committed to Git, baked into container images, or pasted into environment variables that leak through logs and crash dumps. A secret in your repo history is a secret you've already lost.

A dedicated **secrets manager** (HashiCorp **Vault**, **AWS Secrets Manager**, GCP Secret Manager) fixes this by making secrets something services *fetch at runtime*, authenticated by their own identity, never something they store. What you get:

| Capability | Why it matters |
| --- | --- |
| Central, encrypted store | One audited place; encrypted at rest, access-controlled |
| Dynamic secrets | Vault mints a fresh, short-lived DB credential per service on demand — no shared static password to leak |
| Automatic rotation | Rotate keys on a schedule without a redeploy; leaked creds expire fast |
| Fine-grained policy | Service A can read `db/orders` and nothing else — least privilege for secrets |
| Full audit trail | Every read is logged: who fetched what, when |

The elegant part is **dynamic secrets**: instead of a long-lived password shared by every replica, Vault generates a unique database credential when a service boots and revokes it when the lease ends. There is no static secret to steal, and a compromised credential dies on its own within minutes.

```
# App never holds a static DB password — it asks Vault at runtime
service ──(authenticates with its own identity)──▶ Vault
Vault ──▶ mints  db-user-7f3a / pw-9c1e   lease=15m   (unique, expiring)
service ──▶ connects to Postgres with that ephemeral credential
   ...15m later, Vault revokes it; a fresh one is leased on renewal
```

> **Interview tip:** If you draw a database, expect "where does the app get the password?" The weak answer is "environment variable." The strong answer: *"the app authenticates to Vault with its workload identity and fetches a short-lived dynamic credential — nothing static is stored in the image or config."*

## 06 mTLS for service-to-service

Ordinary TLS (HTTPS) authenticates *one* side: the client verifies the server's certificate, so you know you're talking to the real bank. **Mutual TLS (mTLS)** makes it two-way — the server *also* demands and verifies the client's certificate. Now both ends cryptographically prove their identity before a single byte of application data flows.

That two-way proof is precisely the primitive zero trust needs for service-to-service calls. Instead of "trust anything inside the VPC," every service holds a certificate that *is* its identity; a callee that receives a request checks the caller's cert against a trusted CA and authorizes based on the identity in it. The network being private is irrelevant.

|  | TLS (one-way) | mTLS (mutual) |
| --- | --- | --- |
| Server proves identity | Yes | Yes |
| Client proves identity | No | Yes |
| Typical use | Browser → website | Service → service |
| Trust basis | Public CA | Internal CA / SPIFFE identity |

In practice you rarely code mTLS by hand. A **service mesh** (Istio, Linkerd) runs a sidecar proxy beside each service and transparently upgrades every hop to mTLS — issuing, rotating, and verifying certificates automatically, encrypting traffic, and giving you identity-based policy ("only `checkout` may call `payments`") for free. That's how zero trust becomes operationally realistic across hundreds of services.

```
# mTLS handshake — both sides present and verify a certificate
checkout-svc ──ClientHello──▶ payments-svc
             ◀──ServerCert + "send me your cert"──
checkout-svc ──ClientCert (identity: spiffe://cluster/checkout)──▶
payments-svc verifies cert against internal CA
   ▶ policy: is "checkout" allowed to call "payments"?  ✓  ─▶ encrypted channel open
```

## 07 OWASP API Top 10

The **OWASP API Security Top 10** is the industry's consensus list of how APIs actually get breached. Unlike the classic web Top 10, it's dominated by *authorization* failures — because at scale, the hard part isn't stopping SQL injection, it's making sure the token that's valid for *you* can't read *my* data. Know these; interviewers love asking you to threat-model against them.

| # | Risk | The failure & the fix |
| --- | --- | --- |
| API1 | Broken Object Level Auth (BOLA) | `GET /posts/123` returns a post you don't own. Check ownership on *every* object, every request. |
| API2 | Broken Authentication | Weak tokens, no expiry, guessable resets. Strong JWT validation, short TTLs, MFA. |
| API3 | Broken Object Property Level Auth | Client sets `"role":"admin"` in the body; API returns fields it shouldn't. Allow-list inputs and outputs. |
| API4 | Unrestricted Resource Consumption | No rate/size limits → DoS and cost blowups. Throttle, paginate, cap payloads. |
| API5 | Broken Function Level Auth | A regular user hits an admin endpoint. Enforce role checks per route, deny by default. |
| API6 | Unrestricted Access to Business Flows | Bots drain inventory or scrape. Detect automation; add friction to sensitive flows. |
| API7 | Server-Side Request Forgery | API fetches a user-supplied URL and hits internal metadata. Validate + allow-list egress. |
| API8 | Security Misconfiguration | Default creds, verbose errors, open CORS. Harden, and fail secure. |
| API9 | Improper Inventory Management | Forgotten `/v1` and staging hosts stay exposed. Catalog and retire endpoints. |
| API10 | Unsafe Consumption of APIs | Blindly trusting a third-party response. Validate data from upstreams too. |

**BOLA (API1) is the one to burn into memory** — it's the single most common and most damaging API flaw. The mistake is authenticating (verifying *who* you are) and then forgetting to authorize (verifying you may touch *this specific object*). A valid token is a key to the building, not to every room in it.

## 08 Worked example: Facebook Post Search

Let's run the 5-step framework on *"Design search over Facebook posts"* — but through a **security lens**. The interesting part here isn't the inverted index; it's that search runs over *private data*, so the whole design lives or dies on getting authorization right. This is where every concept above earns its keep.

### ① Scope

- **Functional:** a logged-in user searches posts by keyword and gets back only posts they're permitted to see — their own, friends', and public ones, respecting each post's audience (public / friends / custom). Also: first-party mobile + web clients, and third-party apps that search on a user's behalf.
- **Non-functional (security-first):** **correct authorization is non-negotiable** (never leak a private post — a BOLA here is a headline), low-latency (p99 < 300 ms), high availability, full auditability of who searched what, and zero implicit trust between internal services.
- **Out of scope (say it):** ranking quality, the indexing pipeline internals — we focus on the security architecture.

### ② Estimate

```
2B DAU × ~5 searches/day = 10B searches/day
   ÷ 100k s  ≈ 100k searches/s avg  →  peak ×3 ≈ 300k QPS      read-dominant, huge
JWT validation must be cache-friendly at the edge: JWKS public key
   cached in-gateway → verification is pure local crypto (no network hop)
audience-filtering the results is the expensive part, not signature checks
```

Verdict: at 300k QPS you *cannot* afford a DB round-trip to authenticate each request — hence stateless JWTs verified at the gateway. And authorization must be pushed into the query, not applied after, or you'll fetch millions of posts only to throw most away.

### ③ Interface

Authenticated, token-bearing, and scoped — no anonymous search of private data:

```
GET /api/v1/search?q=vacation&cursor=<opaque>&limit=20
  headers: Authorization: Bearer <access_token>      # OIDC/JWT, scope=search:read
  returns: 200 { results:[ {postId, author, snippet, ...} ], nextCursor }
           401 if token invalid/expired · 403 if scope missing
```

Third-party apps reach this endpoint via **OAuth 2.0**: the user consents once (Authorization Code + PKCE), the app gets an access token scoped to `search:read` and nothing else — never the user's password, never write access.

### ④ High-level design

```
            (mobile/web/3rd-party app,  Bearer JWT)
                          │
                    [ CDN / WAF ]                        # edge: DDoS, rate limit — defense in depth
                          │
                 [ API Gateway ]                         # PEP: validate JWT (sig/exp/iss/aud), scope, throttle
                          │  (mTLS)
                 [ Search Service ]                      # builds authz-filtered query
                    │(mTLS)      │(mTLS)
        [ Authz / Social Graph ] [ Search Index (ES) ]   # "who can I see?"     inverted index
                                       │
                                 secrets (index/db creds) ◀── Vault (dynamic, short-lived)
```

Trace one request: the gateway (a policy enforcement point) validates the JWT locally against the cached JWKS key, checks `aud = post-search-api` and `scope = search:read`, and rate-limits the caller (OWASP API4). It forwards over **mTLS** to the search service, passing the verified `sub` (user id). Every internal hop is mTLS — zero trust, no service trusts the network. Index and DB credentials come from **Vault** as short-lived dynamic secrets, never from config.

### ⑤ Deep-dive: authorization is the whole problem (BOLA)

Here's the trap. The naïve design searches the index for "vacation," gets 10,000 hits, and returns them. That leaks every private post matching the term — a textbook **BOLA (OWASP API1)**. Authentication told us *who* is searching; it said nothing about which of those 10,000 posts they're allowed to see. We must authorize *every result*. Two ways to do it, and the trade-off is the discussion:

| Approach | How | Trade-off |
| --- | --- | --- |
| Filter after search | Get top-N hits, then call the authz service to drop ones the user can't see | Simple & always correct, but leaks results (you may filter away most of a page) and adds a hop per query |
| Filter inside the query | Inject the viewer's visibility set (author ∈ friends ∨ audience = public ∨ author = self) as an index filter | Fast & no over-fetch, but the index must carry each post's audience + the query must be built from the trusted `sub`, never client input |

The senior move: **push authorization into the query** using the audience metadata stored alongside each indexed post, and derive the filter from the server-verified `sub` — never from a client-supplied user id (that would re-open BOLA). Keep a post-filter as a defense-in-depth backstop so a bug in the index filter still can't leak. Every result is authorized twice; that redundancy is the point.

**Scaling & hardening the rest:** shard the index by region and replicate for the 300k QPS read load; cache the social-graph "who can I see" set per user (short TTL) to avoid a graph call per search; enforce cursor-based pagination and per-token rate limits (API4); log every search with the `sub`, query, and result count for audit and anomaly detection (assume breach — detect it). Rotate JWT signing keys via JWKS so a leaked key expires fast. Each control is one ring; none is load-bearing alone.

> **The one-sentence answer:** "Search over private data is an **authorization** problem wearing a search costume: authenticate statelessly at the gateway with JWTs, then authorize *every hit* against the viewer's visibility set — pushed into the query and backstopped after it — with mTLS between services and secrets in Vault." Say that and you've shown the interviewer the whole module.

## 09 Your reps this week

Reading security is not the same as reasoning about it under pressure. Do these, in order:

1. **Whiteboard Facebook Post Search yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end through the security lens — gateway JWT validation, mTLS hops, Vault, and above all the BOLA authorization deep-dive — timed to ~35 minutes, *before* re-reading Section 08.
2. **Trace the OAuth flow by hand.** Step through Authorization Code + PKCE in the [🔐 OAuth Flow Visualizer](../tools/oauth-flow.html), then close it and redraw all seven steps from memory. Explain out loud what PKCE defends against.
3. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff security engineer running a system design interview. Give me the prompt: "Design search over Facebook posts, with a focus on the security architecture." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on the security-critical parts: how do you authenticate at scale, where and how do you validate the JWT, how do third-party apps get access (OAuth/OIDC), how do services trust each other, where do secrets live, and above all — how do you guarantee a user can NEVER see a post they're not authorized to see (walk me into the BOLA trap and see if I catch it). Do NOT give me the answer or lead me. After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements & threat modeling, authentication design, authorization (object-level) design, service-to-service trust & secrets, scaling under the NFRs, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Threat-model against the OWASP API Top 10.** Take your Post Search design and, for each of API1–API10, name where it could break and the control that stops it. If you can't place a risk, that's a gap you just found.
2. **Flashcards** (make these 5, review at week's end): *What does PKCE protect and how? · OAuth vs OIDC in one line? · The four things a gateway must check on a JWT? · TLS vs mTLS — who proves identity? · What is BOLA and why is "valid token" not enough?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the OAuth and JWT primers *before* your reps; the mTLS and zero-trust ones deepen the service-to-service picture for the case study.

- **[OAuth 2 Explained In Simple Terms](https://www.youtube.com/watch?v=ZV5yTm4pT8g)** — ByteByteGo · ~4 min · OAuth 2.0 — The cleanest short intro to the four roles and the token exchange. Watch first.
- **[OAuth 2.0 and OpenID Connect (in plain English)](https://www.youtube.com/watch?v=996OiexHze0)** — OktaDev · ~1 hr · OAuth + OIDC — The definitive talk on why OAuth exists and how OIDC adds identity. The one to watch if a single video sticks.
- **[Why is JWT popular?](https://www.youtube.com/watch?v=P2CPd9ynFLg)** — ByteByteGo · ~4 min · JWT — Nails the stateless-scaling trade-off and the revocation gotcha in four minutes.
- **[JWT — JSON Web Token Crash Course (NodeJS & Postgres)](https://www.youtube.com/watch?v=T0k-3Ze4NLo)** — Hussein Nasser · ~57 min · JWT deep dive — Session vs JWT, refresh tokens, and asymmetric signing — the details a gateway must get right.
- **[Zero Trust Explained in 4 mins](https://www.youtube.com/watch?v=yn6CPQ9RioA)** — IBM Technology · ~4 min · zero trust — "Never trust, always verify" and the PDP/PEP model, distilled. Watch before the case study.
- **[Mutual TLS | The Backend Engineering Show](https://www.youtube.com/watch?v=KwpV-ICpkc4)** — Hussein Nasser · ~50 min · mTLS — One-way vs mutual TLS, why services need it, and the operational costs. The service-to-service piece.

**Read (optional depth):** the [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) project page — the authoritative source for Section 07, and short enough to read in one sitting. For the broader architecture vocabulary, the [System Design Primer](https://github.com/donnemartin/system-design-primer) security notes (free).

---
*Source: `modules/15-security-architecture.html` — System Design Mastery. Interactive version has the live simulators.*
