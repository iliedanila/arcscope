# arcscope v2 — Agent-authored, continuously-verified architecture knowledge

> Status: **implemented** — proof slice + structural discovery layer merged to `main`. Supersedes the v1 thesis where noted.
> v1 source of truth remains [arcscope-spec.html](arcscope-spec.html); this document records the v2 pivot and the reasoning behind it.

## 1. Why (the motivating failure)

A real bug in the dogfood repo (`knowledge-graph`): copying a document produced linked
nodes whose badges showed `…` instead of a number. The invariant was *"every way of
copying a document must re-number link badges"* (`normalizeLinkOrderForCanvas`). It was
**fixed twice** — the first fix patched the shared clone helper (two app paths that
import it); two days later a second fix was needed for a **cloud-function path that
hand-mirrors the clone logic** because a build boundary forbids it from importing the
shared helper.

The second path shares **no machine-detectable signal** with the first: different folder,
no shared import, generic internal names. So:

- v1 arcscope (tree-sitter + import graph) would have **missed the exact path the humans
  missed.** `find_refs` on the helper returns the two app importers and stops.
- This is not a hole to patch in the structural tier. **No structural analysis — not
  tree-sitter, not a full call graph — can cluster code that is *semantically* the same
  but *syntactically* unrelated.** Discovering "this hand-mirror is also a copy path"
  requires *understanding*, not parsing.

## 2. The lateral reframe

We do not need to *employ* a model to understand the codebase: **a model is already on
the codebase** — the coding agent driving arcscope. The understanding is produced for
free as a side effect of real work. The missing capability is **durability**: capturing
what one session worked out so a *later, fresh* session inherits it instead of
re-deriving (or missing) it.

So arcscope stops being a read-only index and becomes a **persistent, agent-co-authored
knowledge base**:

1. A **structural index** of the whole repo (v1 engine), persisted and incrementally
   updated — the deterministic substrate. *(IDEs have indexed whole codebases for
   decades; this is engineering, not research.)*
2. An **assertion store** the agent writes to: named concepts bound to live locators,
   each optionally carrying an **invariant** every member must satisfy. Persisted across
   sessions; a later session queries arcscope and inherits the knowledge.

## 3. The load-bearing principle: store assertions, not facts

If the agent writes "copy = these 3 files" and it **missed one** (the original failure),
arcscope would now serve a confident, wrong answer to every future session — *worse* than
no memory, because it launders a guess into "the knowledge base says so."

So the rule is absolute:

> **arcscope never stores a fact. It stores an assertion bound to live code, and
> re-checks it on every read.**

The agent does not write `copy = [a.ts, b.ts, c.ts]`. It writes:

- a **binding** — locators that resolve to members live (`importers of cloneGraphForDocument`
  + a pinned `path` for the known orphan), and
- an **invariant** — a rule every member must satisfy (`must reference normalizeLinkOrderForCanvas`).

arcscope re-resolves the binding and re-checks the invariant against the **current tree**
on every read. A wrong or stale assertion either fails its own check immediately, or is
caught when reality diverges — it cannot silently rot. The model supplies *judgment*;
arcscope supplies *durability + continuous verification*. The stored object is closer to a
**test** than a note.

This is the durable differentiator: not prose memory (rots), not a one-shot architecture
diagram (rots), but **assertions that re-run against live code**.

## 4. Invariant changes vs v1

Consciously relaxed (the v1 spec deferred these pending a measurement; the document-copy
case is that measurement):

| v1 invariant | v2 |
| --- | --- |
| #2 tree-sitter only | **Relaxed** — a precise tier (type-resolved refs / call graph, SCIP-style precomputed index) may be added. Still labeled by `precisionTier`. |
| #3 no build-tool coupling | **Relaxed** — may read `tsconfig`/workspace config where it sharpens resolution accuracy. |
| #5 no persistent store | **Reversed** — the persistent store is now the point. |

Held (non-negotiable):

- **#1 local-only.** arcscope itself still makes zero network calls. The *agent* that
  writes assertions is a separate process; that the agent is a cloud model is irrelevant
  — it already sees the code. The store is a local file.
- **#4 locators never shell out.** A committed assertion must not execute arbitrary code
  on a teammate's machine. Locator kinds stay `symbol` / `path` / `import`.
- **#6 stdio hygiene.** stderr-only logging.

## 5. The assertion schema

A concept gains one optional field, `must` (the invariant). Members are the existing
`locators` (or `stages`). Provenance (`source`) is assigned by which file a concept was
loaded from, not authored.

```yaml
# .arcscope/assertions.yaml   (agent-owned; merged with the human-authored vocab.yaml)
concepts:
  document-copy:
    title: Document copy paths
    locators:                                   # the binding (members), resolved live
      - { kind: import, of: '@lib/graph-clone' }          # self-maintaining: new app paths auto-appear
      - { kind: path,   glob: 'functions/**/clone-template-content.ts' }   # the orphan, pinned once
    must:                                        # the invariant every member must satisfy
      title: re-numbers link badges
      locators:
        - { kind: import, of: '@lib/link-order' }         # member files must import this
```

**Conformance** = every member file must appear in the set resolved by `must.locators`.
Members outside that set are **violations**. For document-copy: the two app paths import
both helpers → conform; the orphan imports the clone-equivalent by hand but **not**
`@lib/link-order` → **violation** — i.e. fix #2, caught before it ships, and re-fired for
every future copy path that forgets the rule.

Two stores, merged at load:

- `vocab.yaml` — human-authored, hand-edited, commented (`source: vocab`).
- `assertions.yaml` — agent-written via `arch_assert`, freely rewritten (`source: agent`).

Keeping them separate avoids clobbering human comments and makes provenance visible —
agent-asserted knowledge is labeled as such, so trust is calibrated, not assumed.

## 6. Tools

- `arch_assert` *(new, write)* — the agent records/updates a concept (binding + optional
  invariant) into `assertions.yaml`. The write-back surface.
- `arch_query` *(extended)* — when a concept has a `must`, the live result now includes a
  **conformance report** (members, conforming count, violations) alongside drift.
- `arch_candidates` *(new, discovery)* — finds a concept's likely **unpinned** members by
  structural AST-shape similarity (name-independent — it catches a renamed re-implementation
  that shares no name, import, or path). Returns ranked **suspects** (a `structural-similarity`
  precision tier — heuristic); confirm and pin the real ones via `arch_assert`. Suspects that
  would violate the concept's invariant are flagged.
- `arch_list`, `find_def`, `find_refs`, `dep_graph` — unchanged.

## 7. Governance of the poisoning risk

- Every assertion is **re-verified on read** (§3) — a wrong invariant surfaces as its own
  violation or drift, not as silent truth.
- Provenance is explicit (`source: agent`) so a reader knows what was machine-asserted.
- `assertions.yaml` is a committed, reviewable artifact: review checks the *binding and
  rule* (verifiable), not prose claims.
- Residual, stated honestly: a re-implementation is never *auto-confirmed* — a session that
  touches it must pin it, and knowledge accretes as the codebase is worked on rather than
  being provably complete. **`arch_candidates`** (§6) narrows the gap: it surfaces structural
  re-implementations (AST shape, name-independent) as suspects to confirm — turning
  unknown-unknowns into surfaced questions. (A cheaper name-overlap detector was measured
  against the dogfood and rejected — 75% false positives, and it missed the real orphan.) It
  stays heuristic: a re-implementation that copied only part of the logic, or rewrote its
  structure, can fall below threshold.

## 8. Proof slice (what we build first, and the kill-criterion)

The smallest thing that validates the bet, tested against the real bug:

1. `must` invariant + conformance evaluation on concepts.
2. `arch_assert` write-back to a persistent `assertions.yaml`.
3. Merge of agent assertions into the live vocabulary, with provenance.

**A→B test** (fixture mirrors the document-copy shape: a shared `graph-clone` module, two
files importing it, and an orphan that hand-rolls the copy and does *not* import
`link-order`):

- **Session A**: agent calls `arch_assert` to record `document-copy` (binding incl. the
  pinned orphan + the `must` link-order invariant). Persisted to disk.
- **Session B**: a *fresh* `IndexStore`, no in-memory carryover, loads the assertion from
  disk and runs `arch_query document-copy` → reports the orphan as a **conformance
  violation it never independently discovered.**

**Pass:** B flags the orphan that A's structural tools alone would miss. This is also the
clean cross-session form of the v1 §13 wedge test (live, verified knowledge vs static
prose) that never ran cleanly in-session.

## 9. Deferred past the slice

- The precise structural tier (SCIP-style precomputed index; recommended over a live LSP
  for determinism + cacheability).
- Incremental persistence of the structural index itself (today: in-memory, lazy
  re-index; persist when scale justifies it) — including caching the structural fingerprints
  across runs.
- Symbol-reference invariants beyond import-membership (e.g. "calls X" via ref-scan) once
  the import-based form is proven.
- Cross-language structural matching (fingerprints currently compare within a single grammar).
