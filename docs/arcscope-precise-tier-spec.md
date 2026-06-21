# arcscope precise tier — compiler-exact resolution, the call graph, and flow surfaces

> Status: **proposed (revised after adversarial review).** Extends [arcscope-v2-spec.md](arcscope-v2-spec.md) and the v1 spec. Settles method-dispatch resolution and defines the call graph + "flow surface" built on it.
>
> **What the review changed:** the core decision (use the TypeScript type checker) survived; the *completeness claims* did not. Three corrections are baked in below — (1) the precise call graph is **per-Program** and does **not** cross the app↔`functions/` module boundary where the historically-missed orphan lives; (2) on Angular DI a large share of calls resolve to a library `.d.ts` or a bare interface/abstract member, not a concrete in-repo callee, so "resolves method dispatch" is restated as "resolves to a concrete in-repo callee, measured"; (3) `findReferences`/`getImplementationAtPosition` are **LanguageService** APIs, not `Program`/`TypeChecker`, so we need a LanguageService too. These are now measured gates in Phase 0, not footnotes.

## 0. Phase 0 results (measured on knowledge-graph, 2026-06-21)

Ran the bespoke path (TS Compiler API + LanguageService) against the real repo. Measured, not assumed:

- **Construction: solved.** A Program built from `apps/graph-knowledge/tsconfig.app.json` with `disableSourceOfProjectReferenceRedirect:true` pulls lib **source** via the Nx `@graph-knowledge/*` path mappings — one `createProgram`, **520 in-repo `.ts`** files incl. `graph-clone.ts` source. No project-reference gymnastics; no root `tsconfig` needed.
- **Cost: cheap for a per-flow surface.** Build (parse+bind) **0.8s / 0.45 GB**; tracing the `forkDocument` flow resolved **61 calls in <0.1s**; impl-hops 0.1s; total **~0.46 GB**. The review's "seconds + GBs" is the cost of a *whole-repo* type-check; a single flow only forces checking of its own closure. **The cost worry does not apply to the flow-surface use case.**
- **Reach: ✓.** From `forkDocument`, the method-resolved closure reached the full chain `cloneGraphForDocument → cloneNode → cloneElement → normalizeLinkOrderForCanvas`.
- **DI dispatch: needs the LanguageService, and then works.** Of 33 property-access calls: 73% library (RxJS/Firestore — correctly resolved, correctly stop). Of the 9 in-repo method calls, `getResolvedSignature` alone resolved 1 directly; `getImplementationAtPosition` recovered **7 of the 8** abstract/interface calls to a concrete in-repo impl (≈89% of in-repo method calls). The 1 miss is a callback-typed property (higher-order residual). Program+TypeChecker alone is thin; **Program + LanguageService is complete enough** — confirming the LanguageService is required *and* that it delivers.

**Blocker #1 (cross-Program orphan) reframed.** The `functions/` orphan is a *parallel* flow (an independent Firestore trigger), **not called by the app** — so no call graph from an app entry point reaches it, regardless of Program boundaries. Reaching parallel implementations is `arch_candidates`' job (it already does this), not the call graph's. The per-Program boundary is real but only bites a *single* flow that spans module systems (rare; app↔`functions/` communicate via Firestore events, not calls). "The call graph misses the orphan" was a conflation of two capabilities; corrected.

**Decision: bespoke Program + LanguageService, per-flow on demand.** `scip-typescript`'s advantages (cross-project + a persisted *whole-repo* index) are oriented to a whole-repo precise index, which the per-flow surface does not need, and its batch re-index cost is a downside for on-demand use. (Not empirically benchmarked — the per-flow bespoke numbers made SCIP's whole-repo advantages moot for this use case; revisit only if a global precise index is ever wanted.)

## 1. Why — method dispatch is non-negotiable

The tree-sitter engine resolves **function calls** and **imported-symbol references**, but not **method dispatch** — `this.service.foo()`. As a caveat in `find_refs` that was tolerable; for a **call graph** and the **flow surface** on top it is **fatal** — the dogfood (knowledge-graph) is Angular + DI + method-heavy, and a flow surface that can't follow `this.documentService.clone(...)` would miss most of the flow. An incomplete flow surface is worse than none: it gives false confidence you've seen everything.

There is no tree-sitter trick for this — resolving a call's target requires the receiver's *type*. So we adopt a type system. But "adopt a type system" does not by itself give a *complete* in-repo call graph on this repo; §§3, 7, 9 are honest about where it stops.

## 2. The decision

Adopt a **precise tier built on the TypeScript Compiler API + LanguageService** (the `typescript` package; **local**, no network). It resolves `obj.method()` through the receiver's static type — including **constructor-injected concrete services and inheritance** (validated: this is the sound core of the bet) — exactly as VS Code does.

Two object surfaces are needed, not one (review correction):
- **`Program` + `TypeChecker`** — `getResolvedSignature` / `getSymbolAtLocation` for call-graph derivation.
- **`LanguageService`** (over a `LanguageServiceHost`) — `findReferences` and `getImplementationAtPosition` (these do **not** exist on `Program`/`TypeChecker`; verified against typescript 5.9.3). Drive it from `languageService.getProgram()` so both share one checker.

So "self-contained, no server lifecycle" is weaker than first claimed: we still stand up a `LanguageServiceHost` — much of what tsserver wraps. That cost is real and is weighed against the alternative below.

**Genuine alternative — `scip-typescript` (must be evaluated in Phase 0, not dismissed).** It is a local, no-network, LanguageService-backed **batch indexer** that already (a) walks an Nx multi-`tsconfig` monorepo into **one cross-project** symbol+reference index — the exact stitching that breaks the document-copy example — and (b) **persists** an on-disk index — the cache this spec otherwise hand-waves. It ships much of what the bespoke path would rebuild. Its real weakness is **incremental re-index cost** (batch, not edit-time). The honest decision is a **measured bake-off** (§9 Phase 0): does SCIP's cross-project index reach the `functions/` orphan and resolve DI calls to concrete impls, and at what re-index cost, vs the bespoke Program+LanguageService path? (`ts-morph` is set aside — it's a Compiler-API ergonomics wrapper; it does not solve the multi-Program problem.)

We do **not** claim this "is the evolution the `precisionTier` field anticipated." That field's comment named an LSP tier, and divergent labels (`'unresolved-candidate'`, `'structural-similarity'`) already live outside the union. It's a clean extension point, nothing more.

## 3. How it resolves a call (runnable mechanism + where it stops)

Config load (prefer the one-call entry that handles the `extends` chain — important for Nx's `tsconfig.base.json`):
```
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, /*optionsToExtend*/ {}, host);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();
```
Per `CallExpression`:
```
const sig = checker.getResolvedSignature(call);
if (!sig?.declaration) { /* unresolved -> keep tree-sitter tier */ }
else {
  const decl = sig.declaration;
  const sf   = decl.getSourceFile();
  const pos  = sf.getLineAndCharacterOfPosition(decl.getStart());  // file + line/col
}
```
`getResolvedSignature` returns `Signature | undefined`, and `Signature.declaration` is itself optional. The **unresolved buckets are not rare** and must be enumerated and labeled, not pretended away:

- **`any`-typed / dynamic `obj[key]()` receivers** → no single declaration.
- **Library calls** (RxJS `Observable`/`Subject`, `Map`, framework methods) → declaration is in `node_modules` `.d.ts` — a real target, but **no in-repo body to recurse into** (the call graph stops).
- **Interface / abstract / `InjectionToken` / `useFactory` DI** → resolves to the **declared member** (the abstract method signature), **not** the runtime concrete service. This is the *dominant* Angular pattern, not an edge case. Crossing to the concrete impl requires a second **`languageService.getImplementationAtPosition`** hop (which itself may return multiple impls).
- **Overloads** → `getResolvedSignature` returns the matched **overload signature** (no body); normalize back to the implementation declaration (or the symbol's primary declaration via `getSymbolAtLocation` on the callee name).

So the headline is restated: **the checker resolves the call's static signature; the fraction that lands on a *concrete in-repo callee* (the thing the flow graph needs) is an empirical number measured in Phase 0 — not assumed near-100%.**

## 4. Architecture — additive tier, with the integration honestly scoped

Two tiers side by side:

| | tree-sitter (exists) | TypeScript (new) |
| --- | --- | --- |
| Speed | instant (ms) | seconds (forces a full type-check) |
| Breadth | multi-language | TS/JS only, **per-Program** |
| Resolves method dispatch | no | yes (to the static signature; concrete-impl needs a 2nd hop) |
| Use | fast/broad nav, fallback | call graph, flow surface |

- **`ProgramStore`** owns the `Program(s)` + `LanguageService` lifecycle. Its seconds-long build **cannot** sit in `serve()`'s startup `sync()` (would delay server-ready) — it is **lazily** constructed on first precise request.
- **Path identity is a hard contract:** the Compiler API speaks in absolute, forward-slashed `fileName`s; every existing surface keys on `IndexStore.relPath()` (root-relative-posix). `ProgramStore` **must** map every `ts` `fileName` back through that same transform, or merged call/import graphs land in disjoint, silently-wrong node sets.
- **Mixed results must be tier-labeled per node/edge**, plus a coverage statement ("Programs X, Y analyzed precisely; files under Z structural only"), so the agent can see exactly where the precise graph ends. This is a trust requirement (§1: incomplete-but-confident is worse than nothing), not an open question.
- **`PrecisionTier` widening is small but not zero:** `PrecisionTier = 'tree-sitter'` is a closed single-member union (`engine/types.ts:6`); `RefRecord` and `ResolvedLocation` carry *separate* closed literals; ~6 literal write-sites (`find-refs.ts:77`, `resolver.ts:66/81/86`, `extract.ts:42`) and hardcoded "precision: tree-sitter" format strings (`find-def.ts`, `find-refs.ts:113`, `serve.ts` INSTRUCTIONS) all assume the single tier. Phase 3 widens the union to `'tree-sitter' | 'typescript'`, unifies the records onto it, and updates those sites.

**The per-Program boundary is a first-class limitation, not a wrinkle.** A `ts.Program` covers one compilation. The dogfood's document-copy flow spans **two** Programs (the app, and `functions/` under its own CommonJS `tsconfig.json`). A single Program's closure **stops at that boundary** — exactly where the historically-missed orphan lives. Options: (a) build a **multi-Program union** and **stitch edges** across the alias/import boundary by hand (match an unresolved cross-Program import specifier to a symbol in the other Program); (b) honestly **scope cross-module-system flows out** and say so. Either way, "does the closure reach `functions/clone-template-content.ts`?" is a **Phase 0 kill-criterion**.

**Invariants:** HELD — #1 local-only (tsc reads only local config/lib files; no network — confirmed), #4 no shell-out, #6 stdio. RELAXED (approved) — #2 tree-sitter-only, #3 build-coupling, #5 persistent store, instant-speed. Distribution note: `typescript` moves from `devDependencies` to runtime `dependencies` (multi-MB tarball weight); local-only is preserved, the cost is package size.

## 5. What it upgrades

- **`find_def`/`find_refs`** → compiler-exact via the LanguageService where the precise tier ran; the member-access caveat is **conditionally** retired (the caveat string must be gated on whether the precise tier actually ran for that file, or it will lie once methods resolve). tree-sitter remains the instant fallback and the path for non-TS / out-of-Program files.
- **conformance (`must`)** → unlocks call-based invariants ("every member must *call* X").

## 6. The call graph (new primitive — its own tool, not a `dep_graph` flag)

`dep_graph` is file→file import adjacency; a call graph is function/method→function/method. They share only token-bounding/formatting, so this is a **dedicated `call_graph` / `flow` tool** with symbol+location node identity, derived from `ProgramStore`. Per function/method: resolved outgoing/incoming calls, transitive closure from a focus, and on-demand `getImplementationAtPosition` to cross the interface→impl boundary. Token-bounded; every node/edge tier-labeled.

## 7. The flow surface (the motivating application)

The "expose the complete area of a feature before writing" capability:

1. The **agent names a flow** + seeds entry points (function/method/symbol). arcscope never *names* flows; it **expands the boundary** from the seed.
2. arcscope computes the **method-resolved transitive closure** (across Programs if §4(a) is built) = the flow's functions/files, plus a **structural edge-case checklist** (every `if`/`switch`/`try`/`catch`/`throw`/`await`/early-return inside them, from the AST).
3. It may **suggest peer entry points** (`arch_candidates` siblings) for the agent to confirm.
4. The agent corrects what the static graph got wrong, adds **semantic** edges structure can't see (offline, concurrent edit, migration, empty state), and **persists the flow as a v2 concept** — kept honest by conformance.

**Acid test:** the closure must reach the cross-Program orphan, and the coverage statement must make any precise/structural boundary explicit. If it can't reach the orphan and can't say so, it fails §1.

## 8. Costs & risks (honest, measure before quoting)

- **The seconds are type-checking, not parsing.** `createProgram` (parse+bind) is sub-second; the cost is **forcing lazy type-checking** by calling `getResolvedSignature` on ~every call — comparable to a full `tsc --noEmit`. Realistic on knowledge-graph: **high-single to low-double-digit seconds, ~1–3 GB**, and the real `rootNames` balloons past 1,000 once referenced packages + lib `.d.ts` are pulled in. **Two Programs resident** (app + `functions/`) roughly **doubles** memory and may approach Node's default old-space limit (plan to raise `--max-old-space-size`). Quote only **measured** figures.
- **No ready cache.** `createIncrementalProgram`/watch reuse parse+bind, **not** `getResolvedSignature` results; `.tsbuildinfo` persists type-check state, not arcscope's derived edges. Invalidating a *type-resolved* graph is categorically harder than re-running tree-sitter tags (editing one base class / interface / `tsconfig` path can invalidate transitive resolutions repo-wide). The call-graph cache is **open research**, not a shipped mitigation — either accept cold rebuild-on-demand (measure it's tolerable) or sequence the v2 persistent store ahead of Phase 2, keyed by file version + reverse-dependency invalidation.
- **Nx construction is not point-at-a-config.** There is **no root `tsconfig.json`** (only an empty `tsconfig.base.json`); `createProgram` ignores `references` for `rootNames`, and project references redirect imports to built `.d.ts`. A *source-level* cross-package graph requires parsing each project's config (`getParsedCommandLineOfConfigFile`), **unioning all `fileNames` into one `createProgram`**, merging path mappings, and/or `disableSourceOfProjectReferenceRedirect: true` — then **verifying `getSourceFiles()` actually contains cross-package `.ts`** before trusting the graph.

## 9. Phasing & falsifiable gates

**Phase 0 — bake-off + spike (decide the path before building).** On the real knowledge-graph:
- Stand up *both* candidate paths far enough to answer: bespoke Program+LanguageService (with the Nx file-union construction) **and** `scip-typescript`.
- **Falsifiable gates (kill-criteria):**
  - **Reach:** does the method-resolved closure from a real app entry point reach `functions/src/account/clone-template-content.ts` (the cross-Program orphan)? If neither path reaches it without unacceptable hand-stitching, cross-domain flows are scoped out and stated.
  - **Concreteness:** fraction of property-access calls that resolve to a **concrete in-repo callee** (excluding `node_modules` `.d.ts` and bare interface/abstract members); below a set threshold (to be fixed at the start of Phase 0), the precise tier does not deliver the flow graph and we re-decide.
  - **Cost:** cold build **< N s** and resident **< N GB** with both Programs loaded (N fixed up front). Incremental re-index cost measured for SCIP.
- Output: a measured bespoke-vs-SCIP decision, or a no-go.

**Phase 1 — call graph.** The chosen backend → the `call_graph` tool, path-identity contract, per-node tier labeling.
**Phase 2 — flow surface.** Closure + edge-case checklist + v2 persistence; the cache decision resolved.
**Phase 3 — upgrade nav.** Route `find_def`/`find_refs` through the precise tier (new `ProgramStore` lazy lifecycle in `serve()`, tier-router in the tools, TS/JS eligibility + fallback); conditionally retire the member-access caveat.

## 10. Open questions (resolved in Phase 0/1)

- Multi-Program union + cross-boundary edge-stitching vs scoping cross-domain flows out.
- bespoke Program+LanguageService vs `scip-typescript` (decided by the Phase 0 bake-off).
- Call-graph cache + invalidation strategy (or rebuild-on-demand).
- Node granularity and tool surface (`call_graph`/`flow`, function-level nodes).
