# Prompt Engineering & Vibe Coding

*Track B · GenAI Development·Module B2·Weeks 13+ · ~13 hrs*

The prompt is the new interface to every model you'll ship on — so learning to write one **precisely** is now a core engineering skill, as fundamental to a GenAI developer as reading a stack trace.

## 01 From prompts to vibe coding

Prompt engineering is the craft of shaping an LLM's input so its output is **reliable, correct, and useful** — treating the prompt as a program you write in natural language rather than a wish you toss at a magic box.

The same skill scaled into a new way of building software. In early 2025 Andrej Karpathy coined **"vibe coding"** — "fully giving in to the vibes" and letting an AI write the code while you steer in plain English: describe the outcome, read the diff, accept or correct, repeat. Tools like GitHub Copilot, Cursor, and Claude Code turned that from a tweet into a daily workflow. The developer's job shifts from typing every line to *specifying intent precisely and reviewing what comes back*.

That shift is exactly why this belongs in a system-design track. A vague prompt produces plausible-looking code that's subtly wrong the same way a vague requirement produces a system that scales wrong. **Ambiguity in, ambiguity out.** The engineers who win with these tools aren't the ones with secret magic words — they're the ones who are relentlessly specific about context, constraints, and what "done" means.

> **Key idea:** You are now programming in English. The prompt is the source of truth, and the model fills every gap you leave with a confident guess — so the skill is **leaving fewer gaps**, not finding clever phrasing.

## 02 Anatomy of a developer prompt

A strong developer prompt is not a sentence — it's a small structured document. Four parts do the heavy lifting; a fifth (output format) is the cheap add that saves the most re-work. Assemble them deliberately every time until it's muscle memory.

1. **Role** *(who)* — Assign an expertise so the model draws from the right region of what it learned: *"You are a senior Go engineer who values simple, well-tested code."* It biases vocabulary, defaults, and rigor.
2. **Context** *(what it needs to know)* — The facts it can't see: the relevant code, the schema, the exact error, language/library versions, the runtime. A model can't read your repo — if a fact matters to the answer, it must be *in the prompt*.
3. **Task** *(the one verb)* — A single, specific instruction. "Refactor this function to be O(n)" beats "improve this code." One clear ask per prompt; split unrelated asks into separate turns.
4. **Constraints** *(the boundaries)* — The guardrails: language version, style, dependencies allowed or banned, performance targets, and explicit *don'ts* ("no external packages," "don't change the public API"). Constraints are where correctness lives.
5. **Format** *(how to answer)* — State the shape you want: a unified diff, a single function, strict JSON, "code only, no explanation." Ambiguous format is the #1 cause of re-prompting.

Put the most important instruction **first and last** — models weight the start and end of a prompt more heavily (primacy and recency), and a long middle can get lost. Prefer explicit over implicit: "return only the function body" is a rule the model can follow; "keep it clean" is a vibe it will interpret however it likes.

> **Practical tip:** Write constraints as a bulleted checklist, not prose. A list of five explicit rules ("Python 3.11 · type hints · no new deps · thread-safe · no prints") is followed far more reliably than the same rules buried in a paragraph.

## 03 Zero-shot → few-shot escalation

Examples are the highest-leverage tool you have, and the right amount is a ladder you climb only as far as you need. This is **in-context learning**: the model adapts to your examples at inference time, with no fine-tuning and no weight changes — the pattern lives entirely in the prompt (the idea popularized by GPT-3, "Language Models are Few-Shot Learners," 2020).

| Rung | What you give | Reach for it when |
| --- | --- | --- |
| Zero-shot | Instruction only, no examples | Common task, obvious format — the default; start here |
| One-shot | Instruction + 1 example | You need to pin an exact output shape or style |
| Few-shot | Instruction + 2–5 examples | Niche task, tricky format, or subtle labeling rules |

The discipline: **start zero-shot, escalate only when it fails.** If the model already nails it, examples just burn context tokens and latency. If the output format drifts or the task is unusual, add examples — they teach by demonstration far more efficiently than more description does. A few-shot classifier prompt looks like this:

```
# Classify the sentiment of a code review comment.
"This finally reads cleanly, nice work."  → POSITIVE
"Why is this O(n^2)? Redo it."            → NEGATIVE
"Ship it after the tests pass."           → NEUTRAL
"You reinvented a stdlib function again." →
```

Three rules make few-shot actually work: keep examples **representative** of the real inputs; keep the label set **balanced** and the ordering varied (a lopsided example set biases the model toward the majority label); and format every example **identically** so the pattern is unmistakable. Sloppy examples teach sloppy patterns.

## 04 Chain-of-thought prompting

**Chain-of-thought (CoT)** prompting asks the model to produce its intermediate reasoning steps *before* the final answer. On multi-step problems — arithmetic, logic, debugging, anything with several dependent decisions — writing the steps out measurably improves accuracy, because each step conditions the next instead of the model leaping straight to a guess (Wei et al., 2022).

The cheapest version is **zero-shot CoT**: append *"Let's think step by step"* (Kojima et al., 2022) and the model lays out its reasoning unprompted. For developer work, phrase it as a plan-first instruction:

```
# Force a plan before code
Before writing any code, outline your approach in 3–5 bullets:
edge cases, data structure, and complexity. Then implement it.
```

This surfaces a bad plan while it's still cheap to redirect — you catch "it's about to use a nested loop" before it writes fifty lines around one.

> **Important caveat:** The reasoning text is **not a faithful trace** of the model's internal computation — it's more output, generated the same way. Treat it as a useful scaffold and a review aid, not proof the answer is right. And modern reasoning-tuned models already do this internally, so explicit "think step by step" adds less there; use CoT where it earns its extra tokens and latency, skip it on simple lookups.

## 05 Iterating & fixing hallucinations

Prompting is a **loop, not a one-shot**. The first output is a draft. You read it critically, name the exact gap ("it ignored the timezone" / "that method doesn't exist"), and feed that back as the next, tighter prompt. Expert prompting looks less like one perfect incantation and more like fast, precise correction.

The failure you'll fight most is the **hallucination**: confident, fluent output that is simply wrong — a nonexistent library method, an invented function signature, an API parameter that was never real. It happens because the model predicts *plausible* tokens, not *true* ones; it has no built-in ground truth and will fill any gap rather than say "I don't know."

| Symptom | Fix |
| --- | --- |
| Invents an API / method that doesn't exist | Ground it — paste the real docs, signatures, or schema into context; don't trust parametric memory for specifics |
| Confidently wrong on facts | Add "if you're unsure, say so" and "cite the source"; verify against docs before you trust it |
| Drifts or over-reaches on a big ask | Decompose into smaller, checkable steps; constrain scope explicitly |
| Creative/inconsistent on a factual task | Lower the temperature (less randomness) for code and facts |
| You can't tell if it's right | Run it — execution is the ultimate ground truth |

> **The fastest filter:** Don't argue with a hallucination — **execute it**. Run the code, hit the endpoint, check that the import resolves. A failing run gives you the exact error to paste back, and that grounded correction beats any amount of re-wording.

## 06 Worked example: a real prompt

Watch the same request go from a coin-flip to a reliable one. The task: a token-bucket rate limiter for a service — a nice bridge from the system-design track.

### v1 — the vague ask (don't do this)

```
write a rate limiter in python
```

You'll get *a* rate limiter — but which algorithm, in-memory or distributed, thread-safe or not, with what limits? Every unstated choice is a guess you'll have to catch later.

### v2 — the structured prompt

```
# Role
You are a senior Python engineer who writes simple, well-tested code.

# Context
FastAPI service, Python 3.11, one process, multiple threads.
Redis is available via redis-py. Limit is per-user: 100 requests / 60s.

# Task
Implement a token-bucket rate limiter as a single module.

# Constraints
- thread-safe
- no new dependencies beyond redis-py
- full type hints; a docstring on the public method
- return (allowed: bool, retry_after_seconds: int)

# Reason first, then format
Outline the approach in 3 bullets (state, atomicity, clock),
then output the module only — no prose after the code.
```

Role, context, task, constraints, a chain-of-thought nudge, and an explicit output format — every ambiguity from v1 is now pinned.

### The iteration — grounding a hallucination

Say the model returns code calling `redis.token_bucket(...)`. Clean-looking, and **completely invented** — no such method exists. You don't rewrite the whole prompt; you ground the one gap:

```
redis-py has no token_bucket(). Reimplement using only these
primitives, atomically: run a single Lua script via EVAL that
reads a counter + timestamp, refills tokens, and returns the
allow/deny decision. Show the Lua and the Python wrapper.
```

Now it has the real building blocks and a real constraint (atomicity via one Lua round-trip). That's the whole loop: specify precisely → read critically → correct the exact gap. The magic was never a phrase — it was refusing to leave anything to chance.

## 07 Vibe coding in practice

Vibe coding is this loop run at speed with an agent that can edit files and run commands. It's genuinely powerful for prototypes and unfamiliar territory — and it drifts into a mess the moment you stop steering. The workflow that keeps it honest:

- **Commit before you generate.** Version control is your undo button. A clean `git` checkpoint means any AI change is a diff you can read and revert in one command.
- **Keep changes small.** One feature or fix per prompt. Huge asks produce huge, unreviewable diffs where bugs hide.
- **Read every diff.** Accepting code you haven't read is how subtle bugs and phantom dependencies ship. You own the code the moment you merge it.
- **Let tests be the ground truth.** Ask for tests alongside the code and run them. Green tests turn "looks right" into "is right."
- **Feed it context, not just vibes.** The best agents work against a spec, a task card, and the surrounding code — the same structure that makes a human contributor effective.

Karpathy's own framing is the right mental model: full vibe mode is great for a throwaway weekend project where a bug just means "try again." For production, you still own correctness — so when you hit critical, unfamiliar, or security-sensitive code, **drop out of vibe mode** and actually read and understand it. The antidote to vibe-coding drift is writing the spec first, which is exactly where the next module goes.

> **Free resource → drill it:** The open [Prompt Engineering Guide](https://www.promptingguide.ai) (DAIR.AI) has runnable, technique-by-technique pages for everything above — zero/few-shot, CoT, and more. Open it beside your editor and try each pattern on a task you actually have.

## 08 Your reps this week

Reading about prompting doesn't build the instinct — reps do. Do these, in order:

1. **Refactor v1 into v2.** Take a lazy one-line prompt you'd normally type and rewrite it with all five parts — role, context, task, constraints, format. Run both against the same model and compare the outputs side by side.
2. **Climb the ladder.** Pick a niche classification or formatting task. Try zero-shot; if it drifts, add one example, then a few. Note the exact rung where it locks in — that's your intuition forming.
3. **Force a hallucination, then ground it.** Ask for code using an obscure or made-up library. When it invents a method, fix it *only* by pasting real signatures or docs into context — don't just re-ask.
4. **Vibe-code a throwaway.** Build a tiny tool in an agent editor: commit first, keep prompts small, read every diff, make it write tests. Notice where you had to drop out of vibe mode and read.
5. **Run the drill rig below** to pressure-test a prompt against a tougher grader:

**Mock-interview / practice prompt:**
```
You are a staff engineer and a strict prompt-engineering coach. I will paste a prompt I wrote to get code (or another technical output) from an LLM. Do NOT answer the prompt. Instead: (1) score it 1–5 on each of role, context, task, constraints, and output format; (2) name every ambiguity or missing fact that would force the model to guess; (3) flag anything likely to trigger a hallucination and how to ground it; (4) tell me whether zero-shot, few-shot, or chain-of-thought fits and why; then (5) rewrite it as a tight, production-grade prompt and explain what you changed. Here is my prompt: <paste>
```

**Flashcards** (make these 5, review at week's end): *The five parts of a developer prompt? · When do you escalate from zero-shot to few-shot? · What does chain-of-thought buy you, and why not trust the reasoning text? · Three ways to fix a hallucination? · What's the one guardrail that makes vibe coding safe?*

## 09 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the prompt-engineering and shot/CoT ones *before* your reps; save the vibe-coding walkthroughs for when you're building.

- **[Prompt Engineering Tutorial – Master ChatGPT and LLM Responses](https://www.youtube.com/watch?v=_ZvnD73m40o)** — freeCodeCamp.org · full tutorial · guide — The comprehensive foundation — principles, structure, and technique end to end. Watch first.
- **[Prompt Engineering 101 - Crash Course & Tips](https://www.youtube.com/watch?v=aOm75o2Z5-o)** — AssemblyAI · crash course · guide — A fast, practical primer if you want the essentials before the full tutorial.
- **[Chain of Thought Prompting Explained](https://www.youtube.com/watch?v=S9OJC76qZ8A)** — StormWind Studios · short · reasoning — Why step-by-step reasoning lifts accuracy on multi-step problems, cleanly explained.
- **[Zero, One, and Few Shot Prompting with Langchain and OpenAI LLMs](https://www.youtube.com/watch?v=SNxe2kwgPi4)** — Ryan & Matt Data Science · hands-on · few-shot — The escalation ladder in real code — see in-context learning actually run.
- **[I figured out the best way to vibe code](https://www.youtube.com/watch?v=wwfJlSF34n8)** — Matthew Berman · walkthrough · vibe coding — A practical, opinionated workflow for steering an AI agent without losing the plot.
- **[The Ultimate Vibe Coding Tutorial (5 Hours)](https://www.youtube.com/watch?v=uianlp3QsmA)** — Jan Marshal · ~5 hrs · deep dive — Planning, prompting, execution, and debugging in one long build. Dip in by chapter.

**Read (free, and genuinely apt):** the open [Prompt Engineering Guide](https://www.promptingguide.ai) (DAIR.AI) for technique reference, and [Learn Prompting](https://learnprompting.org/docs/basics/few_shot)'s shot-based prompting chapter for a clean zero/one/few-shot walkthrough.

---
*Source: `modules/b2-prompt-engineering.html` — System Design Mastery. Interactive version has the live simulators.*
