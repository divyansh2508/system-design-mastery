# Compliance & Protection

*Phase 4 · Production-Grade·Module 16·Weeks 6-8 · ~13 hrs*

A design that works isn't done — it has to survive hostile traffic, prove it protects user data, and stand up to an auditor. This module adds the **security and compliance layer** that separates a demo from something you can actually run in production.

## 01 Threat model & defense in depth

Security is not a component you bolt on at the end — it's a **property of every layer**, from the edge that receives a packet to the dependency that parses it. The senior move in an interview is to reason about *who the attacker is* and *what they're after* before naming a single control.

A quick, repeatable threat-modeling lens is **STRIDE**: Spoofing (pretending to be someone else), Tampering (altering data in transit or at rest), Repudiation (denying an action with no audit trail), Information disclosure (leaking data), Denial of service (overwhelming the system), and Elevation of privilege (gaining rights you shouldn't have). Walk any design against those six and the missing controls announce themselves.

The organizing principle is **defense in depth**: assume every single layer will eventually fail, and make sure the next one still catches the attack. A WAF might miss a novel injection — but parameterized queries stop it at the database. An auth token might leak — but least-privilege scoping limits the blast radius. No single control is trusted to be perfect.

> **Key idea:** A WAF, rate limiting, and encryption are **compensating controls**, not substitutes for secure code. The interviewer wants to hear "and even if that's bypassed, the next layer…". Never present one control as the whole answer.

The rest of this module is the toolkit for each layer: the edge (WAF, rate limiting), the application (authorization), the code (OWASP), the data (compliance), and the build (supply chain). Then we run all of it end-to-end on one system.

## 02 Web Application Firewall (WAF)

A **WAF** is a filter that sits in front of your application and inspects **Layer-7 (HTTP/HTTPS)** traffic — the request path, headers, query string, and body — deciding to *allow, block, or challenge* each request before it reaches your servers. A traditional network firewall reasons about IPs and ports (Layers 3–4); a WAF understands the *content* of a web request, which is where application attacks live.

### Two security models

- **Negative security model (blocklist)** — match requests against signatures of known attacks (SQL injection patterns, XSS payloads, path traversal). Easy to deploy, but only stops what it recognizes.
- **Positive security model (allowlist)** — permit only traffic that matches a known-good schema and reject everything else. Far stronger, but expensive to build and maintain as the app changes.

Most real WAFs run a **managed ruleset** — commonly the **OWASP Core Rule Set (CRS)** — as a negative baseline, then layer your own custom rules on top. Cloud offerings (Cloudflare, AWS WAF, Azure Front Door) ship these rulesets plus rate-based rules and bot management as a service; a change is often just a DNS/proxy update.

> **Interview tip:** Always deploy a new WAF in **detection (count) mode** first, watch for **false positives**, tune the rules, *then* switch to blocking. Saying "I'd run it in count mode and tune before enforcing" signals you've operated one, not just read about it.

Where does it sit? At the edge, inline on the request path, typically fused with your CDN and load balancer:

```
client ──▶ CDN / edge ──▶ [ WAF ] ──▶ load balancer ──▶ app servers
                            │
                            ├─ SQLi / XSS / path-traversal signatures (OWASP CRS)
                            ├─ rate-based rules  (per-IP, per-path floods)
                            ├─ IP reputation + geo / bot rules
                            └─ custom rules  (block unused verbs, oversized bodies)
```

A WAF is your *first* layer, not your only one. It buys time against automated scanners and known payloads and gives you a place to push an emergency "virtual patch" while you fix the real bug — but a determined attacker with a novel payload can slip past it, which is exactly why the application code behind it still has to be secure.

## 03 Rate limiting & abuse prevention

**Rate limiting** caps how many requests a client may make in a window. It protects you three ways: it blunts **DoS/brute-force** attacks, it enforces **fairness** (one noisy tenant can't starve the rest), and it maps directly to **plan tiers and cost** (free = 100 req/min, pro = 10k). Nearly every public API needs it.

### The four algorithms to know

| Algorithm | How it works | Trade-off |
| --- | --- | --- |
| Fixed window | Counter per fixed clock window (e.g. per minute) | Dead simple; allows a 2× burst straddling the boundary |
| Sliding window log | Store timestamp of every request, count those in the last N sec | Exact and smooth; memory grows with traffic |
| Sliding window counter | Weighted blend of current + previous window counts | Near-exact, cheap memory — the common production choice |
| Token bucket | Bucket refills at a steady rate; each request spends a token | Allows controlled bursts; the default for most API gateways |

The **fixed-window boundary burst** is the classic gotcha: a client sending 100 requests at 00:00:59 and another 100 at 00:01:00 gets 200 through in one second while never breaking a per-minute limit. Sliding-window and token-bucket approaches exist precisely to smooth that out.

### Where to enforce, and on what key

Push rate limiting as far to the **edge / API gateway** as you can, so junk traffic dies before it touches app servers. In a distributed fleet, every node must agree on the count — so the counter lives in a shared store, typically **Redis**, keyed by the dimension you're protecting:

```
# Token bucket in Redis, keyed per API key (atomic via Lua / MULTI)
key   = "rl:{api_key}:{route}"
allow = redis.call_lua(refill_and_take, key, rate=100, per=60s, cost=1)

# On reject — be a good API citizen:
HTTP/1.1 429 Too Many Requests
Retry-After: 30
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1720368000
```

Choose the **key** deliberately: per-IP catches crude floods but punishes users behind shared NATs; per-API-key or per-user is fairer and ties to billing; per-endpoint protects an expensive route specifically. Real systems combine several.

> **Beyond simple counting:** Rate limiting is necessary but not sufficient for **abuse prevention**. Layer on: **bot detection** and CAPTCHA/JS challenges for scripted traffic, **credential-stuffing** defenses (device fingerprinting, exponential backoff, breached-password checks) on login, **per-plan quotas** for sustained fairness, and always return `429` with `Retry-After` so well-behaved clients back off gracefully.

## 04 Authorization: RBAC vs ABAC

First, separate two words people blur. **Authentication (authn)** is *"who are you?"* — proving identity (password, OAuth token, mTLS). **Authorization (authz)** is *"what are you allowed to do?"* — the decision this section is about. You authenticate once; you authorize on *every* request.

### RBAC — Role-Based Access Control

Users are assigned **roles** (`viewer`, `editor`, `admin`); roles carry **permissions**. The check is "does this user's role include this permission?" It's simple, easy to audit, and correct for the vast majority of systems. Its weakness is **role explosion**: once you need "editors, but only for their own team's documents, on weekdays," you end up minting a combinatorial pile of hyper-specific roles.

### ABAC — Attribute-Based Access Control

Access is decided by a **policy** that evaluates **attributes** of four things: the *subject* (user's department, clearance), the *resource* (owner, sensitivity, tier), the *action* (read/write/delete), and the *environment* (time, IP, region). It's dynamic and fine-grained — "allow if `resource.owner == user.id`" — but harder to reason about and audit, because a decision now depends on live data, not a static grant.

| Dimension | RBAC | ABAC |
| --- | --- | --- |
| Decision basis | Static role → permission | Live attributes + policy rules |
| Granularity | Coarse (per role) | Fine (per request context) |
| Context-aware | No (role is fixed) | Yes (time, ownership, location) |
| Auditability | Easy — list who has a role | Harder — must evaluate policies |
| Best when | Stable, well-defined job functions | Ownership, tenancy, dynamic rules |

In practice you **combine them**: RBAC for the coarse cut (is this a `free`, `pro`, or `admin` user?), ABAC for the fine cut (does this user *own* the specific record they're touching?). That ownership check is the one interviewers care about most — skipping it is the single most common real-world vulnerability, which you'll meet as OWASP **A01** in the next section.

> **Architecture pattern:** Decouple the decision from the enforcement: a **Policy Decision Point (PDP)** answers "allow or deny?" while a **Policy Enforcement Point (PEP)** in each service asks and obeys. Tools like **Open Policy Agent (OPA)** or AWS **Cedar** externalize policy as code; **ReBAC** (relationship-based, à la Google Zanzibar / SpiceDB) is the modern take for "can user X access object Y through some relationship?" — the model behind Google Docs sharing.

## 05 OWASP Top 10, mapped to architecture

The **OWASP Top 10** is the industry's consensus list of the most critical web application security risks, refreshed every few years. You are not expected to recite all ten in an interview — but you *are* expected to name the relevant ones for *your* design and point to the architectural control that mitigates each. Here is the 2021 list, each mapped to where it lives in a system.

| # | Risk | Architectural mitigation |
| --- | --- | --- |
| A01 | Broken Access Control | Enforce ownership on every object (ABAC), deny-by-default, no IDOR — server checks, never the client |
| A02 | Cryptographic Failures | TLS everywhere, encrypt PII at rest, managed KMS, no home-rolled crypto or secrets in code |
| A03 | Injection (SQL/NoSQL/cmd) | Parameterized queries, ORM, input validation, WAF as backstop |
| A04 | Insecure Design | Threat-model early, secure defaults, rate limits and quotas designed in |
| A05 | Security Misconfiguration | Hardened images, least-privilege IAM, no default creds, disable debug endpoints |
| A06 | Vulnerable & Outdated Components | Dependency scanning + SBOM (see §07); patch on a cadence |
| A07 | Identification & Auth Failures | MFA, strong session handling, lockout & rate limiting on login |
| A08 | Software & Data Integrity Failures | Signed artifacts, verified CI/CD, no unsigned deserialization |
| A09 | Logging & Monitoring Failures | Centralized audit logs, alerting, tamper-evident trails (also SOC 2 evidence) |
| A10 | Server-Side Request Forgery (SSRF) | Allowlist outbound hosts, block link-local/metadata IPs, no raw user URLs to `fetch` |

Two of these dominate modern designs. **A01 (Broken Access Control)** is consistently #1 — usually an **IDOR** (Insecure Direct Object Reference): `GET /orders/1043` returns someone else's order because the code checked *authentication* but never re-checked *ownership*. The fix is the ABAC ownership check from §04, on every read and write, server-side.

**A10 (SSRF)** matters the instant your backend fetches a URL supplied by a user — image proxies, webhooks, link previews, scrapers. An attacker points you at `http://169.254.169.254/` (the cloud metadata endpoint) and exfiltrates your instance credentials. The control is a strict outbound **allowlist** plus blocking private/link-local ranges. Keep this one in your pocket — it's the deep-dive that wins the Price Tracking case study below.

## 06 Data residency & compliance

Compliance is where *legal* requirements become *architectural* ones. You don't need to be a lawyer, but a senior engineer must know what these three regimes **force into the design** — because "we'll store all users in one US database" can be an illegal architecture, not just a suboptimal one.

| Regime | Scope | What it forces into your design |
| --- | --- | --- |
| GDPR | Personal data of people in the EU | Lawful basis + consent, data-subject rights, breach notice, minimization, residency |
| SOC 2 | B2B service providers (trust report) | Auditable controls: access, change mgmt, monitoring, encryption — with evidence |
| HIPAA | US healthcare data (PHI) | Technical safeguards, encryption, access logs, signed BAAs with vendors |

### GDPR — the one that reshapes architecture

The EU's General Data Protection Regulation grants users concrete **data-subject rights** that you must be able to satisfy on demand: access (export their data), **erasure** ("right to be forgotten"), rectification, and portability. It also mandates **data minimization** (collect only what you need), **privacy by design and by default**, and **breach notification within 72 hours**. Penalties reach the greater of **€20M or 4% of global annual revenue** — which is why this drives design, not just paperwork.

Two implications hit your architecture hardest:

- **Right to erasure → cascade deletes.** "Delete my account" must actually purge PII across every store — primary DB, replicas, caches, search indexes, backups (or documented, time-bounded backup expiry), and analytics. If you denormalized a user's email into five tables, you now own five deletes. Design for this from day one; retrofitting it is brutal.
- **Data residency → regional pinning.** Some data legally must *stay in region*. That pushes you toward **geo-sharding**: an EU user's PII lives in an EU region; cross-border transfer needs an adequacy decision or Standard Contractual Clauses. "Shard by region" becomes a compliance requirement, not a performance one.

**SOC 2** is a report, not a law — an independent auditor attests that your controls meet the Trust Services Criteria (security, availability, processing integrity, confidentiality, privacy). *Type I* checks design at a point in time; *Type II* checks that controls *operated* over 6–12 months. Practically, it forces the boring-but-real work: centralized audit logging, least-privilege access reviews, change management, and encryption — the same A09 controls from the OWASP table, now with evidence.

**HIPAA** governs US health data (PHI) and demands administrative, physical, and technical safeguards — encryption in transit and at rest, strict access controls, immutable audit logs of who viewed what — plus a signed **Business Associate Agreement (BAA)** with every vendor that touches PHI (your cloud provider included).

> **The design takeaway:** Compliance turns into three concrete architectural moves: **encrypt PII** (at rest + in transit), **log every access** to sensitive data immutably, and **be able to find and delete a single user's data** across the whole system. If your design can do those three, most of GDPR/SOC 2/HIPAA falls out naturally.

## 07 Supply-chain security

Modern services are mostly other people's code — a typical app pulls in hundreds of transitive dependencies. Attackers noticed. **Log4Shell** (a single logging library, 2021), **SolarWinds** (a poisoned build pipeline, 2020), and the **xz backdoor** (a maintainer-level social-engineering attack, 2024) all weaponized the supply chain rather than your code. This is OWASP **A06** and **A08** made concrete.

### The core controls

- **SBOM (Software Bill of Materials)** — a machine-readable inventory of every component and version in a build, in a standard format (**SPDX** or **CycloneDX**). When the next Log4Shell drops, an SBOM answers "are we affected, and where?" in seconds instead of a frantic week.
- **Dependency / SCA scanning** — Software Composition Analysis tools (Dependabot, Snyk, OWASP Dependency-Check, Trivy) match your dependency tree against CVE databases and open PRs to bump vulnerable versions. Run it in CI, gate on severity.
- **Pin & lock** — commit lockfiles and pin versions so a build is reproducible and a compromised upstream release can't silently slide in. Beware **typosquatting** (`reqeusts` vs `requests`).
- **Sign & verify provenance** — sign artifacts (Sigstore/cosign) and generate provenance attestations so a deploy can verify *this artifact was built from that source by our pipeline*. The **SLSA** framework grades exactly this maturity.

```
# Supply-chain gate, wired into CI
commit ──▶ CI build
             ├─ generate SBOM        (CycloneDX)          # what's in here?
             ├─ SCA scan vs CVE DB   (fail on HIGH/CRIT)  # A06 gate
             ├─ sign artifact        (cosign)             # A08 integrity
             └─ attach provenance    (SLSA attestation)
                     │
                     ▼
              deploy verifies signature + provenance before running
```

> **Interview tip:** When asked "how do you keep dependencies safe?", don't just say "we update them." Say: *"SBOM for inventory, SCA scanning gated in CI, pinned lockfiles for reproducibility, and signed artifacts with provenance so we know what we deployed."* That four-part answer reads as production experience.

## 08 Worked example: Price Tracking Service

Let's run the 5-step framework on a system that touches *every* concept above — *"Design a service that tracks product prices across e-commerce sites and alerts users when a price drops."* It has a public API (WAF, rate limiting), user PII (GDPR), plan tiers (RBAC/ABAC), a URL-fetching scraper (SSRF), and a big dependency tree (supply chain). Perfect stress test.

### ① Scope

- **Functional:** user adds a product URL + target price; the system scrapes prices on a schedule; on a drop below target, notify by email/push; user views price history and manages watches via a dashboard and public API.
- **Non-functional:** a hardened public API (untrusted callers), **PII protection + GDPR** (we store emails and behavioral data on EU users), high availability of alerts, correctness of price data, **abuse resistance** (both attackers hitting our API and us over-scraping target sites), and auditability (heading toward SOC 2).
- **Out of scope (say it):** the payment/billing flow, the ML "is this a genuine deal" model — keep the core tight.

### ② Estimate

```
users               = 5M,  avg 20 watches each  → 100M watch rows
distinct products   ≈ 10M    (many users watch the SAME item → dedupe!)
scrape cadence      = hourly → 10M ÷ 3,600s ≈ ~2,800 scrapes/s   (outbound = the real load)
price samples       = 10M × 24 = 240M rows/day
history storage     = 240M × 365 × 3yr × ~50 B ≈ ~13 TB          → time-series store, downsample old data
dashboard reads     ≈ a few hundred QPS, bursty                  → cache latest price per product
```

The estimate already made the key decision: **scrape the product, not the watch.** Deduping 100M watches down to 10M distinct products cuts outbound load 10× and keeps us from hammering target sites — a correctness *and* a good-citizen win.

### ③ Interface

```
# Create a watch (auth: OAuth token or API key; rate-limited per key)
POST /api/v1/watches
  body:    { "productUrl": "https://shop.example/item/42", "targetPrice": 59.99 }
  returns: 201 { "watchId": "w_8xK2", "productId": "p_5521" }

# Read a product's price history (only if you own a watch on it)
GET /api/v1/products/{productId}/history?from=...&to=...
  returns: 200 { "points": [ { "t": ..., "price": ... }, ... ] }

# GDPR: export or erase all of my data
GET    /api/v1/me/export        → 200 (async job → signed download)
DELETE /api/v1/me               → 202 (cascade-delete PII across all stores)
```

### ④ High-level design

```
                         ┌── WAF + rate limit (per API key, Redis token bucket) ──┐
client ──▶ CDN / edge ──▶│  API gateway  (authn → authz: RBAC tier + ABAC owner)  │──▶ app services
                         └────────────────────────────────────────────────────────┘        │
                                                                                             ▼
  users │ watches │ products │ price_history        ◀── primary DB (PII encrypted, EU-sharded)
                                   ▲                                                          │
        scrape scheduler ──▶ job queue ──▶ scraper workers ──▶ fetch target site ──▶ write price
                                                  │                                           │
                                                  └─ on drop below target ──▶ notification service ──▶ email/push
```

One request path for humans/API clients (guarded by WAF → gateway → authz), and a separate scraping pipeline (scheduler → queue → workers) that produces the price data the alerts run on.

### ⑤ Deep-dive & scale — the security & compliance layer

This is where the module pays off. Walk each control against the design:

- **Edge (WAF + rate limiting).** The public API sits behind a WAF running the OWASP CRS, with per-API-key token-bucket limits in Redis enforcing plan tiers (free = 100 req/min, pro = 10k) and returning `429 + Retry-After`. This is A04-by-design plus DoS protection.
- **Authorization (RBAC + ABAC).** **RBAC** handles the coarse tier — `free` caps at 5 watches, `pro` at 1,000, `admin` for support. **ABAC** handles the fine cut: `GET /products/{id}/history` must verify the caller *owns a watch* on that product. Skip that ownership check and you've shipped an **IDOR / A01** — the top risk on the list.
- **SSRF (A10) — the signature deep-dive.** Our scraper fetches *user-supplied URLs*. Naïvely, an attacker submits `productUrl = http://169.254.169.254/latest/meta-data/` and the worker cheerfully returns our cloud credentials. Mitigation: resolve the host and **block private, loopback, and link-local ranges**, enforce an **allowlist of real e-commerce domains**, disable redirects to internal targets, and run scraper workers in an **egress-restricted sandbox**. Naming SSRF here, unprompted, is the strongest single signal in this interview.
- **Injection (A03).** Product URLs and search terms hit the DB via parameterized queries only; the WAF is the backstop, not the primary defense.
- **Compliance (GDPR).** We store minimal PII (email), encrypted at rest with a managed KMS. `DELETE /me` triggers a cascade purge across primary DB, replicas, caches, the search index, and analytics, with backups on a documented expiry. EU users' PII is pinned to an EU shard (residency). Every access to a user's data is written to an immutable audit log — which doubles as SOC 2 (A09) evidence.
- **Supply chain.** The scrapers pull a large tree of HTTP/HTML-parsing libraries — prime A06/A08 surface. CI generates an SBOM, runs SCA gated on HIGH/CRITICAL CVEs, pins lockfiles, and signs artifacts with provenance so we deploy only what we built.
- **Scale.** Shard `price_history` by `product_id` in a time-series store (write-heavy, 240M rows/day) and downsample data older than 90 days; cache the latest price per product for dashboard reads; the job queue absorbs scrape spikes; and per-target-domain rate limits keep us a good citizen of the sites we scrape.

> **Why this design scores:** A junior answer draws the boxes and stops. A senior answer walks the **same** boxes a second time through the security lens — WAF, ownership checks, SSRF, cascade deletes, signed builds — naming the OWASP category and compliance driver at each step. That second pass *is* this module.

## 09 Your reps this week

Reading security is not doing security — reps are. Work these in order:

1. **Whiteboard the Price Tracking Service yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end with the 5-step framework, timed to ~35 minutes, *before* re-reading Section 08. Force yourself to add the security layer on a second pass — WAF, authz, SSRF, GDPR deletes, supply chain.
2. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design against security pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff security-minded engineer running a system design interview. Give me the prompt: "Design a Price Tracking Service that scrapes product prices and alerts users on a price drop." Then act as the interviewer — let me drive through requirements, estimation, API, and high-level design. Push hard on the security and compliance layer: ask how I stop one user reading another's data, what happens when a user submits a malicious productUrl, how "delete my account" works under GDPR, how I rate-limit the public API, and how I keep my scraper's dependencies safe. Push back on anything hand-wavy and keep asking "why?" and "what if that's bypassed?". Do NOT give me the answer. After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, security & compliance depth (WAF, RBAC/ABAC, OWASP mapping, GDPR, supply chain), and communication — with specific feedback and what a strong candidate would have added.
```

1. **Threat-model it.** Walk your Price Tracking design against the OWASP Top 10 table in §05, one row at a time. For each risk, either name your mitigation or write "GAP" — then fix the gaps. Bonus: run the same design through STRIDE.
2. **Explain RBAC vs ABAC back** to a rubber duck (or me) without notes, then justify which one guards the "can this user see this product's history?" check. If you can't explain why the ownership check is ABAC, not RBAC, that's a gap you don't have yet.
3. **Flashcards** (make these 5, review at week's end): *Which OWASP category is reading another user's record via a guessed ID, and the fix? · Which OWASP risk does a URL-fetching scraper introduce, and how do you block it? · Fixed-window vs token bucket — which avoids the boundary burst? · What three things must "delete my account" do to satisfy GDPR? · Name the four supply-chain controls (inventory → scan → pin → sign).*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the OWASP and authorization ones *before* your reps; save the deeper GDPR talk for when you want to go past the basics.

- **[OWASP Top 10 2021 — The List and How You Should Use It](https://www.youtube.com/watch?v=hryt-rCLJUA)** — Cyber Citadel · ~9 min · OWASP overview — Clear walk through all ten risks — the mental checklist for §05. Watch first.
- **[OWASP Top 10 API Security Risks: How To Protect Your APIs from Hackers](https://www.youtube.com/watch?v=gLKkvDRj5fs)** — apiguru · ~14 min · API security — The API-specific angle — broken auth, IDOR, and resource abuse on public endpoints.
- **[Role-Based Access Control (RBAC) vs. Attribute-Based Access Control (ABAC)](https://www.youtube.com/watch?v=rvZ35YW4t5k)** — IBM Technology · ~8 min · authorization — The clearest short explainer of the two models and when each fits.
- **[RBAC vs. ABAC: Which Should You Use?](https://www.youtube.com/watch?v=ZMwK-w4pyGY)** — Keeper Security · ~2 min · decision guide — A fast decision-oriented take to lock in the §04 trade-off.
- **[How Does a WAF Work? — Web Application Firewall Explained](https://www.youtube.com/watch?v=UlInbFEOlqg)** — Indusface · ~2 min · WAF — A crisp animation of L7 filtering — signatures, rules, and where the WAF sits.
- **[Privacy and GDPR: What All Developers Should Know](https://www.youtube.com/watch?v=6SHc7DWDDs4)** — NDC Conferences · ~60 min · GDPR for engineers — A full conference talk on what GDPR actually asks of the people writing the code. The deep dive — save it for after the basics.

**Read (optional depth):** the [System Design Primer — Security](https://github.com/donnemartin/system-design-primer#security) section (free) for the interview-shaped summary, and the [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) plus the OWASP Cheat Sheet Series as the definitive control checklists. (DDIA has no security chapter — this is the topic where the OWASP references beat the textbook.)

---
*Source: `modules/16-compliance-protection.html` — System Design Mastery. Interactive version has the live simulators.*
