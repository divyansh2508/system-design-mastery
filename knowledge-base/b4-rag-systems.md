# RAG Systems & Context-Aware AI

*Track B · GenAI Development·Module B4·Weeks 13+ · ~13 hrs*

How to give a language model the **right facts at the right moment** — retrieval-augmented generation, embeddings, vector search, and the failure modes that separate a slick demo from a production developer assistant your team actually trusts.

## 01 What RAG is & why it exists

**Retrieval-Augmented Generation (RAG)** is the pattern of *fetching relevant text at query time and pasting it into the model's prompt* so the model answers from that grounded context instead of from memory alone.

A base LLM has three structural gaps that no amount of prompting fixes. It has a **knowledge cutoff** — it never saw your last sprint's decisions or last night's incident. It has **no access to private data** — your codebase, your wiki, your customer records were never in its training set. And it will **hallucinate** — when it doesn't know, it produces fluent, confident, wrong text, because it was trained to be plausible, not to abstain. RAG attacks all three at once: retrieve the actual passage, hand it to the model, and ask it to answer *from that*.

The mental model that keeps you honest: an LLM is a brilliant reasoner with **amnesia**; RAG is the open-book exam. You don't retrain the student for every new fact — you let them look it up. Fine-tuning teaches *behaviour and style*; RAG supplies *knowledge*. They solve different problems, and RAG is almost always the cheaper, faster, more auditable way to make a model current.

> **Key idea:** RAG doesn't make the model smarter — it makes the model **informed and citable**. Every answer can point at the source passage it used, which is what turns an AI toy into something a senior engineer will actually ship.

The payoff beyond accuracy is **trust and freshness**. Because the answer is grounded in a retrieved chunk, you can show the citation, and because knowledge lives in an index you own, updating a doc updates the model's answers instantly — no retraining, no redeploy. That property alone is why RAG became the default architecture for internal assistants, support bots, and code companions.

## 02 The RAG pipeline end-to-end

RAG splits cleanly into two phases: an **offline indexing** phase that runs when your data changes, and an **online query** phase that runs on every request. Almost every production bug lives in one of these six steps — knowing the seams is how you debug them.

1. **Ingest & chunk** *(offline)* — Pull in the source corpus (docs, wikis, code, tickets), split each document into passages of a few hundred tokens with some overlap. Chunking is the single highest-leverage decision in the whole pipeline.
2. **Embed** *(offline)* — Run every chunk through an embedding model to get a vector — a list of numbers that encodes meaning. Same model must be used at query time; mixing embedding models silently breaks retrieval.
3. **Index** *(offline)* — Store the vectors (plus metadata: source, path, timestamp) in a vector database with an approximate-nearest-neighbour index so similarity search is fast at millions of chunks.
4. **Retrieve** *(online)* — Embed the user's query with the *same* model, ask the index for the top-k most similar chunks. Optionally filter by metadata (this repo, this team, docs newer than X).
5. **Augment** *(online)* — Assemble a prompt: system instructions + the retrieved chunks (with their sources) + the user question. This "context stuffing" is where the R meets the G.
6. **Generate** *(online)* — The LLM writes the answer grounded in the supplied context, ideally citing which chunk each claim came from. You return the answer *and* its sources.

Read the flow in one line: **chunk → embed → index** (offline), then **embed query → retrieve → stuff → generate** (online). The G step gets all the attention, but in practice the quality of a RAG system is dominated by the **R** — if retrieval hands the model the wrong passages, no model can save the answer.

> **Play with it → your tool:** Open the [🧠 RAG Pipeline](../tools/rag-pipeline.html) and watch a query flow through all six stages — see how a chunk gets embedded, how top-k similarity picks passages, and how changing chunk size or `k` changes what lands in the prompt. Break retrieval on purpose and watch the answer degrade; that intuition is the whole module.

## 03 Embeddings & semantic search

An **embedding** is a function that turns a piece of text into a fixed-length vector of floating-point numbers — commonly 384, 768, or 1536 dimensions. The magic is *where* the vector lands: the model is trained so that texts with similar meaning end up close together in that high-dimensional space, even when they share no words. "How do I reset my password?" and "steps to recover account access" have almost no keyword overlap, but their vectors nearly touch.

That's the leap from keyword search to **semantic search**. Classic search (BM25, Elasticsearch's default) matches *tokens*; it's precise for exact terms and hopeless for synonyms and paraphrase. Semantic search matches *meaning* by measuring the distance between vectors. The usual distance is **cosine similarity** — the angle between two vectors, from 1.0 (identical direction) to −1.0 (opposite) — because we care about direction, not magnitude.

```
# The whole idea in five lines of pseudo-code
v_query = embed("how do I revoke an API key?")   # -> [0.02, -0.11, ...]  (768 floats)
for chunk in corpus:
    score = cosine(v_query, chunk.vector)          # nearness of meaning
top_k = sort_by(score, desc)[:5]                   # the 5 most relevant passages
```

A few properties worth carrying into interviews. **Dimensions are a trade-off:** more dims capture more nuance but cost more storage and slower search — 768 is a sane default, 1536 for richer corpora. **The embedding model is a hard dependency:** you must embed queries and documents with the *same* model, and if you upgrade the model you must re-embed the entire corpus. And embeddings are **lossy** — they compress a paragraph into a point, so fine-grained facts (a specific number, a negation) can wash out. That lossiness is the seed of several failure modes in Section 08.

Which model? For most teams a strong open model (the BGE or nomic families) run locally, or a hosted embedding API, both work well; the differentiator is rarely the model and almost always your *chunking and retrieval strategy* (Section 05). Pick a decent embedder, then spend your energy on the pipeline around it.

## 04 Vector databases & indexing

Once you have millions of chunk vectors, the core operation is: *given a query vector, find its nearest neighbours.* Doing that exactly means comparing the query to every stored vector — `O(n)` per query, fine for 10k chunks, ruinous at 10M. A **vector database** exists to make that search sub-linear by building an **Approximate Nearest Neighbour (ANN)** index — trading a sliver of recall for orders-of-magnitude speed.

The dominant ANN index is **HNSW** (Hierarchical Navigable Small World) — a layered graph you greedily walk from a coarse top layer down to fine-grained local neighbourhoods, reaching the nearest vectors in roughly logarithmic hops. The other common family is **IVF** (inverted-file), which clusters vectors and searches only the nearest clusters; often paired with **PQ** (product quantization) to compress vectors and shrink memory. The knobs (HNSW's `ef`/`M`, IVF's `nprobe`) all dial the same trade-off: **recall vs. latency vs. memory**.

| Option | Shape | Reach for it when |
| --- | --- | --- |
| pgvector | Postgres extension | You already run Postgres and want vectors next to your relational data — no new system |
| FAISS | In-process library | You need a fast, embeddable index and will manage persistence/serving yourself |
| Qdrant / Weaviate / Milvus | Dedicated vector DB | Large corpora, rich metadata filtering, horizontal scale as a first-class concern |
| Pinecone | Managed service | You want zero index ops and will trade cost/lock-in for it |
| Elasticsearch / OpenSearch | Search engine + vectors | You want dense *and* keyword search in one place (hybrid, Section 05) |

The feature that matters most in practice isn't raw speed — it's **metadata filtering**. Real queries are "find similar chunks *from this repo, on the main branch, updated this quarter, that this user is allowed to see*." A vector DB that filters efficiently *during* the ANN walk (not by over-fetching then discarding) is what makes multi-tenant, access-controlled RAG viable. Weigh that as heavily as benchmark QPS.

> **Interview tip:** Don't default to a shiny dedicated vector DB. If the corpus is under a few million chunks and you already run Postgres, **pgvector is often the senior answer** — one fewer system to operate, transactional consistency with your source data, and HNSW support built in. Name the scale threshold at which you'd graduate to a dedicated store.

## 05 Chunking & retrieval strategy

This is the section that separates working RAG from a demo, and it's the part beginners skip. The embedding model and vector DB are commodities; your **chunking and retrieval strategy** is where the quality actually comes from.

### Chunking

You split documents because a whole file is too big to embed meaningfully and too big to stuff into a prompt. But *how* you split decides what can ever be retrieved. Chunk too large and a single vector blurs several topics, so precision collapses; chunk too small and you sever the context a fact needs to make sense. Good defaults: **a few hundred tokens per chunk with ~10–20% overlap**, and — crucially — **split on natural boundaries** (headings, paragraphs, function definitions) rather than blindly every N characters. Attach metadata to every chunk (title, section, source path) so retrieval can filter and the model can cite.

### Retrieval quality

- **Hybrid search.** Dense (semantic) retrieval is great at paraphrase but can miss exact identifiers — an error code, a function name, a SKU. Combine it with sparse keyword search (BM25) and fuse the rankings. Hybrid beats either alone on almost every real corpus.
- **Reranking.** Retrieve a wide net (top-20 to top-50) cheaply, then run a **cross-encoder reranker** that scores each candidate against the query with full attention, and keep the best 3–5. This two-stage "retrieve wide, rerank narrow" is the highest-ROI upgrade you can make.
- **Tune `k` deliberately.** Too few chunks and you starve the model of context; too many and you drown the answer in noise and pay for tokens. Start at k≈5 *after* reranking and measure.
- **Query transformation.** Rewrite vague or multi-part questions before retrieving — expand acronyms, split compound questions, or generate a hypothetical answer to embed (HyDE). Small step, real recall gains on messy queries.

The through-line: **garbage retrieval → garbage answer**, and no model fixes bad retrieval. Spend your engineering budget here before you reach for a bigger LLM.

## 06 Connecting AI to your code, docs & internal data

Grounding a model in *your* world — the codebase, the runbooks, the design docs, the ticket history — is where RAG earns its keep for engineering teams. The pipeline is the same; the details of ingestion are what change.

- **Code needs code-aware chunking.** Don't split source by character count — split on structure. Chunk by function, method, or class using the language's syntax (a tree-sitter/AST parse), and carry the signature, file path, and symbol name as metadata. A chunk that stops mid-function is worse than useless.
- **Docs split on headings.** Markdown and Confluence pages have a natural hierarchy — respect it. Keep a heading trail ("Auth › Token rotation › Revocation") in metadata so retrieval can filter and answers can cite the exact section.
- **Incremental, not full, re-indexing.** Codebases and wikis change constantly. Re-embedding everything nightly is wasteful and stale; hash each chunk and re-embed only what changed, wired to a commit hook or a webhook. Freshness is a feature.
- **Access control is not optional.** Retrieval must respect who is allowed to see what. Stamp every chunk with its ACL (team, repo, visibility) and filter at query time. A RAG bot that surfaces a private repo's secrets to the wrong user is a security incident, not a bug.
- **Structured data is different.** For rows in a database, embedding raw records rarely beats letting the model write a query (text-to-SQL) or calling an API. RAG shines on *unstructured* text; know when a different tool fits better.

This is also the boundary where RAG starts shading into *agents*: once the assistant can choose *which* source to retrieve from, or decide to run a tool instead of retrieving, you're one step from Module B5. RAG is the retrieval substrate agents stand on.

## 07 Worked example: a developer assistant over your docs & code

Let's build the thing most teams actually want: *"Ask a question in Slack, get an answer grounded in our internal docs and codebase, with links to the source."* Read it once, then you'll design your own in the reps below.

### ① Scope

- **Corpus:** one monorepo (~2M lines) + a Confluence space (~4k pages) + closed Jira tickets.
- **Query:** natural-language questions from engineers — "how does token rotation work?", "where do we validate webhook signatures?"
- **Must-haves:** answers cite their sources, respect repo/space access, and stay fresh within a day of a merge or doc edit.

### ② Indexing pipeline (offline)

```
# Docs: split on heading hierarchy, keep the trail + ACL
for page in confluence:
    for section in split_by_headings(page):
        store(embed(section.text),
              meta={source:"confluence", url:page.url,
                    trail:section.heading_path, acl:page.space})

# Code: AST-chunk by function; carry signature + path as metadata
for file in repo.changed_since(last_index):        # incremental!
    for fn in ast_functions(file):
        store(embed(fn.signature + "\n" + fn.body),
              meta={source:"code", path:file.path,
                    symbol:fn.name, repo:repo.name})
```

### ③ Query pipeline (online)

```
q = "how do we revoke a leaked API key?"
v = embed(q)                                        # SAME embedder as indexing
cands = vectordb.search(v, k=30,
          filter={acl: user.allowed_spaces})        # wide net + access control
cands = bm25_merge(cands, keyword_search(q))        # hybrid: catch "API key", "revoke"
top   = rerank(q, cands)[:5]                         # cross-encoder narrows to the best 5
answer = llm(prompt(system, context=top, question=q))
```

### ④ The prompt (where R meets G)

```
SYSTEM: You are an engineering assistant. Answer ONLY from the
        provided context. Cite each claim as [source N]. If the
        context does not contain the answer, say you don't know.

CONTEXT:
  [source 1] confluence · Auth › Key rotation › Revocation
             "To revoke a key, POST /keys/{id}/revoke ..."
  [source 2] code · services/auth/keys.py · revoke_key()
             "def revoke_key(id): ... marks status=REVOKED ..."

QUESTION: how do we revoke a leaked API key?
```

Notice what the design buys you. The **"say you don't know"** instruction plus grounded context is your first line against hallucination. The **citations** make every answer auditable. The **ACL filter** keeps the blast radius safe. And **incremental indexing** means the answer reflects this morning's merge. None of that came from a bigger model — it came from the pipeline around it.

> **See it move:** The retrieve → rerank → stuff flow you just wrote is exactly what the [🧠 RAG Pipeline](../tools/rag-pipeline.html) lets you run interactively. Feed it this question, watch the top-k change as you adjust chunk size and `k`, and see how reranking reorders the candidates before they hit the prompt.

## 08 Limitations & failure modes of RAG

RAG is not "LLM + vector DB = done." It's an information-retrieval system bolted to a generator, and it fails in specific, diagnosable ways. Senior candidates name these failure modes and their fixes — that's what the "why RAG is hard" video in the next section is about.

| Failure mode | What you see | The fix |
| --- | --- | --- |
| Retrieval miss | Right answer exists, model says "I don't know" or guesses | Hybrid search, better chunking, query rewriting, raise k then rerank |
| Bad chunking | Fact is split across two chunks; neither is retrievable alone | Split on structure, add overlap, right-size chunks |
| Lost in the middle | Correct chunk was retrieved but ignored — it sat mid-context | Rerank so the best chunk is first; shrink k; keep context tight |
| Grounded hallucination | Model contradicts or embellishes beyond the context | "Answer only from context / else abstain" prompt; verify citations |
| Stale index | Answer reflects last month's code/docs | Incremental re-indexing on merge/edit; timestamp + freshness filters |
| Context overflow / cost | Too many chunks blow the window, add latency and $ | Rerank to a tight top-k; compress or summarize chunks |
| No evaluation | You can't tell if a change helped or hurt | Build an eval set; measure retrieval + answer quality (below) |

Two structural truths to internalize. First, **the bottleneck is almost always retrieval, not the LLM** — when an answer is wrong, check what got retrieved *before* you blame the model. Second, **RAG reduces hallucination but never eliminates it**: the model can still ignore, misread, or over-extend the context, so grounding is a strong prior, not a guarantee — keep the citations and keep a human in the loop for high-stakes answers.

And you cannot improve what you don't measure. A real RAG system needs **evaluation on two axes**: *retrieval* quality (did the right chunk make the top-k? — recall@k, precision) and *generation* quality (is the answer faithful to the retrieved context, and does it actually answer the question?). Build a small labelled eval set of real questions early; it turns "the vibes are off" into a number you can move.

## 09 Your reps this week

Reading is not learning — reps are. Do these, in order:

1. **Design a RAG dev-assistant yourself.** Whiteboard the full pipeline for "answer questions over our docs + codebase with citations," end-to-end, out loud, timed to ~35 minutes — *before* re-reading Section 07. Name a choice and its trade-off at every box: chunking, embedder, vector store, hybrid + rerank, eval.
2. **Run a mock interview.** Paste the rig below into me (or any LLM) and defend your design against pushback:

**Mock-interview / practice prompt:**
```
You are a senior staff ML/platform engineer running a system design interview. Give me the prompt: "Design a RAG-powered developer assistant that answers questions over our internal docs and codebase, with citations." Then act as the interviewer — let me drive, ask clarifying and probing questions, and push hard on the parts candidates skip: chunking strategy, embedding-model choice and re-embedding cost, vector DB selection (pgvector vs a dedicated store) and the scale threshold between them, hybrid search vs pure semantic, reranking, top-k tuning, access control on retrieval, incremental indexing/freshness, evaluation (retrieval recall@k AND answer faithfulness), and the failure modes (retrieval miss, lost-in-the-middle, grounded hallucination, stale index). Do NOT give me the answer or lead me. After ~35 minutes (or when I say "done"), grade me 1-5 on each of: problem framing, retrieval design, embeddings & vector store, chunking & ranking, evaluation & failure-mode awareness, and communication — with specific feedback and what a strong candidate would have added.
```

1. **Break it in the tool.** In the [🧠 RAG Pipeline](../tools/rag-pipeline.html), deliberately mis-size chunks and drop `k` to 1 — watch the answer degrade, then fix it. Feeling retrieval fail is worth more than reading about it.
2. **Explain it back.** Teach "why is retrieval the bottleneck, not the model?" and "why does RAG reduce but not eliminate hallucination?" to a rubber duck (or me) without notes. Gaps you can't explain are gaps you don't have yet.
3. **Flashcards** (make these 5, review at week's end): *Why does RAG reduce but not eliminate hallucination? · Dense vs. sparse (BM25) retrieval — when hybrid? · What does HNSW trade, and for what? · Why does chunk size matter, and what is "lost in the middle"? · What two axes must a RAG eval measure?*

## 10 Watch & read

Free videos, hand-picked and link-verified for this module. Watch the RAG and embeddings explainers *before* your reps; save the failure-modes one for *after* you've designed your own pipeline.

- **[What is Retrieval-Augmented Generation (RAG)?](https://www.youtube.com/watch?v=T-D1OfcDW1M)** — IBM Technology · ~7 min · RAG explained — The clearest short intro to the retrieve-then-generate loop and why it beats a bare LLM. Watch first.
- **[Vectoring Words (Word Embeddings)](https://www.youtube.com/watch?v=gQddtTdmG_8)** — Computerphile · ~16 min · embeddings — Builds real intuition for how meaning becomes geometry — why similar text lands nearby in vector space.
- **[Word Embedding and Word2Vec, Clearly Explained!!!](https://www.youtube.com/watch?v=viZrOnJclY0)** — StatQuest with Josh Starmer · ~16 min · embeddings — The mechanics under semantic search, at a gentle pace. Great second take on embeddings.
- **[What is a Vector Database?](https://www.youtube.com/watch?v=t9IDoenf-lo)** — IBM Technology · ~9 min · vector DB — What a vector store is, why similarity search needs one, and where it sits in a RAG stack.
- **[Vector Search & Approximate Nearest Neighbors (ANN) | FAISS (HNSW & IVF)](https://www.youtube.com/watch?v=chz74Mtd1AA)** — Mustafa Zaki · ~15 min · indexing deep cut — How ANN indexes actually work — the HNSW vs. IVF trade-off behind every vector DB. Optional depth.
- **[Why RAG Fails in Production — And How To Actually Fix It](https://www.youtube.com/watch?v=j0d68suEaS4)** — CodeRash with Gaurav · ~12 min · failure modes — The gap between a demo and a system that survives real traffic. Watch AFTER your own design attempt.

**Read (optional depth):** DDIA Chapter 3 (Storage & Retrieval) for the indexing intuition that HNSW/IVF build on — same nearest-neighbour problem, higher dimensions. For the pattern itself, the original *Retrieval-Augmented Generation* paper (Lewis et al., 2020, free on arXiv) is the primary source, and the free [System Design Primer](https://github.com/donnemartin/system-design-primer) covers the caching/serving scaffolding a production RAG service still needs.

---
*Source: `modules/b4-rag-systems.html` — System Design Mastery. Interactive version has the live simulators.*
