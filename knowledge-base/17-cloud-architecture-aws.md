# Cloud Architecture (AWS)

*Phase 5 · Cloud & DevOps·Module 17·Weeks 9–10 · ~13 hrs*

Every design you've drawn so far — load balancers, caches, queues, sharded databases — has a concrete AWS service behind it; this module maps the boxes on your whiteboard to real infrastructure you can name, price, and defend in an interview.

## 01 The AWS mental model

The cloud is just **someone else's data center, rented by the second, and driven by an API**. AWS's value isn't the servers — it's that every piece of infrastructure you'd otherwise rack, wire, and babysit is now a managed service you provision in seconds and pay for only while it runs.

Before the service names blur together, anchor two geographic concepts that shape every availability and latency decision you'll make:

- **Region** — a physical location (e.g. `us-east-1` in Virginia, `eu-west-1` in Ireland). You pick a region to be close to users and to satisfy data-residency rules. Data and traffic *between* regions costs money and crosses the public backbone.
- **Availability Zone (AZ)** — one or more isolated data centers *within* a region, on independent power and networking. AZs in a region are close enough for low-latency replication but far enough that one failing doesn't take the others down. **The golden rule: deploy across at least two AZs.** A single-AZ system is a single point of failure with extra steps.

Everything else slots into four buckets, and every module you've done maps onto them: **compute** (run code), **storage** (keep bytes), **networking** (connect and protect), and **managed services** (databases, queues, caches you don't operate yourself). Your job as an architect is to pick the right service in each bucket for the requirements — the same trade-off lens from Module 1, now with a price tag attached.

> **Key idea:** AWS runs on a **shared responsibility model**: AWS secures the cloud (hardware, the hypervisor, the physical network); *you* secure what's *in* it (your data, your IAM permissions, your security-group rules, patching your own instances). Interviewers love the candidate who knows where that line sits.

## 02 Compute & storage: EC2, ECS, Lambda, S3

Three compute services form a ladder from "most control, most ops" to "zero servers, zero ops." You choose by how much operational burden you want to trade for control and cost predictability.

### EC2 — virtual machines

**Elastic Compute Cloud** gives you a raw virtual server: pick an instance type (a family + size like `m6i.large` — general-purpose; `c7g` — compute-optimized; `r6i` — memory-optimized), boot it from an **AMI** (a machine image), attach an **EBS** volume for persistent disk, and it's yours to configure. You own the OS, the patching, the runtime. To scale, you put EC2 instances behind a load balancer in an **Auto Scaling Group** that adds or removes instances based on a metric like CPU or request count. EC2 is the fallback for anything that doesn't fit a higher-level service: legacy apps, specialized runtimes, GPU workloads.

### ECS / Fargate — containers

**Elastic Container Service** runs Docker containers for you. You define a *task* (one or more containers + CPU/memory) and a *service* (how many copies to keep running behind a load balancer). Two launch modes: on **EC2** you manage the underlying instances; on **Fargate** you don't — you just say "run this container with 0.5 vCPU and 1 GB" and AWS finds the capacity. Fargate is the sweet spot for most microservices: containerized portability without babysitting servers. (Full container depth is Module 18 — Kubernetes.)

### Lambda — functions (serverless)

**Lambda** runs a function in response to an event — an HTTP request via API Gateway, a new object in S3, a message on a queue — and you pay per millisecond of execution, nothing while idle. No servers, automatic scaling from zero to thousands of concurrent invocations. The trade-offs that matter in interviews: a **cold start** (first invocation after idle spins up a runtime, adding latency), a **15-minute max** execution time, and statelessness (no local disk you can rely on between calls). Perfect for spiky, event-driven, short-lived work; wrong for long-running or latency-critical hot paths.

| Choose | When | You manage | Scaling |
| --- | --- | --- | --- |
| EC2 | Full control, legacy, GPU, custom OS | OS, patching, capacity | Auto Scaling Group (minutes) |
| ECS / Fargate | Containerized services, steady traffic | Container image only (Fargate) | Service desired-count (seconds) |
| Lambda | Event-driven, spiky, glue code | Just the function code | Automatic, per-request (instant) |

### S3 — object storage

**Simple Storage Service** is where the internet keeps its files. You put *objects* (any blob — an image, a video, a backup, a log) into *buckets*, addressed by key. It is effectively infinite, offers **eleven nines of durability** (99.999999999% — it replicates every object across multiple AZs), and is dirt cheap per GB. S3 is *not* a filesystem and not a database — it's a key→blob store with HTTP access. Core uses that show up in designs: storing user uploads, serving static website assets, holding data-lake/analytics files, and backups. Two features worth naming: **storage classes** (Standard for hot data, Infrequent Access and Glacier for cold/archival — cheaper storage, pricier retrieval) and **presigned URLs** (a time-limited signed link that lets a client upload or download directly to S3 without routing bytes through your servers — the standard pattern for photo/video uploads).

> **Interview tip:** When a design involves large media (photos, video), the senior move is: **store the blob in S3, put CloudFront (the CDN) in front, and keep only the metadata + S3 key in your database.** Never stream big files through your app servers — let clients hit S3/CloudFront directly via presigned URLs. You'll use exactly this in the Instagram case study below.

## 03 Databases & caching: RDS, ElastiCache

You learned the *concepts* of databases and caches in Phase 2. AWS gives you managed versions so you're not hand-rolling replication and failover on EC2.

### RDS — managed relational databases

**Relational Database Service** runs PostgreSQL, MySQL, MariaDB, SQL Server, or Oracle and handles the operational grind: backups, patching, and — critically — **Multi-AZ** and **read replicas**. Multi-AZ keeps a synchronous standby in a second AZ and fails over automatically if the primary dies (that's your *availability* lever). Read replicas are asynchronous copies you point read traffic at to scale reads (your *read-scaling* lever from Module 4). **Aurora** is AWS's cloud-native reimplementation of Postgres/MySQL — it separates compute from a distributed storage layer replicated 6 ways across 3 AZs, giving better throughput and near-instant replicas. Reach for RDS/Aurora whenever you need real transactions, joins, and strong consistency.

When the access pattern is key-based, massive-scale, and doesn't need joins, the AWS answer is **DynamoDB** — a managed, horizontally partitioned NoSQL store with single-digit-millisecond reads and effectively unlimited scale. It's the natural fit for high-write feed metadata, session stores, and anything you'd otherwise shard by hand.

### ElastiCache — managed Redis / Memcached

**ElastiCache** is a managed in-memory cache (Redis or Memcached) that sits between your app and the database to absorb the hot read path. Everything from Module 5 applies: cache-aside, TTLs, eviction. In an AWS design you'll name ElastiCache (Redis) for **session storage**, **read-through caching** of expensive queries, **rate limiting**, and **leaderboards / feeds** (Redis sorted sets). The one-line justification interviewers want: *"reads dominate ~100:1, so I put ElastiCache in front of RDS to keep p99 low and shield the database."*

> **The pattern to internalize:** **Client → CloudFront (CDN) → ALB → app (ECS/Lambda) → ElastiCache → RDS/DynamoDB**, with big blobs living in S3. Nearly every read-heavy web system you design on AWS is a variation of this spine. Learn it cold and you always have a defensible starting diagram.

## 04 VPC: your private network

A **Virtual Private Cloud** is your own isolated slice of the AWS network — a private IP space where your resources live, invisible to the internet until you deliberately open a door. Understanding it separates candidates who "use AWS" from those who can architect it securely.

### The building blocks

- **CIDR block** — the VPC's private IP range, e.g. `10.0.0.0/16` (65,536 addresses). Everything inside gets an IP from here.
- **Subnets** — you carve the VPC into subnets, each pinned to *one AZ*. A **public subnet** has a route to an **Internet Gateway (IGW)**, so resources in it can be reached from the internet (your load balancer, a bastion). A **private subnet** has no such route — databases and app servers live here, unreachable from outside.
- **NAT Gateway** — private-subnet resources often still need *outbound* internet (to pull packages, call an external API). A NAT Gateway lives in a **public** subnet and lets private instances make **outbound-only** connections — the internet can never initiate a connection back in. It's the one-way valve for private egress.

```
# A textbook 2-AZ VPC (10.0.0.0/16)
                         Internet
                            │
                      [Internet GW]
              ┌─────────────┴─────────────┐
        AZ-a  │                           │  AZ-b
   ┌──────────┴──────────┐     ┌──────────┴──────────┐
   │ PUBLIC 10.0.1.0/24  │     │ PUBLIC 10.0.2.0/24  │
   │  ALB node · NAT GW  │     │  ALB node · NAT GW  │
   ├─────────────────────┤     ├─────────────────────┤
   │ PRIVATE 10.0.11.0/24│     │ PRIVATE 10.0.12.0/24│
   │  app (ECS) + RDS    │     │  app (ECS) + RDS    │
   └─────────────────────┘     └─────────────────────┘
   outbound from private ──▶ NAT GW ──▶ IGW ──▶ internet
```

### Two firewalls: security groups vs NACLs

AWS gives you two layers of traffic control, and mixing them up is a classic interview stumble. The distinction is **stateful vs stateless** and **where they attach**:

|  | Security Group | Network ACL (NACL) |
| --- | --- | --- |
| Attaches to | The instance / ENI | The whole subnet |
| State | **Stateful** — reply traffic auto-allowed | **Stateless** — must allow return traffic explicitly |
| Rules | Allow rules only | Allow *and* deny rules |
| Evaluation | All rules evaluated together | Numbered, first match wins |
| Default | Deny all inbound, allow all outbound | Default NACL allows all both ways |

In practice: **security groups are your primary tool** — they're stateful, so if you allow inbound port 443, the response flows back automatically. You chain them by reference: the ALB's SG allows 443 from the internet; the app's SG allows traffic only *from the ALB's SG*; the database's SG allows 5432 only *from the app's SG*. That reference-chaining is the clean, least-privilege pattern. NACLs are the coarse, subnet-wide backstop — most teams leave them permissive and do the real work in security groups.

> **Interview tip:** Say "**stateful**" for security groups and "**stateless**" for NACLs and you'll sound like you've operated AWS. The follow-up trap: "if a security group allows inbound, do you need an outbound rule for the reply?" — **No**, because it's stateful. For a NACL, **yes**, you'd need to allow the ephemeral return ports.

## 05 Load balancing: ALB vs NLB

Module 2 taught load balancing as a concept; AWS's **Elastic Load Balancing** offers two you must be able to choose between, and the choice is exactly the **Layer 4 vs Layer 7** distinction from the OSI model.

- **Application Load Balancer (ALB)** — operates at **Layer 7** (HTTP/HTTPS). It reads the actual request: the URL path, host header, HTTP method, cookies. That lets it do *content-based routing* — send `/api/*` to one target group and `/images/*` to another, terminate TLS, do sticky sessions, health-check on an HTTP path. It is the default choice for web apps and microservices.
- **Network Load Balancer (NLB)** — operates at **Layer 4** (TCP/UDP). It doesn't open the packet; it just forwards connections by IP and port at extreme speed. That buys you *ultra-low latency*, the ability to handle millions of connections and sudden spikes, a **static IP per AZ**, and support for non-HTTP protocols (raw TCP, UDP, TLS passthrough). It preserves the client's source IP.

| Dimension | ALB (L7) | NLB (L4) |
| --- | --- | --- |
| OSI layer | 7 — application (HTTP) | 4 — transport (TCP/UDP) |
| Routes on | Path, host, headers, method | IP + port only |
| Latency | Higher (inspects request) | Lowest (just forwards) |
| Static IP | No (DNS name) | Yes, per AZ |
| Protocols | HTTP, HTTPS, gRPC, WebSocket | TCP, UDP, TLS passthrough |
| Reach for it when | Web apps, microservice routing | Extreme throughput, non-HTTP, static IP |

The default heuristic: **use an ALB unless you have a specific reason to drop to an NLB** — you need raw TCP/UDP, you're chasing every millisecond of latency, or you need a fixed IP to hand a partner to allow-list. Both distribute across AZs and integrate with Auto Scaling and target groups.

> **Play with it → your tool:** Open the [🚦 Load Balancer Playground](../tools/load-balancer-simulator.html) and drive traffic through different algorithms — round-robin, least-connections — then watch what happens when a target goes unhealthy. It's the same distribution logic an ALB runs, made visible.

## 06 Decoupling with SQS

**Simple Queue Service** is AWS's managed message queue — the async-decoupling pattern from Module 7, as a service you never operate. A producer drops a message; a consumer pulls it when ready. That one hop of indirection buys you three things every scalable system needs: **spike absorption** (the queue holds a burst so a sudden 10× doesn't crush your workers), **decoupling** (producer and consumer scale and fail independently), and **resilience** (if a worker dies mid-task the message reappears and another worker retries).

The mechanics worth naming in an interview:

- **Standard vs FIFO** — Standard queues are near-infinite throughput with *at-least-once* delivery and best-effort ordering (design consumers to be **idempotent**). FIFO queues guarantee exactly-once processing and strict order, at lower throughput. Default to Standard unless order truly matters.
- **Visibility timeout** — when a consumer picks up a message it becomes invisible to others for N seconds; if the consumer finishes and deletes it, done — if it crashes, the message reappears for retry. This is what makes the queue self-healing.
- **Dead-letter queue (DLQ)** — after a message fails processing K times, route it to a separate DLQ so one poison message doesn't block the line, and you can inspect failures later.
- **SQS vs SNS** — SQS is one queue, pulled by workers (point-to-point). **SNS** is pub/sub — one publish fans out to many subscribers. The classic combo is **SNS → many SQS queues** (fan-out): publish an event once, and several independent services each get their own copy to process.

```
# Async write path — user uploads a photo, response returns fast
client ─▶ ALB ─▶ app: store original in S3, write metadata row
                     │
                     └─▶ SQS ("process-image")
                              │
              ┌───────────────┼────────────────┐
        [worker] resize     [worker] ML tag    [worker] update feeds
        thumbnails→S3       (labels)           (fan-out to followers)

The user got a 201 in ~50 ms; the heavy work drains from the queue.
```

> **Interview tip:** The moment you hear "this step is slow / spiky / can happen later" — **image processing, sending email, generating a feed, transcoding video** — say "I'll do that **asynchronously via SQS** so the user-facing request stays fast." Then mention idempotent consumers and a DLQ, and you've shown production instinct, not just theory.

## 07 Infrastructure as Code (Terraform)

Clicking around the AWS console to build infrastructure is fine for learning and fatal for production — it's unrepeatable, undocumented, and impossible to review. **Infrastructure as Code (IaC)** fixes this: you *declare* your infrastructure in text files, version them in Git, and a tool makes reality match the file. **Terraform** (by HashiCorp) is the cloud-agnostic standard; AWS's native equivalent is **CloudFormation**.

Terraform is **declarative** — you describe the desired end state, not the steps. You write resources in HCL, run `terraform plan` to see a diff of what will change, then `terraform apply` to make it so:

```
# main.tf — declare an S3 bucket and a security group
provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "media" {
  bucket = "myapp-user-media-prod"
}

resource "aws_security_group" "web" {
  name        = "web-sg"
  description = "allow HTTPS in"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]   # open 443 to the world
  }
}

# workflow:  terraform init  →  plan (preview diff)  →  apply
```

Three concepts make Terraform click:

- **Providers** — plugins that know how to talk to a platform (AWS, GCP, Cloudflare). One config, many clouds.
- **State** — Terraform records what it has created in a *state file* so it can compute the diff between "what exists" and "what you declared." In a team you store this remotely (an S3 bucket + DynamoDB lock) so everyone shares one source of truth and two people can't apply at once.
- **Modules** — reusable, parameterized bundles of resources (a "VPC module," a "service module") so you don't copy-paste a network layout across five environments.

> **Interview tip:** The single most important IaC idea to voice: infrastructure changes go through the **same pull-request review as code** — `plan` shows the diff, a human approves, CI runs `apply`. That makes infra **reviewable, repeatable, and auditable**, and lets you rebuild an entire environment from scratch. Mishandled remote **state** (no locking, committed to Git with secrets) is the most common real-world Terraform failure — name it and you sound experienced.

## 08 Cloud cost optimization

In the cloud, **architecture decisions are cost decisions**. Elasticity cuts both ways: you can scale down and save, or leave things running and bleed money. Senior engineers reason about the bill, and interviewers increasingly probe it. Start with the compute pricing models — the biggest lever:

| Model | Discount vs on-demand | Use for |
| --- | --- | --- |
| On-Demand | baseline | Spiky, unpredictable, short-lived |
| Savings Plans / Reserved | up to ~72% | Steady baseline load (1–3 yr commit) |
| Spot Instances | up to ~90% | Fault-tolerant, interruptible batch/workers |

The playbook for keeping a bill sane:

- **Right-size and auto-scale.** The cheapest server is the one you turned off. Match instance size to real utilization and let Auto Scaling shrink capacity at night — don't pay peak 24/7.
- **Commit to your baseline, burst on-demand.** Cover the steady floor of load with Savings Plans; handle spikes with on-demand; run interruptible workers on Spot.
- **Tier your storage.** Use S3 lifecycle rules to move cold objects to Infrequent Access and Glacier automatically. Old logs and backups don't belong in hot Standard storage.
- **Watch data-transfer costs.** Data *into* AWS is free; data *out* to the internet and *across regions/AZs* is not. A CDN (CloudFront) in front of S3 both speeds delivery and cuts egress. Cross-AZ chatter adds up — a real, invisible line item.
- **Prefer serverless for spiky, low-volume work.** Lambda + S3 + DynamoDB scale to zero — you pay nothing when idle, which beats a permanently-running EC2 fleet for bursty workloads.

> **Key idea:** When you add a component in a design, add a sentence on its cost posture: *"CloudFront in front of S3 cuts egress and offloads reads,"* or *"these workers are interruptible, so Spot."* Naming the money trade-off alongside the latency/availability one is a senior signal that costs you nothing to say.

## 09 Worked example: Design Instagram

Let's run the Module 1 five-step framework on a classic — *"Design Instagram"* — and pin every box to a concrete AWS service so the abstract becomes real. Read it once, then do it yourself in the reps below.

1. **Scope** *(~5 min)* — Functional: upload a photo (with caption); view a home feed of photos from people you follow; follow/unfollow; like & comment. Non-functional: *extremely* read-heavy, very high availability, low-latency feed, durable media (never lose a photo), eventual consistency is fine (a new post appearing a few seconds late is OK). Out of scope (say it): DMs, Stories, search, ads.
2. **Estimate** *(~5 min)* — Size the load to justify choices — reads vs writes and media storage are what drive the architecture.
3. **Interface** *(~5 min)* — A small REST surface — upload, feed, follow — plus the presigned-URL trick so media never flows through app servers.
4. **High-level design** *(~10 min)* — Lay the AWS spine — CloudFront, S3, ALB, ECS, ElastiCache, DynamoDB/RDS — and trace an upload and a feed read end-to-end.
5. **Deep-dive & scale** *(~15 min)* — The feed. Fan-out on write vs read, the celebrity problem, and the hybrid that real systems use.

### ② Estimate

```
500M DAU
uploads: 100M photos/day  ÷ 100k  ≈ 1,000 writes/s   peak ×3 ≈ 3k/s
feed reads: each user opens feed ~10×, ~20 photos each
            500M × ~100 photo-reads/day = 50B/day
            50B ÷ 100k ≈ 500,000 reads/s               read:write ≈ 500:1 — brutally read-heavy
media: 100M photos/day × ~1.5 MB (multi-resolution)
       ≈ 150 TB/day → petabytes/year                   → S3, tiered; never a database
```

The estimate already dictates the design: **500:1 reads** screams CDN + cache + fan-out; **petabytes of media** means blobs live in S3 with only metadata in the database. No sharding decision is guessed — the numbers force each one.

### ③ Interface

```
# Get a presigned S3 URL, upload the bytes directly to S3, then commit metadata
POST /api/v1/media/presign   → 200 { "uploadUrl": "https://s3...", "key": "..." }
PUT  <uploadUrl>              # client → S3 directly, bytes never touch our servers
POST /api/v1/posts           body: { "s3Key": "...", "caption": "..." } → 201

# Read the home feed (the hot path — must be fast)
GET  /api/v1/feed?cursor=<ts>&limit=20  → 200 { "posts": [...], "next": "<ts>" }

POST /api/v1/follow          body: { "targetUserId": "..." } → 204
```

### ④ High-level design on AWS

```
                         ┌──────────────┐
        photo bytes ─────▶│  S3 (media)  │◀──── CloudFront (CDN) ────▶ viewers
        (presigned PUT)   └──────────────┘         serves images at the edge
                                 ▲
 client ─▶ CloudFront ─▶ ALB ─▶ ECS/Fargate app ──▶ ElastiCache (feed cache, hot)
                                    │                      │ miss
                                    │                      ▼
                                    ├──▶ DynamoDB: posts, follows, feed entries
                                    │
                                    └──▶ SQS ─▶ fan-out workers (build followers' feeds)
```

**Upload path:** client asks the app for a presigned URL → `PUT`s the photo straight to **S3** (bytes never touch our servers) → app writes a post row to **DynamoDB** → drops a message on **SQS** for async work. **Read path:** the feed request hits **CloudFront** → **ALB** → **ECS** app → serve the precomputed feed from **ElastiCache**; the image URLs point at CloudFront, so the actual JPEGs are served from the edge, not our backend. Metadata is small and lives in DynamoDB; the multi-petabyte media lives in S3.

### ⑤ Deep-dive: how is the feed built?

This is the heart of Instagram, and a perfect trade-off discussion. When you open the app, how does the server produce your feed quickly out of 500,000 reads/s?

| Strategy | How | Trade-off |
| --- | --- | --- |
| Fan-out on read (pull) | At read time, query everyone you follow and merge | Cheap writes; *slow, expensive reads* — bad at 500:1 |
| Fan-out on write (push) | On post, push the post ID into each follower's precomputed feed | Instant reads; but a celebrity post = millions of writes |
| Hybrid (what real systems do) | Push for normal users; pull for celebrities, merged at read | Best of both; more moving parts |

The winning answer names the **celebrity problem**: pure push breaks when one user has 100M followers (one post → 100M feed writes). So the hybrid: **fan-out on write** for ordinary accounts — when you post, SQS workers push your post ID into your followers' feed lists in **ElastiCache/DynamoDB**, so their read is a single fast lookup — but for celebrities, **skip the fan-out** and merge their recent posts in at read time. Then scale the pieces: **CloudFront** absorbs the media reads globally, **ElastiCache** holds hot feeds, **DynamoDB** partitions metadata by user so writes spread, and **SQS** smooths the fan-out spikes. Every move is triggered by the estimate — not guessed.

> **Notice the reuse:** Nothing here is new — it's Module 5's caching, Module 7's queues, Module 4's sharding, and Module 6's CDN, now wearing AWS names (ElastiCache, SQS, DynamoDB, CloudFront). That's the whole point of this module: you already know the architecture; now you can **provision and price it**.

## 10 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard Instagram on AWS yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end using the 5-step framework, out loud, timed to ~35 minutes — *before* re-reading Section 09. Force yourself to name a concrete AWS service for every box (which load balancer? where's the cache? what stores the photos?).
2. **Label a reference architecture.** Draw the VPC from Section 04 (2 AZs, public/private subnets, IGW, NAT) and annotate which security group allows what — ALB SG → app SG → database SG. If you can't chain the rules, re-read the firewall table.
3. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer at AWS running a system design interview. Give me the prompt: "Design Instagram." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push back hard on anything hand-wavy. Specifically probe: which compute (EC2 vs ECS vs Lambda) and why; where photos are stored and how they reach users; ALB vs NLB for the front door; how the home feed is built (make me defend fan-out on write vs read and handle the celebrity case); how I keep it inside a VPC securely (subnets, security groups); and one question on cost. Do NOT give me the answer or lead me — keep asking "why?". After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, deep-dives & trade-offs, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Explain it back.** Teach the CloudFront → ALB → app → ElastiCache → database spine to a rubber duck (or me) without notes, and say *why* each layer earns its place. Gaps you can't explain are gaps you don't have yet.
2. **Flashcards** (make these 5, review at week's end): *Security group vs NACL — which is stateful, and at what level does each attach? · ALB vs NLB — which layer, and when do you pick NLB? · Why does a NAT gateway sit in a public subnet, and what direction of traffic does it allow? · Fan-out on write vs read — which suits Instagram's 500:1 reads, and what breaks it? · Name the three EC2 pricing models and which workload each fits.*

## 11 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the EC2/S3 and VPC ones *before* your reps; treat the long freeCodeCamp and Terraform courses as references to dip into by chapter, not cover-to-cover.

- **[Beginners Guide to AWS EC2](https://www.youtube.com/watch?v=t5Ee67IGfSc)** — Johnny Chivers · ~19 min · compute — Clear, hands-on tour of EC2 — instances, AMIs, the console flow. Start here for compute.
- **[Amazon S3 Bucket Explained in 5 Minutes | AWS for Beginners](https://www.youtube.com/watch?v=SJmGzLLJDuA)** — SKSecOps · ~5 min · storage — Fast primer on buckets, objects, and durability — the storage half of Section 02.
- **[AWS VPC Beginner to Pro — Virtual Private Cloud Tutorial](https://www.youtube.com/watch?v=g2JOHLHh4rI)** — freeCodeCamp.org · ~1 hr · networking (reference) — The definitive free VPC walkthrough — subnets, route tables, IGW, NAT, security. Dip in by chapter.
- **[Load balancing in Layer 4 vs Layer 7 with HAPROXY Examples](https://www.youtube.com/watch?v=aKMLgFVxZYk)** — Hussein Nasser · ~9 min · load balancing — The exact L4-vs-L7 distinction behind NLB vs ALB, explained crisply. Watch before Section 05.
- **[Terraform for Beginners: AWS Infrastructure as Code](https://www.youtube.com/watch?v=wAwVOFf0Xq4)** — Telusko · ~35 min · IaC — Approachable first pass at Terraform on AWS — providers, resources, plan/apply.
- **[Complete Terraform Course — From BEGINNER to PRO!](https://www.youtube.com/watch?v=7xngnjfIlK4)** — DevOps Directive · ~2.5 hrs · IaC (deep-dive) — The thorough course — state, modules, remote backends. Bookmark and work through sections.

**Read (optional depth):** DDIA Chapter 1 (reliability, scalability, maintainability) reframes every AWS choice above as an availability/scalability trade-off. For AWS-native architecture guidance, skim the [System Design Primer](https://github.com/donnemartin/system-design-primer) sections on CDNs, load balancers, and asynchronism — they map one-to-one onto CloudFront, ELB, and SQS.

---
*Source: `modules/17-cloud-architecture-aws.html` — System Design Mastery. Interactive version has the live simulators.*
