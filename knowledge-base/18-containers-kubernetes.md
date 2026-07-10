# Containers & Kubernetes

*Phase 5 · Cloud & DevOps·Module 18·Weeks 9-10 · ~13 hrs*

Once you've designed a system, you have to **ship and run it** — and modern systems run as containers on an orchestrator. This module turns your architecture diagrams into deployable, self-healing, auto-scaling infrastructure.

## 01 Why containers changed everything

A **container** packages an application together with its exact dependencies — libraries, runtime, config — into one immutable artifact that runs identically on your laptop, in CI, and in production.

The old pain was "*works on my machine.*" You'd build against Python 3.11 and OpenSSL 3, then production had 3.9 and a different libc, and things broke in ways no one could reproduce. Containers kill that class of bug by shipping the whole userland with the app. The deploy artifact *is* the tested artifact.

People conflate containers with virtual machines, but the mechanism is different. A VM virtualizes **hardware** and boots a full guest OS with its own kernel — heavy, slow to start, gigabytes on disk. A container virtualizes the **operating system**: it's just a normal Linux process that the kernel has been told to isolate, using two features — **namespaces** (which give the process its own view of the filesystem, network, process tree, and users) and **cgroups** (which cap its CPU and memory). No guest kernel, no boot. That's why a container starts in milliseconds and a VM starts in seconds.

| Dimension | Virtual machine | Container |
| --- | --- | --- |
| Isolates | Hardware (own kernel) | OS process (shared kernel) |
| Startup | seconds | milliseconds |
| Footprint | GBs (full OS) | MBs (just the app) |
| Density / host | tens | hundreds+ |
| Isolation strength | Stronger (hypervisor) | Weaker (shared kernel) |

> **Key idea:** A container is **a process, not a machine**. It shares the host kernel and is isolated by namespaces + cgroups. Understanding this explains everything else — why it's fast, why it's small, and why kernel-level isolation is weaker than a VM's.

## 02 Docker: images, layers, builds

Docker is the tooling that made containers usable. Three nouns carry the whole model:

- An **image** is a read-only template — a filesystem snapshot plus metadata (entrypoint, env, ports). It's built once and never changes.
- A **container** is a running instance of an image: the image's read-only layers plus a thin *writable* layer on top for that run's changes.
- A **registry** (Docker Hub, ECR, GHCR) stores and distributes images by `name:tag` — or, immutably, by content `digest`.

### Layers & the build cache

An image is built from a `Dockerfile`, and **each instruction produces a layer** — a diff on top of the previous filesystem. Layers are content-addressed and cached: if an instruction and everything above it are unchanged, Docker reuses the cached layer instead of re-running it. This is the single most important thing to exploit for fast builds.

The rule that falls out: **order instructions from least-changing to most-changing.** Copy your dependency manifest and install dependencies *before* copying your source code — so an edit to a source file doesn't bust the (expensive) dependency-install layer.

```
# BAD — any code change re-runs the slow install
COPY . .
RUN npm install

# GOOD — deps cached until package.json changes
COPY package.json package-lock.json .
RUN npm ci              # cached layer, reused on every code edit
COPY . .                # only this cheap layer rebuilds
```

### Multi-stage builds

Your build toolchain (compilers, dev headers, the whole `node_modules` for building) does not belong in the image you ship. A **multi-stage build** uses one stage with the full toolchain to produce artifacts, then `COPY --from` only those artifacts into a tiny final stage. The result is a runtime image that's a fraction of the size — smaller to push, faster to pull, and with a smaller attack surface.

```
# ---- stage 1: build (has the full toolchain) ----
FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod go.sum .
RUN go mod download            # cached layer
COPY . .
RUN CGO_ENABLED=0 go build -o /app ./cmd/topk

# ---- stage 2: runtime (tiny, no compiler) ----
FROM gcr.io/distroless/static
COPY --from=build /app /app    # just the binary
USER nonroot:nonroot
ENTRYPOINT ["/app"]            # final image ≈ 10 MB, not 900 MB
```

> **Interview tip:** When asked "how do you keep images small and builds fast," name three things: **multi-stage builds** (drop the toolchain), **layer ordering** (deps before source), and a **minimal base** (`distroless`/`alpine` over a full OS). Pin by digest for reproducibility. That answer signals you've actually run this in production.

## 03 Kubernetes: the control loop

One container on one host is easy. Now run 400 containers across 30 machines, restart the ones that die, roll out a new version without downtime, and move workloads off a failing node — by hand, that's impossible. **Kubernetes (K8s)** is the orchestrator that does it for you.

Its core idea is **declarative reconciliation**: you submit the *desired state* ("I want 5 replicas of this image"), and K8s runs a control loop that continuously compares desired vs actual and takes action to close the gap. A pod crashes and now there are 4? The controller starts a 5th. You never issue imperative "start a container" commands — you edit the desired state and let the loop converge.

### Cluster anatomy

A cluster splits into a **control plane** and **worker nodes**:

- **Control plane** — the *API server* (the front door; everything goes through it), *etcd* (the consistent key-value store that *is* the cluster's source of truth), the *scheduler* (decides which node a new pod lands on), and *controllers* (the reconciliation loops).
- **Worker node** — runs the *kubelet* (the agent that starts/stops containers and reports health), *kube-proxy* (programs the network rules for Services), and a *container runtime* (containerd) that actually runs the containers.

### The objects you'll actually name in an interview

1. **Pod** *(smallest unit)* — One or more containers that share a network namespace (same IP) and storage. Pods are *ephemeral* — they get replaced, and their IP changes. You rarely create them directly.
2. **Deployment** *(manages pods)* — Declares "N replicas of this pod template." Owns a ReplicaSet, keeps the count correct, and orchestrates rolling updates and rollbacks. This is your primary workload object.
3. **Service** *(stable address)* — A stable virtual IP + DNS name in front of a shifting set of pods, load-balancing across them. Types: *ClusterIP* (internal), *NodePort*, *LoadBalancer* (cloud LB).
4. **Ingress** *(L7 routing)* — HTTP(S) routing into the cluster — host/path rules, TLS termination — fronting many Services through one entry point, run by an ingress controller (nginx, Traefik).
5. **Namespace** *(tenancy)* — A virtual partition for isolating and grouping resources (team, environment) with their own quotas and RBAC. `default`, `kube-system`, and yours.

Here's a minimal Deployment + Service — the two objects that turn an image into a reachable, self-healing workload:

```
apiVersion: apps/v1
kind: Deployment
metadata: { name: topk-api }
spec:
  replicas: 3                       # desired state — the loop keeps it at 3
  selector: { matchLabels: { app: topk-api } }
  template:
    metadata: { labels: { app: topk-api } }
    spec:
      containers:
      - name: api
        image: registry/topk-api:1.4.2
        ports: [ { containerPort: 8080 } ]
        readinessProbe:             # gate traffic until healthy
          httpGet: { path: /healthz, port: 8080 }
---
apiVersion: v1
kind: Service
metadata: { name: topk-api }
spec:
  selector: { app: topk-api }       # matches the pods above
  ports: [ { port: 80, targetPort: 8080 } ]
```

> **Mental model:** Pods are cattle, not pets. You never SSH in and fix one — you change the **desired state** and let the controller replace it. Design every service to be stateless and disposable so K8s can kill and reschedule it freely.

## 04 Config, secrets, scaling & Helm

A container image should be **environment-agnostic** — the same `topk-api:1.4.2` runs in staging and prod. Everything that differs per environment gets injected at runtime, which is where ConfigMaps and Secrets come in.

### ConfigMaps & Secrets

A **ConfigMap** holds non-sensitive configuration (feature flags, window sizes, service URLs) as key-value pairs, injected into a pod as environment variables or mounted files. A **Secret** is the same shape for sensitive values — API keys, DB passwords, TLS certs.

> **Gotcha that bites people:** Kubernetes Secrets are **base64-encoded, not encrypted**. Base64 is not security — anyone with read access decodes it instantly. For real protection you must enable **encryption-at-rest** for etcd, lock down RBAC, and ideally pull from an external manager (AWS Secrets Manager, Vault, Sealed Secrets). Saying this out loud is a strong seniority signal.

### Horizontal Pod Autoscaler (HPA)

The **HPA** automatically changes a Deployment's replica count based on observed load. It watches a metric (CPU, memory, or a custom/external metric) and every ~15s recomputes how many pods it needs:

```
desiredReplicas = ceil( currentReplicas × currentMetric / targetMetric )

# e.g. 4 pods averaging 90% CPU, target 60%:
#   ceil(4 × 90 / 60) = ceil(6) = 6 pods
```

Two prerequisites people forget: the pods must declare resource **requests** (otherwise there's no baseline to compute a percentage against), and a metrics source (`metrics-server`, or Prometheus via an adapter for custom metrics) must be running. You also set `minReplicas`/`maxReplicas` as guardrails.

```
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: topk-processor }
spec:
  scaleTargetRef: { kind: Deployment, name: topk-processor }
  minReplicas: 4
  maxReplicas: 60
  metrics:
  - type: Pods
    pods:
      metric: { name: kafka_consumer_lag }   # custom metric
      target: { type: AverageValue, averageValue: "2000" }
```

### Networking, briefly

K8s mandates a **flat network**: every pod gets its own IP and can reach every other pod directly, with no NAT — a **CNI** plugin (Calico, Cilium) implements it. Services give stable addressing on top; Ingress handles L7 entry; and **NetworkPolicies** are your firewall — by default everything can talk to everything, so you add policies to restrict pod-to-pod traffic (e.g. only the API may reach the database).

### Helm — the package manager

Hand-maintaining dozens of YAML files across environments is misery. **Helm** packages them into a *chart*: templated manifests plus a `values.yaml` of parameters. You install/upgrade a chart as a versioned *release*, override values per environment, and `helm rollback` to any previous release in one command.

```
helm install topk ./chart -f values.prod.yaml
helm upgrade topk ./chart --set image.tag=1.4.3   # new version
helm rollback topk 1                              # revert to release 1
```

## 05 ECS: Fargate vs EC2

Kubernetes is powerful but operationally heavy. On AWS, many teams reach for **ECS (Elastic Container Service)** instead — AWS's own, simpler orchestrator. You define a *task definition* (which containers, CPU/memory, env), run it as a *service* that keeps N tasks healthy behind a load balancer. The interview-relevant fork is the **launch type**: who owns the compute?

- **EC2 launch type** — you provision and manage a fleet of EC2 instances; ECS packs tasks onto them. You control the instance type, patching, and bin-packing, and you pay for the whole instance whether it's full or not.
- **Fargate launch type** — serverless. You just declare each task's CPU/memory; AWS provisions the compute invisibly. No instances to patch or scale. You pay per-task for exactly the resources requested.

| Dimension | EC2 launch type | Fargate |
| --- | --- | --- |
| You manage | The instances (OS, patching, scaling) | Nothing below the task |
| Pricing | Per instance-hour (idle = waste) | Per task vCPU/GB (no idle) |
| Bin-packing | Your job — dense & cheap if tuned | Automatic, but a premium per task |
| Cost at scale | Cheaper if steady & well-packed | Cheaper for spiky/low utilization |
| Best for | Steady high load, GPU, special AMIs | Bursty, low-ops, small teams |

The rule of thumb: **Fargate to move fast and stop managing servers**; **EC2 when steady, predictable load lets careful bin-packing beat Fargate's per-task premium**. And if you specifically want Kubernetes on AWS without running the control plane yourself, that's **EKS** — managed K8s, which itself can run its nodes on EC2 or Fargate.

## 06 GitOps: ArgoCD & Flux

How does a new image tag actually reach the cluster? The modern answer is **GitOps**: a Git repository is the single source of truth for your declarative infrastructure, and an in-cluster agent **continuously reconciles the live cluster to match Git**. You never `kubectl apply` to prod by hand — you open a pull request.

This flips the deployment model from **push** (CI reaches into the cluster and applies changes) to **pull** (an agent inside the cluster watches Git and pulls changes in). The payoffs are big:

- **Auditability** — every change is a reviewed, signed Git commit. The repo *is* the audit log.
- **Trivial rollback** — reverting a deploy is `git revert`; the agent reconciles back to the previous state.
- **No drift** — if someone hand-edits the cluster, the agent detects the divergence from Git and can self-heal it back.
- **Disaster recovery** — rebuild an entire cluster by pointing a fresh agent at the repo.

Two CNCF tools dominate. **ArgoCD** is application-centric with a rich UI showing sync status and diffs, and an "app-of-apps" pattern for managing many apps. **Flux** is a lighter, modular toolkit (a set of controllers) that leans CLI/API-first and has strong built-in image-update automation.

| Dimension | ArgoCD | Flux |
| --- | --- | --- |
| Model | Pull, in-cluster agent | Pull, in-cluster controllers |
| UI | First-class dashboard | Minimal — CLI / API-first |
| Shape | Monolithic app, opinionated | Modular GitOps toolkit |
| Multi-app | App-of-apps pattern | Kustomize + source controllers |
| Leans toward | Teams wanting visibility & RBAC | Composable, automation-heavy setups |

Both are correct answers. What matters in an interview is naming the *principle* — Git as source of truth, pull-based reconciliation, PR-driven deploys — not picking a winner.

## 07 Rolling updates & image scanning

Shipping a new version can't mean downtime. A Deployment's default **rolling update** replaces pods gradually: it spins up new-version pods, waits for their **readiness probe** to pass before sending them traffic, then terminates old ones — bounded by `maxSurge` (how many extra you may create) and `maxUnavailable` (how many may be down at once). Traffic only ever flows to healthy pods, so users see no interruption.

```
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 25%          # create up to 25% extra during rollout
    maxUnavailable: 0      # never drop below desired capacity

# if the new version misbehaves:
kubectl rollout undo deployment/topk-api   # instant revert to prior ReplicaSet
```

When you need more caution than a blind roll, reach for **canary** (send 5% of traffic to the new version, watch error rates, then ramp) or **blue-green** (stand up the new version fully, then flip the Service to it — instant switch, instant rollback). Rolling is the default; canary/blue-green buy you a controlled blast radius.

### Image scanning & supply-chain safety

A container image is a frozen snapshot of an OS — including whatever **known CVEs** its packages carry the day you built it. Production hygiene means scanning every image in CI for vulnerabilities with a tool like **Trivy**, **Grype**, or **Clair**, and failing the build on high-severity findings. Going further: **sign** images (`cosign`) so you can prove provenance, and add an **admission controller** that refuses to run unsigned or vulnerable images. This whole chain — scan → sign → verify at admission — is what "supply-chain security" means in practice.

> **Put it together:** A production pipeline reads end-to-end: **build multi-stage image → scan (Trivy) → sign (cosign) → push to registry → bump the tag in the Git manifest repo → ArgoCD reconciles → K8s does a readiness-gated rolling update.** Every step is automated and auditable. That's the shape you're aiming to describe.

## 08 Worked example: YouTube Top-K

Let's run the 5-step framework on *"Design a system that returns the Top-K most-viewed videos"* — the classic heavy-hitters problem — and then **deploy it on everything from this module**. The twist for a Cloud & DevOps interview is that the deep-dive isn't only the algorithm; it's how you containerize, scale, and roll out the design.

### ① Scope

- **Functional:** ingest a firehose of "video viewed" events; return the top-K (K≈100–1000) most-viewed videos over rolling windows (last 1 min, 1 hr, 24 hr), optionally per region.
- **Non-functional:** enormous *write* throughput; low-latency, high-QPS *reads* of the trending list; **approximate counts are acceptable** (nobody needs exact view counts to rank trending); highly available; and **elastic** — load spikes hard when a video goes viral.
- **Out of scope (say it):** personalized recommendations, exact per-video lifetime counts, fraud/bot filtering. Keep the core tight.

### ② Estimate

```
5B views/day        ≈ 58,000 events/s avg   (5e9 ÷ 86,400)
peak (×3 viral)     ≈ 175,000 events/s       → the number that drives autoscaling
trending reads 200M/day ≈ 2,300 reads/s      → tiny & cacheable (few hot keys)
K = 100–1000 per (window, region)            → result set is small
```

Verdict: writes dominate by ~75:1 and spike hard, so the *ingestion + processing* tier is what must autoscale; reads are trivial and cache beautifully. That single observation tells you where the HPA belongs.

### ③ Interface

```
# Ingest (fire-and-forget, extreme volume)
POST /v1/events/view   { "videoId": "...", "region": "US", "ts": 1720000000 }
  returns: 202 Accepted

# Read the trending list (hot, cacheable)
GET  /v1/trending?window=1h®ion=US&k=100
  returns: 200 { "videos": [ { "videoId": "...", "approxViews": 91230 }, ... ] }
```

### ④ High-level design

Never sort billions of counters on the read path. Precompute the answer with a streaming pipeline and serve it from a cache:

```
ingest API ─▶ Kafka (partitioned by videoId) ─▶ stream processors
                                                     │  per-shard, per-window:
                                                     │  Count-Min Sketch + min-heap(K)
                                                     ▼
                                          local top-K per partition
                                                     │
                                                     ▼  merge
                                            global top-K aggregator
                                                     │
                                                     ▼
                     Redis sorted-set  key = (window, region)   ◀── GET /trending
                                                     ▲
                          stateless serving API reads precomputed top-K
```

Partitioning Kafka by `videoId` means every view of a given video lands on the same processor, so its count is local and lock-free. Each processor keeps a **Count-Min Sketch** (approximate counts in fixed memory) plus a **min-heap of size K** (the running top-K). A two-tier merge combines per-partition top-Ks into a global one, written to Redis for the serving tier to read in O(1).

### ⑤ Deep-dive & scale — and how it ships

**Algorithmic scale.** A Count-Min Sketch trades a little accuracy for bounded memory — perfect since we only need *approximate* ranking. Rolling windows use bucketed counters (e.g. 60 one-minute buckets summed for the hour). The danger is a **hot partition**: a globally viral video overwhelms one processor. Fix it with key-salting (split the hot video across N sub-keys, sum at merge) or a two-level pre-aggregation.

**Now the module's payload — how this actually runs:**

- **Containerize each service** — ingest gateway, stream processor, aggregator, and serving API each become a *multi-stage* image (§02): a tiny distroless binary, scanned and signed in CI.
- **Deployments + Services** — each runs as a Deployment behind a Service (§03). The serving API sits behind an Ingress/LoadBalancer; the stream processors form a Kafka consumer group.
- **HPA on the processors** — the write tier is the elastic one. An HPA scales the `topk-processor` Deployment on **Kafka consumer lag** (a custom metric) rather than CPU: when a video goes viral, lag climbs, the HPA adds pods, each grabs more partitions, and lag drains — then it scales back down (§04). This is exactly the ×3 spike from step ②, handled automatically.
- **ConfigMap + Secret** — window sizes, K, and the region list live in a ConfigMap so you retune without rebuilding the image; Kafka SASL credentials and the Redis auth token live in Secrets (with etcd encryption-at-rest enabled — §04).
- **Helm** — one chart parameterizes replicas and resource requests per environment: small in staging, `maxReplicas: 60` in prod.
- **GitOps rollout** — CI scans + signs the new image and bumps its tag in the manifest repo; **ArgoCD** reconciles the cluster to Git and triggers a **readiness-gated rolling update** (§06–07). A new processor only takes traffic once it has joined the consumer group and its probe is green; a bad release is one `git revert` away.

> **See it move → your tool:** The serving tier — Ingress → stateless API replicas → Redis — is a textbook load-balanced read path. Stress and break it in the [🚦 Load Balancer Playground](../tools/load-balancer-simulator.html): watch how adding replicas (what the HPA does for you) changes tail latency under a viral spike.

Notice the shape of a strong answer: the *algorithm* (Count-Min Sketch + heaps) and the *operations* (containers, HPA, GitOps) are one continuous story. In a Cloud & DevOps round, leaving out the second half leaves points on the table.

## 09 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Whiteboard YouTube Top-K yourself.** Open [Excalidraw](https://excalidraw.com) (free) and design it end-to-end with the 5-step framework, out loud, timed to ~35 minutes — *and finish by drawing the deployment*: which pods, where the HPA sits, how a new version rolls out. Do this *before* re-reading Section 08.
2. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend both the design *and* its deployment against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff engineer running a Cloud & DevOps system design interview. Give me the prompt: "Design a YouTube Top-K system — the K most-viewed videos over rolling time windows — and explain how you would containerize, deploy, and scale it on Kubernetes." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push back on anything hand-wavy. Probe specifically on: why approximate counts are OK, hot-partition handling, what metric the HPA scales on and why (not just CPU), why Kubernetes Secrets alone aren't secure, and how a bad release is rolled back under GitOps. Do NOT give me the answer or lead me; keep asking "why?". After ~35 minutes (or when I say "done"), grade me 1–5 on each of: requirements gathering, capacity estimation, API design, high-level design, deep-dives & trade-offs, deployment/Kubernetes fluency, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Containerize something real.** Take any small app, write a *multi-stage* Dockerfile, and get the final image under ~50 MB. Then deploy it to a local cluster ([kind](https://kind.sigs.k8s.io) or minikube), add an HPA, and generate load until you watch it scale up and back down. Nothing teaches K8s like seeing the replica count move.
2. **Explain it back.** Teach a rubber duck (or me) two things without notes: the container-vs-VM mechanism (namespaces + cgroups), and the GitOps pull-based loop. Gaps you can't explain are gaps you don't have yet.
3. **Flashcards** (make these 5, review at week's end): *What are image layers and why does Dockerfile instruction order matter for caching? · What metric should the Top-K processor's HPA scale on, and what's the desiredReplicas formula? · Are Kubernetes Secrets encrypted by default — and what do you add for real security? · ECS Fargate vs EC2 launch type — one trade-off each way? · GitOps: what makes rollback trivial, and what's "pull vs push"?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the two "100 Seconds" primers first for the mental model, then go deep with the crash courses before your reps.

- **[Docker in 100 Seconds](https://www.youtube.com/watch?v=Gjnup-PuquQ)** — Fireship · ~2 min · docker primer — The fastest possible mental model of image vs container vs Dockerfile. Watch first.
- **[Docker Tutorial for Beginners [FULL COURSE in 3 Hours]](https://www.youtube.com/watch?v=3c-iBn73dDE)** — TechWorld with Nana · ~3 hrs · docker deep-dive — The definitive hands-on Docker course — Dockerfiles, layers, volumes, Compose. Skim the sections you need.
- **[Kubernetes Explained in 100 Seconds](https://www.youtube.com/watch?v=PziYflu8cB8)** — Fireship · ~2 min · k8s primer — Why an orchestrator exists and what pods/nodes/services are, in one breath.
- **[Kubernetes Crash Course for Absolute Beginners [NEW]](https://www.youtube.com/watch?v=s_o8dwzRlu4)** — TechWorld with Nana · ~1 hr · k8s beginners — Pods, Deployments, Services, and ConfigMaps hands-on. The best single intro to K8s objects.
- **[Kubernetes HPA with Demo | Horizontal Pod Autoscaler Demo](https://www.youtube.com/watch?v=Ays8sM-tylU)** — Java Home Cloud · ~15 min · autoscaling — Watch an HPA add and remove pods live under load — the exact behavior our Top-K processors rely on.
- **[How to Use Argo CD for GitOps (Beginner-Friendly Tutorial)](https://www.youtube.com/watch?v=c1sOAdQx91U)** — Akuity · ~20 min · gitops — Pull-based reconciliation in action, from the team behind Argo. See a Git commit become a live deploy.

**Read (optional depth):** DDIA Chapter 11 (Stream Processing) — the theory behind the Kafka + windowed-aggregation pipeline in our Top-K design. And [The Twelve-Factor App](https://12factor.net) (III. Config, free) — the discipline that ConfigMaps and Secrets exist to enforce: keep config out of the image and in the environment.

---
*Source: `modules/18-containers-kubernetes.html` — System Design Mastery. Interactive version has the live simulators.*
