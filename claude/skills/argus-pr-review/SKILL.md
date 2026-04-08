---
name: argus-pr-review
description: Run a deep, multi-pass PR review using the Argus pipeline. Use this skill when the user asks for an "argus review", a "deep review", a "full PR review", a "multi-agent review", or when they reference a worktree they want reviewed end-to-end (e.g. "review the PR on /path/to/repo"). Combines context-bundle building (Babel AST graph + Ollama embeddings), per-bucket per-pass codex agents fanned out via subagents, cross-PR callsite audit, and persona-voice synthesis. NOT for tiny single-file feedback — use the n2d4-pr-review skill for that.
---

# Argus PR Review

You are running a deep, structured PR review using the Argus pipeline. The pipeline does things a single human reviewer (or a single-shot LLM) cannot do well:

- Build a rich AST + embedding context bundle for every changed file
- Slice the bundle into per-bucket per-pass context files that fit a codex window
- Identify the load-bearing invariant of the PR up front and use it as a lens
- Fan out N codex agents in parallel, one per (bucket, pass) combination
- Audit every callsite of every symbol the PR adds, across the **entire repo** (not just the diff)
- Synthesize the raw findings into a final review in the N2D4 + nams1570 senior-engineer voice

The pipeline is **scripted** (the context build, splitting, codex invocation), but the **orchestration is dynamic**: you pick which buckets matter for THIS PR, decide which retries are worth, and apply judgment during synthesis. That dynamic layer is what this skill describes.

## Where Argus lives

The Argus scripts (`index.ts`, `split.ts`, `eval.ts`, `review.ts`) live at:

```
ARGUS_DIR=/tmp/review-ctx
```

If they've moved (e.g. cloned to a permanent location from https://github.com/mantrakp04/argus), update the variable below before starting.

```bash
ARGUS_DIR=/tmp/review-ctx
```

The codex companion script lives at:

```
CODEX=/Users/barreloflube/.claude/plugins/cache/openai-codex/codex/1.0.2/scripts/codex-companion.mjs
```

## Inputs you need before starting

Confirm these with the user (or infer from the conversation) before doing anything else:

1. **`WORKTREE`** — absolute path to the git worktree being reviewed. The trailing whitespace / spaces in the path matter, quote it everywhere.
2. **`BASE`** — base branch to diff against. Default `dev` for stack-auth, otherwise `main`.
3. **`RUN_DIR`** — output directory for this review. Default `/tmp/review-run-N` where N is the next free integer (check `ls /tmp | grep review-run`).
4. **`SCOPE`** _(optional)_ — narrow the indexing to a subdirectory if the PR is small but the repo is huge.

Drop these into the working state at the top of the conversation so subsequent steps can reference them.

## Phase 0 — preflight

```bash
# Verify ollama is running and the embedding model is pulled
curl -s http://localhost:11434/api/tags | head -c 500

# If embeddinggemma is missing, pull it:
#   ollama pull embeddinggemma:latest

# Verify codex is set up
node "$CODEX" setup --json
```

If codex setup says "not authenticated", tell the user to run `!codex login` and stop. If it says "not installed", offer to install via `npm install -g @openai/codex`.

## Phase 1 — build the context bundle

```bash
cd "$WORKTREE"
bun run "$ARGUS_DIR/index.ts" \
  --base "$BASE" \
  --out "$RUN_DIR/ctx.json"
```

This walks the repo, parses every JS/TS file with Babel, builds the import graph (with workspace + tsconfig path alias resolution), embeds via Ollama, and emits a JSON bundle with full per-file context lanes. ~20s without embeddings, a few minutes the first time with embeddings, near-instant on warm cache.

Optionally validate the bundle quality before continuing:

```bash
bun run "$ARGUS_DIR/eval.ts" "$RUN_DIR/ctx.json"
```

You want all 7 categories PASS or INFO. If category 1 (existence) or 2 (import resolution) fail, the bundle is broken — stop and debug.

## Phase 2 — split into per-bucket per-pass context files

```bash
bun run "$ARGUS_DIR/split.ts" "$RUN_DIR/ctx.json" "$RUN_DIR" "$WORKTREE"
```

This produces:

```
$RUN_DIR/
  00-overview.md
  rules-and-memory.md
  prelude-context.md
  prompts/
    prelude.md
    callsite-audit.md
    pass1+3.md
    pass2.md
    pass4.md
  buckets/
    01-db-migrations-and-schema/
      pass1+3.md
      pass2.md
      pass4.md
    02-backend-api-routes/...
    03-backend-lib/...
    ...
  outputs/    # empty, you'll fill this
```

Read `00-overview.md` to see the bucket map and decide which buckets matter for THIS PR. A 5-file dashboard-only PR doesn't need the e2e-tests bucket reviewed; a database migration PR absolutely needs db-migrations + backend-lib + shared-packages.

## Phase 3 — pre-pass: load-bearing invariant + surface map

The pre-pass MUST run first because every later pass reads its output (`PRELUDE.md`) for the load-bearing invariant and the `[INVARIANT]`-tagged surface map.

Build the combined prompt and dispatch via codex. The prompt = the prelude template + rules + prelude-context, with an explicit instruction to write to `$RUN_DIR/PRELUDE.md`.

```bash
PRELUDE_PROMPT="$RUN_DIR/_runner/prelude.combined.md"
mkdir -p "$RUN_DIR/_runner"

cat \
  "$RUN_DIR/prompts/prelude.md" \
  "$RUN_DIR/rules-and-memory.md" \
  "$RUN_DIR/prelude-context.md" \
  > "$PRELUDE_PROMPT"

cat >> "$PRELUDE_PROMPT" <<EOF

---

## Output instruction

When you are done, write your full prelude analysis as plain markdown to:

  $RUN_DIR/PRELUDE.md

Do NOT print it to stdout. Write it to that path. If the file already exists, overwrite it.
EOF

node "$CODEX" task \
  --prompt-file "$PRELUDE_PROMPT" \
  --cwd "$WORKTREE" \
  --write
```

After it returns, **verify** the output file exists and is non-empty:

```bash
ls -la "$RUN_DIR/PRELUDE.md"
head -40 "$RUN_DIR/PRELUDE.md"
```

If `PRELUDE.md` is missing or stub-sized (< 1KB), retry the same command. Codex tasks die silently ~30% of the time; one retry usually fixes it. If it fails twice, escalate to the user — something is wrong with codex setup.

The PRELUDE.md should contain a one-sentence load-bearing invariant + a surface map of every load-bearing symbol the PR adds, with `[INVARIANT]` tags on the things later passes must audit. If it doesn't, ask codex to redo it (the prompt is in `prompts/prelude.md`).

## Phase 4 — fan out per-bucket pass1+3 + callsite audit (parallel)

Now you fan out. The bucket pass1+3 calls are independent, and the callsite audit is independent of them. **Spawn them as parallel `general-purpose` subagents** so the main thread keeps its context window clean and you can process retries without losing the plot.

For each bucket you've decided to review (start with the 2-3 highest-risk ones), and for the callsite audit, dispatch a subagent with this brief:

> You are running ONE codex task for a PR review pipeline. Do the following:
>
> 1. Build a combined prompt file at `$RUN_DIR/_runner/<task-name>.combined.md` by concatenating:
>    - `$RUN_DIR/prompts/<pass>.md` (the pass instruction template)
>    - `$RUN_DIR/rules-and-memory.md` (project rules + review memory)
>    - `$RUN_DIR/PRELUDE.md` (load-bearing invariant + surface map)
>    - `$RUN_DIR/buckets/<bucket-id>/<pass>.md` (this bucket's per-pass context) — **only for bucket passes, not for the callsite audit**
>    - An "Output instruction" footer telling codex to write its findings to `$RUN_DIR/outputs/<task-name>.md`
> 2. Invoke `node $CODEX task --prompt-file <combined-prompt> --cwd "$WORKTREE" --write`
> 3. After it returns, verify `$RUN_DIR/outputs/<task-name>.md` exists and is > 1KB
> 4. If missing, retry the same codex command up to 2 more times
> 5. Report back: task name, output file size, exit status, and a 3-line summary of what codex found (read the output)
> 6. **Do NOT** rewrite the findings into the persona voice — that's the synthesis pass's job. You're just executing one codex run and reporting.

Spawn these in **a single message with multiple `Agent` tool calls** so they actually run in parallel. Example for a 3-bucket scan:

- Agent 1: bucket `03-backend-lib` pass `pass1+3` → `outputs/03-backend-lib.pass1+3.md`
- Agent 2: bucket `07-shared-packages` pass `pass1+3` → `outputs/07-shared-packages.pass1+3.md`
- Agent 3: bucket `01-db-migrations-and-schema` pass `pass1+3` → `outputs/01-db-migrations-and-schema.pass1+3.md`
- Agent 4: callsite-audit (no bucket) → `outputs/callsite-audit.md`

Wait for all four to return. Then check the outputs directory:

```bash
ls -la "$RUN_DIR/outputs/"
wc -l "$RUN_DIR/outputs/"*.md
```

If any output is missing, dispatch one more retry agent for it.

### Optional: Pass 2 + Pass 4 sweeps on high-risk buckets

For high-risk buckets (anything touching DB schemas, payments, auth, sync, concurrency), also dispatch Pass 2 (inter-file contracts) and Pass 4 (concurrency + external context) agents. Same brief shape, different prompt + bucket file:

- Agent 5: bucket `03-backend-lib` pass `pass2` → `outputs/03-backend-lib.pass2.md`
- Agent 6: bucket `03-backend-lib` pass `pass4` → `outputs/03-backend-lib.pass4.md`
- ...

Pass 2 catches schema-vs-query mismatches and caller-callee contract violations. Pass 4 catches concurrency races, third-party-API mismatches, missing observability, migration safety. Both add real value on PRs touching shared state.

## Phase 5 — synthesis

This is where you (the main thread) earn your keep. Codex output is terse raw findings; the synthesis transforms them into a senior-engineer voice review with cross-cutting themes, hypothetical walkthroughs, and severity prefixes.

Read every output file:

```bash
cat "$RUN_DIR/PRELUDE.md"
for f in "$RUN_DIR/outputs/"*.md; do
  echo "=== $f ==="
  cat "$f"
done
```

You can either do the synthesis yourself in the main thread (using the persona voice from the `n2d4-pr-review` skill — read `/Users/barreloflube/.claude/skills/n2d4-pr-review/SKILL.md` to load it) **or** dispatch one more codex task for the synthesis. The codex synthesis is faster and consistent; the main-thread synthesis can be slightly higher quality because you can interleave clarifying greps. Try codex first; if its output is too generic, redo the synthesis yourself.

### Codex synthesis dispatch

```bash
SYNTH_PROMPT="$RUN_DIR/_runner/synthesis.combined.md"

cat > "$SYNTH_PROMPT" <<'PROMPT_EOF'
# Codex instructions — Persona-voice synthesis

You are the SYNTHESIS pass of a structured PR review. You are reading the
raw output of N earlier codex passes (intent + quality, inter-file contracts,
high-level / concurrency / external, plus a cross-PR callsite audit) and
combining them into ONE final review file in the merged voice of two senior
Stack Auth engineers, **N2D4** + **nams1570**.

## Voice (must follow exactly)

The voice is:
- Default lowercase, casual, conversational for short comments
- Switches to proper sentence case with capital "I" when leading with a
  severity prefix on a substantive comment
- Light contractions and slang are fine ("cuz", "rq", "lmk", "haha",
  "prolly", "acc", "idk", "sgtm", "mb", "FWIW")
- Ultra-short reactions encouraged when the issue is obvious:
  `accident?`, `unused?`, `revert this`, `as above`, `++`, `?`
- Use `as above` heavily when the same issue repeats
- Polite hedging on substantive comments: "as far as I can tell", "I might
  be missing something, but...", "I think this is..."
- Direct questions are a primary tool: "Why do we X?", "Wouldn't this Y?",
  "Is there a guarantee that X always returns Y?"
- Cite concrete files/functions when reasoning across the codebase

### Severity prefixes (use these on substantive comments)

- **`nit:`** — minor / take-it-or-leave-it
- **`Suggestion:`** — recommended improvement, not a blocker
- **`Discussion:`** — open-ended question, may not need action
- **`Potential bug:`** — you suspect something is wrong but aren't 100% sure
- **`bug:`** / **`Bug:`** — confirmed issue
- **`BUG:`** (all caps) — serious / cross-system / blocker. Reserve for
  things that could break production, corrupt data, or take down a queue.

### Comment shapes

A single review typically contains all four lengths:
1. One-word reaction (`accident?`, `as above`, `++`)
2. One short lowercase sentence
3. A labeled paragraph with severity prefix
4. A multi-paragraph hypothetical walkthrough for serious bugs

## What to do

1. Read PRELUDE.md to understand the load-bearing invariant
2. Read every outputs/*.md file
3. Identify cross-cutting themes (the same bug in multiple places gets one
   primary callout + `as above` notes elsewhere)
4. Rank by severity. The structure of the final review should be:
   - **Summary** — 2-3 sentences. What is the PR doing and what is your
     overall take.
   - **Load-bearing invariant** — quote the one from PRELUDE.md
   - **BUGs / Bugs** — confirmed issues, ordered by blast radius
   - **Potential bugs** — things you suspect but can't prove
   - **Suggestions** — improvements that aren't blockers
   - **Discussion** — open questions
   - **nits** — minor stuff, can be a single bullet list
5. For each serious bug, write a multi-step hypothetical walkthrough showing
   exactly how it manifests in production
6. For pattern bugs (the same issue in multiple files), give the primary
   callout + a list of `as above` sites
7. Cite files with `path:line` format

## Hard rules

- Use the voice. This is non-negotiable.
- Never invent issues to fill space. If a pass found nothing, the synthesis
  has nothing to report from that pass.
- Don't summarize the diff — assume the author already knows what they wrote.
- Don't recommend adding docstrings, logs, or comments unless something is
  actively wrong.
- Walkthroughs are the highest-value artifact. Write them whenever a bug
  isn't obvious from the line itself.

## Inputs

PROMPT_EOF

# Concatenate every output file the dispatch produced
echo '' >> "$SYNTH_PROMPT"
echo "## PRELUDE.md" >> "$SYNTH_PROMPT"
echo '```markdown' >> "$SYNTH_PROMPT"
cat "$RUN_DIR/PRELUDE.md" >> "$SYNTH_PROMPT"
echo '```' >> "$SYNTH_PROMPT"

for f in "$RUN_DIR/outputs/"*.md; do
  name=$(basename "$f")
  echo '' >> "$SYNTH_PROMPT"
  echo "## outputs/$name" >> "$SYNTH_PROMPT"
  echo '```markdown' >> "$SYNTH_PROMPT"
  cat "$f" >> "$SYNTH_PROMPT"
  echo '```' >> "$SYNTH_PROMPT"
done

cat >> "$SYNTH_PROMPT" <<EOF

---

## Output instruction

Write your final synthesized review to:

  $RUN_DIR/final-review.md

Do NOT print to stdout. Write to that path.
EOF

node "$CODEX" task \
  --prompt-file "$SYNTH_PROMPT" \
  --cwd "$WORKTREE" \
  --write
```

Verify:

```bash
ls -la "$RUN_DIR/final-review.md"
wc -l "$RUN_DIR/final-review.md"
head -60 "$RUN_DIR/final-review.md"
```

A good final review is 200-500 lines, has at least one walkthrough for a serious bug, uses lowercase + severity prefixes correctly, and surfaces issues found in the callsite audit (which by definition aren't in the diff).

## Phase 6 — present to user

Show the user:

1. **Path** to `$RUN_DIR/final-review.md`
2. **Stats**: number of buckets reviewed, number of codex tasks dispatched, total wall-clock, output sizes
3. **Top 3-5 findings** as a quick triage list (BUG-severity first)
4. Offer to:
   - Walk through any specific finding in more detail
   - Re-run a specific bucket / pass with a different focus
   - Add a missing bucket to the review

## Failure modes + retries

- **Codex returns "completed" but the output file is missing.** Most common failure. Retry the same task. Two retries is usually enough.
- **Codex output is a stub like "Pending analysis" or "Will continue in next session".** Codex ran out of budget. Re-dispatch with the same prompt; the second run usually completes.
- **Codex reads files from the wrong worktree.** Should be impossible because `--cwd "$WORKTREE"` is set + the prompt has a `cd` preamble. If it happens, double-check the `WORKTREE` variable doesn't have a typo.
- **Output file exists but is empty markdown.** Codex dispatched but didn't actually do the work. Retry.
- **Bucket pass1+3 file is huge (> 200KB) and codex truncates.** The bucket has too many files. Either narrow `--scope` in Phase 1 to reduce the indexed set, or split the bucket manually by editing `split.ts` and re-running Phase 2.

## Quick reference

```bash
# variables (set these once at the top of the run)
WORKTREE="/path/to/repo"
BASE="dev"
RUN_DIR="/tmp/review-run-N"
ARGUS_DIR="/tmp/review-ctx"
CODEX="/Users/barreloflube/.claude/plugins/cache/openai-codex/codex/1.0.2/scripts/codex-companion.mjs"

# phase 1 — context
cd "$WORKTREE" && bun run "$ARGUS_DIR/index.ts" --base "$BASE" --out "$RUN_DIR/ctx.json"

# phase 2 — split
bun run "$ARGUS_DIR/split.ts" "$RUN_DIR/ctx.json" "$RUN_DIR" "$WORKTREE"

# phase 3 — prelude (read 00-overview.md first to pick buckets)
# ... (build $RUN_DIR/_runner/prelude.combined.md as above)
node "$CODEX" task --prompt-file "$RUN_DIR/_runner/prelude.combined.md" --cwd "$WORKTREE" --write

# phase 4 — fan out via parallel subagents (spawn in ONE message)
# (subagent brief above)

# phase 5 — synthesis
# (build $RUN_DIR/_runner/synthesis.combined.md as above)
node "$CODEX" task --prompt-file "$RUN_DIR/_runner/synthesis.combined.md" --cwd "$WORKTREE" --write

# phase 6 — show $RUN_DIR/final-review.md to user
```

## Notes on the design

- **Why fan out via subagents and not via `node $CODEX task --background`?** Background mode is fire-and-forget — you have to poll for results, and the codex companion isn't great at telling you when a job died. Subagents have a clean parent/child relationship and structured return values, and they keep the main context clean.
- **Why does the skill not just call a single `orchestrate.ts`?** Because every PR is different. Some PRs need 8 buckets, some need 2. Some need Pass 2 and 4 on every bucket, some only need Pass 1+3 on one bucket. The dynamic judgment about WHICH passes to run matters more than the throughput from running ALL of them. A driver script makes that call rigid.
- **Why is synthesis sometimes done by codex and sometimes by the main thread?** Codex is faster and consistent. Main thread is higher quality on PRs where the bugs need cross-pass synthesis (e.g. "Pass 1 found X, callsite audit found Y, together they imply Z"). Default to codex; redo manually if quality is bad.
- **Ollama is only used for embeddings.** Every chat call goes through codex. There is no other LLM in the loop.
