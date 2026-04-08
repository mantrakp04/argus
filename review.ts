#!/usr/bin/env bun
/**
 * review.ts — single-file end-to-end review smoke test using a bundle from index.ts.
 *
 * Usage:
 *   bun run review.ts <bundle.json> [file-path] [--worktree <path>]
 *   bun run review.ts /tmp/ctx.json                            # auto-pick meaty file
 *   bun run review.ts /tmp/ctx.json apps/backend/seed.ts       # specific file
 *   bun run review.ts /tmp/ctx.json --worktree /repos/myrepo   # set codex cwd
 *
 * Builds a Greptile-style per-file review prompt with all context lanes and
 * runs it through `codex` via the codex-companion task interface. Codex is
 * the only LLM in the loop — Ollama is only used by `index.ts` for embeddings.
 *
 * The prompt instructs codex to write its review to <bundlePath>.review.md
 * (so this script never has to parse codex stdout).
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

interface SemanticNeighbor { path: string; score: number; alsoIn: string[] }
interface HopNode { path: string; via: string; viaSymbols: string[]; type: string }
interface FileEntry {
  path: string;
  prevPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
  fullContent: string;
  truncated: boolean;
  symbols: { exports: string[]; functions: string[]; classes: string[] };
  directImports: Array<{
    specifier: string; kind: 'internal' | 'external'; type: string;
    resolvedPath?: string; namedSymbols: string[]
  }>;
  directCallers: Array<{ path: string; importedSymbols: string[]; type: string }>;
  multiHop: { forwardTiers: HopNode[][]; reverseTiers: HopNode[][] };
  semanticNeighbors: SemanticNeighbor[];
  siblings: string[];
  otherChangedFiles: string[];
}
interface Bundle {
  meta: Record<string, unknown>;
  rules: Record<string, string>;
  memory: { path: string; content: string } | null;
  changedFiles: string[];
  files: FileEntry[];
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let bundlePath = '';
let targetArg = '';
let worktree = process.cwd();

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === '--worktree') {
    worktree = resolve(argv[++i] ?? '');
  } else if (!bundlePath) {
    bundlePath = a;
  } else if (!targetArg) {
    targetArg = a;
  }
}
if (!bundlePath) {
  console.error('usage: bun run review.ts <bundle.json> [file-path] [--worktree <path>]');
  process.exit(2);
}

const bundle: Bundle = JSON.parse(await readFile(bundlePath, 'utf8'));

// Pick a file: either the one the user asked for, or a "meaty" one that
// exercises the full context (internal imports + callers + multi-hop + neighbors).
let file: FileEntry | undefined;
if (targetArg) {
  file = bundle.files.find((f) => f.path === targetArg || f.path.endsWith(targetArg));
}
if (!file) {
  file = bundle.files.find((f) =>
    f.directImports.filter((i) => i.kind === 'internal').length >= 3 &&
    f.directCallers.length >= 1 &&
    f.multiHop.forwardTiers.length >= 1 &&
    f.semanticNeighbors.length >= 3 &&
    f.patch.length > 200 &&
    f.patch.length < 8000,
  );
}
if (!file) file = bundle.files[0]!;

const outputPath = resolve(bundlePath + '.review.md');
const promptPath = resolve(bundlePath + '.review.prompt.md');

console.error(`[review] bundle  : ${bundlePath}`);
console.error(`[review] file    : ${file.path}`);
console.error(`[review] worktree: ${worktree}`);
console.error(`[review] output  : ${outputPath}`);
console.error(`[review] lanes   : imports=${file.directImports.length} callers=${file.directCallers.length} fwdHops=${file.multiHop.forwardTiers.map((t) => t.length).join(',')} revHops=${file.multiHop.reverseTiers.map((t) => t.length).join(',')} neighbors=${file.semanticNeighbors.length}`);

// ---------------------------------------------------------------------------
// Prompt construction — Greptile-style per-file review, all lanes included
// ---------------------------------------------------------------------------
function fmtImports(imports: FileEntry['directImports']): string {
  const internal = imports.filter((i) => i.kind === 'internal');
  if (internal.length === 0) return '  (none)';
  return internal
    .map((i) => {
      const syms = i.namedSymbols.length > 0 ? ` { ${i.namedSymbols.join(', ')} }` : '';
      return `  ${i.resolvedPath}${syms}`;
    })
    .join('\n');
}

function fmtCallers(callers: FileEntry['directCallers']): string {
  if (callers.length === 0) return '  (none)';
  return callers
    .map((c) => {
      const syms = c.importedSymbols.length > 0 ? ` uses { ${c.importedSymbols.join(', ')} }` : '';
      return `  ${c.path}${syms}`;
    })
    .join('\n');
}

function fmtHops(tiers: HopNode[][]): string {
  if (tiers.length < 2 || tiers[1]!.length === 0) return '  (none)';
  return tiers[1]!
    .map((n) => `  ${n.path}  ← via ${n.via}`)
    .join('\n');
}

function fmtNeighbors(neighbors: SemanticNeighbor[]): string {
  if (neighbors.length === 0) return '  (none)';
  return neighbors
    .slice(0, 6)
    .map((n) => {
      const also = Array.isArray(n.alsoIn) ? n.alsoIn : [];
      const overlap = also.length > 0 ? ` [also in ${also.join('+')}]` : '';
      return `  ${n.score.toFixed(3)}  ${n.path}${overlap}`;
    })
    .join('\n');
}

function extractMemorySections(memory: string): string {
  return memory
    .split('\n')
    .filter((l) => l.startsWith('- ') || /^##\s/.test(l))
    .join('\n');
}

const memoryBlock = bundle.memory ? extractMemorySections(bundle.memory.content) : '(no memory)';
const ruleBlock = Object.entries(bundle.rules)
  .map(([k, v]) => `### ${k}\n${v.slice(0, 800)}`)
  .join('\n\n');

const MAX_BODY_CHARS = 14000;
let body = file.fullContent;
if (body.length > MAX_BODY_CHARS) {
  body = body.slice(0, MAX_BODY_CHARS) + '\n... [truncated for context window]';
}

const prompt = `# Codex instructions — single-file PR review

You are a senior code reviewer doing a focused review of ONE file from a pull
request. The bundle below contains every context lane the reviewer normally
gets: extracted symbols, direct imports, callers, multi-hop forward/reverse
graph, semantic neighbors, sibling files in the PR, the diff, and the full
file body with line numbers.

You may freely \`grep\`/\`rg\`/\`cat\` the actual repo at your cwd to verify
hypotheses and trace symbols beyond what's inlined here. You may NOT edit any
file other than the single output markdown file specified below.

## cwd setup (do this first)

\`\`\`bash
cd "${worktree}"
pwd
\`\`\`

## Output

When you are done, write your review as plain markdown to:

  \`${outputPath}\`

Format:

\`\`\`markdown
# Review: ${file.path}

## Summary
[1-3 sentence summary of what the change is and your overall take]

## Findings

- L<num> [logic|contract|style] — short finding
  Optional walkthrough or suggestion block...

- L<num> ...
\`\`\`

## Hard rules

- Most files need 0-3 findings. Zero findings is acceptable.
- Each finding must cite a specific line number from the "File body" section.
- Prefer logic / contract / concurrency issues over style.
- Never recommend adding docstrings, logs, or comments unless something is
  actively wrong.
- Follow the project rules and review memory below; never violate suppressions.

# Repository

- Repo: ${bundle.meta.repo}
- Base: ${bundle.meta.base}
- PR scope: ${bundle.meta.changedFileCount} files changed

# Review memory (team preferences)

${memoryBlock}

# Project rules

${ruleBlock}

# File under review

Path: \`${file.path}\`
Status: ${file.status} (+${file.additions} / -${file.deletions})
${file.prevPath ? `Renamed from: \`${file.prevPath}\`\n` : ''}

## Extracted symbols

- exports:   ${file.symbols.exports.join(', ') || '(none)'}
- functions: ${file.symbols.functions.join(', ') || '(none)'}
- classes:   ${file.symbols.classes.join(', ') || '(none)'}

## Direct dependencies (internal)

${fmtImports(file.directImports)}

## Callers (who imports this file)

${fmtCallers(file.directCallers)}

## 2-hop forward (reached through direct deps)

${fmtHops(file.multiHop.forwardTiers)}

## 2-hop reverse (callers-of-callers)

${fmtHops(file.multiHop.reverseTiers)}

## Semantically similar files (embedding cosine)

${fmtNeighbors(file.semanticNeighbors)}

## Other files in this PR

${file.otherChangedFiles.slice(0, 15).join('\n') || '(none)'}

## Diff

\`\`\`diff
${file.patch.slice(0, 6000)}${file.patch.length > 6000 ? '\n... [truncated]' : ''}
\`\`\`

## File body (with line numbers)

\`\`\`
${body}
\`\`\`

Now do the review and write your findings to \`${outputPath}\`.
`;

await writeFile(promptPath, prompt);

console.error(`[review] prompt bytes: ${prompt.length}`);
console.error(`[review] prompt file : ${promptPath}`);
console.error('[review] invoking codex (this can take a few minutes)...');

// ---------------------------------------------------------------------------
// Invoke codex via codex-companion task --prompt-file --write
// ---------------------------------------------------------------------------
const COMPANION = '/Users/barreloflube/.claude/plugins/cache/openai-codex/codex/1.0.2/scripts/codex-companion.mjs';

// Best-effort: clear any stale output from a previous run
try { await stat(outputPath); await writeFile(outputPath, ''); } catch { /* ok */ }

const t0 = Date.now();

await new Promise<void>((resolveP, rejectP) => {
  const child = spawn('node', [
    COMPANION, 'task',
    '--prompt-file', promptPath,
    '--cwd', worktree,
    '--write',
  ], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', rejectP);
  child.on('exit', (code) => {
    if (code === 0) resolveP();
    else rejectP(new Error(`codex-companion task exited with ${code}`));
  });
});

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// Verify output file was written
let outBytes = 0;
try {
  const s = await stat(outputPath);
  outBytes = s.size;
} catch {
  console.error(`[review] WARNING: codex did not write expected output file ${outputPath}`);
  process.exit(1);
}

console.error(`[review] done in ${elapsed}s — output ${outBytes} bytes`);
console.error();
console.error('================================================================');
console.error(`  REVIEW : ${file.path}`);
console.error(`  ELAPSED: ${elapsed}s`);
console.error(`  OUTPUT : ${outputPath}`);
console.error('================================================================');

// Print the review to stdout for convenience
console.log(await readFile(outputPath, 'utf8'));
