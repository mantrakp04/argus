# argus

> Many-eyed PR review pipeline: deep context building + multi-agent codex review + persona-voice synthesis.

Argus was the hundred-eyed giant who could see in all directions, even when sleeping. This project is a pipeline that does roughly the same thing to a pull request — it slices a large diff into structured context buckets, fans those out to multiple codex agents running different review passes in parallel, and then synthesizes the raw findings into a senior-engineer-voice review.

It's designed to do things that are hard for a single human reviewer to do well:

- Audit every call site of every symbol the PR adds/changes, across the entire repo (not just the diff).
- Run independent passes (intent + quality, inter-file contracts, concurrency + external context) with different cognitive lenses.
- Construct multi-step hypothetical walkthroughs for serious bugs.
- Verify claims against actual code (reads Dockerfile to confirm PG version, reads schema files to check NOT NULL, etc.) instead of guessing from training data.
- Identify the load-bearing invariant of a PR up front and use it as a lens for every later pass.

It is **not** a drop-in replacement for a senior engineer, but on the PRs tested it catches the same bugs a senior engineer would catch, plus 10+ additional ones via systematic grep-based audits.

## Status

**Research-grade.** The review quality ceiling is high (matches or beats hand-written senior reviews on test PRs). Orchestration is now driven by a Claude Code skill (`argus-pr-review`) that fans out per-bucket codex agents via subagents, so the dispatch / retry / synthesis layer is in the main thread instead of a rigid driver script. Treat this as a working prototype you can study and extend, not a production tool.

## What's in here

Four TypeScript scripts, each usable independently:

| File | What it does |
|---|---|
| `index.ts` | Context bundle builder. Walks a repo, parses every JS/TS file with a Babel AST, builds forward + reverse import graphs with tsconfig path alias + workspace package resolution, optionally computes Ollama embeddings with a content-addressed cache, does multi-hop traversal, and emits a structured JSON bundle for every changed file. Inspired by Greptile's graph-based codebase context. |
| `split.ts` | Slices a bundle into per-bucket, per-pass text context files that fit in a codex context window. Generates the pass prompt templates (prelude, callsite audit, P1+3, P2, P4) with the worktree cd-preamble baked in. |
| `eval.ts` | Quality evaluator for bundles. Cross-checks every resolved path, every graph edge, every multi-hop node, every semantic neighbor, and every rule/memory string against the actual filesystem. Flags existence failures, resolution misses, AST recall gaps, multi-hop integrity bugs, and context gaps. 7 categories, pass/fail per category. |
| `review.ts` | Single-file end-to-end review smoke test. Takes a bundle, picks a meaty file (or one you specify), builds a Greptile-style per-file review prompt with all context lanes, and dispatches it via the codex companion's `task` interface. Codex writes the review to `<bundle>.review.md`. Useful for verifying a bundle end-to-end without spinning up the full multi-agent pipeline. |

Plus a Claude Code skill:

- [`argus-pr-review`](#full-pipeline-multi-agent-multi-pass) — orchestrates the full multi-bucket multi-pass pipeline. Lives at `~/.claude/skills/argus-pr-review/SKILL.md` (a copy is shipped under `claude/skills/argus-pr-review/SKILL.md` in this repo). Drop it into your `~/.claude/skills/` directory and invoke with the trigger phrases listed in the skill's frontmatter.

And the supporting files:

- `package.json` — Bun runtime, deps are `@babel/parser` and `@babel/traverse`.
- `tsconfig.json` — strict, ESNext, bundler resolution.
- `LICENSE` — Apache 2.0.

## Requirements

- [**Bun**](https://bun.sh/) ≥ 1.3 (runs TypeScript directly, handles CJS/ESM interop for Babel).
- [**Ollama**](https://ollama.com/) with any embedding model pulled. Default is `embeddinggemma:latest`. Ollama is used **only** for embeddings — every chat / review call goes through codex. The rest of the pipeline works without Ollama via `--no-embeddings` (you just lose the semantic neighbors lane).
- A **git worktree** of the repo you want to review, with a base branch to diff against.
- The [**Codex CLI**](https://github.com/openai/codex) — required for both the single-file `review.ts` smoke test and the full multi-agent pipeline. The pipeline talks to codex through the [openai-codex Claude Code plugin](https://github.com/openai/codex)'s `codex-companion.mjs` runtime.
- [**Claude Code**](https://claude.com/code) (recommended for the full pipeline) — the `argus-pr-review` skill orchestrates the multi-agent fan-out from inside Claude Code. You can also drive the pipeline by hand with bash + parallel codex calls.

## Install

```bash
git clone https://github.com/mantrakp04/argus.git
cd argus
bun install
```

## Quick start — just the context bundle

Build a rich JSON bundle for every changed file in a working tree vs. its base branch:

```bash
cd /path/to/your/repo
bun run /path/to/argus/index.ts --base main --out /tmp/ctx.json
```

On a 2,000-file TypeScript monorepo this takes ~20s without embeddings, ~6-10min the first time with embeddings (cached for subsequent runs).

The resulting `ctx.json` has this shape:

```jsonc
{
  "meta": { "repo", "base", "generatedAt", "changedFileCount", "indexedFileCount", "graphEdgeCount", "maxHops", "embeddings", ... },
  "rules": { "CLAUDE.md": "...", "AGENTS.md": "..." },                // auto-loaded project rules
  "memory": { "path": "~/.claude/skills/REVIEW_MEMORY.md", "content": "..." },  // persistent learned preferences
  "changedFiles": [ "apps/.../foo.ts", ... ],
  "files": [
    {
      "path": "apps/.../foo.ts",
      "status": "modified",
      "additions": 42, "deletions": 8,
      "patch": "...",
      "fullContent": "1: ...\n2: ...\n...",
      "symbols": { "exports": [...], "functions": [...], "classes": [...] },
      "directImports": [{ "specifier", "kind", "resolvedPath", "namedSymbols", "type" }],
      "directCallers":  [{ "path", "importedSymbols", "type" }],
      "multiHop":       { "forwardTiers": [[...], [...]], "reverseTiers": [[...]] },
      "semanticNeighbors": [{ "path", "score", "alsoIn" }],
      "siblings": [...],
      "otherChangedFiles": [...],
      // ...
    }
  ]
}
```

### Key flags

```
--base <ref>                  Base git ref to diff against (default: dev)
--scope <dir>                 Only index files under this dir (relative to root)
--max-hops <n>                Maximum graph hops (default: 2)
--max-per-parent <n>          Cap descendants contributed per parent at each hop (default: 6)
--max-neighbors <n>           Top-K semantic neighbors per file (default: 8)
--no-embeddings               Skip semantic neighbors (skip Ollama entirely)
--no-workspaces               Don't auto-walk pnpm/yarn workspace packages
--include-content-for-deps    Inline source of direct internal deps
--embedding-model <name>      Ollama embedding model (default: embeddinggemma:latest)
--memory-path <path>          Override ~/.claude/skills/REVIEW_MEMORY.md location
```

Full help: `bun run index.ts --help`.

## Quality eval

After generating a bundle, run the evaluator to check structural quality:

```bash
bun run eval.ts /tmp/ctx.json
```

Outputs a 7-category report:

```
1. Existence               PASS  994/994 paths exist on disk
2. Import resolution       PASS  0 unresolved out of 143 external + 1434 internal
3. AST symbol recall       PASS  0 symbols the regex baseline finds that AST missed
4. Multi-hop integrity     PASS  200/200 hop edges have valid `via` chain
5. Semantic neighbors      INFO  42% share 3-deep path prefix
6. Memory & rules          PASS  byte-identical to on-disk
7. Context gaps            PASS  0 source files with empty context

errors: 0   warnings: 0
```

This is useful during development to catch regressions in the resolver, AST parser, or graph builder.

## Persistent review memory

`argus` maintains a `REVIEW_MEMORY.md` file at `~/.claude/skills/REVIEW_MEMORY.md` (path configurable with `--memory-path`). This is the Greptile-style learned-rules layer: rules the reviewer should follow, patterns to suppress, free-form notes. The file is automatically included in every generated bundle.

CRUD it via the `memory` subcommand:

```bash
bun run index.ts memory show
bun run index.ts memory rule "Prefer named exports over default exports for React components"
bun run index.ts memory suppress "Don't comment on TODO comments unless they reference a deleted ticket"
bun run index.ts memory note "dev branch is the trunk, not main"
bun run index.ts memory clear-cache   # wipes the embedding cache
```

## Single-file review (quick demo)

The simplest way to see a full review happen end-to-end. Pick a changed file from a bundle and feed it to codex via the companion task runtime:

```bash
# auto-pick a meaty file
bun run review.ts /tmp/ctx.json

# review a specific file
bun run review.ts /tmp/ctx.json apps/backend/src/lib/payments.ts

# explicitly set the worktree (so codex's cwd is right)
bun run review.ts /tmp/ctx.json --worktree /repos/myrepo
```

The script builds a Greptile-style per-file review prompt with every context lane (symbols, imports, callers, multi-hop, semantic neighbors, siblings, cross-PR files, patch, line-numbered body), saves it to a prompt file, then dispatches `codex-companion task --prompt-file ... --cwd <worktree> --write`. Codex writes its review back to `<bundle>.review.md` so the script never has to parse stdout.

This is the simplest possible orchestration — one file, one codex call. Useful for smoke-testing that a bundle is well-formed and verifying the review-agent contract before running the full pipeline.

## Full pipeline (multi-agent, multi-pass)

For a serious review, use the **`argus-pr-review` Claude Code skill**. The skill is the orchestration layer — it tells Claude exactly which scripts to run, when to spawn parallel codex agents, how to verify their outputs, and how to synthesize the raw findings into a persona-voice final review.

The skill keeps the dynamic decisions (which buckets matter for THIS PR, when to retry a flaky codex run, what to walk through in the synthesis) in the main thread instead of baking them into a rigid driver script. Every PR is different — a 5-file dashboard PR doesn't need the same buckets as a 200-file sync PR — and the skill format lets the reviewer adapt without code changes.

### Installing the skill

The skill file lives at `claude/skills/argus-pr-review/SKILL.md` in this repo. Copy it into your Claude Code skill directory:

```bash
mkdir -p ~/.claude/skills/argus-pr-review
cp claude/skills/argus-pr-review/SKILL.md ~/.claude/skills/argus-pr-review/
```

Edit the `ARGUS_DIR` variable at the top of the skill if your `argus` checkout isn't at `/tmp/review-ctx`.

### Running a review

In Claude Code, just say something like:

> argus review the PR on /Users/me/repos/myrepo against base `dev`

Claude will pick up the skill and walk through the six phases:

1. **Preflight** — verify Ollama + codex are reachable.
2. **Build context** — run `index.ts` to produce a JSON bundle for the worktree (Babel AST + import graph + Ollama embeddings).
3. **Split** — run `split.ts` to slice the bundle into per-bucket per-pass context files plus prompt templates with the worktree `cd` preamble baked in.
4. **Pre-pass (codex)** — dispatch ONE codex task that reads the prelude prompt + `prelude-context.md` and writes `PRELUDE.md` containing the **load-bearing invariant** (the rule that, if broken anywhere, breaks the PR's correctness), the **surface map** of every load-bearing symbol the PR adds, and the `[INVARIANT]` tags later passes audit against. This is the single most consequential pass — every later pass uses its output as the lens.
5. **Fan-out (parallel)** — Claude spawns N `general-purpose` subagents in parallel (one per high-risk bucket × pass, plus one for the callsite audit). Each subagent's only job is to:
   - Build a combined prompt = pass template + rules + `PRELUDE.md` + bucket context + an "Output instruction" footer
   - Invoke `codex-companion task --prompt-file ... --cwd <worktree> --write`
   - Verify the output file exists and is non-trivial
   - Retry up to 2 more times if codex died silently
   - Report back a structured summary

   The cross-PR **callsite audit** pass is the highest-value finding generator — it greps the entire repo for mutation sites of every `[INVARIANT]`-tagged symbol from the surface map and reports violations in files that are NOT in the diff. This catches bugs Pass 1+3 structurally cannot find.

6. **Synthesis (codex or main thread)** — concatenate every `outputs/*.md` file plus `PRELUDE.md` into a synthesis prompt, plus the persona description (lowercase casual default, severity prefixes for substantive comments, multi-step hypothetical walkthroughs for serious bugs), and dispatch one final codex task to write `final-review.md` in the merged voice of N2D4 + nams1570. The skill describes when to fall back to main-thread synthesis instead.

The skill is self-contained — read it for the exact commands, the subagent brief shape, and the failure-mode playbook.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        index.ts (context)                       │
│                                                                  │
│   walk repo ──► parse AST ──► resolve imports ──► build graph   │
│       │            │                │                  │        │
│       └─►   workspace packages       │                  │        │
│       └─►   tsconfig path aliases    │                  │        │
│                                      │                  │        │
│   embed via Ollama ─► cache ─► cosine ─► semantic neighbors     │
│                                                          │       │
│   multi-hop BFS (forward + reverse) ────────────────────┤       │
│                                                          │       │
│   per-changed-file bundle ◄─────────────────────────────┘       │
│                                                                  │
│              output: JSON bundle (~2 MB for a 200-file PR)      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         split.ts (bucketing)                    │
│                                                                  │
│   bucket files by domain ──► emit per-pass context files        │
│                              inject worktree cd preamble        │
│                                                                  │
│              output: /tmp/review-run-X/buckets/*/pass*.md       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              fan-out: N buckets × M passes codex agents         │
│                                                                  │
│   bucket-01 ──► pre-pass ──► P1+3 ──► P2 ──► P4                │
│   bucket-02 ──► pre-pass ──► P1+3 ──► P2 ──► P4                │
│   bucket-03 ──► pre-pass ──► P1+3 ──► P2 ──► P4                │
│   ...                                                            │
│                                                                  │
│         + cross-PR callsite audit pass (whole-repo grep)        │
│                                                                  │
│              output: outputs/<bucket>.<pass>.md (raw findings)  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│     synthesis (main thread, persona voice, walkthroughs,       │
│                cross-cutting themes, triage list)               │
│                                                                  │
│              output: final-review.md                            │
└─────────────────────────────────────────────────────────────────┘
```

## Features that set it apart

- **Babel AST parsing** — handles JSX/TSX/decorators/TS-specific nodes with `errorRecovery` mode. 0 parse failures across 2,000+ file monorepos.
- **tsconfig path alias resolution with `extends` recursion** — follows `extends` chains up to 8 levels with cycle detection, respects `baseUrl` scoping.
- **Workspace package resolution** — reads `pnpm-workspace.yaml` or `package.json` workspaces, builds a package-name → source-dir map, resolves `@yourorg/*` imports to `<pkg>/src/*.ts` (rewriting `dist/` paths to `src/` for review purposes).
- **Filesystem fallback resolver** — out-of-scope source files still get classified internal, non-source assets (JSON, CSS, SVG, MDX) also resolve.
- **TypeScript `.js` → `.ts` bundler convention** — imports like `import './foo.js'` resolve to `foo.ts` for bundler-style TS projects.
- **Multi-hop BFS (forward + reverse) with per-parent capping** — hop-2 doesn't get monopolized by one barrel file with 50 re-exports; every hop-1 parent gets an equal slice.
- **Provenance-consistent hop tiers** — the stored tier IS the next-hop frontier, so hop-(n+1).via always references a node present in hop-n.
- **Content-addressed embedding cache** — keyed by `sha256(model + snippet)`, so file renames don't invalidate vectors.
- **Semantic neighbors with overlap tagging** — neighbors that also appear in graph-hop tiers are tagged `alsoIn: ['forward' | 'reverse']` rather than hard-excluded, so the strongest "in both graph AND embedding" signal is surfaced, not discarded.
- **Persistent learned-rules memory** — `~/.claude/skills/REVIEW_MEMORY.md` flows into every bundle.
- **Shrinking-snippet fallback** for embedding context-length errors — big files get halved until they fit or give up.
- **Batched Ollama `/api/embed`** — amortizes per-call overhead vs. the legacy per-prompt endpoint.
- **Worktree cwd preamble** — every generated prompt starts with `cd "<worktree>"` so codex agents don't read the wrong branch's files.

## Known limitations

- **Codex task reliability is ~60-70%** on first dispatch. Roughly 30-40% of calls die silently without writing the output file. The skill builds in retry logic (up to 2 retries per task), but a few stubborn buckets may still need a manual re-run.
- **Pass 2 / Pass 4 are opt-in.** The prompt files and bucket context are always generated, but the skill defaults to running only Pass 1+3 + the callsite audit on every bucket. For high-risk buckets (DB schema, payments, auth, sync), the skill instructs Claude to also dispatch Pass 2 (inter-file contracts) and Pass 4 (concurrency + external) — you choose at runtime which buckets get the full sweep.
- **JS/TS only.** Python/Go/Rust/etc. are invisible. Extend by registering more extensions and adding the equivalent AST parser.
- **No learned-rule feedback loop.** The `REVIEW_MEMORY.md` layer is a flat markdown file the user maintains. It does NOT auto-track `{made, addressed, reactions}` counters the way Greptile's does, because the pipeline never sees review outcomes.
- **Embedding throughput is Ollama-bound.** On an M-series Mac with `embeddinggemma:latest`, roughly 1-2 files/sec cold. Batching helps a little but not a lot — Ollama serializes inside the runner. Warm cache makes re-runs near-instant.
- **No git-history lane.** The bundle doesn't include blame-of-changed-lines, "files that change together in commits", or "who last touched this file". That'd be a useful future lane.

## Inspiration + prior art

The core context-building pipeline is heavily inspired by [Greptile](https://www.greptile.com/)'s publicly-described architecture: graph-based codebase indexing (SCIP-derived symbol/reference extraction), per-file summary generation, per-file agentic review with full codebase context injected into the prompt, and a learned-memory layer. The research that informed `index.ts` started as an analysis of Greptile's open-source fragments (their `scip-typescript` fork, their example `pr-review-bot`) combined with their public system-architecture docs.

The multi-pass review structure (Pass 1 intent-vs-implementation, Pass 2 inter-file contracts, Pass 3 code quality, Pass 4 high-level + concurrency + external context, plus the cross-PR callsite audit) is derived from the [N2D4 + nams1570 PR review skill](https://github.com/mantrakp04) — a distilled senior-engineer review process modeled on two Stack Auth engineers.

The rescue-subagent-as-forwarder pattern for calling codex comes from the [OpenAI Codex Claude Code plugin](https://github.com/openai/codex) infrastructure.

## License

[**Apache 2.0**](./LICENSE). Use it however you want, commercially or otherwise. The only ask: keep the copyright notice + license file when you redistribute. See `LICENSE` for the full text.

---

Built by [@mantrakp04](https://github.com/mantrakp04).
