# The AI Toolkit & Developer Setup

*Track B · GenAI Development·Module B1·Weeks 13+ · ~13 hrs*

System design taught you to reason about systems — this track adds the other half of the modern senior job: wielding LLMs and AI tools as a daily engineering multiplier, starting with a clear map of the landscape and a dev environment set up the **right** way.

## 01 What the AI toolkit actually is

The AI toolkit is the set of **models, editors, and agents** you use to think, write, and ship code faster — and knowing how to choose them and wire them together is now a core engineering skill, not a party trick.

Keep three layers separate in your head, because tools blur them and it causes confusion. The **model** is the LLM itself — the raw intelligence (GPT, Claude, Gemini, Llama). The **surface** is how you reach it — a chat window, an IDE plugin, a terminal, or a raw API call. The **agent** is a loop wrapped around the model that lets it take actions — read files, run commands, call tools, check the result, and try again. The same underlying model can show up as a chat box, an autocomplete, or a fully autonomous coding agent; what changes is the surface and the loop around it.

Here's the mental model that makes all of this click: treat an LLM as an **extremely fast, widely-read junior engineer with confident recall but no accountability**. It has read more code than you ever will, produces a plausible answer in seconds, and will state a wrong answer with exactly the same confidence as a right one. Your job is not to "prompt" it — your job is to give it good context, aim it at verifiable work, and build the guardrails (tests, types, code review, small diffs) that turn its speed into trustworthy output.

> **Key idea:** The durable skill isn't typing clever prompts — it's **judgment**: which tool to reach for, how much to trust it, and how to verify. Models change every few weeks; that judgment transfers across all of them.

## 02 The map: four families of tools

The space feels chaotic because vendors ship weekly, but almost everything sorts into four families. Learn the *families*, not the logos — new products just fill an existing slot.

| Family | What it's for | Representative tools |
| --- | --- | --- |
| Frontier chat models | General reasoning, writing, planning, one-off code | ChatGPT (OpenAI), Claude (Anthropic), Gemini (Google); open-weight: Llama, Mistral, DeepSeek, Qwen |
| IDE copilots | Inline completion & in-editor edits, in flow | GitHub Copilot, Cursor, Windsurf, JetBrains AI, Amazon Q, Cody |
| CLI / agentic coders | Multi-step tasks across a repo, from the terminal | Claude Code, OpenAI Codex CLI, Aider, Gemini CLI, Cline |
| AI search / research | Grounded, cited answers instead of a stack of tabs | Perplexity, Phind, Kagi, Exa; in-engine AI overviews |

Three more categories sit adjacent and you'll meet them later in Track B: **embeddings + RAG** (search over your own data), **multimodal generation** (image / audio / video), and **orchestration frameworks** (LangGraph, LlamaIndex, the vendor Agents SDKs) for stitching models into pipelines. For this module we stay on the four that a working developer touches every single day.

## 03 Category deep-dive

### Frontier chat models — the raw intelligence

These are the general-purpose reasoners. You reach them two ways: through a **chat UI** (fast, throwaway iteration — debugging, brainstorming, explaining a stack trace) or through the **API** (when you want to automate the same call inside a script or product). The web chat and the API hit the same model; pick the surface by whether the work is a conversation or a program. Every other tool below is, under the hood, one of these models with a different loop bolted on.

### IDE copilots — intelligence in your editor

Copilots operate in two modes. **Inline completion** predicts the next lines as you type (the grey ghost text you Tab to accept) — great for boilerplate and staying in flow. **Agentic edit** takes a natural-language instruction and rewrites across multiple files while you watch. Architecturally there's a real split: **Copilot** is a plugin bolted onto existing editors (VS Code, JetBrains, Neovim), while **Cursor** and **Windsurf** are AI-native forks of VS Code that rebuilt the editor around the model, which buys tighter multi-file control at the cost of leaving your existing setup.

### CLI / agentic coders — the autonomous loop

These run in your terminal and are given real capabilities: read and edit any file, run commands, execute tests, read the output, and iterate — a genuine agent loop. They shine on larger, multi-step tasks ("add auth to these three routes and update the tests") where you supervise by reviewing the **git diff** rather than watching every keystroke. More power, more blast radius: you run these on a branch, never straight onto `main`.

### AI search — cited synthesis

AI search replaces "search, open six tabs, reconcile them" with a single synthesized answer plus citations. It's excellent for "what's the current best way to do X" and for unfamiliar libraries. The discipline is non-negotiable: **follow the citations**. A confident summary with a fabricated or misread source is worse than no answer, because it looks done.

## 04 The evaluation lens

This is the backbone of the whole module. When someone asks "which model / tool should I use?", the senior answer is never a name — it's *"for what task, judged on which of these four axes?"* Every choice is a trade-off across accuracy, context, cost, and latency.

| Axis | The question | How to weigh it |
| --- | --- | --- |
| Accuracy | Does it get *your* tasks right? | Measure on your own tasks; public benchmarks (SWE-bench, HumanEval, GPQA, MMLU) are directional and leak into training |
| Context window | How much can it hold at once? | Roughly 128K → 1M+ tokens today; bigger fits more code/docs, but attention degrades and cost rises with every token |
| Cost | What does a call actually cost? | Priced per million input/output tokens (output usually dearer); small "mini/flash" tiers can be an order of magnitude cheaper |
| Latency | How fast does it respond? | Time-to-first-token + tokens/sec; critical for interactive autocomplete, irrelevant for an overnight batch refactor |
| Ergonomics | Does it fit your workflow? | Editor/CLI integration, tool + MCP support, and data-retention / privacy policy for proprietary code |

A worked instinct: reaching for a top frontier model to reformat a JSON file is like chartering a jet to cross the street — it works, but you're paying premium tokens and latency for a task a tiny fast model nails. Conversely, saving pennies with a weak model on a security-critical refactor is a false economy. **Match the model tier to the value and verifiability of the task.** Two useful token facts to internalize: *a token is ~4 characters / ~0.75 words*, and *context degrades in the middle* — a model with a 1M window still attends best to the start and end, so where you put information in the prompt matters.

> **The move that beats every leaderboard:** Build a **golden set** of 8–12 real tasks from your own codebase, with known-good answers. Re-run it on each new model or tool and score it yourself. Your eval on your work is worth more than any public benchmark — and it takes an afternoon to build.

## 05 When AI helps vs when it hurts

The single predictor of whether AI helps is **verifiability**. AI accelerates work you can quickly check; it's dangerous precisely where you *can't* tell if the output is wrong — because a plausible-but-wrong answer costs you more than no answer.

| Reach for it | Slow down / keep the human in charge |
| --- | --- |
| Boilerplate, scaffolding, config | Novel algorithm or data-structure design |
| Unit tests for existing code | Security / auth / crypto / payments code |
| Glue for an unfamiliar API or library | Anything you can't read and verify yourself |
| Mechanical refactors under a test suite | Large, ambiguous tasks with no plan or tests |
| Explaining unfamiliar code; regex & SQL drafts | Subtle concurrency / consistency / correctness bugs |

The failure mode to fear isn't a crash — it's **confidently wrong output that compiles and looks right**: a hallucinated method that doesn't exist, an off-by-one in a boundary the tests don't cover, a subtly incorrect concurrency assumption. That's exactly the territory your system-design training warns about — the bugs live where you weren't looking.

> **Systems lens:** Think of an LLM as an **AP system** from Module 1: highly available, eventually-*ish*-correct, never strongly consistent with reality. Treat every output as a *proposal to be validated*, not a source of truth — and put the strongest guardrails where the blast radius is largest.

## 06 Setting up your AI dev environment

A good setup is deliberate, not "install everything." Five steps get you a workflow that compounds instead of one that fights you:

1. **Choose your layers** *(pick 3)* — One editor copilot for flow (Copilot / Cursor / Windsurf), one CLI agent for bigger tasks (Claude Code / Aider), and one chat model for thinking and debugging. More tools ≠ better; depth in a few beats shallow use of many.
2. **Write a rules / context file** *(highest ROI)* — Add a `CLAUDE.md`, `.cursorrules`, or `AGENTS.md` at the repo root: your stack, conventions, how to run tests and lint, and explicit do/don'ts. This one file is the difference between an agent that respects your codebase and one that reinvents it every session.
3. **Wire tools via MCP** *(capabilities)* — Give the agent real hands instead of copy-paste. The Model Context Protocol (MCP) lets it read your docs, query a database, run the test suite, or drive a browser through standard servers — turning a chat box into something that can actually check its own work.
4. **Secure your keys & data** *(non-negotiable)* — API keys live in env vars or a secret manager — never in prompts, code, or commits. Know each tool's data-retention / training policy, and use zero-retention or enterprise modes before you point an agent at proprietary code.
5. **Establish the loop** *(the habit)* — Branch per agent task; let tests and the type-checker be the guardrails; review every diff before you commit; commit in small steps. Reach for the cheapest model that clears the task, and escalate only when it can't.

> **Do this first:** If you do only one thing this week, write the **rules file** (step 2). It's the highest-leverage setup action by a wide margin — quality of agent output tracks the quality of that file more than the model you pick.

## 07 Worked example: shipping a feature with an AI pair

Let's add **rate limiting** to the URL shortener from Module 1 — protect `POST /api/v1/urls` so one client can't flood it. Watch how the human owns the trade-offs and the model owns the typing.

```
# A good agent prompt — context first, plan before code
Context: Node/Express service. Rules in CLAUDE.md. The handler is in
  src/routes/urls.js; existing middleware live in src/middleware/.
Task: add per-API-key rate limiting to POST /api/v1/urls.
Constraints: use our Redis client (src/redis.js); add tests; do NOT
  touch the redirect hot path GET /{code}.
First: give me a short PLAN and the key trade-off. Do not write code yet.
```

The agent proposes a **token-bucket in Redis** (atomic `INCR` + `EXPIRE`) over an in-memory counter — correct, because in-memory state doesn't survive multiple app servers (a Module 1 reflex). But it surfaces the decision *you* must make:

```
Plan:
  1. Redis token bucket keyed by api_key, window = 60s, limit = 100.
  2. Express middleware on POST /urls only; return 429 + Retry-After.
  3. Tests: under limit → 201, over limit → 429, window resets.

Open question for YOU:  if Redis is DOWN, do we
  fail-OPEN  (allow the write, lose the limit)  or
  fail-CLOSED (reject the write, stay protected)?   ← a design call, not a code call
```

You decide **fail-open** here — availability of link creation beats perfect rate enforcement during a Redis blip (again, the AP instinct). You tell the agent, it implements the middleware and tests, you run the suite, read the diff, confirm the redirect path is untouched, and commit. Total human effort: three decisions and a review. The model wrote the code; *you* owned the trade-off it can't own.

> **The whole skill in one line:** The model handled the **mechanism** (Redis bucket, middleware, tests); you handled the **judgment** (fail-open vs fail-closed under partition). That division of labor — AI for mechanism, human for trade-offs — is what senior AI-assisted engineering looks like.

## 08 Your reps this week

Reading about tools is not skill — running them under discipline is. Do these, in order:

1. **Build your golden eval set.** Pull 8–12 real tasks from your own codebase (a bug, a refactor, a test to write, an API to explain). Run each through two different tools and score accuracy, latency, and rough cost. You now have an opinion grounded in your work, not hype.
2. **Write a rules file.** Add a `CLAUDE.md` / `.cursorrules` to your main repo — stack, conventions, test/lint commands, do/don'ts. Re-run one task from rep 1 and feel the difference.
3. **Ship one real change with a CLI agent**, end to end: branch, ask for a plan first, let it implement, run the tests, review the diff line by line, commit. Notice where you had to step in.
4. **Cost audit.** Take a task you did on a frontier model and redo it on a cheap "mini/flash" tier. Was the quality actually different for that task? Downshift everything that passes.
5. **Coach + flashcards.** Paste the rig below into any LLM to be quizzed on this module, then keep the 5 flashcards for the week's end.

**Mock-interview / practice prompt:**
```
You are an interviewer for a senior / Forward-Deployed engineering role, drilling me on the modern AI developer toolkit. Ask me ONE question at a time, wait for my answer, then push back on anything vague and ask a harder follow-up before moving on. Cover: (1) the four families of AI tools and an example of each; (2) the difference between a model, a surface, and an agent; (3) the four evaluation axes — accuracy, context window, cost, latency — and how each changes a tool choice; (4) when AI helps vs when it hurts, and WHY verifiability is the deciding factor; (5) how you'd set up an AI dev environment and why a rules/context file matters; (6) a scenario: "an agent wrote code that passes tests but you're uneasy — what do you check?" After ~15 minutes, score me 1–5 on: tool-landscape fluency, evaluation reasoning, risk judgment, and setup discipline — with specific gaps and what a strong candidate would have added.
```

**Flashcards** (make these 5, review at week's end): *Name the four tool families + one example each · Model vs surface vs agent — what's the difference? · The four evaluation axes, and one decision each one drives · Why is verifiability the predictor of whether AI helps? · What is a rules/context file and why is it the highest-ROI setup step?*

## 09 Watch & read

Free videos, hand-picked and link-verified for this module. Start with what an LLM *is*, then work outward to picking models and wiring tools into your workflow.

- **[Large Language Models explained briefly](https://www.youtube.com/watch?v=LPZh9BOjkQs)** — 3Blue1Brown · ~8 min · foundations — The clearest short explanation of what an LLM actually is under the hood. Watch first — it makes every tool choice make sense.
- **[I Tested Gemini vs Claude vs ChatGPT So You Don't Have To](https://www.youtube.com/watch?v=18mkropUvl0)** — Parker Prompts · ~9 min · model comparison — A hands-on head-to-head of the frontier chat models. Watch for the method of comparing, not the specific verdicts.
- **[I Ranked Every AI Coding Assistant](https://www.youtube.com/watch?v=NAWcnIebQ-o)** — Jan Marshal · ~30 min · tool landscape — A tour across the coding-assistant field — use it to place each tool into the four-family map from Section 02.
- **[Github Copilot vs Cursor: which AI coding assistant is better?](https://www.youtube.com/watch?v=Wl5NJVieiBM)** — Steve (Builder.io) · ~8 min · Cursor vs Copilot — The core IDE-copilot head-to-head: how a plugin-on-an-editor differs from an AI-native editor in real use.
- **[My Workflow With AI: How I Code, Test, and Deploy Faster Than Ever](https://www.youtube.com/watch?v=2E610yzqQwg)** — DevOps Toolkit · ~18 min · dev environment — A practical look at wiring AI into the code → test → deploy loop — the Section 06 setup in motion.
- **[Full Walkthrough: Workflow for AI Coding — Matt Pocock](https://www.youtube.com/watch?v=-QFHIoCo-Ko)** — AI Engineer · ~96 min · deep workshop — A disciplined, plan-and-context-first AI-coding workflow, in depth. Save it for when you want the full masterclass.

**Read (optional depth):** there's no DDIA chapter on AI tooling — but **DDIA Chapter 1** (reliability, scalability, maintainability) is exactly the lens you apply the moment an LLM goes into production, because an AI feature is still a system that can fail. Pair it with the [System Design Primer](https://github.com/donnemartin/system-design-primer) for the fundamentals your AI-built services still rest on.

---
*Source: `modules/b1-ai-toolkit-setup.html` — System Design Mastery. Interactive version has the live simulators.*
