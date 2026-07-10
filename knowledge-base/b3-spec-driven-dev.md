# Spec-Driven Development with AI

*Track B · GenAI Development·Module B3·Weeks 13+ · ~13 hrs*

Stop chatting code into existence one guess at a time — learn to write a **specification** the model implements, so generation becomes something you can review, reproduce, and trust at the scale a Forward-Deployed engineer actually ships at.

## 01 From prompts to specifications

A prompt is a **wish**. A spec is a **contract**. That one distinction is the whole module: the moment your task grows past a snippet, wishing stops working and you need a contract the model can be held to.

Early prompting — "vibe coding" — feels magical on small things: you describe a function, the model writes it, you tweak. But it degrades badly as scope grows, for three concrete reasons. **It under-constrains:** a one-line request leaves a hundred decisions (error handling, naming, edge cases, which existing utility to reuse) to the model's sampler, and it will guess differently every run. **It's unreviewable:** the intent lives in a throwaway chat transcript, so the only artifact left to review is the code itself — you can't diff what you *meant*. **It doesn't compose:** ten prompts in a row drift, because nothing pins the boundaries between them.

**Spec-Driven Development (SDD)** inverts the order. You write a structured specification *first* — the intent, the contract, the constraints, the acceptance criteria — and treat that document as the source of truth. The agent's job is to implement the spec; your job is to make the spec unambiguous. The code becomes a build artifact of the spec, the way a binary is a build artifact of source. Tools like [GitHub Spec Kit](https://github.com/github/spec-kit) and agentic IDEs like Kiro formalize this into a loop — **Spec → Plan → Tasks → Implement** — but the loop matters more than any tool.

> **Key idea:** In SDD the thing you author and version is the **spec**, not the code. If the output is wrong, you don't patch the code — you tighten the spec and regenerate. That's what makes the workflow reviewable and repeatable instead of a slot machine.

## 02 Anatomy of a good spec

A spec is not a paragraph of prose — prose is where ambiguity hides. A good code spec is a small set of **structured, parseable sections**, because a model (like a reviewer) reads structure more reliably than vibes. Five layers carry almost all the weight:

1. **Intent** *(why)* — One or two sentences on what this is for and the problem it solves. Grounds every downstream decision — the model uses it to break ties you didn't foresee.
2. **Contract** *(shape)* — The precise interface: typed function or class signatures, request/response schemas, HTTP verbs and status codes. Types remove whole categories of guessing.
3. **Constraints** *(rules)* — Performance (O(1) on the hot path), concurrency, dependencies you must reuse, style conventions, security rules. The non-obvious requirements a snippet-request would drop.
4. **Examples** *(proof)* — Concrete input → output pairs, especially edge cases. These double as few-shot guidance *and* as acceptance tests — write them once, use them twice.
5. **Acceptance & non-goals** *(done)* — The testable definition of done (passes these tests, this lint, this type-check) plus an explicit list of what NOT to build. Non-goals are how you stop the model gold-plating.

Prefer machine-friendly formats the agent can consume without interpretation: markdown headings for the skeleton, real function signatures and type definitions for the contract, and JSON Schema or OpenAPI for data and endpoints. A spec written as typed signatures plus examples leaves far less room for divergence than the same intent in English.

> **Interview / on-the-job tip:** Write your **acceptance criteria as executable examples first**. If you can't state a concrete input and the exact output you expect, the requirement isn't specified yet — it's still a wish. The examples you write become the tests the agent must pass, so specifying and testing collapse into one step.

## 03 Few-shot with your codebase

**Few-shot prompting** means putting a handful of input→output examples (typically 2–5 "shots") into the prompt so the model infers the pattern instead of inventing one. For code, the highest-leverage examples aren't textbook snippets — they're **real patterns pulled from your own repository**. The model imitates what you show it, so showing it your conventions is how you get output that looks like your team wrote it.

Three rules make this work:

- **Show, don't describe.** "Follow our error-handling style" is vague; pasting one canonical handler that raises your `ApiError` is unambiguous. A single good example out-specifies a paragraph of adjectives.
- **Use golden examples.** The model copies flaws as faithfully as virtues — one messy example poisons the batch. Pick a clean, correct, representative file and label it as the pattern to follow.
- **Anchor to real interfaces.** Reference the actual utility, base class, or type the new code must plug into (`src/ratelimit/base.py`) so the model *reuses* instead of reinventing a parallel abstraction.

```
# WEAK — describes, under-constrains, invites a fresh invention
"Add input validation to the new /orders endpoint."

# STRONG — few-shot with a golden pattern from THIS repo
Here is our canonical handler; follow its exact structure:

  # src/api/users.py  (the pattern to imitate)
  @router.post("/users")
  def create_user(body: CreateUser) -> UserOut:
      _validate(body)              # raises ApiError(422, ...)
      return svc.create(body)

Write the /orders handler the SAME way:
  - Pydantic model in src/api/schemas.py
  - a thin handler that calls _validate() then delegates to a service
  - raise ApiError on bad input; never return a bare dict
Return only the diff.
```

The second prompt gives the model a shape to fill, a file to reuse, and a boundary ("only the diff"). That's few-shot doing the heavy lifting the spec's Contract and Constraints sections point at — examples and structure, not more English.

## 04 Generating code that matches

Even with a tight spec, dumping the whole thing on the model and saying "build it" scales poorly — long generations wander and are hard to review. The reliable pattern is the SDD loop: **decompose, then verify each piece against the spec.**

1. **Plan** *(decompose)* — Have the model turn the spec into an ordered task list — the components and the sequence to build them. Review the plan before a line of code exists; fixing a bad plan is cheap.
2. **Implement one task** *(small chunks)* — Generate a single task at a time. Small units stay inside the context window, stay reviewable, and localize any error to one step.
3. **Verify against acceptance** *(machine-check)* — Run the tests, type-checker, and linter from the Acceptance section. Don't eyeball it — let the criteria you wrote judge the output.
4. **Feed failures back** *(close the loop)* — On a red test, hand the failure back to the model with the spec. The acceptance criteria become the feedback signal that drives it to correct itself.

The through-line is **traceability**: every requirement maps to code and to a test that proves it. That's what lets you trust generated code you didn't hand-write — not faith in the model, but a chain from intent to a passing check. Here's the shift in one table:

| Dimension | Prompt-only ("vibe") | Spec-driven |
| --- | --- | --- |
| Source of truth | A chat transcript | A versioned spec file |
| What you review | Re-read the code | Review intent; diff the spec |
| Re-run behavior | Different code each time | Same spec, same criteria |
| Scope control | Model guesses the edges | Non-goals stated explicitly |
| Verification | Eyeball it | Acceptance criteria + tests |
| Scales to | A snippet | A feature across a codebase |

## 05 Ambiguity & reproducibility

Be precise about a word that gets overused here: **determinism**. LLM generation is *not* truly deterministic — it samples from a probability distribution, so temperature > 0 means the same prompt can yield different code, and even at temperature 0 batching, hardware, and floating-point non-associativity make bit-for-bit identical output an unreliable assumption. What SDD actually buys you is not determinism but **reduced variance and improved reproducibility**: a much narrower, more predictable space of outputs, all of which satisfy the same checks.

You attack the problem from two directions at once:

### Shrink the input's ambiguity

- **Every unstated assumption is a coin flip.** A tight Contract and explicit Constraints remove degrees of freedom, so there are simply fewer decisions left for the sampler to make differently.
- **Examples collapse the space.** Few-shot input→output pairs pin down format and behavior far more tightly than description.
- **Non-goals cut off whole branches** the model might otherwise wander down.

### Constrain the output & the decoding

- **Lower the temperature** (or greedy/near-greedy decoding) for code tasks to cut sampling variance; set a **seed** where the provider exposes one for best-effort reproducibility.
- **Constrain the format** — structured outputs, JSON-schema-constrained decoding, or grammars force valid shapes and eliminate parse-time surprises.
- **Pin the model version** so an upgrade doesn't silently change behavior under you.
- **Backstop with guardrails:** tests, type-checks, schema validation, and CI catch the residual variance the above can't remove. This is the honest answer — you don't make generation deterministic, you make *wrong* generation loud and cheap to catch.

> **Say this out loud:** "Specs and low temperature don't make the model deterministic — they shrink the distribution of outputs and make every one of them checkable. Determinism I get from tests and schemas, not from hope." That framing is what separates a senior answer from a naive one.

## 06 Worked example: a rate limiter

Let's spec one small, real component — a token-bucket rate limiter — the SDD way. Read the spec and notice how little is left to guess:

```
# Spec: Token-Bucket Rate Limiter

## Intent
Cap each API key at a sustained rate while absorbing short bursts,
so one client can't exhaust shared capacity.

## Contract
class RateLimiter:
    def __init__(self, capacity: int, refill_per_sec: float): ...
    def allow(self, key: str, now: float) -> bool
        # True = admit the request, False = throttle it

## Constraints
- O(1) time and no per-request allocation on the hot path.
- Thread-safe: concurrent allow() on the same key stays correct.
- Tokens refill continuously (fractional), capped at `capacity`.
- An unseen key starts full (capacity tokens).
- Reuse the Limiter interface in src/ratelimit/base.py.

## Examples  (these ARE the tests)
capacity=2, refill=1/s
  allow(k, t=0) -> True    # 2 -> 1
  allow(k, t=0) -> True    # 1 -> 0
  allow(k, t=0) -> False   # empty, throttled
  allow(k, t=1) -> True    # +1 token refilled -> admit

## Acceptance
- Unit tests cover: burst-to-empty, refill over time, cap at capacity,
  isolation across keys, and monotonic `now`.
- Passes existing lint + type-check; conforms to base.Limiter.

## Non-goals
- Distributed / multi-node coordination (single process only).
- Persistence across restarts.
```

Every section is pulling weight. The **Contract** pins the signature so the model can't rename or reshape `allow()`. The **Examples** are literally the test cases — the refill-over-time row forces the continuous-refill math instead of a naive per-window reset. The **Non-goals** stop the model from "helpfully" reaching for Redis and building a distributed limiter you never asked for. Combined with a golden anchor ("here's our existing `FixedWindowLimiter` for style"), the space of plausible outputs is tiny — and whatever comes back either passes those five test groups or it doesn't.

Run it through the loop from Section 04: ask for a plan (bucket state, refill-on-read, the lock), implement `allow()`, then run the five example groups as pytest cases. A red test goes back to the model with the spec attached. You reviewed intent once, and a passing suite proves the rest.

> **Connect it back:** Rate limiting is a real system-design primitive — the same token bucket protects the services you stress in the [🚦 Load Balancer Playground](../tools/load-balancer-simulator.html). Spec-driven dev is how you'd actually ship that component: a tight spec, a golden pattern, and tests as the contract.

## 07 Your reps this week

Reading about specs won't teach you to write them — reps will. Do these in order:

1. **Rewrite a real prompt as a spec.** Take something you recently vibe-coded and reverse-engineer the spec you *should* have written: Intent, Contract, Constraints, Examples, Acceptance, Non-goals. Regenerate from the spec and compare.
2. **Drill the spec interview.** Paste the rig below into any capable LLM and let it force the ambiguity out of you before it writes a line:

**Mock-interview / practice prompt:**
```
You are a staff engineer who refuses to write code without a written spec.
I'll give you a feature in one loose sentence. Do NOT write code yet.
First, interview me until you can produce a complete spec with these
sections: Intent, Contract (typed signatures), Constraints, Worked
Examples that double as tests, Acceptance Criteria, and Non-goals. Push
back on every ambiguity and unhandled edge case — name the assumption
you'd otherwise have had to guess. When the spec is tight, echo it back,
THEN generate the code plus tests that satisfy exactly the acceptance
criteria, and show how each criterion is verified. Keep temperature low
and tell me where the output could still vary between runs.
My feature: "<paste one loose sentence here>"
```

1. **Build the token bucket for real** from the Section 06 spec, using a golden example from a repo you know. Did the five example rows survive as passing tests on the first regeneration? Where did it drift, and which spec section would have prevented it?
2. **Run the same spec twice** at temperature 0 and again at a higher temperature. Diff the two outputs. Seeing what stays fixed (the contract) versus what wanders (naming, comments, structure) is the whole reproducibility lesson in one experiment.
3. **Flashcards** (make these 5, review at week's end): *Prompt vs spec in one line? · The five/six sections of a code spec? · Why do worked examples double as tests? · Does SDD make generation deterministic — and if not, what does? · What do explicit non-goals prevent?*

## 08 Watch & read

Free, hand-picked, and link-verified for this module. Watch the intro and the reliability framing *before* your reps; save the hands-on tool walkthroughs for when you build the token bucket.

- **[Spec-Driven Development: AI Assisted Coding Explained](https://www.youtube.com/watch?v=mViFYTwWvcM)** — IBM Technology · ~10 min · intro — Clean mental model for what SDD is and why raw prompting breaks down. Watch first.
- **[Spec-Driven Development: The Discipline Behind Reliable AI Coding](https://www.youtube.com/watch?v=Gv4hd49lI4E)** — deepsense · ~15 min · reliability — Frames the spec as the guardrail that tames LLM variance — pairs with Section 05.
- **[The ONLY guide you'll need for GitHub Spec Kit](https://www.youtube.com/watch?v=a9eR1xsfvHg)** — Den Delimarsky · ~20 min · tooling — The Spec Kit maintainer walks the Spec → Plan → Tasks → Implement loop end-to-end.
- **[Up & Running with GitHub Spec Kit #1 — Intro & Setup](https://www.youtube.com/watch?v=61K-2VRaC6s)** — Net Ninja · ~12 min · hands-on — Gentle setup to actually run a spec workflow yourself. Start here before your reps.
- **[AWS re:Invent 2025 — Spec-driven development with Kiro (DEV314)](https://www.youtube.com/watch?v=4qcWgPb-8Fk)** — AWS Events · ~45 min · agentic IDE — How an agentic IDE turns specs into code + tests — the requirements→code path in practice.
- **[Spec-driven Development: How AI Changed Everything (And Nothing)](https://www.youtube.com/watch?v=35dH6q18UtI)** — Spring I/O · ~50 min · deeper cut — Conference talk placing SDD in the long history of software specs. Optional depth.

**Read (free):** Addy Osmani's [How to write a good spec for AI agents](https://addyosmani.com/blog/good-spec/) is a practical checklist for the anatomy in Section 02. Then skim the [GitHub Spec Kit methodology doc](https://github.com/github/spec-kit/blob/main/spec-driven.md) for the Spec → Plan → Tasks → Implement loop in full.

---
*Source: `modules/b3-spec-driven-dev.html` — System Design Mastery. Interactive version has the live simulators.*
